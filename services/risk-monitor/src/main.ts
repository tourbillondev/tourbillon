import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, encodeAbiParameters, formatEther, formatUnits, getAddress, http, keccak256, parseEventLogs, stringToHex, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { chainFor, LOCAL_CHAIN_ID } from "@tourbillon/common/chain.ts";
import { EQUITY_OFFSET } from "@tourbillon/common/equity.ts";
import { openExchange, type ExchangeRead } from "@tourbillon/common/exchange.ts";
import { stockToken } from "@tourbillon/common/covers.ts";
import { amountOf, settlementOf, type Settlement } from "@tourbillon/common/settlement.ts";
import { MAX_FEE_PER_GAS, POLL_MS, withHeadroom } from "@tourbillon/common/gas.ts";
import { log } from "@tourbillon/common/log.ts";
import { loadSigner, type KeyInput, type Signer } from "@tourbillon/common/signer.ts";
import { Conditions, emit, type AlarmName } from "./alarm.ts";
import { capHigh, coverageState, DEFAULTS, equityMismatch, exchangeMarketDown, type Thresholds } from "./checks.ts";
import { m6Abi, m6Alarms, settleDue, type M6Event, type OpenLot } from "./m6.ts";
import { m7Abi, m7Alarms, receiptsAgeHours, type M7Addresses, type M7Event } from "./m7.ts";
import { OutageTracker } from "./outage.ts";
import { inventoryMismatch, markRound, quarterCapHigh, splitRatio } from "./rh.ts";
import { loadKeys, lowKeys, type WatchedKey } from "./keys.ts";

/// The risk-monitor (M3 step 9; RH6: two venues, Backend §6). Every pass it checks the venues (the crypto hedge
/// exchange for crypto markets; hedger-onchain's status for stock markets), the pool's risk state and the services'
/// liveness, and
/// writes alarm lines in a stable shape (src/alarm.ts). With an M6 deployment file it also watches the open book
/// (buybacks, uncovered matched raw, dust, vault slashes) and the weekly risk auction (src/m6.ts); with an M7 file, the
/// timelock queue, role changes, pauses and receipts liveness (src/m7.ts); and the Robinhood Chain checks (src/rh.ts:
/// splits, out-of-session anchoring, quarter caps, the on-chain hedge inventory, stuck covering tokens). Its only
/// on-chain action: pausing opens on one market with the pause-only RISK_PAUSER key, after 15 minutes of continuous
/// venue outage there, or at once on a split (G9). It can never unpause. Alarm names follow the playbook: lower-dash,
/// the market joined with a dash when the bot posts them.

const poolAbi = [
  ...["available", "stressedLiability", "sentOut", "receivedBack", "round"].map(
    (name) => ({ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }) as const,
  ),
  { type: "function", name: "opensPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "equityReady", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "equityKey", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  ...["notionalCap", "openNotional", "directionalCap", "directional"].map(
    (name) => ({ type: "function", name, stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] }) as const,
  ),
  { type: "function", name: "marketPaused", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "pauseMarket", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] },
  { type: "function", name: "sessionCalendar", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "event", name: "CoverStuckPaused", inputs: [{ type: "bytes32", name: "market", indexed: true }, { type: "address", name: "book" }] },
  {
    type: "function",
    name: "rounds",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [
      { type: "uint256" }, { type: "uint256" }, { type: "bool" }, { type: "bool" }, { type: "uint256" },
      { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint64" },
    ],
  },
  {
    type: "event",
    name: "TreasurySent",
    inputs: [
      { type: "address", name: "treasury", indexed: true },
      { type: "uint256", name: "amount" },
      { type: "uint256", name: "sentOut" },
      { type: "uint256", name: "sentToday" },
      { type: "uint256", name: "navBefore" },
    ],
  },
  {
    type: "event",
    name: "TreasuryReturned",
    inputs: [
      { type: "address", name: "treasury", indexed: true },
      { type: "uint256", name: "amount" },
      { type: "uint256", name: "receivedBack" },
    ],
  },
] as const;
const calendarAbi = [
  { type: "function", name: "isRegularSession", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "openCapBps", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
] as const;
const finalisedAbi = [
  { type: "event", name: "Finalised", inputs: [{ type: "bytes32", name: "key", indexed: true }, { type: "uint80", name: "round", indexed: true }, { type: "uint256", name: "median" }, { type: "uint256", name: "published" }, { type: "uint256", name: "votes" }] },
] as const;
const markKeyOf = (m: string): Hex => keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }], ["MARK", stringToHex(m, { size: 32 })]));
/// A venue counts as down for a warning (dex-down / cex-down) after this share of the pause window (5 of 15 minutes).
const DOWN_WARN_SHARE = 1 / 3;

