/// Realised vol, exponentially weighted, on 5-minute log returns (owner decisions, M1):
/// - λ = 2^(−1/288) per 5-minute step: a return's weight halves after one day;
/// - var ← λ·var + (1−λ)·r², no mean subtracted;
/// - σ = √(var · 365 · 288), clipped to 5–500%, voted in whole bps;
/// - a single 5-minute return is capped at 25% (bad data must not inflate vol for days);
/// - a gap of k steps counts as k steps (λ^k decay, r² spread over k); a gap over 1 h needs a fresh start.
/// Pure maths: no clock, no network.

export const STEP_S = 300;
export const HALF_LIFE_STEPS = 288;
export const LAMBDA = 2 ** (-1 / HALF_LIFE_STEPS);
export const ANNUAL_STEPS = 365 * 288;
export const MIN_SIGMA_BPS = 500;
export const MAX_SIGMA_BPS = 50_000;
export const MAX_STEP_RETURN = 0.25;
export const MAX_GAP_STEPS = 12; // 1 h
export const MIN_START_RETURNS = 288; // at least 1 day before VOL votes

/// A price at a 5-minute boundary (seconds since epoch, a multiple of STEP_S).
export type Point = { t: number; px: number };

export type UpdateResult = "ok" | "same-step" | "out-of-order" | "gap-too-long" | "bad-price";

export class EwmaVol {
  private constructor(
    public variance: number, // per 5-minute step
    public lastT: number,
    public lastPx: number,
    public steps: number, // returns absorbed, counted in steps
    public capped: number, // returns that hit the cap
  ) {}

  /// Starts from a run of boundary prices (candle closes), oldest first. The variance starts at the mean
  /// squared return of the run (no bias toward zero), then the run is replayed through the update rule.
  static start(points: Point[]): EwmaVol {
    if (points.length < MIN_START_RETURNS + 1) throw new Error(`need ${MIN_START_RETURNS + 1} prices, got ${points.length}`);
    const first = points[0]!;
    checkPoint(first);
    let sum = 0;
    let n = 0;
    for (let i = 1; i < points.length; i++) {
      const p = points[i]!;
      const q = points[i - 1]!;
      checkPoint(p);
      const k = (p.t - q.t) / STEP_S;
      if (!Number.isInteger(k) || k < 1) throw new Error("start prices must be strictly increasing on 5-minute steps");
      if (k > MAX_GAP_STEPS) throw new Error(`gap of ${k} steps in the start prices`);
      sum += cappedSq(Math.log(p.px / q.px), k);
      n += k;
    }
    const v = new EwmaVol(sum / n, first.t, first.px, 0, 0);
    for (let i = 1; i < points.length; i++) v.update(points[i]!);
    return v;
  }

  /// Absorbs the price at the next boundary.
  update(p: Point): UpdateResult {
    if (!(p.px > 0) || !Number.isFinite(p.px) || p.t % STEP_S !== 0) return "bad-price";
    if (p.t === this.lastT) return "same-step";
    if (p.t < this.lastT) return "out-of-order";
    const k = (p.t - this.lastT) / STEP_S;
    if (k > MAX_GAP_STEPS) return "gap-too-long";
    const r = Math.log(p.px / this.lastPx);
    const sq = cappedSq(r, k);
    if (sq < (r * r) / k) this.capped++;
    const decay = LAMBDA ** k;
    this.variance = decay * this.variance + (1 - decay) * sq;
    this.lastT = p.t;
    this.lastPx = p.px;
    this.steps += k;
    return "ok";
  }

  /// Annualised σ, unclipped.
  sigma(): number {
    return Math.sqrt(this.variance * ANNUAL_STEPS);
  }

  /// σ in whole bps, clipped to 5–500%.
  sigmaBps(): number {
    return clipBps(Math.round(this.sigma() * 10_000));
  }
}

/// r² per step for a return over k steps, with each step's share capped at MAX_STEP_RETURN.
function cappedSq(r: number, k: number): number {
  return Math.min((r * r) / k, MAX_STEP_RETURN * MAX_STEP_RETURN);
}

function checkPoint(p: Point): void {
  if (!(p.px > 0) || !Number.isFinite(p.px) || p.t % STEP_S !== 0) throw new Error(`bad start price at ${p.t}`);
}

export function clipBps(bps: number): number {
  return Math.min(MAX_SIGMA_BPS, Math.max(MIN_SIGMA_BPS, bps));
}

/// The value voted on the board: a WAD fraction, so the board's volBps (value / 1e14) reads back `bps` exactly.
export function bpsToWad(bps: number): bigint {
  if (!Number.isInteger(bps) || bps < MIN_SIGMA_BPS || bps > MAX_SIGMA_BPS) throw new Error(`bps out of range: ${bps}`);
  return BigInt(bps) * 10n ** 14n;
}
