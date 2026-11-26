/// Each signer's two-source check (Backend §4: "dual-source inside the quorum … disagreement → refuse"). Pure: every
/// reading and the time are passed in. A refusal means this signer does not vote; if enough signers refuse, the board
/// goes stale and opens on that market close (law 2). Sells keep using the last good sample.
import type { Price } from "./feeds.ts";

/// Stocks, during the regular session: the on-chain token price and the equity reference must agree within 1% (G4).
export const STOCK_BAND_BPS = 100n;
/// Crypto: the exchange median and Pyth must agree within 1% (C2: the same band as stocks; G5 sets no number).
export const CRYPTO_BAND_BPS = 100n;
/// Two exchanges at least, so one bad venue cannot set the median alone.
export const MIN_EXCHANGES = 2;

/// Oldest reading each input may be. A voted price must be as fresh as a vote (10 s, decide.ts); a cross-check
/// reference may be a little older, since it only bounds the voted price.
export const MAX_AGE_MS = { voted: 10_000, reference: 60_000 } as const;

export type MarkCheck =
  | { ok: true; px: bigint; atMs: number; note: "checked" | "out-of-session" }
  | { ok: false; reason: "no-onchain" | "stale-onchain" | "no-reference" | "stale-reference" | "disagree" | "too-few-exchanges" | "no-pyth" | "stale-pyth" };

const fresh = (p: Price | null, nowMs: number, maxAgeMs: number) => p !== null && nowMs - p.atMs <= maxAgeMs && p.atMs <= nowMs + 5_000;

/// |a − b| > band (in bps of b).
export function outsideBand(a: bigint, b: bigint, bandBps: bigint): boolean {
  const diff = a > b ? a - b : b - a;
  return diff * 10_000n > b * bandBps;
}

/// Stock markets. The vote is the on-chain token price (the "Robinhood Chain mark", Overview §3). During the regular
/// session it must agree with the off-chain equity reference; outside it the reference is closed, so the token price is
/// voted alone and the board's anchor band caps it (Backend §4: weekend and out-of-hours marks are anchored, ±10%).
export function stockMark(onchain: Price | null, reference: Price | null, nowMs: number, inSession: boolean): MarkCheck {
  if (onchain === null) return { ok: false, reason: "no-onchain" };
  if (!fresh(onchain, nowMs, MAX_AGE_MS.voted)) return { ok: false, reason: "stale-onchain" };
  if (!inSession) return { ok: true, px: onchain.px, atMs: onchain.atMs, note: "out-of-session" };
  if (reference === null) return { ok: false, reason: "no-reference" };
  if (!fresh(reference, nowMs, MAX_AGE_MS.reference)) return { ok: false, reason: "stale-reference" };
  if (outsideBand(onchain.px, reference.px, STOCK_BAND_BPS)) return { ok: false, reason: "disagree" };
  return { ok: true, px: onchain.px, atMs: onchain.atMs, note: "checked" };
}

/// Median of bigints (the lower-middle average for an even count, rounded down).
export function median(xs: bigint[]): bigint {
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2n;
}

/// Crypto markets (G5): the median of fresh exchange prices, checked against Pyth. No weekend rule for crypto.
export function cryptoMark(exchanges: (Price | null)[], pyth: Price | null, nowMs: number): MarkCheck {
  const used = exchanges.filter((p): p is Price => fresh(p, nowMs, MAX_AGE_MS.voted));
  if (used.length < MIN_EXCHANGES) return { ok: false, reason: "too-few-exchanges" };
  const px = median(used.map((p) => p.px));
  if (pyth === null) return { ok: false, reason: "no-pyth" };
  if (!fresh(pyth, nowMs, MAX_AGE_MS.reference)) return { ok: false, reason: "stale-pyth" };
  if (outsideBand(px, pyth.px, CRYPTO_BAND_BPS)) return { ok: false, reason: "disagree" };
  return { ok: true, px, atMs: Math.min(...used.map((p) => p.atMs)), note: "checked" };
}