const viewAbi = [
  { type: "function", name: "markWad", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "volBps", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "latestValue", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "latestSample", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }] },
] as const;

type Config = {
  deployment: string;
  rpc?: string;
  key: KeyInput;
  exchange?: string; // the crypto hedge exchange (read-only key); "sim" on anvil; others refused until Q5
  exchangeUrl?: string;
  hedgerStatus: string[]; // the hedgers' status files (hedger-cex, hedger-onchain)
  keys: WatchedKey[];
  outageMs: number;
  tickSeconds: number;
  equityEveryS: number;
  once: boolean;
  t: Thresholds;
};

function parseArgs(argv: string[]): Config {
  const a = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (!k.startsWith("--")) throw new Error(`unexpected argument ${k}`);
    const f = k.slice(2);
    if (f === "once") a.set(f, true);
    else {
      const v = argv[++i];
      if (v === undefined) throw new Error(`--${f} needs a value`);
      a.set(f, v);
    }
  }
  const known = ["deployment", "rpc", "keystore", "keystore-dir", "local-unlocked", "watch", "exchange", "exchange-url", "hedger-status", "keys", "outage-minutes", "tick-seconds", "equity-every-seconds", "once"];
  for (const k of a.keys()) if (!known.includes(k)) throw new Error(`unknown flag --${k}`);
  const s = (k: string) => (typeof a.get(k) === "string" ? (a.get(k) as string) : undefined);
  if (!s("deployment")) throw new Error("--deployment is required");
  const inputs = ["keystore", "local-unlocked", "watch"].filter((k) => a.has(k));
  if (inputs.length !== 1) throw new Error("give exactly one of --keystore, --local-unlocked, --watch (watch: alarms only, no pause)");
  const key: KeyInput = a.has("keystore")
    ? { type: "keystore", name: s("keystore")!, dir: s("keystore-dir") }
    : a.has("local-unlocked")
      ? { type: "local-unlocked", address: getAddress(s("local-unlocked")!) }
      : { type: "watch", address: getAddress(s("watch")!) };
  return {
    deployment: s("deployment")!,
    rpc: s("rpc"),
    key,
    exchange: s("exchange"),
    exchangeUrl: s("exchange-url"),
    hedgerStatus: s("hedger-status") ? s("hedger-status")!.split(",") : [],
    keys: s("keys") ? loadKeys(s("keys")!) : [],
    outageMs: Number(s("outage-minutes") ?? 15) * 60_000,
    tickSeconds: Math.max(1, Number(s("tick-seconds") ?? 60)),
    equityEveryS: Number(s("equity-every-seconds") ?? 3600),
    once: a.has("once"),
    t: DEFAULTS,
  };
}

type Dep = {
  chainId: number;
  router: Address;
  board: Address;
  pool: Address;
  book: Address;
  markets: string[];
  deployBlock: bigint;
  // M6 (absent in older deployment files)
  settlement: Settlement;
  matchBook: Address | null;
  auction: Address | null;
  vault: Address | null;
  // M7
  engine: Address | null;
  m7: M7Addresses;
};

