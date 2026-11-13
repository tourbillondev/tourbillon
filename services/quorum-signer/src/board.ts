import { revertName } from "@tourbillon/common/tx.ts";
import { BaseError, ContractFunctionRevertedError, stringToHex, type Address, type PublicClient } from "viem";
import type { Kind, KeyState } from "./decide.ts";

export const boardAbi = [
  { type: "function", name: "isSigner", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "signerCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "quorum", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "feeds",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "bool", name: "listed" }, { type: "uint16", name: "stepBps" }, { type: "uint32", name: "heartbeat" }],
  },
  { type: "function", name: "markKey", stateMutability: "pure", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "volKey", stateMutability: "pure", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32" }] },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [
      { type: "uint80", name: "roundId" },
      { type: "int256", name: "answer" },
      { type: "uint256", name: "startedAt" },
      { type: "uint256", name: "updatedAt" },
      { type: "uint80", name: "answeredInRound" },
    ],
  },
  { type: "function", name: "openVotes", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "hasVoted",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }, { type: "uint80" }, { type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "vote",
    stateMutability: "nonpayable",
    inputs: [{ type: "bytes32", name: "key" }, { type: "uint80", name: "round" }, { type: "uint256", name: "value" }],
    outputs: [],
  },
  { type: "function", name: "finalize", stateMutability: "nonpayable", inputs: [{ type: "bytes32", name: "key" }], outputs: [] },
  { type: "error", name: "NoData", inputs: [{ type: "bytes32", name: "key" }] },
  { type: "error", name: "NotReady", inputs: [{ type: "bytes32", name: "key" }] },
  { type: "error", name: "NotSigner", inputs: [{ type: "address", name: "account" }] },
  { type: "error", name: "UnknownKey", inputs: [{ type: "bytes32", name: "key" }] },
  { type: "error", name: "WrongRound", inputs: [{ type: "uint80", name: "expected" }, { type: "uint80", name: "given" }] },
  { type: "error", name: "AlreadyVoted", inputs: [{ type: "address", name: "signer" }] },
  { type: "error", name: "ZeroValue", inputs: [] },
  { type: "error", name: "ValueTooLarge", inputs: [{ type: "uint256", name: "value" }] },
  {
    type: "event",
    name: "Voted",
    inputs: [
      { type: "bytes32", name: "key", indexed: true },
      { type: "uint80", name: "round", indexed: true },
      { type: "address", name: "signer", indexed: true },
      { type: "uint256", name: "value", indexed: false },
    ],
  },
  {
    type: "event",
    name: "VoteDropped",
    inputs: [
      { type: "bytes32", name: "key", indexed: true },
      { type: "uint80", name: "round", indexed: true },
      { type: "address", name: "signer", indexed: true },
      { type: "uint256", name: "value", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Finalised",
    inputs: [
      { type: "bytes32", name: "key", indexed: true },
      { type: "uint80", name: "round", indexed: true },
      { type: "uint256", name: "median", indexed: false },
      { type: "uint256", name: "published", indexed: false },
      { type: "uint256", name: "votes", indexed: false },
    ],
  },
] as const;

export type BoardKey = { market: string; kind: Kind; key: `0x${string}`; heartbeat: number };

/// The board's custom error name in a revert, if any.
export const boardErrorName = revertName;

/// Reverts that only mean the board moved on since this signer read it (another signer voted or finalised
/// first). They are skipped quietly; the next pass reads the new state.
export const RACE_ERRORS = new Set(["NotReady", "WrongRound", "AlreadyVoted"]);

/// Logged reason for a race revert, or undefined for any other revert.
export function raceReason(name: string): string | undefined {
  if (!RACE_ERRORS.has(name)) return undefined;
  return name === "NotReady" ? "not-ready" : "raced";
}

export function marketBytes32(market: string): `0x${string}` {
  return stringToHex(market, { size: 32 });
}

/// The board keys for every market (MARK and VOL), checked to be listed.
export async function boardKeys(client: PublicClient, board: Address, markets: string[]): Promise<BoardKey[]> {
  const out: BoardKey[] = [];
  for (const market of markets) {
    for (const kind of ["MARK", "VOL"] as const) {
      const key = await client.readContract({
        address: board,
        abi: boardAbi,
        functionName: kind === "MARK" ? "markKey" : "volKey",
        args: [marketBytes32(market)],
      });
      const [listed, , heartbeat] = await client.readContract({ address: board, abi: boardAbi, functionName: "feeds", args: [key] });
      if (!listed) throw new Error(`board: ${kind} ${market} is not listed`);
      out.push({ market, kind, key, heartbeat });
    }
  }
  return out;
}

/// The pool's EQUITY key (M3 step 4), checked to be listed.
export async function equityBoardKey(client: PublicClient, board: Address, key: `0x${string}`): Promise<BoardKey> {
  const [listed, , heartbeat] = await client.readContract({ address: board, abi: boardAbi, functionName: "feeds", args: [key] });
  if (!listed) throw new Error("board: EQUITY is not listed for this pool");
  return { market: "EQUITY", kind: "EQUITY", key, heartbeat };
}

/// The latest final round, or round 0 when the key has never been finalised (the board reverts NoData).
async function latest(client: PublicClient, board: Address, key: `0x${string}`): Promise<{ round: bigint; updatedAt: number }> {
  try {
    const [roundId, , , updatedAt] = await client.readContract({ address: board, abi: boardAbi, functionName: "latestRoundData", args: [key] });
    return { round: roundId, updatedAt: Number(updatedAt) };
  } catch (e) {
    if (e instanceof BaseError) {
      const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
      if (r instanceof ContractFunctionRevertedError && r.data?.errorName === "NoData") return { round: 0n, updatedAt: 0 };
    }
    throw e;
  }
}

export async function readKeyState(
  client: PublicClient,
  board: Address,
  k: BoardKey,
  me: Address,
  myVoteAt: number | null,
  quorum: number,
): Promise<KeyState> {
  const l = await latest(client, board, k.key);
  const round = l.round + 1n;
  const [openVotes, iVoted] = await Promise.all([
    client.readContract({ address: board, abi: boardAbi, functionName: "openVotes", args: [k.key] }),
    client.readContract({ address: board, abi: boardAbi, functionName: "hasVoted", args: [k.key, round, me] }),
  ]);
  return {
    latestRound: l.round,
    latestUpdatedAt: l.updatedAt,
    openVotes: Number(openVotes),
    iVoted,
    myVoteAt: iVoted ? myVoteAt : null,
    heartbeat: k.heartbeat,
    quorum,
  };
}
