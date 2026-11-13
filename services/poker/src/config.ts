import { getAddress } from "viem";
import { LOCAL_CHAIN_ID } from "@tourbillon/common/chain.ts";
import type { KeyInput } from "@tourbillon/common/signer.ts";
import type { Role } from "./poke.ts";

export const TICK_SECONDS = 20;

export type Config = { deployment: string; rpc?: string; key: KeyInput; role: Role; dryRun: boolean; once: boolean };

const USAGE = `usage: bun src/main.ts --deployment <file-m2.json> (--keystore <name> [--keystore-dir <dir>] | --local-unlocked <addr> | --watch <addr>)
                [--rpc <url>] [--role primary|backup] [--dry-run] [--once]`;

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
  const known = new Set(["deployment", "rpc", "keystore", "keystore-dir", "local-unlocked", "watch", "role", "dry-run", "once"]);
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
  const role = (str("role") ?? "primary") as Role;
  if (role !== "primary" && role !== "backup") throw new Error("--role is primary or backup");
  return { deployment, rpc: str("rpc"), key, role, dryRun, once: a.has("once") };
}

export function checkForChain(cfg: Config, chainId: number): void {
  if (cfg.key.type === "local-unlocked" && chainId !== LOCAL_CHAIN_ID) {
    throw new Error("--local-unlocked works only on a local anvil (31337)");
  }
}
