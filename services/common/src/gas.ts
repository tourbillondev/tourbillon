import { parseEther, parseGwei } from "viem";

/// Gas policy (owner decision, M1; G14 kept the cap): never pay more than 1 gwei; warn below 0.2 of the gas token.
/// On Robinhood Chain gas is paid in ETH (owner fact F1); the warning level is set after RobinhoodProbe measures fees (Q10).
export const MAX_FEE_PER_GAS = parseGwei("1");
export const LOW_BALANCE = parseEther("0.2");

/// Receipt polling. The spec assumes blocks of 500 ms or less on Robinhood Chain (U, measured by RobinhoodProbe).
export const POLL_MS = 500;

/// Gas limit headroom. The estimate is made against the latest block; if another transaction lands first, this one
/// may do more work (a vote that turns out to finalise a round). Unused gas is not charged.
export const MIN_GAS_LIMIT = 250_000n;
export function withHeadroom(estimate: bigint): bigint {
  return estimate * 2n > MIN_GAS_LIMIT ? estimate * 2n : MIN_GAS_LIMIT;
}
