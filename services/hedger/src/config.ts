import { getAddress, type Address } from "viem";
import { LOCAL_CHAIN_ID } from "@tourbillon/common/chain.ts";

export const TICK_SECONDS = 30;
/// Delta caps in USD (owner default): directional cap ÷ (2 × shock), rounded up; the pool holds the same values
/// on-chain (hedgerDeltaCap) and refuses a directional cap above delta cap × 2 × shock. The hard position limit equals
/// the cap.
export const DEFAULT_DELTA_CAP_USD: Record<string, number> = { BTC: 2_500_000, ETH: 1_200_000, HYPE: 357_143 };
/// Skip a market when Hyperliquid's mark and the router's mark differ by more than this.
export const MAX_MARK_MISMATCH = 0.01;

export type Config = {
  deployment: string;
  rpc?: string;
  hlUser?: Address; // the pool's Hyperliquid account (positions read from the public info API)
  positions?: Map<string, number>; // fixed positions instead (tests)
  hlApi?: string; // anvil only
  deltaCapUsd: Record<string, number>;
  once: boolean;
  venue: "none" | "sim" | "hl-testnet"; // none = dry run (default)
  venueUrl?: string; // sim: the simulated venue's local URL
  agentKeystore?: string; // hl-testnet: the agent (API wallet) keystore account
  testnetOrdersApproved: boolean;
  tickSeconds: number;
  statusFile?: string; // per-pass hedging status for the risk-monitor (same server)
};

const USAGE = `usage: bun src/main.ts --deployment <file-m3.json> (--hl-user <address> | --positions BTC=0,ETH=0) [--rpc <url>]
                [--delta-cap BTC=2500000,...] [--hl-api <url>] [--once]
                [--venue sim --venue-url <local url>]                  orders to a local simulated venue
                [--venue hl-testnet --agent-keystore <name> --testnet-orders-approved]   step 12 only, with the owner's yes
Without --venue: dry run (plans and "would send" lines only). Mainnet orders are never possible.`;

export function parseArgs(argv: string[]): Config {
  const a = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (!k.startsWith("--")) throw new Error(`unexpected argument ${k}\n${USAGE}`);
    const flag = k.slice(2);
    if (flag === "once" || flag === "dry-run" || flag === "testnet-orders-approved") a.set(flag, true);
    else {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`--${flag} needs a value\n${USAGE}`);
      a.set(flag, v);
    }
  }
  const known = new Set(["deployment", "rpc", "hl-user", "positions", "hl-api", "delta-cap", "once", "dry-run", "venue", "venue-url", "agent-keystore", "testnet-orders-approved", "tick-seconds", "status-file"]);
  for (const k of a.keys()) if (!known.has(k)) throw new Error(`unknown flag --${k}\n${USAGE}`);
  const str = (k: string) => (typeof a.get(k) === "string" ? (a.get(k) as string) : undefined);
  const deployment = str("deployment");
  if (!deployment) throw new Error(`--deployment is required\n${USAGE}`);
  if ((str("hl-user") === undefined) === (str("positions") === undefined)) throw new Error(`give exactly one of --hl-user, --positions\n${USAGE}`);
  const kv = (s: string) => new Map(s.split(",").map((x) => {
    const [m, v] = x.split("=");
    if (!m || v === undefined || !Number.isFinite(Number(v))) throw new Error(`bad MARKET=value: ${x}`);
    return [m, Number(v)] as const;
  }));
  const venue = (str("venue") ?? "none") as Config["venue"];
  if (!["none", "sim", "hl-testnet"].includes(venue)) throw new Error("--venue is sim or hl-testnet");
  const cfg: Config = {
    deployment,
    rpc: str("rpc"),
    hlApi: str("hl-api"),
    deltaCapUsd: { ...DEFAULT_DELTA_CAP_USD },
    once: a.has("once"),
    venue,
    venueUrl: str("venue-url"),
    agentKeystore: str("agent-keystore"),
    testnetOrdersApproved: a.has("testnet-orders-approved"),
    tickSeconds: Math.max(1, Number(str("tick-seconds") ?? TICK_SECONDS)),
    statusFile: str("status-file"),
  };
  if (venue === "sim" && !cfg.venueUrl) throw new Error("--venue sim needs --venue-url");
  if (venue === "hl-testnet" && (!cfg.agentKeystore || !cfg.testnetOrdersApproved)) {
    throw new Error("--venue hl-testnet needs --agent-keystore and --testnet-orders-approved (M3 step 12, owner's yes only)");
  }
  if (venue !== "none" && str("positions")) throw new Error("--positions is for dry runs; with a venue, positions come from it");
  if (str("hl-user")) cfg.hlUser = getAddress(str("hl-user")!);
  if (str("positions")) cfg.positions = kv(str("positions")!);
  if (str("delta-cap")) for (const [m, v] of kv(str("delta-cap")!)) cfg.deltaCapUsd[m] = v;
  return cfg;
}

export function checkForChain(cfg: Config, chainId: number): void {
  if (cfg.hlApi && chainId !== LOCAL_CHAIN_ID) throw new Error("--hl-api works only on a local anvil (31337)");
  if (cfg.venue === "sim" && chainId !== LOCAL_CHAIN_ID) throw new Error("--venue sim works only on a local anvil (31337)");
}
