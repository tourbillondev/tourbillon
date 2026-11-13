import { createPublicClient, createWalletClient, getAddress, http, maxUint256, parseEther, parseUnits, stringToHex, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { chainFor, LOCAL_CHAIN_ID } from "@tourbillon/common/chain.ts";
import { log } from "@tourbillon/common/log.ts";
import { loadM6Deployment, sourcesAbi, vaultAbi, type M6Deployment } from "./chain.ts";
import { domainFor, quoteTypes, SIDE_BOTH, MIN_SIGMA_BPS, MAX_SIGMA_BPS, toJson, type Quote } from "./quote.ts";

/// A reference maker bot for the local run (LOCAL ONLY, anvil 31337). It quotes one market around the board's vol and
/// posts each quote to the gateway. It signs through the node's unlocked account (eth_signTypedData_v4), so no private
/// key appears anywhere. With --fund it first mints mock USDC to itself and deposits it in its MakerVault.
///   bun src/bot.ts --deployment <m6.json> --maker <anvil account> --market BTC [--rpc <url>] [--gateway <url>]
///     [--sigma-offset-bps -300] [--max-units 50] [--ttl-seconds 600] [--every-seconds 60] [--fund 100000] [--once]

export type BotParams = {
  maker: Address;
  market: string;
  sigmaOffsetBps: number; // added to the board's σ (negative: quotes under the board)
  maxUnits: bigint; // WAD
  ttlSeconds: number;
  bandPct: number; // strike band ± this share of the mark
};

/// The quote the bot signs: σ = board + offset inside the maths bounds; strikes mark × (1 ± band); every tempo the book
/// takes (1 hour to 30 days); calls and puts (a maker's side must still be bounded to fill: law 4).
export function buildQuote(p: BotParams, markWad: bigint, boardBps: bigint, now: bigint, nonce: bigint): Quote {
  let sigma = boardBps + BigInt(p.sigmaOffsetBps);
  if (sigma < MIN_SIGMA_BPS) sigma = MIN_SIGMA_BPS;
  if (sigma > MAX_SIGMA_BPS) sigma = MAX_SIGMA_BPS;
  const band = BigInt(Math.round(p.bandPct * 10_000));
  return {
    maker: p.maker,
    name: stringToHex(p.market, { size: 32 }),
    sides: SIDE_BOTH,
    kLoWad: (markWad * (10_000n - band)) / 10_000n,
    kHiWad: (markWad * (10_000n + band)) / 10_000n,
    tauLo: 3_600,
    tauHi: 30 * 86_400,
    sigmaBps: sigma,
    maxUnits: p.maxUnits,
    validUntil: now + BigInt(p.ttlSeconds),
    nonce,
  };
}

/// Signs a quote with the node's unlocked account (eth_signTypedData_v4).
export function signQuote(wallet: WalletClient, d: M6Deployment, q: Quote): Promise<Hex> {
  return wallet.signTypedData({ account: q.maker, domain: domainFor(d.chainId, d.quoteBook), types: quoteTypes, primaryType: "Quote", message: q });
}

const mintAbi = [
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

/// Local only: mints mock USDC to the maker and deposits it in the vault.
export async function fund(client: PublicClient, wallet: WalletClient, d: M6Deployment, maker: Address, usdc: bigint): Promise<void> {
  const send = async (address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]) => {
    const hash = await wallet.writeContract({ address, abi, functionName, args, account: maker, chain: wallet.chain } as never);
    const r = await client.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} reverted`);
  };
  await send(d.usdc, mintAbi, "mint", [maker, usdc]);
  await send(d.usdc, mintAbi, "approve", [d.vault, maxUint256]);
  await send(d.vault, vaultAbi, "deposit", [d.usdc, usdc]);
}

/// One round: read the mark and the board, sign a fresh quote, post it. Returns the quote, or null when the market is
/// stale (no quote: nothing would fill anyway, law 2).
export async function quoteOnce(client: PublicClient, wallet: WalletClient, d: M6Deployment, p: BotParams, gateway: string, nonce: bigint): Promise<Quote | null> {
  const name = stringToHex(p.market, { size: 32 });
  let mark: bigint;
  let board: bigint;
  try {
    [mark, board] = await Promise.all([
      client.readContract({ address: d.router, abi: sourcesAbi, functionName: "markWad", args: [name] }),
      client.readContract({ address: d.board, abi: sourcesAbi, functionName: "volBps", args: [name] }),
    ]);
  } catch {
    log("warn", "mark or board stale: no quote this round", { market: p.market });
    return null;
  }
  const now = (await client.getBlock()).timestamp;
  const q = buildQuote(p, mark, board, now, nonce);
  const sig = await signQuote(wallet, d, q);
  const res = await fetch(new URL("/quotes", gateway), { method: "POST", headers: { "content-type": "application/json" }, body: toJson({ quote: q, sig }) });
  const body = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(`the gateway refused the quote: ${body.error}`);
  log("info", "quoted", { market: p.market, sigmaBps: q.sigmaBps, boardBps: board, nonce, validUntil: q.validUntil });
  return q;
}

function parseArgs(argv: string[]) {
  const a = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (!k.startsWith("--")) throw new Error(`unexpected argument ${k}`);
    if (k === "--once") a.set("once", true);
    else {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${k} needs a value`);
      a.set(k.slice(2), v);
    }
  }
  const known = ["deployment", "rpc", "gateway", "maker", "market", "sigma-offset-bps", "max-units", "ttl-seconds", "every-seconds", "fund", "band-pct", "once"];
  for (const k of a.keys()) if (!known.includes(k)) throw new Error(`unknown flag --${k}`);
  const s = (k: string) => (typeof a.get(k) === "string" ? (a.get(k) as string) : undefined);
  for (const k of ["deployment", "maker", "market"]) if (!s(k)) throw new Error(`--${k} is required`);
  return {
    deployment: s("deployment")!,
    rpc: s("rpc"),
    gateway: s("gateway") ?? "http://127.0.0.1:8547",
    everySeconds: Math.max(1, Number(s("every-seconds") ?? 60)),
    fund: s("fund") ? parseUnits(s("fund")!, 6) : 0n,
    once: a.has("once"),
    p: {
      maker: getAddress(s("maker")!),
      market: s("market")!,
      sigmaOffsetBps: Number(s("sigma-offset-bps") ?? -300),
      maxUnits: parseEther(s("max-units") ?? "50"),
      ttlSeconds: Number(s("ttl-seconds") ?? 600),
      bandPct: Number(s("band-pct") ?? 0.3),
    } satisfies BotParams,
  };
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  const d = loadM6Deployment(cfg.deployment);
  if (d.chainId !== LOCAL_CHAIN_ID) throw new Error("the reference maker bot runs only on a local anvil (31337)");
  const chain = chainFor(d.chainId);
  const client = createPublicClient({ chain, transport: http(cfg.rpc) }) as PublicClient;
  if ((await client.getChainId()) !== LOCAL_CHAIN_ID) throw new Error("the RPC is not a local anvil (31337)");
  const wallet = createWalletClient({ chain, transport: http(cfg.rpc), account: cfg.p.maker });
  if (cfg.fund > 0n) {
    await fund(client, wallet, d, cfg.p.maker, cfg.fund);
    log("info", "funded the vault", { maker: cfg.p.maker, usdc: cfg.fund });
  }
  let nonce = BigInt(Date.now());
  let stopping = false;
  process.on("SIGINT", () => (stopping = true));
  process.on("SIGTERM", () => (stopping = true));
  while (!stopping) {
    try {
      await quoteOnce(client, wallet, d, cfg.p, cfg.gateway, nonce++);
    } catch (e) {
      log("error", "round failed", { error: (e as Error).message.split("\n")[0] });
    }
    if (cfg.once) break;
    for (let i = 0; i < cfg.everySeconds && !stopping; i++) await Bun.sleep(1000);
  }
  log("info", "stopped");
}

if (import.meta.main) {
  main().catch((e) => {
    log("error", "fatal", { error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    process.exit(1);
  });
}
