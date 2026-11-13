import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseAbi, type Hex } from "viem";
import { b32, haveFoundry, startLocalM7, type LocalM7 } from "@tourbillon/common/localM7.ts";
import { loadM7Deployment } from "../src/collect.ts";
import { Collector } from "../src/epochs.ts";
import { buildTree, KIND_NAV, KIND_TRADE, KIND_VOL_FINAL, leafOf, proofOf } from "../src/tree.ts";

// On a local anvil with DeployM7: trades in one hour, then the service (--once) posts every finished hour that holds
// receipts; the on-chain root equals an independent rebuild, ReceiptRoots verifies a trade's proof, and a second pass
// posts nothing new. Skipped without anvil/forge.
const PORT = 25545 + Math.floor(Math.random() * 1000);
let L: LocalM7 | undefined;

const abi = parseAbi([
  "struct Leg { bool isCall; uint128 kWad; int128 qty; }",
  "struct Part { uint256 tempo; uint256 weight; }",
  "struct Quote { address maker; bytes32 name; uint8 sides; uint128 kLoWad; uint128 kHiWad; uint32 tauLo; uint32 tauHi; uint64 sigmaBps; uint128 maxUnits; uint64 validUntil; uint64 nonce; }",
  "function mint(address, uint256)",
  "function approve(address, uint256) returns (bool)",
  "function buy(bytes32 market, Leg[] legs, Part[] movement, uint256 units, uint256 maxCost, uint256 deadline, Quote[] quotes, bytes[] sigs, uint256[] offerIds) returns (uint256, uint256, uint8)",
  "function rootOf(uint256) view returns (bytes32, uint256, uint256)",
  "function verify(uint256 epoch, bytes32 leaf, bytes32[] proof) view returns (bool)",
  "function lastEpoch() view returns (uint256)",
]);
const W = 10n ** 18n;

async function service(): Promise<Record<string, unknown>[]> {
  const p = Bun.spawn(["bun", "src/main.ts", "--deployment", L!.m7File, "--rpc", L!.rpc, "--local-unlocked", L!.acc[10]!, "--once", "--port", "0", "--margin-seconds", "5"], {
    cwd: resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

beforeAll(async () => {
  if (haveFoundry()) L = await startLocalM7(PORT);
}, 240_000);
afterAll(() => L?.stop());

test.skipIf(!haveFoundry())(
  "finished hours are posted once; the root equals an independent rebuild; a trade's proof verifies on-chain",
  async () => {
    const { acc, m7, client, send } = L!;
    const T = acc[16]!;
    await send(T, m7.MockUSDC!, abi, "mint", [T, 1_000_000n * 10n ** 6n]);
    await send(T, m7.MockUSDC!, abi, "approve", [m7.Engine!, 1_000_000n * 10n ** 6n]);
    const legs = [
      { isCall: true, kWad: 74_000n * W, qty: W },
      { isCall: true, kWad: 76_000n * W, qty: -W },
    ];
    const deadline = (await client.getBlock()).timestamp + 3600n;
    const r = await send(T, m7.OpenBook!, abi, "buy", [b32("BTC"), legs, [{ tempo: 86_400n, weight: W }], 2n * W, 10n ** 12n, deadline, [], [], []]);
    await L!.warp(2 * 3600); // the hours of the deploy, the LP round and the trade are now over
    const lines = await service();
    const posted = lines.filter((l) => l.msg === "posted");
    expect(posted.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.level === "error")).toBe(false);

    // an independent rebuild of every posted hour from the chain's logs
    const d = loadM7Deployment(L!.m7File);
    const col = new Collector(client, d, d.deployBlock);
    await col.scan();
    const kindsSeen = new Set<number>();
    for (const p of posted) {
      const e = Number(p.epoch);
      const list = col.byEpoch.get(e)!;
      for (const x of list) kindsSeen.add(x.kind);
      const [root, count] = await client.readContract({ address: d.receipts, abi, functionName: "rootOf", args: [BigInt(e)] });
      expect(root).toBe(buildTree(list.map((x) => leafOf(x.encoded))).root);
      expect(Number(count)).toBe(list.length);
    }
    expect([...kindsSeen].sort()).toEqual([KIND_TRADE, KIND_VOL_FINAL, KIND_NAV]);

    // the trade's Routed log proves against its hour's root, through ReceiptRoots itself
    const routedLog = r.logs.find((l) => l.address.toLowerCase() === d.openBook.toLowerCase())!;
    const found = col.find(r.transactionHash, routedLog.logIndex)!;
    expect(found.receipt.kind).toBe(KIND_TRADE);
    const tree = buildTree(col.byEpoch.get(found.epoch)!.map((x) => leafOf(x.encoded)));
    const leaf = leafOf(found.receipt.encoded);
    expect(await client.readContract({ address: d.receipts, abi, functionName: "verify", args: [BigInt(found.epoch), leaf, proofOf(tree, leaf)] })).toBe(true);
    expect(await client.readContract({ address: d.receipts, abi, functionName: "verify", args: [BigInt(found.epoch), leafOf("0x1234" as Hex), proofOf(tree, leaf)] })).toBe(false);

    // a second pass: nothing new to post
    const again = await service();
    expect(again.filter((l) => l.msg === "posted").length).toBe(0);
    expect(again.some((l) => l.level === "error")).toBe(false);
  },
  240_000,
);
