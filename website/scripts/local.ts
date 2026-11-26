import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress, parseAbi, type Address } from "viem";
import { startStack } from "./stack.ts";

/// LOCAL ONLY: the live site against anvil on this computer. Starts the local back end (scripts/stack.ts), writes
/// public/deployment.json (ignored by git), keeps the marks fresh, gives the wallet you name test ETH and test
/// settlement tokens, then runs the site in live mode. Nothing here touches a public network or uses a key: your
/// wallet signs on the local chain (add network "Local test chain", RPC as printed, chain id 31337).
///   bun scripts/local.ts --wallet 0xYourAddress [--port 18545]

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = Number(opt("port") ?? 18545);
const who = opt("wallet");

const s = await startStack(port);
writeFileSync(resolve(import.meta.dir, "../public/deployment.json"), JSON.stringify(s.manifest, null, 2) + "\n");
if (who) {
  const a = getAddress(who) as Address;
  await s.L.rpcCall("anvil_setBalance", [a, "0x56BC75E2D63100000"]); // 100 test ETH for gas
  await s.L.send(s.L.acc[0]!, s.L.m7.SettlementToken!, parseAbi(["function mint(address, uint256)"]), "mint", [a, 100_000n * 10n ** 6n]);
  console.log(`sent to ${a}: 100 test ETH and 100,000 test ${s.manifest.settlement && (s.manifest.settlement as { symbol: string }).symbol}`);
}
const keepFresh = setInterval(() => s.freshen().catch((e) => console.error("freshen:", e.message)), 4 * 60_000);
console.log(`local chain ${s.L.rpc} · API ${s.apiUrl} · manifest public/deployment.json`);

const vite = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", "5173", "--strictPort"], {
  cwd: resolve(import.meta.dir, ".."),
  env: { ...process.env, VITE_TOURBILLON_MODE: "live" },
  stdout: "inherit",
  stderr: "inherit",
});
const stop = async () => {
  clearInterval(keepFresh);
  vite.kill();
  await s.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await vite.exited;
await stop();
