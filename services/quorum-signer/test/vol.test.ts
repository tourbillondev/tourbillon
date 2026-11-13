import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { parseEther } from "viem";
import { parseCandles } from "../src/hyperliquid.ts";
import { HyperliquidSource, START_RETRY_MS } from "../src/source.ts";
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
} from "../src/vol.ts";

// Real reply, trimmed: the last 400 complete BTC 5-minute candles before 2026-11-11 15:45 UTC.
const candles = await Bun.file(new URL("./fixtures/candles_BTC_5m.json", import.meta.url)).json();
const LAST_CLOSE_S = candles.at(-1).t / 1000 + STEP_S;
const meta = await Bun.file(new URL("./fixtures/metaAndAssetCtxs.json", import.meta.url)).json();

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
    // feed exactly 288 returns of a fixed size worth 90% annual vol
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

  test("start-up needs at least one day of returns", () => {
    expect(() => EwmaVol.start(path(0.5, 287, 7))).toThrow("need 289");
    expect(() => EwmaVol.start(path(0.5, 288, 7))).not.toThrow();
  });

  test("clipped to 5–500%, whole bps, WAD encoding reads back exactly", () => {
    expect(clipBps(10)).toBe(MIN_SIGMA_BPS);
    expect(clipBps(90_000)).toBe(MAX_SIGMA_BPS);
    expect(EwmaVol.start(path(0.01, 400, 8)).sigmaBps()).toBe(500);
    expect(EwmaVol.start(path(9, 400, 9)).sigmaBps()).toBe(50_000);
    expect(bpsToWad(4321)).toBe(parseEther("0.4321"));
    expect(bpsToWad(4321) / 10n ** 14n).toBe(4321n); // what QuorumBoard.volBps returns
    expect(() => bpsToWad(4321.5)).toThrow();
    expect(() => bpsToWad(499)).toThrow();
  });
});

