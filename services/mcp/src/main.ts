import { createPublicClient, http, type PublicClient } from "viem";
import { chainFor } from "@tourbillon/common/chain.ts";
import { handle } from "./protocol.ts";
import { loadM7, makeTools } from "./tools.ts";

/// The MCP service (spec section 7, "api / mcp"; M7 G17), on standard input and output: one JSON-RPC message per line.
/// It reads the chain and builds unsigned transactions and mandates; it never holds a key. Diagnostics go to stderr.
///   bun src/main.ts --deployment <m7.json> [--rpc URL] [--gateway URL]

function parseArgs(argv: string[]) {
  const a = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]!;
    const v = argv[i + 1];
    if (!k.startsWith("--") || v === undefined) throw new Error(`bad argument ${k}`);
    if (!["deployment", "rpc", "gateway"].includes(k.slice(2))) throw new Error(`unknown flag ${k}`);
    a.set(k.slice(2), v);
  }
  if (!a.get("deployment")) throw new Error("--deployment is required");
  return { deployment: a.get("deployment")!, rpc: a.get("rpc"), gateway: a.get("gateway") };
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  const d = loadM7(cfg.deployment);
  const client = createPublicClient({ chain: chainFor(d.chainId), transport: http(cfg.rpc) }) as PublicClient;
  if ((await client.getChainId()) !== d.chainId) throw new Error("the RPC is not the deployment's chain");
  const tools = makeTools(client, d, cfg.gateway);
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += new TextDecoder().decode(chunk);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const out = await handle(tools, line);
      if (out !== null) process.stdout.write(out + "\n");
    }
  }
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}\n`);
  process.exit(1);
});
