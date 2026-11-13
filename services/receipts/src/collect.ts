import { readFileSync } from "node:fs";
import { getAddress, keccak256, encodeAbiParameters, stringToHex, toEventSelector, type Address, type Hex, type Log } from "viem";
import { encodeReceipt, KIND_NAV, KIND_TRADE, KIND_VOL_FINAL } from "./tree.ts";

/// Which logs become receipts, and the hour each belongs to.
/// - Trades: Engine `Bought`, `ShapeBought`, `Sold`; OpenBook `Routed`; WriterBook `Written`, `Unwritten`; MatchBook
///   `Matched`, `BoughtBack`, `EarlyClosed`; RiskAuction `Settled`.
/// - Vol finals: QuorumBoard `Finalised` for a market's VOL key.
/// - NAV snapshots: MainspringPool `Settled` (each settled round: NAV and NAV per share).
/// An epoch is the UTC hour of the log's block (`timestamp / 3600`, as ReceiptRoots).

export type M7Deployment = {
  chainId: number;
  receipts: Address;
  engine: Address;
  openBook: Address;
  writerBook: Address;
  matchBook: Address;
  auction: Address;
  board: Address;
  pool: Address;
  markets: string[];
  deployBlock: bigint;
};

export function parseM7Deployment(json: string): M7Deployment {
  const d = JSON.parse(json) as Record<string, unknown>;
  const need = (k: string) => {
    if (typeof d[k] !== "string") throw new Error(`deployment: missing ${k} (an M7 file is needed)`);
    return getAddress(d[k] as string);
  };
  return {
    chainId: Number(d.chainId),
    receipts: need("ReceiptRoots"),
    engine: need("Engine"),
    openBook: need("OpenBook"),
    writerBook: need("WriterBook"),
    matchBook: need("MatchBook"),
    auction: need("RiskAuction"),
    board: need("QuorumBoard"),
    pool: need("MainspringPool"),
    markets: d.markets as string[],
    deployBlock: BigInt(Number(d.deployBlock ?? 0)),
  };
}

export const loadM7Deployment = (path: string) => parseM7Deployment(readFileSync(path, "utf8"));

const sel = (sig: string) => toEventSelector(sig);
const TRADE_EVENTS: Record<string, string[]> = {
  engine: [
    "Bought(address,uint256,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
    "ShapeBought(address,uint256,bytes32,uint256,uint256,uint256,uint256,int256,uint256,uint256)",
    "Sold(address,uint256,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool,bool)",
  ],
  openBook: ["Routed(address,uint256,uint8,uint256,uint256,address)"],
  writerBook: [
    "Written(address,uint256,uint256,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,int256,uint256)",
    "Unwritten(uint256,uint256,uint256,uint256,uint256,int256,uint256,uint256,uint256,uint256,bool,bool,bool)",
  ],
  matchBook: [
    "Matched(bytes32,uint256,uint256,uint256,uint256,uint256)",
    "BoughtBack(bytes32,uint256,uint256,uint256,uint256,uint256)",
    "EarlyClosed(bytes32,uint256,uint256,uint256,int256,uint256)",
  ],
  auction: ["Settled(uint256,address,uint256,uint256,uint256,uint256)"],
};
const FINALISED = sel("Finalised(bytes32,uint80,uint256,uint256,uint256)");
const POOL_SETTLED = sel("Settled(uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)");

const volKey = (m: string) => keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }], ["VOL", stringToHex(m, { size: 32 })]));

export type Receipt = { epoch: number; kind: number; encoded: Hex; txHash: Hex; logIndex: number; blockNumber: bigint };

/// The receipt for a log, or null when the log is not one (`ts` = its block's timestamp).
export function receiptOf(d: M7Deployment, l: Log, ts: number): Receipt | null {
  const emitter = getAddress(l.address);
  const t0 = l.topics[0];
  if (!t0 || l.transactionHash === null || l.logIndex === null || l.blockNumber === null) return null;
  let kind = 0;
  const byContract: [Address, string][] = [
    [d.engine, "engine"],
    [d.openBook, "openBook"],
    [d.writerBook, "writerBook"],
    [d.matchBook, "matchBook"],
    [d.auction, "auction"],
  ];
  for (const [addr, name] of byContract) {
    if (emitter === addr && TRADE_EVENTS[name]!.some((s) => sel(s) === t0)) kind = KIND_TRADE;
  }
  if (emitter === d.board && t0 === FINALISED && d.markets.some((m) => volKey(m) === l.topics[1])) kind = KIND_VOL_FINAL;
  if (emitter === d.pool && t0 === POOL_SETTLED) kind = KIND_NAV;
  if (kind === 0) return null;
  return {
    epoch: Math.floor(ts / 3600),
    kind,
    encoded: encodeReceipt(kind, d.chainId, emitter, l.transactionHash, l.logIndex, l.topics as Hex[], l.data),
    txHash: l.transactionHash,
    logIndex: l.logIndex,
    blockNumber: l.blockNumber,
  };
}

/// The contracts whose logs are read.
export const watched = (d: M7Deployment): Address[] => [d.engine, d.openBook, d.writerBook, d.matchBook, d.auction, d.board, d.pool];
