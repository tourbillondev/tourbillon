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
    public steps: number, // price changes absorbed, counted in steps
    public capped: number, // price changes that hit the cap
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

/// Follows one market's vol from this signer's own accepted marks (owner queue Q8: no outside vol source yet). It keeps
/// the first price of each 5-minute boundary, warms up until one day of steps is in (MIN_START_RETURNS), then votes.
///
/// Gaps (choice C3): a gap longer than MAX_GAP_STEPS normally starts again from nothing (a stale history must not set
/// vol). For a tokenized-stock market, a gap that holds no regular-session minute (a night, a weekend, a holiday) counts
/// as a single step instead: closed time is not trading time, and without this every Monday would start a fresh day of
/// warm-up with no vol vote. A long gap during regular hours still starts again. Crypto has no session: any long gap
/// starts again. Pure: the session test is passed in.
export class VolTracker {
  private warm: Point[] = [];
  private est: EwmaVol | null = null;
  private lastRealT = -1; // seconds, real boundary time of the last price kept
  private shiftS = 0; // closed time skipped so far, taken off every later boundary
  lastPointMs = 0; // wall-clock time of the last price kept, for the reading's age
  restarts = 0;

  constructor(
    readonly sessionAware: boolean,
    private readonly overlapsSession: (fromMs: number, toMs: number) => boolean,
  ) {}

  /// Absorbs a price seen at `atMs`; only the first price of each 5-minute boundary counts.
  sample(px: number, atMs: number): void {
    if (!(px > 0) || !Number.isFinite(px)) return;
    const t = Math.floor(atMs / 1000 / STEP_S) * STEP_S;
    if (this.lastRealT >= 0) {
      if (t <= this.lastRealT) return; // same boundary, or out of order
      const k = (t - this.lastRealT) / STEP_S;
      if (k > MAX_GAP_STEPS) {
        if (this.sessionAware && !this.overlapsSession(this.lastRealT * 1000, t * 1000)) this.shiftS += (k - 1) * STEP_S;
        else this.restart();
      }
    }
    const p = { t: t - this.shiftS, px };
    this.lastRealT = t;
    this.lastPointMs = atMs;
    if (this.est) {
      this.est.update(p);
      return;
    }
    this.warm.push(p);
    if (this.warm.length >= MIN_START_RETURNS + 1) {
      this.est = EwmaVol.start(this.warm);
      this.warm = [];
    }
  }

  private restart(): void {
    this.est = null;
    this.warm = [];
    this.shiftS = 0;
    this.restarts++;
  }

  /// Vol in whole bps (clipped to 5–500%), or null while warming up.
  sigmaBps(): number | null {
    return this.est ? this.est.sigmaBps() : null;
  }

  /// Unclipped σ in bps, for the "clipped" warning.
  rawBps(): number | null {
    return this.est ? Math.round(this.est.sigma() * 10_000) : null;
  }

  get warmSteps(): number {
    return this.est ? MIN_START_RETURNS : Math.max(0, this.warm.length - 1);
  }
}
