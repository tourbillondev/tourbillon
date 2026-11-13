/// Thresholds and the pure checks behind the alarms (owner defaults, all configurable).

export type Thresholds = {
  coverageHeadroom: number; // warn when free / stressed < this
  capUse: number; // warn when use / cap > this
  sampleAgeS: number; // poker down
  settlementAgeS: number; // keeper down
  equityRelTol: number; // EQUITY mismatch: relative to the account value
  equityAbsTolUsd: number; // … or this many USD, whichever is larger
  hedgerSilentS: number; // hedger status file older than this
  markMismatch: number; // Hyperliquid vs router
  auctionSettleGraceS: number; // an auction lot unsettled this long after its reveal ends
  receiptsStaleHours: number; // no receipt root posted for this long
};

export const DEFAULTS: Thresholds = {
  coverageHeadroom: 0.1,
  capUse: 0.9,
  sampleAgeS: 15 * 60,
  settlementAgeS: 2 * 3600,
  equityRelTol: 0.01,
  equityAbsTolUsd: 1_000,
  hedgerSilentS: 5 * 60,
  markMismatch: 0.01,
  auctionSettleGraceS: 3600,
  receiptsStaleHours: 3,
};

/// Coverage: "breached" when available < stressed; "low" when the free part is under the headroom share of stressed.
export function coverageState(available: number, stressed: number, t: Thresholds): "ok" | "low" | "breached" {
  if (available < stressed) return "breached";
  if (stressed > 0 && (available - stressed) / stressed < t.coverageHeadroom) return "low";
  return "ok";
}

export function capHigh(use: number, cap: number, t: Thresholds): boolean {
  return cap > 0 && use / cap > t.capUse;
}

/// EQUITY check: the board's P&L-only value (minus the offset) against the monitor's own recompute, both in USD.
export function equityMismatch(boardPnl: number, ownPnl: number, accountValue: number, t: Thresholds): boolean {
  return Math.abs(boardPnl - ownPnl) > Math.max(t.equityRelTol * Math.abs(accountValue), t.equityAbsTolUsd);
}

/// Hyperliquid's view of a market is healthy when it answered, lists the market with a mark, and (when the router is
/// fresh) the two marks agree within `markMismatch`.
export function hlMarketDown(hlMark: number | null, routerMark: number | null, t: Thresholds): boolean {
  if (hlMark === null) return true;
  if (routerMark === null) return false; // the router is stale: a signer problem, raised separately
  return Math.abs(hlMark - routerMark) / routerMark > t.markMismatch;
}
