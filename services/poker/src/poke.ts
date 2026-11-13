/// When to poke. Pure: every input is passed in.
///
/// The book takes at most one level-0 sample per 5-minute window. Two pokers run (spec: "Tourbillon runs two"): the
/// primary pokes from 5 s into each window, the backup from 35 s, and each only if the window has no sample yet, so
/// in the normal case only one pays. A collision is harmless: the book ignores a second sample in the same window.

export const WINDOW_S = 300;
export type Role = "primary" | "backup";
export const ROLE_OFFSET_S: Record<Role, number> = { primary: 5, backup: 35 };
/// Alarm after this many whole windows in a row without a sample (15 minutes).
export const ALARM_AFTER_MISSED = 3;

export function windowStart(t: number): number {
  return t - (t % WINDOW_S);
}

export type PokeDecision = "poke" | "sampled" | "wait";

/// `latestSampleT` is 0 when the market has no sample yet.
export function decidePoke(role: Role, now: number, latestSampleT: number): PokeDecision {
  const w = windowStart(now);
  if (latestSampleT >= w) return "sampled";
  if (now - w < ROLE_OFFSET_S[role]) return "wait";
  return "poke";
}

/// Whole windows in a row that ended without a sample (the current window, still open, is not counted).
export function missedWindows(now: number, latestSampleT: number): number {
  if (latestSampleT === 0) return 0; // never sampled: nothing to miss yet
  const missed = (windowStart(now) - windowStart(latestSampleT)) / WINDOW_S - 1;
  return missed > 0 ? missed : 0;
}

/// Windows a sample is due in during [start, end): each window whose +40 s point falls inside, by which time the
/// primary (+5 s) or the backup (+35 s) must have poked it. Used by the end-to-end run's coverage check.
export function windowsDueIn(start: number, end: number): number[] {
  const out: number[] = [];
  for (let w = windowStart(start - 40); w + 40 < end; w += WINDOW_S) if (w + 40 >= start) out.push(w);
  return out;
}
