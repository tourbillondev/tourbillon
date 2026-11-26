import { getAddress, type Address } from "viem";
import { LOCAL_CHAIN_ID } from "@tourbillon/common/chain.ts";
import type { KeyInput } from "@tourbillon/common/signer.ts";

/// The two hedgers (Backend §6, §7): `cex.ts` (hedger-cex) for crypto markets at the crypto hedge exchange, and
/// `onchain.ts` (hedger-onchain) for stock markets on Robinhood Chain liquidity through the pool's hedgeSwap. A market
/// is a stock market when the pool's covering-asset table lists a token for it.

export const TICK_SECONDS = 30;
/// Delta caps in USD (owner default): directional cap ÷ (2 × shock), rounded up; the pool holds the same values
/// on-chain (hedgerDeltaCap) and refuses a directional cap above delta cap × 2 × shock. The hard position limit equals
/// the cap.
export const DEFAULT_DELTA_CAP_USD: Record<string, number> = { BTC: 2_500_000, ETH: 1_200_000, STK1: 625_000 }; // STK1: the placeholder stock's deploy value (owner queue Q13)
/// Skip a crypto market when the exchange's mark and the router's mark differ by more than this.
export const MAX_MARK_MISMATCH = 0.01;

type Common = {
  deployment: string;
  rpc?: string;
  deltaCapUsd: Record<string, number>;
  once: boolean;
  tickSeconds: number;
  statusFile?: string; // per-pass hedging status for the risk-monitor (same server)
};

export type CexConfig = Common & {
  exchange?: string; // the crypto hedge exchange; "sim" on anvil; any other name is refused until Q5
  exchangeUrl?: string; // sim only
  positions?: Map<string, number>; // fixed positions for a dry run without an exchange (tests)
  dryRun: boolean; // plans and "would send" lines only
};

export type OnchainConfig = Common & {
  key?: KeyInput; // the keeper key (HEDGER_ROLE); absent = dry run
  dryRun: boolean;
  slippageBps: number; // the hedger's own bound, at most the pool's
};

const CEX_USAGE = `usage: bun src/cex.ts --deployment <file> (--exchange sim --exchange-url <local url> | --positions BTC=0,ETH=0)
                [--rpc <url>] [--delta-cap BTC=2500000,...] [--dry-run] [--once] [--tick-seconds N] [--status-file <path>]
Without an exchange, or with --dry-run: plans and "would send" lines only. Only the local simulated exchange exists until
the owner picks the exchange (Q5).`;

const ONCHAIN_USAGE = `usage: bun src/onchain.ts --deployment <file> (--keystore <name> [--keystore-dir <dir>] | --local-unlocked <addr> | --dry-run)
                [--rpc <url>] [--delta-cap STK1=625000,...] [--slippage-bps 50] [--once] [--tick-seconds N] [--status-file <path>]
Without a key, or with --dry-run: plans and "would send" lines only.`;

function flags(argv: string[], bools: string[], known: string[], usage: string): Map<string, string | true> {
  const a = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (!k.startsWith("--")) throw new Error(`unexpected argument ${k}\n${usage}`);
    const flag = k.slice(2);
    if (bools.includes(flag)) a.set(flag, true);
    else {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`--${flag} needs a value\n${usage}`);
      a.set(flag, v);
    }
  }
  for (const k of a.keys()) if (!known.includes(k) && !bools.includes(k)) throw new Error(`unknown flag --${k}\n${usage}`);
  return a;
}

function kv(s: string): Map<string, number> {
  return new Map(
    s.split(",").map((x) => {
      const [m, v] = x.split("=");
      if (!m || v === undefined || !Number.isFinite(Number(v))) throw new Error(`bad MARKET=value: ${x}`);
      return [m, Number(v)] as const;
    }),
  );
}

function common(a: Map<string, string | true>, usage: string): Common {
  const str = (k: string) => (typeof a.get(k) === "string" ? (a.get(k) as string) : undefined);
  const deployment = str("deployment");
  if (!deployment) throw new Error(`--deployment is required\n${usage}`);
  const c: Common = {
    deployment,
    rpc: str("rpc"),
    deltaCapUsd: { ...DEFAULT_DELTA_CAP_USD },
    once: a.has("once"),
    tickSeconds: Math.max(1, Number(str("tick-seconds") ?? TICK_SECONDS)),
    statusFile: str("status-file"),
  };
  if (str("delta-cap")) for (const [m, v] of kv(str("delta-cap")!)) c.deltaCapUsd[m] = v;
  return c;
}

const COMMON_FLAGS = ["deployment", "rpc", "delta-cap", "tick-seconds", "status-file"];

export function parseCexArgs(argv: string[]): CexConfig {
  const a = flags(argv, ["once", "dry-run"], [...COMMON_FLAGS, "exchange", "exchange-url", "positions"], CEX_USAGE);
  const str = (k: string) => (typeof a.get(k) === "string" ? (a.get(k) as string) : undefined);
  const cfg: CexConfig = { ...common(a, CEX_USAGE), exchange: str("exchange"), exchangeUrl: str("exchange-url"), dryRun: a.has("dry-run") };
  if ((cfg.exchange === undefined) === (str("positions") === undefined)) throw new Error(`give exactly one of --exchange, --positions\n${CEX_USAGE}`);
  if (str("positions")) {
    cfg.positions = kv(str("positions")!);
    cfg.dryRun = true;
  }
  if (cfg.exchange === "sim" && !cfg.exchangeUrl) throw new Error("--exchange sim needs --exchange-url");
  return cfg;
}

export function parseOnchainArgs(argv: string[]): OnchainConfig {
  const a = flags(argv, ["once", "dry-run"], [...COMMON_FLAGS, "keystore", "keystore-dir", "local-unlocked", "slippage-bps"], ONCHAIN_USAGE);
  const str = (k: string) => (typeof a.get(k) === "string" ? (a.get(k) as string) : undefined);
  const keys = ["keystore", "local-unlocked"].filter((k) => a.has(k));
  if (keys.length > 1) throw new Error(`give at most one of --keystore, --local-unlocked\n${ONCHAIN_USAGE}`);
  const slippageBps = Number(str("slippage-bps") ?? 50);
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 300) throw new Error("--slippage-bps is 0 to 300");
  const cfg: OnchainConfig = { ...common(a, ONCHAIN_USAGE), dryRun: a.has("dry-run") || keys.length === 0, slippageBps };
  if (a.has("keystore")) cfg.key = { type: "keystore", name: str("keystore")!, dir: str("keystore-dir") };
  if (a.has("local-unlocked")) cfg.key = { type: "local-unlocked", address: getAddress(str("local-unlocked")!) };
  return cfg;
}

export function checkCexForChain(cfg: CexConfig, chainId: number): void {
  if (cfg.exchange === "sim" && chainId !== LOCAL_CHAIN_ID) throw new Error("--exchange sim works only on a local anvil (31337)");
}

export function checkOnchainForChain(cfg: OnchainConfig, chainId: number): void {
  if (cfg.key?.type === "local-unlocked" && chainId !== LOCAL_CHAIN_ID) throw new Error("--local-unlocked works only on a local anvil (31337)");
}

export type Dep = { chainId: number; router: Address; board: Address; pool: Address; book: Address; markets: string[]; gate: Address | null };
