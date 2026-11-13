import { concat, encodeAbiParameters, keccak256, type Hex } from "viem";

/// Receipt leaves and their Merkle tree (M7 G11), as ReceiptRoots checks them:
/// - a leaf is `keccak256(keccak256(encoded))` (double hash, as `ReceiptRoots.leafOf`);
/// - pairs are hashed sorted (`keccak256(min ‖ max)`), so OpenZeppelin's `MerkleProof.verify` checks a proof;
/// - leaves are sorted ascending before building, so the root depends only on the set of receipts;
/// - a level with an odd count carries its last node up unchanged.

export function leafOf(encoded: Hex): Hex {
  return keccak256(keccak256(encoded));
}

function pair(a: Hex, b: Hex): Hex {
  return BigInt(a) <= BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

export type Tree = { root: Hex; leaves: Hex[]; levels: Hex[][] };

export function buildTree(leaves: Hex[]): Tree {
  if (leaves.length === 0) throw new Error("tree: no leaves");
  const sorted = [...leaves].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0));
  const levels: Hex[][] = [sorted];
  while (levels[levels.length - 1]!.length > 1) {
    const lv = levels[levels.length - 1]!;
    const up: Hex[] = [];
    for (let i = 0; i < lv.length; i += 2) up.push(i + 1 < lv.length ? pair(lv[i]!, lv[i + 1]!) : lv[i]!);
    levels.push(up);
  }
  return { root: levels[levels.length - 1]![0]!, leaves: sorted, levels };
}

/// The proof for `leaf` (sibling hashes from the bottom up).
export function proofOf(t: Tree, leaf: Hex): Hex[] {
  let idx = t.leaves.indexOf(leaf);
  if (idx < 0) throw new Error("tree: leaf not in the tree");
  const proof: Hex[] = [];
  for (let l = 0; l < t.levels.length - 1; l++) {
    const lv = t.levels[l]!;
    const sib = idx ^ 1;
    if (sib < lv.length) proof.push(lv[sib]!);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/// Checks a proof the way `MerkleProof.verify` does.
export function verify(root: Hex, leaf: Hex, proof: Hex[]): boolean {
  let h = leaf;
  for (const p of proof) h = pair(h, p);
  return h.toLowerCase() === root.toLowerCase();
}

/// Receipt kinds (spec: "Trades, vol finals and NAV snapshots").
export const KIND_TRADE = 1;
export const KIND_VOL_FINAL = 2;
export const KIND_NAV = 3;

/// The encoded receipt of one log: (kind, chain id, emitter, transaction hash, log index, topics, data). Everything a
/// reader needs to recompute it from the chain's own logs.
export function encodeReceipt(kind: number, chainId: number, emitter: Hex, txHash: Hex, logIndex: number, topics: Hex[], data: Hex): Hex {
  return encodeAbiParameters(
    [{ type: "uint8" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }, { type: "bytes32[]" }, { type: "bytes" }],
    [kind, BigInt(chainId), emitter, txHash, BigInt(logIndex), topics, data],
  );
}
