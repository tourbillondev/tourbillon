import { createPublicClient, getAddress, http, type Hex, type PublicClient } from "viem";
import { chainFor, LOCAL_CHAIN_ID } from "@tourbillon/common/chain.ts";
import { MAX_FEE_PER_GAS, withHeadroom } from "@tourbillon/common/gas.ts";
import { log } from "@tourbillon/common/log.ts";
import { loadSigner, type KeyInput } from "@tourbillon/common/signer.ts";
import { loadM7Deployment } from "./collect.ts";
import { Collector } from "./epochs.ts";
import { buildTree, leafOf, proofOf } from "./tree.ts";

/// The receipts service (spec section 7: "Posts the hourly root"; M7 G10, G11). Every pass it reads the new logs,
/// and for every finished hour after the last posted one that holds receipts it builds the tree and posts the root to
/// ReceiptRoots with the poster key (it can only post roots). Hours with no receipts are not posted (a gap). It also
/// serves proofs:
///   GET /proof?tx=0x…&logIndex=N  → { epoch, kind, encoded, leaf, proof, root, posted }
///   GET /epoch?e=N                → { epoch, root, count, posted }
///   GET /health
///   bun src/main.ts --deployment <m7.json> (--keystore NAME | --local-unlocked ADDR | --watch ADDR) [--rpc URL]
///     [--port 8548] [--margin-seconds 60] [--tick-seconds 60] [--once]

export const receiptsAbi = [
  { type: "function", name: "post", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "bytes32" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "lastEpoch", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "anyPosted", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "rootOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }] },
] as const;

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
  const known = ["deployment", "rpc", "keystore", "keystore-dir", "local-unlocked", "watch", "port", "margin-seconds", "tick-seconds", "once"];
  for (const k of a.keys()) if (!known.includes(k)) throw new Error(`unknown flag --${k}`);
  const s = (k: string) => (typeof a.get(k) === "string" ? (a.get(k) as string) : undefined);
  if (!s("deployment")) throw new Error("--deployment is required");
  const inputs = ["keystore", "local-unlocked", "watch"].filter((k) => a.has(k));
  if (inputs.length !== 1) throw new Error("give exactly one of --keystore, --local-unlocked, --watch (watch: builds and serves, never posts)");
  const key: KeyInput = a.has("keystore")
    ? { type: "keystore", name: s("keystore")!, dir: s("keystore-dir") }
    : a.has("local-unlocked")
      ? { type: "local-unlocked", address: getAddress(s("local-unlocked")!) }
      : { type: "watch", address: getAddress(s("watch")!) };
  return {
    deployment: s("deployment")!,
    rpc: s("rpc"),
    key,
    port: s("port") ? Number(s("port")) : 8548,
    marginS: Number(s("margin-seconds") ?? 60),
    tickS: Math.max(1, Number(s("tick-seconds") ?? 60)),
    once: a.has("once"),
  };
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  const d = loadM7Deployment(cfg.deployment);
  const client = createPublicClient({ chain: chainFor(d.chainId), transport: http(cfg.rpc) }) as PublicClient;
  const id = await client.getChainId();
  if (id !== d.chainId) throw new Error(`RPC is chain ${id}, deployment file is chain ${d.chainId}`);
  if (cfg.key.type === "local-unlocked" && id !== LOCAL_CHAIN_ID) throw new Error("--local-unlocked works only on a local anvil (31337)");
  const signer = await loadSigner(cfg.key, d.chainId, cfg.rpc);
  const collector = new Collector(client, d, d.deployBlock);
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address: d.receipts, abi: receiptsAbi, functionName, args } as never) as Promise<T>;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: cfg.port,
    async fetch(req) {
      const url = new URL(req.url);
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), { status, headers: { "content-type": "application/json" } });
      try {
        if (url.pathname === "/health") return json({ epochs: collector.byEpoch.size, latestTs: collector.latestTs });
        if (url.pathname === "/proof") {
          const tx = url.searchParams.get("tx") as Hex | null;
          const li = Number(url.searchParams.get("logIndex"));
          if (!tx) return json({ error: "tx is required" }, 400);
          const found = collector.find(tx, li);
          if (!found) return json({ error: "no receipt for that log" }, 404);
          const list = collector.byEpoch.get(found.epoch)!;
          const tree = buildTree(list.map((r) => leafOf(r.encoded)));
          const leaf = leafOf(found.receipt.encoded);
          const [posted] = await read<readonly [Hex, bigint, bigint]>("rootOf", [BigInt(found.epoch)]);
          return json({ epoch: found.epoch, kind: found.receipt.kind, encoded: found.receipt.encoded, leaf, proof: proofOf(tree, leaf), root: tree.root, posted: posted.toLowerCase() === tree.root.toLowerCase() });
        }
        if (url.pathname === "/epoch") {
          const e = Number(url.searchParams.get("e"));
          const list = collector.byEpoch.get(e) ?? [];
          const [posted, count] = await read<readonly [Hex, bigint, bigint]>("rootOf", [BigInt(e)]);
          return json({ epoch: e, root: list.length ? buildTree(list.map((r) => leafOf(r.encoded))).root : null, count: list.length, posted: posted, postedCount: count });
        }
        return json({ error: "not found" }, 404);
      } catch (err) {
        return json({ error: (err as Error).message.split("\n")[0] }, 400);
      }
    },
  });
  log("info", "started", { receipts: d.receipts, posts: signer.wallet !== undefined, url: `http://127.0.0.1:${server.port}` });

  let stopping = false;
  process.on("SIGINT", () => (stopping = true));
  process.on("SIGTERM", () => (stopping = true));
  while (!stopping) {
    try {
      await collector.scan();
      const any = await read<boolean>("anyPosted");
      const last = any ? Number(await read<bigint>("lastEpoch")) : -1;
      for (const e of collector.completeAfter(last, cfg.marginS)) {
        if (!e.tree) continue;
        if (!signer.wallet || !signer.account) {
          log("info", "would post", { epoch: e.epoch, root: e.tree.root, count: e.receipts.length });
          continue;
        }
        const call = { address: d.receipts, abi: receiptsAbi, functionName: "post", args: [BigInt(e.epoch), e.tree.root, BigInt(e.receipts.length)], account: signer.account, maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: 0n } as const;
        const gas = await client.estimateContractGas(call);
        const hash = await signer.wallet.writeContract({ ...call, chain: signer.wallet.chain, gas: withHeadroom(gas) });
        const r = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
        if (r.status !== "success") throw new Error(`post reverted for epoch ${e.epoch}`);
        log("info", "posted", { epoch: e.epoch, root: e.tree.root, count: e.receipts.length, kinds: kinds(e.receipts.map((x) => x.kind)), tx: hash, gasUsed: r.gasUsed });
      }
    } catch (err) {
      log("error", "pass failed", { error: (err as Error).message.split("\n")[0] });
    }
    if (cfg.once) break;
    for (let i = 0; i < cfg.tickS && !stopping; i++) await Bun.sleep(1000);
  }
  server.stop(true);
  log("info", "stopped");
}

function kinds(ks: number[]): Record<string, number> {
  const names: Record<number, string> = { 1: "trades", 2: "volFinals", 3: "navSnapshots" };
  const out: Record<string, number> = {};
  for (const k of ks) out[names[k]!] = (out[names[k]!] ?? 0) + 1;
  return out;
}

if (import.meta.main) {
  main().catch((e) => {
    log("error", "fatal", { error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    process.exit(1);
  });
}
