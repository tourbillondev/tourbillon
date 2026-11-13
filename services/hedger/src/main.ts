import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createPublicClient, formatEther, getAddress, http, stringToHex, type Address, type LocalAccount, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { decryptKeystore, promptHidden, readKeystore } from "@tourbillon/common/keystore.ts";
import { HL_TESTNET, HyperliquidVenue } from "./hlvenue.ts";
import type { Venue } from "./venue.ts";
import { chainFor } from "@tourbillon/common/chain.ts";
import { fetchMetaAndAssetCtxs, HL_API, parseMarks, TIMEOUT_MS } from "@tourbillon/common/hyperliquid.ts";
import { log } from "@tourbillon/common/log.ts";
import { poolHeldCoins, readPositions, sourcesAbi } from "./book.ts";
import { checkForChain, MAX_MARK_MISMATCH, parseArgs, type Config } from "./config.ts";
import { targetHedge } from "./delta.ts";
import { plan } from "./policy.ts";

/// The hedger: works out the pool's net delta per market and the perp orders that bring the hedge to target.
/// Without --venue it only logs them (dry run). With --venue sim it trades on a local simulated venue with a throwaway
/// agent key; --venue hl-testnet is for M3 step 12 only (owner's yes). Mainnet orders are refused in code.

type Dep = { chainId: number; router: Address; board: Address; pool: Address; book: Address; markets: string[] };

function loadDeployment(path: string): Dep {
  const d = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const need = (k: string) => {
    if (typeof d[k] !== "string") throw new Error(`deployment: missing ${k}`);
    return getAddress(d[k] as string);
  };
  return {
    chainId: Number(d.chainId),
    router: need("MarkRouter"),
    board: need("QuorumBoard"),
    pool: need("MainspringPool"),
    book: need("PathFundingBook"),
    markets: d.markets as string[],
  };
}

async function currentPositions(cfg: Config, base: string): Promise<Map<string, number>> {
  if (cfg.positions) return cfg.positions;
  const res = await fetch(new URL("/info", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "clearinghouseState", user: cfg.hlUser }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`clearinghouseState HTTP ${res.status}`);
  const body = (await res.json()) as { assetPositions?: { position?: { coin?: string; szi?: string } }[] };
  const out = new Map<string, number>();
  for (const ap of body.assetPositions ?? []) {
    if (ap.position?.coin && ap.position.szi !== undefined) out.set(ap.position.coin, Number(ap.position.szi));
  }
  return out;
}

/// Per-market hedging status, written after every pass for the risk-monitor: a market is failing when the venue could
/// not be reached or refused its orders (not when it was skipped for a stale or mismatched mark).
type MarketStatus = { ok: boolean; lastOkAt: string | null; error?: string };
const status = new Map<string, MarketStatus>();

function setStatus(market: string, ok: boolean, error?: string): void {
  const prev = status.get(market);
  status.set(market, { ok, lastOkAt: ok ? new Date().toISOString() : (prev?.lastOkAt ?? null), error });
}

function writeStatus(cfg: Config): void {
  if (!cfg.statusFile) return;
  const tmp = `${cfg.statusFile}.tmp`;
  writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), markets: Object.fromEntries(status) }));
  renameSync(tmp, cfg.statusFile); // atomic replace: the monitor never reads half a file
}

