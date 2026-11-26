/// Robinhood Chain checks (RH7; Backend §6, §11; owner G3, G9, D3), pure so they are tested without a chain.

/// The split ratios a corporate action can show: 2, 3, 4, 5, 10, 20 for one, and the reverse.
const RATIOS = [2, 3, 4, 5, 10, 20].flatMap((k) => [k, 1 / k]);

/// G9: a stock MARK round whose quorum median sits a split ratio away from the published value. The board's step clamp
/// (2% a round) holds the published mark back, so right after a split the signers' median is about half (or a third…)
/// of it. Gives the ratio (median ÷ published) when it is within 3% of one of RATIOS and more than 30% from 1, else
/// null. An ordinary gap, even a big one, is not a split.
export function splitRatio(median: bigint, published: bigint): number | null {
  if (published === 0n || median === 0n) return null;
  const r = Number((median * 1_000_000n) / published) / 1_000_000;
  if (Math.abs(r - 1) <= 0.3) return null;
  for (const k of RATIOS) if (Math.abs(r / k - 1) <= 0.03) return k;
  return null;
}

/// What one finalised stock MARK round means for the alarms.
export function markRound(median: bigint, published: bigint, inSession: boolean): "split" | "anchored" | null {
  if (splitRatio(median, published) !== null) return "split";
  if (!inSession && median !== published) return "anchored"; // the session band or the step clamp held it (G1, G3)
  return null;
}

/// G3: on a closed day the open caps are a quarter. High when the use passes `capUse` of the reduced cap.
export function quarterCapHigh(use: number, cap: number, capBps: number, capUse: number): boolean {
  if (capBps >= 10_000 || cap <= 0) return false;
  const reduced = (cap * capBps) / 10_000;
  return reduced > 0 && use / reduced > capUse;
}

/// The on-chain hedge (G7): the pool's holding is off its target by more than twice the band. The hedger trades back
/// inside the band on its own; twice the band means it cannot (caps, free USDC, a failing router).
export function inventoryMismatch(held: number, target: number, band: number): boolean {
  return Math.abs(held - target) > 2 * Math.max(band, 1e-9);
}
