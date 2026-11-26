import { readFileSync, writeFileSync } from "node:fs";
import { checkManifest } from "../src/live/manifest.mjs";

/// The live site's deployment manifest from a deployment file (contracts/deployments/<chainId>-m7.json): the chain,
/// its RPC, the API, the explorer and the addresses the site calls, checked by the same rules the site applies when it
/// loads it. Serve the output as /deployment.json next to the built site. Mainnet is refused (the owner's yes first).
///   bun scripts/manifest.ts --deployment <m7.json> --rpc <url> --api <url> [--explorer <url>] [--name <text>] --out <file>

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
for (const k of ["deployment", "rpc", "api", "out"]) if (!opt(k)) throw new Error(`--${k} is required`);
const d = JSON.parse(readFileSync(opt("deployment")!, "utf8")) as Record<string, unknown>;
const manifest = checkManifest({
  version: 1,
  chainId: Number(d.chainId),
  networkName: opt("name"),
  rpcUrl: opt("rpc"),
  apiUrl: opt("api"),
  explorerUrl: opt("explorer") ?? "",
  deployBlock: String(d.deployBlock ?? ""),
  contracts: Object.fromEntries(["Engine", "OpenBook", "WriterBook", "PathFundingBook", "MainspringPool", "MarkRouter", "SettlementToken"].map((k) => [k, d[k]])),
  settlement: { symbol: d.settlementSymbol, decimals: Number(d.settlementDecimals) },
  markets: d.markets,
});
const out = { ...manifest, deployBlock: manifest.deployBlock.toString() };
writeFileSync(opt("out")!, JSON.stringify(out, null, 2) + "\n");
console.log(`manifest for ${manifest.networkName} (chain ${manifest.chainId}) written to ${opt("out")}`);