describe("candles", () => {
  test("real reply: closes become boundary prices, time-ordered", () => {
    const pts = parseCandles(candles, "BTC", (LAST_CLOSE_S + 10) * 1000);
    expect(pts.length).toBe(400);
    expect(pts[0]!.t).toBe(candles[0].t / 1000 + STEP_S);
    expect(pts.at(-1)!.px).toBe(Number(candles.at(-1).c));
    const v = EwmaVol.start(pts);
    expect(v.sigmaBps()).toBeGreaterThan(MIN_SIGMA_BPS);
    expect(v.sigmaBps()).toBeLessThan(MAX_SIGMA_BPS);
  });

  test("an open candle is dropped; malformed replies are refused", () => {
    expect(parseCandles(candles, "BTC", candles.at(-1).T).length).toBe(399);
    expect(() => parseCandles(candles, "ETH", Date.now())).toThrow("wrong coin");
    expect(() => parseCandles({}, "BTC", Date.now())).toThrow("not a list");
    const bad = structuredClone(candles);
    bad[5].c = "1e5";
    expect(() => parseCandles(bad, "BTC", Date.now())).toThrow();
    const swapped = structuredClone(candles);
    [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
    expect(() => parseCandles(swapped, "BTC", Date.now())).toThrow("time order");
  });
});

describe("HyperliquidSource VOL against a local fake server", () => {
  let mark = "74000.0";
  let candleMode: "ok" | "500" = "ok";
  const bodies: string[] = [];
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.text();
        bodies.push(body);
        if (new URL(req.url).pathname !== "/info") return new Response("no", { status: 404 });
        const q = JSON.parse(body);
        if (q.type === "candleSnapshot") {
          if (candleMode === "500") return new Response("down", { status: 500 });
          return Response.json(candles);
        }
        const m = structuredClone(meta);
        m[1][0].markPx = mark;
        m[1][0].oraclePx = mark;
        return Response.json(m);
      },
    });
  });
  afterAll(() => server.stop(true));

  test("starts from candles, samples the first mark of each 5-minute boundary, ages correctly", async () => {
    const quiet = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      bodies.length = 0;
      let t = (LAST_CLOSE_S + 10) * 1000; // 10 s after the last candle closed
      const src = new HyperliquidSource(["BTC"], `http://127.0.0.1:${server.port}`, 3_000, () => t);
      const chainNow = 1_900_000_000;

      const first = await src.read("BTC", "VOL", chainNow);
      expect(first).not.toBeNull();
      const q = JSON.parse(bodies.find((b) => b.includes("candleSnapshot"))!);
      expect(q.req).toMatchObject({ coin: "BTC", interval: "5m", endTime: t, startTime: t - 7 * 86_400_000 });
      expect(first!.at).toBe(chainNow - 10); // the last candle close was 10 s ago
      expect(first!.value % 10n ** 14n).toBe(0n); // whole bps
      const est = src.vols.get("BTC")!.est!;
      const steps0 = est.steps;

      // Same boundary as the last candle close: not sampled again
      await src.read("BTC", "MARK", chainNow);
      expect(est.steps).toBe(steps0);

      // Next boundary: the first mark is sampled, later marks in the same boundary are not
      t += 300_000;
      mark = "74100.0";
      await src.read("BTC", "MARK", chainNow);
      expect(est.steps).toBe(steps0 + 1);
      expect(est.lastPx).toBe(74100);
      t += 20_000;
      mark = "80000.0";
      await src.read("BTC", "MARK", chainNow);
      expect(est.lastPx).toBe(74100);

      // The reading's age is the time since that sample
      expect((await src.read("BTC", "VOL", chainNow))!.at).toBe(chainNow - 20);
    } finally {
      quiet.mockRestore();
    }
  });

  test("a failed start-up gives no reading and is retried after a minute, not every tick", async () => {
    const quiet = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      let t = (LAST_CLOSE_S + 10) * 1000;
      const src = new HyperliquidSource(["BTC"], `http://127.0.0.1:${server.port}`, 3_000, () => t);
      candleMode = "500";
      bodies.length = 0;
      expect(await src.read("BTC", "VOL", 1)).toBeNull();
      t += 20_000;
      expect(await src.read("BTC", "VOL", 1)).toBeNull();
      expect(bodies.filter((b) => b.includes("candleSnapshot")).length).toBe(1);
      candleMode = "ok";
      t += START_RETRY_MS;
      // candles are now 80 s older than the clock: still recent enough
      expect(await src.read("BTC", "VOL", 1)).not.toBeNull();
    } finally {
      candleMode = "ok";
      quiet.mockRestore();
    }
  });

  test("a gap over 1 h starts again from candles", async () => {
    const quiet = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      let t = (LAST_CLOSE_S + 10) * 1000;
      const src = new HyperliquidSource(["BTC"], `http://127.0.0.1:${server.port}`, 3_000, () => t);
      expect(await src.read("BTC", "VOL", 1)).not.toBeNull();
      t += 2 * 3_600_000; // two hours with no samples
      await src.read("BTC", "MARK", 1);
      expect(src.vols.get("BTC")!.est).toBeNull();
      // the candles on this server are now 2 h old, so the fresh start is refused: no reading, never stale vol
      expect(await src.read("BTC", "VOL", 1)).toBeNull();
    } finally {
      quiet.mockRestore();
    }
  });
});

// Opt-in: HL_LIVE=1 bun test test/vol.test.ts
test.skipIf(process.env.HL_LIVE !== "1")("live: σ for BTC, ETH and HYPE from 7 days of candles", async () => {
  const quiet = spyOn(process.stdout, "write").mockImplementation(() => true);
  const src = new HyperliquidSource(["BTC", "ETH", "HYPE"]);
  const out: string[] = [];
  try {
    for (const m of ["BTC", "ETH", "HYPE"]) {
      const r = await src.read(m, "VOL", Math.floor(Date.now() / 1000));
      expect(r).not.toBeNull();
      const est = src.vols.get(m)!.est!;
      out.push(`live ${m}: sigma ${(Number(r!.value / 10n ** 14n) / 100).toFixed(2)}% (${r!.value / 10n ** 14n} bps), ${est.steps} steps, ${est.capped} capped`);
    }
  } finally {
    quiet.mockRestore();
  }
  for (const l of out) console.log(l);
}, 30_000);
