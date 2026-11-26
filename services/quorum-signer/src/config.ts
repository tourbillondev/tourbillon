import { getAddress, parseEther, type Address } from "viem";
import { LOCAL_CHAIN_ID } from "@tourbillon/common/chain.ts";
import type { KeyInput } from "@tourbillon/common/signer.ts";

export const TICK_SECONDS = 20;

export type Config = {
  deployment: string;
  rpc?: string;
  key: KeyInput;
  dryRun: boolean;
  once: boolean;
  feeds?: string; // the signer's feeds file (feedsConfig.ts); needed unless test marks are given
  testMarks?: Map<string, bigint>; // anvil only
  testVol?: bigint; // anvil only
  equityPool?: Address; // MainspringPool whose EQUITY key this signer votes
  exchange?: string; // the crypto hedge exchange holding that pool's account (read-only key); "sim" on anvil (Q5)
  exchangeUrl?: string; // sim only: the local simulated exchange
};

const USAGE = `usage: bun src/main.ts --deployment <file> (--keystore <name> [--keystore-dir <dir>] | --local-unlocked <addr> | --watch <addr>)
                (--feeds <file.json> | --test-marks STK1=400,BTC=100000 [--test-vol 0.5])
                [--rpc <url>] [--dry-run] [--once]
                [--equity-pool <pool> --exchange sim --exchange-url <local url>]`;

export function parseArgs(argv: string[]): Config {
  const a = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (!k.startsWith("--")) throw new Error(`unexpected argument ${k}\n${USAGE}`);
    const flag = k.slice(2);
    if (flag === "dry-run" || flag === "once") a.set(flag, true);
    else {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`--${flag} needs a value\n${USAGE}`);
      a.set(flag, v);
    }
  }
  const known = new Set(["deployment", "rpc", "keystore", "keystore-dir", "local-unlocked", "watch", "dry-run", "once", "feeds", "test-marks", "test-vol", "equity-pool", "exchange", "exchange-url"]);
  for (const k of a.keys()) if (!known.has(k)) throw new Error(`unknown flag --${k}\n${USAGE}`);

  const str = (k: string) => (typeof a.get(k) === "string" ? (a.get(k) as string) : undefined);
  const deployment = str("deployment");
  if (!deployment) throw new Error(`--deployment is required\n${USAGE}`);

  const inputs = ["keystore", "local-unlocked", "watch"].filter((k) => a.has(k));
  if (inputs.length !== 1) throw new Error(`give exactly one of --keystore, --local-unlocked, --watch\n${USAGE}`);
  let key: KeyInput;
  if (a.has("keystore")) key = { type: "keystore", name: str("keystore")!, dir: str("keystore-dir") };
  else if (a.has("local-unlocked")) key = { type: "local-unlocked", address: getAddress(str("local-unlocked")!) };
  else key = { type: "watch", address: getAddress(str("watch")!) };

  const dryRun = a.has("dry-run");
  if (key.type === "watch" && !dryRun) throw new Error("--watch is for --dry-run only");

  const cfg: Config = { deployment, rpc: str("rpc"), key, dryRun, once: a.has("once"), feeds: str("feeds") };
  const marks = str("test-marks");
  if (marks) {
    cfg.testMarks = new Map(
      marks.split(",").map((kv) => {
        const [m, v] = kv.split("=");
        if (!m || !v) throw new Error("--test-marks: MARKET=price,...");
        return [m, parseEther(v)];
      }),
    );
  }
  const vol = str("test-vol");
  if (vol) cfg.testVol = parseEther(vol);
  const pool = str("equity-pool");
  const exchange = str("exchange");
  if ((pool === undefined) !== (exchange === undefined)) throw new Error("--equity-pool and --exchange go together");
  if (pool && exchange) {
    cfg.equityPool = getAddress(pool);
    cfg.exchange = exchange;
    cfg.exchangeUrl = str("exchange-url");
  }
  if (!cfg.feeds && !cfg.testMarks) throw new Error(`--feeds is required (test marks are for a local anvil only)\n${USAGE}`);
  if (cfg.feeds && cfg.testMarks) throw new Error("give --feeds or --test-marks, not both");
  return cfg;
}

/// Checks that need the chain id (known once the RPC has answered).
export function checkForChain(cfg: Config, chainId: number): void {
  const local = chainId === LOCAL_CHAIN_ID;
  if (cfg.key.type === "local-unlocked" && !local) throw new Error("--local-unlocked works only on a local anvil (31337)");
  if ((cfg.testMarks || cfg.testVol !== undefined) && !local) throw new Error("test values work only on a local anvil (31337)");
  if (cfg.exchange === "sim" && !local) throw new Error("--exchange sim works only on a local anvil (31337)");
}
