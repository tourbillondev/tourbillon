import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress, keccak256, stringToHex, toEventSelector, encodeAbiParameters, type Hex, type Log } from "viem";
import { buildTree, encodeReceipt, KIND_NAV, KIND_TRADE, KIND_VOL_FINAL, leafOf, proofOf, verify } from "../src/tree.ts";
import { receiptOf, type M7Deployment } from "../src/collect.ts";

const h = (i: number) => keccak256(stringToHex(`leaf-${i}`));

describe("the tree", () => {
  test("every leaf proves for every size; a foreign leaf does not; the order of leaves does not change the root", () => {
    for (let n = 1; n <= 9; n++) {
      const leaves = Array.from({ length: n }, (_, i) => h(i));
      const t = buildTree(leaves);
      for (const l of leaves) expect(verify(t.root, l, proofOf(t, l))).toBe(true);
      expect(verify(t.root, h(99), proofOf(t, leaves[0]!))).toBe(n === 1 ? false : false);
      expect(buildTree([...leaves].reverse()).root).toBe(t.root);
    }
    const one = buildTree([h(1)]);
    expect(one.root).toBe(h(1));
    expect(proofOf(one, h(1))).toEqual([]);
    expect(() => buildTree([])).toThrow();
  });

  test("a leaf is the double hash of the encoded receipt", () => {
    const enc = encodeReceipt(1, 31337, "0x000000000000000000000000000000000000000e", h(2), 2, [h(3)], "0x1234");
    expect(leafOf(enc)).toBe(keccak256(keccak256(enc)));
  });
});

const CONTRACTS = resolve(import.meta.dir, "../../../contracts");
const abiOf = (c: string) => {
  const p = resolve(CONTRACTS, `out/${c}.sol/${c}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")).abi as { type: string; name: string; inputs: { type: string }[] }[]) : null;
};
const sigs = (c: string) => (abiOf(c) ?? []).filter((x) => x.type === "event").map((x) => `${x.name}(${x.inputs.map((i) => i.type).join(",")})`);

describe("which logs are receipts", () => {
  const D: M7Deployment = {
    chainId: 31337,
    receipts: getAddress("0x00000000000000000000000000000000000000a0"),
    engine: getAddress("0x00000000000000000000000000000000000000a1"),
    openBook: getAddress("0x00000000000000000000000000000000000000a2"),
    writerBook: getAddress("0x00000000000000000000000000000000000000a3"),
    matchBook: getAddress("0x00000000000000000000000000000000000000a4"),
    auction: getAddress("0x00000000000000000000000000000000000000a5"),
    board: getAddress("0x00000000000000000000000000000000000000a6"),
    pool: getAddress("0x00000000000000000000000000000000000000a7"),
    markets: ["BTC", "ETH", "HYPE"],
    deployBlock: 0n,
  };
  const log = (address: Hex, topics: Hex[]): Log => ({ address, topics, data: "0x", blockNumber: 5n, transactionHash: h(7), logIndex: 3, blockHash: h(8), transactionIndex: 0, removed: false }) as unknown as Log;

  test("trades, vol finals and NAV snapshots, by emitter and event; everything else is not a receipt", () => {
    const shape = toEventSelector("ShapeBought(address,uint256,bytes32,uint256,uint256,uint256,uint256,int256,uint256,uint256)");
    expect(receiptOf(D, log(D.engine, [shape]), 7_200)?.kind).toBe(KIND_TRADE);
    expect(receiptOf(D, log(D.engine, [shape]), 7_200)?.epoch).toBe(2);
    expect(receiptOf(D, log(D.pool, [shape]), 0)).toBeNull(); // right event, wrong contract
    const fin = toEventSelector("Finalised(bytes32,uint80,uint256,uint256,uint256)");
    const vol = keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }], ["VOL", stringToHex("ETH", { size: 32 })]));
    const mark = keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }], ["MARK", stringToHex("ETH", { size: 32 })]));
    expect(receiptOf(D, log(D.board, [fin, vol]), 0)?.kind).toBe(KIND_VOL_FINAL);
    expect(receiptOf(D, log(D.board, [fin, mark]), 0)).toBeNull(); // marks are not vol finals
    const settled = toEventSelector("Settled(uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)");
    expect(receiptOf(D, log(D.pool, [settled]), 0)?.kind).toBe(KIND_NAV);
    const deposit = toEventSelector("DepositQueued(uint256,address,uint256)");
    expect(receiptOf(D, log(D.pool, [deposit]), 0)).toBeNull();
  });

  test.skipIf(abiOf("Engine") === null)("every event the service listens for exists in the compiled contracts", () => {
    const want: [string, string][] = [
      ["Engine", "Bought(address,uint256,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256)"],
      ["Engine", "ShapeBought(address,uint256,bytes32,uint256,uint256,uint256,uint256,int256,uint256,uint256)"],
      ["Engine", "Sold(address,uint256,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool,bool)"],
      ["OpenBook", "Routed(address,uint256,uint8,uint256,uint256,address)"],
      ["WriterBook", "Written(address,uint256,uint256,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,int256,uint256)"],
      ["WriterBook", "Unwritten(uint256,uint256,uint256,uint256,uint256,int256,uint256,uint256,uint256,uint256,bool,bool,bool)"],
      ["MatchBook", "Matched(bytes32,uint256,uint256,uint256,uint256,uint256)"],
      ["MatchBook", "BoughtBack(bytes32,uint256,uint256,uint256,uint256,uint256)"],
      ["MatchBook", "EarlyClosed(bytes32,uint256,uint256,uint256,int256,uint256)"],
      ["RiskAuction", "Settled(uint256,address,uint256,uint256,uint256,uint256)"],
      ["QuorumBoard", "Finalised(bytes32,uint80,uint256,uint256,uint256)"],
      ["MainspringPool", "Settled(uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)"],
    ];
    for (const [c, s] of want) expect(sigs(c)).toContain(s);
  });
});
