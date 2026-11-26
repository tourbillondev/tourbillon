// Refusals by name. A revert from the contracts is decoded against their own error list (abi.generated.mjs) and
// shown as what it means for the user, with what they can do; transport failures stay separate from refusals.
import { decodeErrorResult } from 'viem';
import { ERRORS } from './abi.generated.mjs';

const PLAIN = {
  Stale: 'No fresh mark for this market: opens are closed until one arrives. Selling still works.',
  NoRoute: 'This market has no price route yet: opens are closed. Selling still works.',
  Disagree: 'The price sources disagree: opens are closed until they agree. Selling still works.',
  BuysArePaused: 'Opens are paused. Selling still works.',
  WritesArePaused: 'New writes are paused. Existing positions can still be closed.',
  MarketPaused: 'Opens on this market are paused. Selling still works.',
  OpensPaused: 'Opens are paused. Selling still works.',
  Expired: 'The review expired. Review again for a fresh price.',
  CostAboveMax: 'The price moved above the limit you approved. Review again.',
  NetBelowMin: 'The sale value fell below the minimum you set. Review again.',
  CreditBelowMin: 'The write credit fell below the minimum you set. Review again.',
  StrikeOffStep: 'The strike is not on this market’s strike step.',
  StrikeOutOfBand: 'The strike must be between half and twice the mark.',
  NotListed: 'This market is not listed.',
  Unbounded: 'This shape has no bounded worst case, so it cannot be written against collateral.',
  CoverNotAllowed: 'This market has no covering token for a covered write.',
  NotCaughtUp: 'The funding walk for this position is behind. Try again in a moment.',
  NothingToSell: 'There is nothing left to sell in this position.',
  ERC20InsufficientAllowance: 'The approval is too small for this trade. Approve again.',
  ERC20InsufficientBalance: 'Your balance is too small for this trade.',
  NoSource: 'No source could fill this trade right now.',
  LegsNotCanonical: 'These legs are not in the book’s order.',
  FirstQtyNotOne: 'The first leg must be one unit.',
  RepeatedTempo: 'A Movement cannot repeat a tempo.',
  WeightsNotOne: 'The Movement weights must add up to 100%.',
  DirectionalCapExceeded: 'This market’s directional cap is reached: opens in this direction are closed for now.',
  NotionalCapExceeded: 'This market’s notional cap is reached: opens are closed for now.',
  CoverageBreached: 'The pool’s coverage limit is reached: opens are closed for now.',
};

/// Finds revert data in a viem error or an RPC error object.
function revertData(e) {
  for (let x = e, i = 0; x && i < 8; x = x.cause, i++) {
    const d = x.data?.data ?? x.data;
    if (typeof d === 'string' && /^0x[0-9a-f]{8}/i.test(d)) return d;
    if (typeof x.raw === 'string' && /^0x[0-9a-f]{8}/i.test(x.raw)) return x.raw;
  }
  const m = /0x[0-9a-f]{8}[0-9a-f]*/i.exec(String(e?.message ?? ''));
  return m ? m[0] : null;
}

/// { kind: 'refused' | 'transport' | 'other', name, message } for any failure on the way to the chain.
export function explain(e) {
  if (e?.name === 'TimeoutError' || /fetch failed|network|ECONNREFUSED|Failed to fetch/i.test(String(e?.message ?? ''))) {
    return { kind: 'transport', name: 'unreachable', message: 'The network could not be reached. Nothing was sent; try again.' };
  }
  const named = (() => {
    for (let x = e, i = 0; x && i < 8; x = x.cause, i++) if (x.data?.errorName) return x.data.errorName;
    return null;
  })();
  const data = named ? null : revertData(e);
  let name = named;
  if (!name && data) {
    try {
      name = decodeErrorResult({ abi: ERRORS, data }).errorName;
    } catch {
      name = null;
    }
  }
  if (name) return { kind: 'refused', name, message: PLAIN[name] ?? `Refused by the contract: ${name}.` };
  return { kind: 'other', name: 'unknown', message: 'The transaction could not be prepared. Nothing was sent.' };
}
