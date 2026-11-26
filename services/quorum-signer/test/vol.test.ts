import { describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import {
  ANNUAL_STEPS,
  bpsToWad,
  clipBps,
  EwmaVol,
  LAMBDA,
  MAX_SIGMA_BPS,
  MIN_SIGMA_BPS,
  STEP_S,
  type Point,
  MIN_START_RETURNS,
  VolTracker,
} from "../src/vol.ts";
import { overlapsRegularSession } from "@tourbillon/common/session.ts";


/// Deterministic random numbers (mulberry32) and normal draws (Box-Muller).
function rng(seed: number) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u());
}

/// Prices with a constant annual vol on 5-minute steps.
function path(sigma: number, steps: number, seed: number, t0 = 1_800_000_000 - (1_800_000_000 % STEP_S)): Point[] {
  const z = rng(seed);
  const s = sigma / Math.sqrt(ANNUAL_STEPS);
  const out: Point[] = [{ t: t0, px: 100 }];
  for (let i = 1; i <= steps; i++) out.push({ t: t0 + i * STEP_S, px: out[i - 1]!.px * Math.exp(s * z()) });
  return out;
}

describe("EwmaVol maths", () => {
  test("half-life is exactly one day", () => {
    expect(LAMBDA ** 288).toBeCloseTo(0.5, 12);
    expect(ANNUAL_STEPS).toBe(105_120);
  });

  test("recovers a known constant vol (40% and 100%) within 8%", () => {
    for (const [sigma, seed] of [
      [0.4, 1],
      [1.0, 2],
    ] as const) {
      const p = path(sigma, 7 * 288, seed);
      const v = EwmaVol.start(p);
      expect(Math.abs(v.sigma() / sigma - 1)).toBeLessThan(0.08);
      // and keeps tracking live updates for another 3 days
      const more = path(sigma, 3 * 288, seed + 10, p.at(-1)!.t);
      const scale = p.at(-1)!.px / 100;
      for (const q of more.slice(1)) expect(v.update({ t: q.t, px: q.px * scale })).toBe("ok");
      expect(Math.abs(v.sigma() / sigma - 1)).toBeLessThan(0.08);
    }
  });

  test("a vol change is half absorbed after one day", () => {
    const p = path(0.3, 7 * 288, 3);
    const v = EwmaVol.start(p);
    const v0 = v.variance;
    // feed exactly 288 price changes of a fixed size worth 90% annual vol
    const r = 0.9 / Math.sqrt(ANNUAL_STEPS);
    let { t, px } = p.at(-1)!;
    for (let i = 0; i < 288; i++) v.update({ t: (t += STEP_S), px: (px *= Math.exp(i % 2 ? r : -r)) });
    const target = r * r;
    expect((v.variance - v0) / (target - v0)).toBeCloseTo(0.5, 9);
  });

  test("a single 5-minute return is capped at 25%", () => {
    const p = path(0.5, 300, 4);
    const v = EwmaVol.start(p);
    const before = v.variance;
    const last = p.at(-1)!;
    v.update({ t: last.t + STEP_S, px: last.px * 10 }); // a broken print: +230% log return
    expect(v.capped).toBe(1);
    expect(v.variance).toBeCloseTo(LAMBDA * before + (1 - LAMBDA) * 0.0625, 15);
  });

  test("a gap of k steps counts as k steps; over 1 h is refused", () => {
    const p = path(0.5, 300, 5);
    const a = EwmaVol.start(p);
    const b = EwmaVol.start(p);
    const last = p.at(-1)!;
    const r = 0.003;
    a.update({ t: last.t + 3 * STEP_S, px: last.px * Math.exp(r) });
    expect(a.variance).toBeCloseTo(LAMBDA ** 3 * b.variance + (1 - LAMBDA ** 3) * (r * r) / 3, 18);
    expect(a.steps - b.steps).toBe(3);
    expect(a.update({ t: a.lastT + 12 * STEP_S, px: a.lastPx })).toBe("ok"); // exactly 1 h is fine
    expect(a.update({ t: a.lastT + 13 * STEP_S, px: a.lastPx })).toBe("gap-too-long");
  });

  test("same step, out of order and bad prices are ignored", () => {
    const v = EwmaVol.start(path(0.5, 300, 6));
    const { lastT, lastPx, variance } = v;
    expect(v.update({ t: lastT, px: lastPx * 2 })).toBe("same-step");
    expect(v.update({ t: lastT - STEP_S, px: lastPx })).toBe("out-of-order");
    expect(v.update({ t: lastT + STEP_S, px: 0 })).toBe("bad-price");
    expect(v.update({ t: lastT + 1, px: lastPx })).toBe("bad-price");
    expect(v.variance).toBe(variance);
  });

  test("start-up needs at least one day of price changes", () => {
    expect(() => EwmaVol.start(path(0.5, 287, 7))).toThrow("need 289");
    expect(() => EwmaVol.start(path(0.5, 288, 7))).not.toThrow();
  });

  test("clipped to 5–500%, whole bps, WAD encoding reads back exactly", () => {
    expect(clipBps(10)).toBe(MIN_SIGMA_BPS);
    expect(clipBps(90_000)).toBe(MAX_SIGMA_BPS);
    expect(EwmaVol.start(path(0.01, 400, 8)).sigmaBps()).toBe(500);
    expect(EwmaVol.start(path(9, 400, 9)).sigmaBps()).toBe(50_000);
    expect(bpsToWad(4321)).toBe(parseEther("0.4321"));
    expect(bpsToWad(4321) / 10n ** 14n).toBe(4321n); // what QuorumBoard.volBps gives
    expect(() => bpsToWad(4321.5)).toThrow();
    expect(() => bpsToWad(499)).toThrow();
  });
});