function loadDep(path: string): Dep {
  const d = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const need = (k: string) => getAddress(String(d[k]));
  const maybe = (k: string) => (typeof d[k] === "string" ? getAddress(d[k] as string) : null);
  return {
    chainId: Number(d.chainId),
    router: need("MarkRouter"),
    board: need("QuorumBoard"),
    pool: need("MainspringPool"),
    book: need("PathFundingBook"),
    markets: d.markets as string[],
    deployBlock: BigInt(Number(d.deployBlock ?? 0)),
    settlement: settlementOf(d),
    matchBook: maybe("MatchBook"),
    auction: maybe("RiskAuction"),
    vault: maybe("MakerVault"),
    engine: maybe("Engine"),
    m7: {
      timelock: maybe("Timelock"),
      receipts: maybe("ReceiptRoots"),
      safe: maybe("Safe"),
      guardian: maybe("Guardian"),
      gate: maybe("HedgeKeeperGate"),
      riskPauser: typeof d.riskPauser === "string" && d.Timelock ? getAddress(d.riskPauser as string) : null,
      deployer: typeof d.deployer === "string" && d.Timelock ? getAddress(d.deployer as string) : null,
      names: new Map(
        ["MainspringPool", "Engine", "QuorumBoard", "MarkRouter", "Timelock", "ReceiptRoots", "OpenBook", "MatchBook", "RiskAuction", "MakerVault", "AgentRouter", "PathFundingBook", "HedgeKeeperGate", "SessionCalendar", "CoveringAssets", "HedgeRouterV4"]
          .filter((k) => typeof d[k] === "string")
          .map((k) => [(d[k] as string).toLowerCase(), k] as const),
      ),
    },
  };
}

/// The settlement token (owner D1), from the deployment file: every amount and sentence uses its symbol and decimals.
let S: Settlement;
const usdc = (v: bigint) => amountOf(v, S);
const b32 = (m: string) => stringToHex(m, { size: 32 });

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  const dep = loadDep(cfg.deployment);
  S = dep.settlement;
  const client = createPublicClient({ chain: chainFor(dep.chainId), transport: http(cfg.rpc), pollingInterval: POLL_MS }) as PublicClient;
  const chainId = await client.getChainId();
  if (chainId !== dep.chainId) throw new Error(`RPC is chain ${chainId}, deployment file is chain ${dep.chainId}`);
  if (cfg.key.type === "local-unlocked" && chainId !== LOCAL_CHAIN_ID) throw new Error("--local-unlocked works only on a local anvil (31337)");
  const signer = await loadSigner(cfg.key, dep.chainId, cfg.rpc);
  const ex = cfg.exchange ? await openExchange(cfg.exchange, cfg.exchangeUrl, "read", chainId === LOCAL_CHAIN_ID) : null;
  const stocks = new Set<string>();
  for (const m of dep.markets) if (await stockToken(client, dep.pool, m)) stocks.add(m);
  const outage = new OutageTracker(cfg.outageMs);
  const cond = new Conditions();
  let nextBlock = dep.deployBlock;
  const lots = new Map<bigint, OpenLot>();
  let lastEquityCheck = -Infinity;
  log("info", "started", { pool: dep.pool, markets: dep.markets, stockMarkets: [...stocks], exchange: ex?.name ?? null, pauses: signer.wallet !== undefined, outageMinutes: cfg.outageMs / 60_000 });

  let stopping = false;
  process.on("SIGINT", () => (stopping = true));
  process.on("SIGTERM", () => (stopping = true));
  while (!stopping) {
    try {
      nextBlock = await pass(cfg, client, dep, ex, stocks, signer, outage, cond, nextBlock, lots, () => {
        const due = Date.now() - lastEquityCheck >= cfg.equityEveryS * 1000;
        if (due) lastEquityCheck = Date.now();
        return due;
      });
    } catch (e) {
      emit({ name: "monitor-error", state: "event", level: "alarm", what: "The risk-monitor's pass failed.", who: "risk-monitor operator", market: null, values: { error: (e as Error).message.split("\n")[0] } });
    }
    if (cfg.once) break;
    for (let i = 0; i < cfg.tickSeconds && !stopping; i++) await Bun.sleep(1000);
  }
  log("info", "stopped");
}

