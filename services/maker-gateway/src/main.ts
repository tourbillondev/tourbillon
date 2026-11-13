import { createPublicClient, http, type PublicClient } from "viem";
import { chainFor } from "@tourbillon/common/chain.ts";
import { log } from "@tourbillon/common/log.ts";
import { chainReader, loadM6Deployment } from "./chain.ts";
import { makeHandler } from "./server.ts";

/// The maker-gateway: serves signed vol quotes (spec section 7). No keys: it only reads the chain.
///   bun src/main.ts --deployment <m6.json> [--rpc <url>] [--port 8547] [--host 127.0.0.1]

function parseArgs(argv: string[]) {
  const a = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]!;
    const v = argv[i + 1];
    if (!k.startsWith("--") || v === undefined) throw new Error(`bad argument ${k}`);
    if (!["deployment", "rpc", "port", "host"].includes(k.slice(2))) throw new Error(`unknown flag ${k}`);
    a.set(k.slice(2), v);
  }
  if (!a.get("deployment")) throw new Error("--deployment is required");
  return { deployment: a.get("deployment")!, rpc: a.get("rpc"), port: Number(a.get("port") ?? 8547), host: a.get("host") ?? "127.0.0.1" };
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  const dep = loadM6Deployment(cfg.deployment);
  const client = createPublicClient({ chain: chainFor(dep.chainId), transport: http(cfg.rpc) }) as PublicClient;
  const id = await client.getChainId();
  if (id !== dep.chainId) throw new Error(`RPC is chain ${id}, deployment file is chain ${dep.chainId}`);
  const handler = makeHandler(chainReader(client, dep));
  const server = Bun.serve({ hostname: cfg.host, port: cfg.port, fetch: handler.fetch });
  log("info", "started", { url: `http://${cfg.host}:${server.port}`, chainId: dep.chainId, quoteBook: dep.quoteBook, vault: dep.vault });
  const stop = () => {
    server.stop();
    log("info", "stopped");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  log("error", "fatal", { error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
  process.exit(1);
});
