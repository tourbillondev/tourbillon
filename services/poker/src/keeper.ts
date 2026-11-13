import { type Address, type PublicClient } from "viem";
import { MAX_FEE_PER_GAS, withHeadroom } from "@tourbillon/common/gas.ts";
import { log } from "@tourbillon/common/log.ts";
import type { Signer } from "@tourbillon/common/signer.ts";
import { revertName } from "@tourbillon/common/tx.ts";
import type { Role } from "./poke.ts";

/// The pool keeper (M3 step 10a): runs MainspringPool's hourly cycle, all of it permissionless on-chain:
/// startEpoch → markChunk until final → settle. A separate module, like the walker.
/// The primary acts 60 s after the hour is up, the backup 10 min after (only if the primary has not); a race where
/// the other poker got there first reverts in the simulation and is skipped quietly.

export const EPOCH_S = 3600;
export const KEEPER_OFFSET_S: Record<Role, number> = { primary: 60, backup: 600 };
export const CHUNK = 120n; // series per markChunk (a full 768-series epoch fits a block per transaction at 120)
export const MAX_CHUNKS_PER_PASS = 10;

export type KeeperState = { marking: boolean; epoch: bigint; lastSettled: bigint; epochStart: number };
export type KeeperAction = "mark" | "settle" | "start" | "wait";

export function decideKeeper(s: KeeperState, now: number, role: Role): KeeperAction {
  if (s.marking) return "mark";
  if (s.epoch > s.lastSettled) return "settle";
  if (s.epoch === 0n || now >= s.epochStart + EPOCH_S + KEEPER_OFFSET_S[role]) return "start";
  return "wait";
}

export const keeperAbi = [
  { type: "function", name: "marking", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "epoch", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "lastSettledEpoch", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "epochTimes", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }, { type: "uint64" }] },
  { type: "function", name: "round", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "startEpoch", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "markChunk", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "settle", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "error", name: "EpochInProgress", inputs: [] },
  { type: "error", name: "EpochTooSoon", inputs: [{ type: "uint256" }] },
  { type: "error", name: "NotMarking", inputs: [] },
  { type: "error", name: "NothingToSettle", inputs: [] },
  { type: "error", name: "Stale", inputs: [{ type: "bytes32" }, { type: "address" }] },
  { type: "error", name: "Stale", inputs: [{ type: "bytes32" }, { type: "uint256" }] },
  { type: "error", name: "NoRoute", inputs: [{ type: "bytes32" }] },
] as const;

/// Reverts that only mean another poker acted first.
const RACES = new Set(["EpochInProgress", "EpochTooSoon", "NotMarking", "NothingToSettle"]);

async function state(client: PublicClient, pool: Address): Promise<KeeperState> {
  const [marking, epoch, lastSettled, times] = await Promise.all([
    client.readContract({ address: pool, abi: keeperAbi, functionName: "marking" }),
    client.readContract({ address: pool, abi: keeperAbi, functionName: "epoch" }),
    client.readContract({ address: pool, abi: keeperAbi, functionName: "lastSettledEpoch" }),
    client.readContract({ address: pool, abi: keeperAbi, functionName: "epochTimes" }),
  ]);
  return { marking, epoch, lastSettled, epochStart: Number(times[0]) };
}

/// One pass: as many keeper steps as are due (start, then mark until final, then settle).
export async function keep(client: PublicClient, pool: Address, signer: Signer, role: Role, now: number, dryRun: boolean, gasPaused: boolean): Promise<void> {
  let chunks = 0;
  for (let step = 0; step < MAX_CHUNKS_PER_PASS + 2; step++) {
    const s = await state(client, pool);
    const action = decideKeeper(s, now, role);
    if (action === "wait") {
      if (step === 0) log("info", "keeper: wait", { epoch: s.epoch, nextAt: s.epochStart + EPOCH_S + KEEPER_OFFSET_S[role] });
      return;
    }
    if (action === "mark" && chunks >= MAX_CHUNKS_PER_PASS) return;
    const functionName = action === "start" ? "startEpoch" : action === "mark" ? "markChunk" : "settle";
    const args = action === "mark" ? [CHUNK] : [];
    const call = { address: pool, abi: keeperAbi, functionName, args, account: signer.address, maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: 0n } as const;
    let gas: bigint;
    try {
      gas = await client.estimateContractGas(call as never);
    } catch (e) {
      const name = revertName(e);
      if (name && RACES.has(name)) log("info", "keeper: skip", { action, reason: "raced", error: name });
      else log("warn", "keeper: cannot act", { action, error: name ?? (e as Error).message.split("\n")[0] }); // e.g. stale mark: no epoch (law 2)
      return;
    }
    if (dryRun || !signer.wallet) {
      log("info", "keeper: would act", { action });
      return;
    }
    if (gasPaused) return;
    const hash = await signer.wallet.writeContract({ ...(call as object), account: signer.account!, chain: signer.wallet.chain, gas: withHeadroom(gas) } as never);
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
    log("info", `keeper: ${action === "start" ? "epoch started" : action === "mark" ? "marked" : "settled"}`, { tx: hash, status: receipt.status, gasUsed: receipt.gasUsed, epoch: s.epoch });
    if (receipt.status !== "success") return;
    if (action === "mark") chunks++;
    if (action === "settle") return; // the cycle is complete
  }
}
