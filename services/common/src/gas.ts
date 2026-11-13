import { parseEther, parseGwei } from "viem";

/// Gas policy (owner decision, M1): never pay more than 1 gwei; warn below 0.2 test HYPE.
export const MAX_FEE_PER_GAS = parseGwei("1");
export const LOW_BALANCE = parseEther("0.2");

/// Receipt polling; Elysium blocks are ~221 ms.
export const POLL_MS = 500;

/// Gas limit headroom. The estimate is made against the latest block; if another transaction lands first, this one
/// may do more work (a vote that turns out to finalise a round). Unused gas is not charged.
export const MIN_GAS_LIMIT = 250_000n;
export function withHeadroom(estimate: bigint): bigint {
  return estimate * 2n > MIN_GAS_LIMIT ? estimate * 2n : MIN_GAS_LIMIT;
}