async function tick(cfg: Config, client: PublicClient, dep: Dep, base: string, venue: Venue | null): Promise<void> {
  const marks = parseMarks(await fetchMetaAndAssetCtxs(base), dep.markets);
  const positions = venue ? await venue.positions() : await currentPositions(cfg, base);
  const venueMarkets = venue ? await venue.markets() : null;
  for (const market of dep.markets) {
    const at = { market };
    const m = marks.get(market);
    if (!m || !m.ok) {
      log("warn", "no Hyperliquid mark: market not hedged this pass", { ...at, reason: m && !m.ok ? m.reason : "missing" });
      continue;
    }
    const s = Number(formatEther(m.mark));
    const name = stringToHex(market, { size: 32 });
    let routerMark: number;
    let sigmaBps: number;
    try {
      routerMark = Number(formatEther(await client.readContract({ address: dep.router, abi: sourcesAbi, functionName: "markWad", args: [name] })));
      sigmaBps = Number(await client.readContract({ address: dep.board, abi: sourcesAbi, functionName: "volBps", args: [name] }));
    } catch {
      log("warn", "router mark or board vol stale: market not hedged this pass", at);
      continue;
    }
    if (Math.abs(s - routerMark) / routerMark > MAX_MARK_MISMATCH) {
      log("warn", "Hyperliquid mark and router mark differ by more than 1%: market not hedged this pass", { ...at, hyperliquid: s, router: routerMark });
      continue;
    }
    const book = await readPositions(client, dep.pool, dep.book, market);
    const held = await poolHeldCoins(client, dep.pool, market); // the pool's WHYPE on HYPE (M4)
    const wanted = targetHedge(book, s, sigmaBps, held);
    const mid = m.mid !== null ? Number(formatEther(m.mid)) : s;
    const cap = cfg.deltaCapUsd[market];
    if (cap === undefined) {
      log("warn", "no delta cap configured: market not hedged", at);
      continue;
    }
    const p = plan(market, wanted, positions.get(market) ?? 0, mid, m.szDecimals, cap);
    if (p.unhedged > 0) {
      log("alarm", "target hedge above the hard position limit: remainder unhedged", {
        ...at,
        wanted: p.wanted,
        hardLimit: p.hardLimit,
        unhedgedCoins: p.unhedged,
        unhedgedUsd: p.unhedged * mid,
      });
    }
    log("info", "plan", { ...at, s, sigmaBps, series: book.length, target: p.target, current: p.current, band: p.band, reason: p.reason, orders: p.orders });
    if (!venue || !venueMarkets) {
      for (const o of p.orders) log("info", "would send", { ...o, dryRun: true });
      setStatus(market, true);
      continue;
    }
    if (p.orders.length === 0) {
      setStatus(market, true);
      continue;
    }
    const sentAt = new Date().toISOString();
    const fills = await venue.placeIoc(p.orders, venueMarkets);
    const after = await venue.positions();
    const reconciledAt = new Date().toISOString();
    fills.forEach((f, i) => {
      // a row shaped like the spec's hedges table
      log(f.status === "error" ? "warn" : "info", "hedge", {
        id: `${Date.parse(sentAt)}-${market}-${i}`,
        market,
        side: f.side,
        sz: f.requested,
        px: f.avgPx,
        sent_at: sentAt,
        reconciled_at: reconciledAt,
        filled_sz: f.filled,
        status: f.status,
        error: f.error,
        position_after: after.get(market) ?? 0,
        via: "api_wallet",
      });
    });
    if (fills.some((f) => f.status === "error")) {
      setStatus(market, false, "venue refused orders");
      throw new Error(`venue refused orders on ${market}`);
    }
    setStatus(market, true);
  }
}

/// The agent (API wallet) for a venue: a throwaway key approved on the simulated venue, or the keystore account
/// (hidden password prompt) for Hyperliquid testnet.
async function venueFor(cfg: Config, dep: Dep): Promise<Venue | null> {
  if (cfg.venue === "none") return null;
  if (!cfg.hlUser) throw new Error("a venue needs --hl-user (the pool's Hyperliquid account)");
  let agent: LocalAccount;
  let base: string;
  if (cfg.venue === "sim") {
    base = cfg.venueUrl!;
    agent = privateKeyToAccount(generatePrivateKey()); // never leaves this process
    const res = await fetch(new URL("/sim/approve", base), { method: "POST", body: JSON.stringify({ user: cfg.hlUser, agent: agent.address }) });
    if (!res.ok) throw new Error("the simulated venue did not approve the agent");
  } else {
    base = HL_TESTNET;
    const ks = readKeystore(cfg.agentKeystore!);
    agent = privateKeyToAccount(decryptKeystore(ks, await promptHidden(`password for keystore ${cfg.agentKeystore}: `)));
  }
  log("info", "venue", { venue: cfg.venue, url: base, agent: agent.address, user: cfg.hlUser });
  return new HyperliquidVenue(base, cfg.hlUser, agent, dep.markets);
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  const dep = loadDeployment(cfg.deployment);
  const client = createPublicClient({ chain: chainFor(dep.chainId), transport: http(cfg.rpc) }) as PublicClient;
  const rpcId = await client.getChainId();
  if (rpcId !== dep.chainId) throw new Error(`RPC is chain ${rpcId}, deployment file is chain ${dep.chainId}`);
  checkForChain(cfg, rpcId);
  const venue = await venueFor(cfg, dep);
  const base = cfg.venue === "sim" ? cfg.venueUrl! : cfg.venue === "hl-testnet" ? HL_TESTNET : (cfg.hlApi ?? HL_API);
  log("info", "started", { pool: dep.pool, markets: dep.markets, dryRun: venue === null, venue: cfg.venue, deltaCapUsd: cfg.deltaCapUsd });
  let failures = 0;
  let stopping = false;
  process.on("SIGINT", () => (stopping = true));
  process.on("SIGTERM", () => (stopping = true));
  while (!stopping) {
    try {
      await tick(cfg, client, dep, base, venue);
      if (failures >= 3) log("info", "venue recovered", { after: failures });
      failures = 0;
    } catch (e) {
      failures++;
      const error = e instanceof Error ? e.message.split("\n")[0] : String(e);
      // a failed pass: every market not already marked failing this pass is marked failing
      for (const m of dep.markets) if (status.get(m)?.ok !== false) setStatus(m, false, error);
      // the risk-monitor (step 9) pauses opens after 15 minutes of this
      if (failures >= 3) log("alarm", "hedging failing", { failures, error });
      else log("error", "tick failed", { failures, error });
    }
    writeStatus(cfg);
    if (cfg.once) break;
    for (let i = 0; i < cfg.tickSeconds && !stopping; i++) await Bun.sleep(1000);
  }
  log("info", "stopped");
}

main().catch((e) => {
  log("error", "fatal", { error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
  process.exit(1);
});