describe("VolTracker: this signer's own marks, session-aware for stocks", () => {
  const FRI_CLOSE = Date.parse("2026-11-20T21:00:00Z"); // Friday 16:00 New York
  const feed = (v: VolTracker, pts: Point[], offsetMs = 0) => {
    for (const q of pts) v.sample(q.px, q.t * 1000 + offsetMs);
  };

  test("warms up for one day of steps, then votes; only the first price of a boundary counts", () => {
    const v = new VolTracker(false, () => true);
    const pts = path(0.6, MIN_START_RETURNS, 11);
    feed(v, pts.slice(0, -1));
    expect(v.sigmaBps()).toBeNull(); // one step short
    expect(v.warmSteps).toBe(MIN_START_RETURNS - 1);
    v.sample(pts.at(-1)!.px, pts.at(-1)!.t * 1000 + 1_000);
    v.sample(pts.at(-1)!.px * 3, pts.at(-1)!.t * 1000 + 60_000); // same boundary: ignored
    const est = EwmaVol.start(pts);
    expect(v.sigmaBps()).toBe(est.sigmaBps());
    expect(v.lastPointMs).toBe(pts.at(-1)!.t * 1000 + 1_000);
  });

  test("stocks: a weekend with no regular minute counts as one step, so Monday keeps voting", () => {
    const t0 = FRI_CLOSE / 1000 - MIN_START_RETURNS * STEP_S; // a day of 24/5 trading up to Friday's close
    const v = new VolTracker(true, overlapsRegularSession);
    feed(v, path(0.5, MIN_START_RETURNS, 3, t0));
    const before = v.sigmaBps();
    expect(before).not.toBeNull();
    const mon = Date.parse("2026-11-22T21:00:00Z"); // Sunday evening, before Monday's open
    v.sample(100 * 1.01, mon);
    expect(v.sigmaBps()).not.toBeNull(); // no restart
    expect(v.restarts).toBe(0);
  });

  test("stocks: a long gap during regular hours starts again", () => {
    const tue = Date.parse("2026-11-24T14:30:00Z") / 1000; // Tuesday's open
    const v = new VolTracker(true, overlapsRegularSession);
    feed(v, path(0.5, MIN_START_RETURNS, 5, tue - MIN_START_RETURNS * STEP_S));
    expect(v.sigmaBps()).not.toBeNull();
    v.sample(101, (tue + 2 * 3600) * 1000); // two silent hours in the session
    expect(v.sigmaBps()).toBeNull();
    expect(v.restarts).toBe(1);
  });

  test("crypto: any gap over an hour starts again, weekends included", () => {
    const t0 = FRI_CLOSE / 1000 - MIN_START_RETURNS * STEP_S;
    const v = new VolTracker(false, overlapsRegularSession);
    feed(v, path(0.5, MIN_START_RETURNS, 9, t0));
    expect(v.sigmaBps()).not.toBeNull();
    v.sample(100, Date.parse("2026-11-22T21:00:00Z"));
    expect(v.sigmaBps()).toBeNull();
    expect(v.restarts).toBe(1);
  });

  test("short gaps count as their own steps; bad prices are ignored", () => {
    const v = new VolTracker(false, () => true);
    v.sample(100, 1_800_000_000_000);
    v.sample(Number.NaN, 1_800_000_300_000);
    v.sample(-5, 1_800_000_300_000);
    expect(v.warmSteps).toBe(0);
    v.sample(101, 1_800_000_000_000 + 11 * STEP_S * 1000); // 11 steps: inside the 1 h limit
    expect(v.warmSteps).toBe(1);
    expect(v.restarts).toBe(0);
  });
});