async function pass(
  cfg: Config,
  client: PublicClient,
  dep: Dep,
  ex: ExchangeRead | null,
  stocks: Set<string>,
  signer: Signer,
  outage: OutageTracker,
  cond: Conditions,
  fromBlock: bigint,
  lots: Map<bigint, OpenLot>,
  equityDue: () => boolean,
): Promise<bigint> {
  const block = await client.getBlock();
  const now = Number(block.timestamp);
  const read = <T>(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address, abi, functionName, args } as never) as Promise<T>;

  // ---- treasury events (each one is announced)
  // no new block since the last pass: nothing to read (a from > to range is an invalid request)
  const logs = fromBlock <= block.number ? await client.getLogs({ address: dep.pool, fromBlock, toBlock: block.number }) : [];
  for (const l of parseEventLogs({ abi: poolAbi, logs, strict: false })) {
    const v = l.args as Record<string, bigint>;
    if (l.eventName === "TreasurySent") {
      emit({ name: "treasury-sent", state: "event", level: "alarm", what: `The pool sent ${S.symbol} to the treasury (bound for the crypto hedge exchange).`, who: "treasury operator: confirm the move was planned", market: null, values: { amount: usdc(v.amount!), sentOut: usdc(v.sentOut!), sentToday: usdc(v.sentToday!), navBefore: usdc(v.navBefore!), tx: l.transactionHash } });
    } else if (l.eventName === "CoverStuckPaused") {
      const m = (l.args as { market: Hex }).market;
      emit({ name: "transfer-stuck", state: "event", level: "alarm", what: "A tokenized stock could not move during a sell, an unwrite or a claim: it is kept owed and settles once it moves; new positions on this market are paused (sells and USDC go on).", who: "admin: check the token issuer (pause, freeze or whitelist), then unpause once settled", market: b32name(m), values: { book: (l.args as { book: Address }).book, tx: l.transactionHash } });
    } else if (l.eventName === "TreasuryReturned") {
      emit({ name: "treasury-returned", state: "event", level: "warn", what: `${S.symbol} came back to the pool from the treasury.`, who: "treasury operator: confirm", market: null, values: { amount: usdc(v.amount!), receivedBack: usdc(v.receivedBack!), tx: l.transactionHash } });
    }
  }

  // ---- stock MARK rounds: splits (G9: pause opens at once) and out-of-session anchoring (information)
  const calendar = stocks.size > 0 ? await read<Address>(dep.pool, poolAbi, "sessionCalendar") : zeroAddress;
  if (stocks.size > 0 && fromBlock <= block.number) {
    const keys = new Map([...stocks].map((m) => [markKeyOf(m), m]));
    const fl = await client.getLogs({ address: dep.board, fromBlock, toBlock: block.number });
    for (const l of parseEventLogs({ abi: finalisedAbi, logs: fl, strict: false })) {
      const a = l.args as { key: Hex; median: bigint; published: bigint };
      const m = keys.get(a.key);
      if (!m) continue;
      const at = Number((await client.getBlock({ blockNumber: l.blockNumber })).timestamp);
      const inSession = calendar === zeroAddress ? true : await read<boolean>(calendar, calendarAbi, "isRegularSession", [BigInt(at)]);
      const kind = markRound(a.median, a.published, inSession);
      const values = { median: Number(formatEther(a.median)), published: Number(formatEther(a.published)), tx: l.transactionHash };
      if (kind === "split") {
        const r = splitRatio(a.median, a.published)!;
        await pauseOnce(dep, client, signer, read, m, {
          name: "split-mismatch",
          paused: "The signers' price moved by a split ratio: new positions on this market are paused until the change is reviewed (sells unaffected).",
          watch: "The signers' price moved by a split ratio; watch mode, so opens were NOT paused.",
          who: "admin: review the corporate action; the Safe unpauses once the mark is right",
          values: { ...values, ratio: r },
        });
      } else if (kind === "anchored") {
        emit({ name: "session-anchored", state: "event", level: "warn", what: "Outside the stock session the mark was held within its band of the last session value.", who: "nobody", market: m, values });
      }
    }
  }

  // ---- the open book and the risk auction (M6)
  const m6At = [dep.matchBook, dep.auction, dep.vault].filter((a): a is Address => a !== null);
  if (m6At.length > 0) {
    const m6Logs = fromBlock <= block.number ? await client.getLogs({ address: [dep.pool, ...m6At], fromBlock, toBlock: block.number }) : [];
    const events = parseEventLogs({ abi: m6Abi, logs: m6Logs, strict: false }).map((l) => ({ eventName: l.eventName, args: l.args as Record<string, unknown>, transactionHash: l.transactionHash }) as M6Event);
    for (const a of m6Alarms(events, lots, dep.settlement)) emit({ ...a, state: "event" });
    const due = settleDue(lots, now, cfg.t.auctionSettleGraceS);
    cond.set(due.length > 0, { name: "auction-settle-due", level: "alarm", what: "A risk auction lot's reveal ended and nobody has settled it: bonds stay locked and the pool keeps the risk.", who: "anyone (keeper operator): call settle on the lot", market: null, values: { lots: due.map((l) => ({ lotId: l.lotId, market: l.market, revealEnd: l.revealEnd })) } }, "Every finished auction lot is settled.");
  }

  // ---- governance and receipts (M7)
  if (dep.m7.timelock) {
    const at = [dep.m7.timelock, dep.pool, dep.board, dep.router, ...(dep.engine ? [dep.engine] : []), ...(dep.m7.receipts ? [dep.m7.receipts] : []), ...(dep.m7.gate ? [dep.m7.gate] : [])];
    const m7Logs = fromBlock <= block.number ? await client.getLogs({ address: at, fromBlock, toBlock: block.number }) : [];
    const ts = new Map<bigint, number>();
    const events: M7Event[] = [];
    for (const l of parseEventLogs({ abi: m7Abi, logs: m7Logs, strict: false })) {
      if (!ts.has(l.blockNumber)) ts.set(l.blockNumber, Number((await client.getBlock({ blockNumber: l.blockNumber })).timestamp));
      events.push({ eventName: l.eventName, args: l.args as Record<string, unknown>, address: getAddress(l.address), transactionHash: l.transactionHash, blockTimestamp: ts.get(l.blockNumber)! });
    }
    for (const a of m7Alarms(events, dep.m7)) emit({ ...a, state: "event" });
    if (dep.m7.receipts) {
      const receiptsAbi = [
        { type: "function", name: "anyPosted", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
        { type: "function", name: "lastEpoch", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
      ] as const;
      const [anyPosted, lastEpoch] = await Promise.all([read<boolean>(dep.m7.receipts, receiptsAbi, "anyPosted"), read<bigint>(dep.m7.receipts, receiptsAbi, "lastEpoch")]);
      const deployTs = Number((await client.getBlock({ blockNumber: dep.deployBlock })).timestamp);
      const age = receiptsAgeHours(anyPosted, Number(lastEpoch), deployTs, now);
      cond.set(age > cfg.t.receiptsStaleHours, { name: "receipts-stale", level: "alarm", what: "No receipt root has been posted for too long: trades, vol finals and NAV snapshots are not being committed.", who: "receipts operator", market: null, values: { hoursSinceLastRoot: Math.round(age * 10) / 10, lastEpoch: anyPosted ? Number(lastEpoch) : null } }, "Receipt roots are being posted again.");
    }
  }

  // ---- key watcher: every service key's gas balance, one condition per key
  if (cfg.keys.length > 0) {
    const balances = new Map<Address, bigint>();
    for (const k of cfg.keys) balances.set(k.address, await client.getBalance({ address: k.address }));
    const low = new Map(lowKeys(cfg.keys, balances).map((k) => [k.name, k]));
    for (const k of cfg.keys) {
      const l = low.get(k.name);
      cond.set(l !== undefined, { name: "key-balance-low", level: "warn", what: `The ${k.name} key is low on gas: its service stops when it runs dry.`, who: `${k.name} operator: top up the key`, market: k.name, values: { address: k.address, balance: l?.balance ?? null, min: l?.min ?? null } }, `The ${k.name} key has enough gas again.`);
    }
  }

  // ---- pool-wide risk state
  const [available, stressed, opensPaused, sentOut, receivedBack, round] = await Promise.all([
    read<bigint>(dep.pool, poolAbi, "available"),
    read<bigint>(dep.pool, poolAbi, "stressedLiability"),
    read<boolean>(dep.pool, poolAbi, "opensPaused"),
    read<bigint>(dep.pool, poolAbi, "sentOut"),
    read<bigint>(dep.pool, poolAbi, "receivedBack"),
    read<bigint>(dep.pool, poolAbi, "round"),
  ]);
  const cov = coverageState(usdc(available), usdc(stressed), cfg.t);
  const covValues = { available: usdc(available), stressedLiability: usdc(stressed) };
  cond.set(cov === "breached", { name: "coverage-breached", level: "alarm", what: `Available ${S.symbol} no longer covers the stressed liability: new opens are refused on-chain; sells beyond the stress band could fail (Insolvent).`, who: "admin: add capital or bring capital back from the exchange", market: null, values: covValues }, "Coverage restored.");
  cond.set(cov === "low", { name: "coverage-low", level: "warn", what: `Free ${S.symbol} above the stressed liability is under the headroom threshold.`, who: "admin: watch; consider adding capital", market: null, values: covValues }, "Coverage headroom back above the threshold.");
  cond.set(opensPaused, { name: "drawdown-paused", level: "alarm", what: "NAV per share fell more than 15% below its 30-day high: all opens are paused.", who: "admin: review, then resume opens", market: null, values: {} }, "Opens resumed.");
  if (round > 0n) {
    const r = await read<readonly unknown[]>(dep.pool, poolAbi, "rounds", [round - 1n]);
    const age = now - Number(r[9] as bigint);
    cond.set(age > cfg.t.settlementAgeS, { name: "settlement-stale", level: "alarm", what: "The pool has not settled a round for too long: deposits and withdrawals wait.", who: "keeper operator", market: null, values: { lastSettlementAgeS: age } }, "Settlements running again.");
  }

  // ---- the crypto hedge exchange (crypto markets) and the hedgers' status files (both venues)
  let exMarks: Map<string, number | null> | null = null;
  if (ex) {
    try {
      const mk = await ex.markets();
      exMarks = new Map(dep.markets.filter((m) => !stocks.has(m)).map((m) => [m, mk.get(m)?.mark ?? null]));
    } catch {
      exMarks = new Map(dep.markets.filter((m) => !stocks.has(m)).map((m) => [m, null]));
    }
  }
  let hedger: Record<string, HedgerMarket> | null = null;
  for (const file of cfg.hedgerStatus) {
    if (!existsSync(file)) continue;
    const st = JSON.parse(readFileSync(file, "utf8")) as { updatedAt: string; venue?: string; markets: Record<string, HedgerMarket> };
    const age = (Date.now() - Date.parse(st.updatedAt)) / 1000;
    const silent = age > cfg.t.hedgerSilentS;
    cond.set(silent, { name: "hedger-silent", level: "alarm", what: "A hedger has not reported for too long.", who: "hedger operator", market: st.venue ?? null, values: { statusAgeS: Math.round(age) } }, "The hedger is reporting again.", file);
    if (!silent) hedger = { ...(hedger ?? {}), ...st.markets };
  }

  // ---- per market
  for (const m of dep.markets) {
    const name = b32(m);
    let routerMark: number | null = null;
    let volOk = true;
    try {
      routerMark = Number(formatEther(await read<bigint>(dep.router, viewAbi, "markWad", [name])));
    } catch {
      routerMark = null;
    }
    try {
      await read<bigint>(dep.board, viewAbi, "volBps", [name]);
    } catch {
      volOk = false;
    }
    cond.set(routerMark === null || !volOk, { name: "mark-stale", level: "alarm", what: "The router's mark or the board's vol is stale: opens on this market are closed (law 2).", who: "signer operators", market: m, values: { markFresh: routerMark !== null, volFresh: volOk } }, "Mark and vol fresh again.");

    try {
      const [t] = await read<readonly [bigint, bigint, bigint]>(dep.book, viewAbi, "latestSample", [name]);
      const age = now - Number(t);
      cond.set(age > cfg.t.sampleAgeS, { name: "sample-stale", level: "alarm", what: "No price sample recorded for too long: funding runs on an old sample.", who: "keeper operator (poker)", market: m, values: { lastSampleAgeS: age } }, "Samples recorded again.");
    } catch {
      // no sample yet on this market
    }

    const [nCap, nUse, dCap, dUse] = await Promise.all(
      ["notionalCap", "openNotional", "directionalCap", "directional"].map((f) => read<bigint>(dep.pool, poolAbi, f, [name])),
    );
    const high = capHigh(usdc(nUse!), usdc(nCap!), cfg.t) || capHigh(usdc(dUse!), usdc(dCap!), cfg.t);
    if (stocks.has(m) && calendar !== zeroAddress) {
      const bps = Number(await read<bigint>(calendar, calendarAbi, "openCapBps", [name]));
      const qHigh = quarterCapHigh(usdc(nUse!), usdc(nCap!), bps, cfg.t.capUse) || quarterCapHigh(usdc(dUse!), usdc(dCap!), bps, cfg.t.capUse);
      cond.set(qHigh, { name: "quarter-cap-high", level: "warn", what: "The US stock session is closed today (the equity reference is shut; the token itself still trades), so open caps are a quarter: one is nearly used up.", who: "nobody before the next session; admin if it persists", market: m, values: { capShareBps: bps, notional: usdc(nUse!), directional: usdc(dUse!) } }, "Use back below the reduced cap, or the session reopened.");
      const h = hedger?.[m];
      const mismatch = h?.ok === true && typeof h.held === "number" && typeof h.target === "number" && typeof h.band === "number" && inventoryMismatch(h.held, h.target, h.band);
      cond.set(mismatch, { name: "inventory-mismatch", level: "warn", what: "The pool's tokenized-stock holding is off the on-chain hedge's target by more than twice the band.", who: "hedger operator: check the router, the caps and free USDC", market: m, values: { held: h?.held ?? null, target: h?.target ?? null, band: h?.band ?? null } }, "The holding is back near its target.");
    }
    cond.set(high, { name: "cap-high", level: "warn", what: "A cap is nearly used up on this market.", who: "admin: decide whether to raise the cap", market: m, values: { notional: usdc(nUse!), notionalCap: usdc(nCap!), directional: usdc(dUse!), directionalCap: usdc(dCap!) } }, "Cap use back below the threshold.");

    // venue outage: the exchange for a crypto market, hedger-onchain (swaps, router) for a stock market
    const exDown = exMarks !== null && exMarks.has(m) && exchangeMarketDown(exMarks.get(m) ?? null, routerMark, cfg.t);
    const hedgerDown = hedger !== null && hedger[m]?.ok === false;
    const ev = outage.update(m, exDown || hedgerDown, Date.now());
    const downMs = outage.downFor(m, Date.now());
    const venue = stocks.has(m) ? "onchain" : "cex";
    cond.set(downMs >= cfg.outageMs * DOWN_WARN_SHARE, { name: venue === "onchain" ? "dex-down" : "cex-down", level: "warn", what: venue === "onchain" ? "The on-chain stock hedge cannot trade on this market (no router, or swaps failing)." : "The crypto hedge exchange is down or disagrees with the router on this market.", who: "hedger operator", market: m, values: { downMinutes: Math.round(downMs / 6_000) / 10, exchange: exDown, hedger: hedgerDown } }, "The venue answers again on this market.");
    if (ev === "trip") {
      const values = { downMinutes: downMs / 60_000, venue, exchange: exDown, hedger: hedgerDown };
      await pauseOnce(dep, client, signer, read, m, {
        name: "venue-down-paused",
        paused: "Venue down for 15 minutes on this market: opens paused here (sells unaffected).",
        watch: "Venue down for 15 minutes; watch mode, so opens were NOT paused.",
        who: "nobody: automatic pause done; admin unpauses after recovery",
        values,
      });
    } else if (ev === "recovered") {
      emit({ name: "venue-recovered", state: "event", level: "warn", what: "The venue is healthy again on this market.", who: "admin: unpause opens when satisfied (the risk key cannot)", market: m, values: {} });
    }
  }

  // ---- hourly equity check
  if (ex && equityDue()) {
    const ready = await read<boolean>(dep.pool, poolAbi, "equityReady");
    const outside = sentOut > receivedBack;
    cond.set(!ready && outside, { name: "equity-not-ready", level: "alarm", what: "Capital is at the crypto hedge exchange but EQUITY is not ready (fewer than two finals or 2 h old): NAV leaves it uncounted.", who: "signer operators", market: null, values: { sentOut: usdc(sentOut), receivedBack: usdc(receivedBack) } }, "EQUITY ready again.");
    try {
      const key = await read<`0x${string}`>(dep.pool, poolAbi, "equityKey");
      const [boardValue] = await read<readonly [bigint, bigint]>(dep.board, viewAbi, "latestValue", [key]);
      const [av, { deposits, withdrawalsNet }] = await Promise.all([ex.accountValue(), ex.transfers()]);
      const own = Number(formatEther(av - deposits + withdrawalsNet));
      const board = Number(formatEther(boardValue - EQUITY_OFFSET));
      const accountValue = Number(formatEther(av));
      cond.set(equityMismatch(board, own, accountValue, cfg.t), { name: "equity-mismatch", level: "alarm", what: "The board's EQUITY differs from the exchange account by more than the tolerance.", who: "signer operators and admin: check the signers' EQUITY job and the account", market: null, values: { boardPnl: board, exchangePnl: own, accountValue } }, "EQUITY agrees with the exchange again.");
    } catch {
      // no EQUITY final yet, or the exchange unreachable (raised by the venue checks)
    }
  }
  return block.number + 1n;
}

type HedgerMarket = { ok: boolean; held?: number; target?: number; band?: number };

const b32name = (h: Hex) => Buffer.from(h.slice(2), "hex").toString("utf8").replace(/\0+$/, "");

/// Pauses opens on one market with the pause-only key, once (already paused: nothing), and announces it. Watch mode
/// announces without pausing; a failed pause is its own red alarm.
async function pauseOnce(
  dep: Dep,
  client: PublicClient,
  signer: Signer,
  read: <T>(address: Address, abi: readonly unknown[], functionName: string, args?: readonly unknown[]) => Promise<T>,
  m: string,
  a: { name: AlarmName; paused: string; watch: string; who: string; values: Record<string, unknown> },
): Promise<void> {
  const name = stringToHex(m, { size: 32 });
  if (await read<boolean>(dep.pool, poolAbi, "marketPaused", [name])) return;
  if (!signer.wallet || !signer.account) {
    emit({ name: a.name, state: "event", level: "alarm", what: a.watch, who: "admin: pause opens on this market", market: m, values: a.values });
    return;
  }
  try {
    const call = { address: dep.pool, abi: poolAbi, functionName: "pauseMarket", args: [name], account: signer.account, maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: 0n } as const;
    const gas = await client.estimateContractGas(call);
    const hash = await signer.wallet.writeContract({ ...call, chain: signer.wallet.chain, gas: withHeadroom(gas) });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
    if (receipt.status !== "success") throw new Error("pauseMarket reverted");
    emit({ name: a.name, state: "event", level: "alarm", what: a.paused, who: a.who, market: m, values: { ...a.values, tx: hash } });
  } catch (e) {
    emit({ name: "pause-failed", state: "event", level: "alarm", what: `${a.name}: pausing opens failed.`, who: "admin: pause opens on this market now", market: m, values: { ...a.values, error: (e as Error).message.split("\n")[0] } });
  }
}

main().catch((e) => {
  log("error", "fatal", { error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
  process.exit(1);
});
