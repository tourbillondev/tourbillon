import { describe, expect, test } from "bun:test";
import { poolNetDelta, single, targetHedge, unitDelta, type Position } from "../src/delta.ts";
import { plan, roundPrice, roundSize } from "../src/policy.ts";
import { delta } from "../src/tempo.ts";

const DAY = 86_400;

describe("net delta", () => {
  test("the pool is short what holders own; the hedge offsets it", () => {
    const book = [single(true, 70_000, [{ tempo: DAY, weight: 1 }], 10), single(false, 68_000, [{ tempo: 7 * DAY, weight: 1 }], 4)];
    const s = 70_000;
    const expected = 10 * delta(true, s, 70_000, 4500, DAY) + 4 * delta(false, s, 68_000, 4500, 7 * DAY);
    expect(poolNetDelta(book, s, 4500)).toBeCloseTo(-expected, 12);
    expect(targetHedge(book, s, 4500)).toBeCloseTo(expected, 12);
    expect(targetHedge([], s, 4500)).toBeCloseTo(0, 12);
  });

  test("M4: a shape's delta is the sum of its legs; written shapes (the pool long) count the other way", () => {
    const s = 70_000;
    const parts = [{ tempo: DAY, weight: 1 }];
    const spread: Position = { legs: [{ isCall: true, k: 70_000, qty: 1 }, { isCall: true, k: 72_000, qty: -1 }], parts, units: 5 };
    const legSum = delta(true, s, 70_000, 4500, DAY) - delta(true, s, 72_000, 4500, DAY);
    expect(unitDelta(spread, s, 4500)).toBeCloseTo(legSum, 12);
    expect(poolNetDelta([spread], s, 4500)).toBeCloseTo(-5 * legSum, 12);
    // a ratio leg counts its amount
    const ratio: Position = { legs: [{ isCall: true, k: 70_000, qty: -1 }, { isCall: true, k: 73_000, qty: 1.5 }], parts, units: 1 };
    expect(unitDelta(ratio, s, 4500)).toBeCloseTo(-delta(true, s, 70_000, 4500, DAY) + 1.5 * delta(true, s, 73_000, 4500, DAY), 12);
    // the same spread written to the pool (units < 0): the pool is long it, and a bought and a written spread cancel
    const written: Position = { ...spread, units: -5 };
    expect(poolNetDelta([written], s, 4500)).toBeCloseTo(5 * legSum, 12);
    expect(poolNetDelta([spread, written], s, 4500)).toBeCloseTo(0, 12);
  });

  test("M4: WHYPE the pool holds is long delta in coins (decision A)", () => {
    const s = 40;
    const rise = single(true, 44, [{ tempo: DAY, weight: 1 }], 100);
    const base = poolNetDelta([rise], s, 8000);
    expect(poolNetDelta([rise], s, 8000, 12.5)).toBeCloseTo(base + 12.5, 12);
    expect(targetHedge([rise], s, 8000, 12.5)).toBeCloseTo(-base - 12.5, 12);
    expect(targetHedge([], s, 8000, 7)).toBeCloseTo(-7, 12); // short perps against held WHYPE
  });
});

describe("policy", () => {
  test("in band: no order", () => {
    // BTC cap $2.5M at $70,000 → hard limit 35.714 coins, band 3.571
    const p = plan("BTC", 3.5, 0, 70_000, 5, 2_500_000);
    expect(p.reason).toBe("in-band");
    expect(p.orders).toEqual([]);
  });

  test("outside the band: an IOC limit at mid + 0.5%, size rounded down to the size decimals", () => {
    const p = plan("BTC", 5.123456789, 0, 70_000, 5, 2_500_000);
    expect(p.orders).toEqual([{ market: "BTC", side: "buy", sz: 5.12345, limitPx: 70_350, reduceOnly: false, tif: "Ioc" }]);
  });

  test("shrinking without crossing zero is reduce-only; a sell's limit is mid − 0.5%", () => {
    const p = plan("BTC", 1, 10, 70_000, 5, 2_500_000);
    expect(p.orders).toEqual([{ market: "BTC", side: "sell", sz: 9, limitPx: 69_650, reduceOnly: true, tif: "Ioc" }]);
    const flat = plan("BTC", 0, 10, 70_000, 5, 2_500_000);
    expect(flat.orders[0]).toMatchObject({ side: "sell", sz: 10, reduceOnly: true });
  });

  test("crossing zero: a reduce-only close, then an opening order", () => {
    // ETH cap $1.2M at $2,000 → hard limit 600 coins, band 60: from +150 to −200 is far outside it
    const p = plan("ETH", -200, 150, 2_000, 4, 1_200_000);
    expect(p.orders).toEqual([
      { market: "ETH", side: "sell", sz: 150, limitPx: 1990, reduceOnly: true, tif: "Ioc" },
      { market: "ETH", side: "sell", sz: 200, limitPx: 1990, reduceOnly: false, tif: "Ioc" },
    ]);
  });

  test("beyond the hard limit: clipped, and the unhedged remainder is reported", () => {
    // HYPE cap $357,000 at $70 → hard limit 5,100 coins
    const p = plan("HYPE", 6_000, 0, 70, 2, 357_000);
    expect(p.hardLimit).toBeCloseTo(5_100, 9);
    expect(p.target).toBeCloseTo(5_100, 9);
    expect(p.unhedged).toBeCloseTo(900, 9);
    expect(p.orders[0]).toMatchObject({ side: "buy", sz: 5100 });
    const short = plan("HYPE", -7_000, 0, 70, 2, 357_000);
    expect(short.target).toBeCloseTo(-5_100, 9);
    expect(short.unhedged).toBeCloseTo(1_900, 9);
    expect(plan("HYPE", 100, 0, 70, 2, 357_000).unhedged).toBe(0);
  });

  test("below the $10 minimum: no order", () => {
    // a tiny cap so the band is tiny, and an error worth $7
    const p = plan("HYPE", 0.1, 0, 70, 2, 10);
    expect(p.reason).toBe("below-minimum");
    expect(p.orders).toEqual([]);
  });

  test("Hyperliquid size and price rules", () => {
    expect(roundSize(1.23456789, 5)).toBe(1.23456);
    expect(roundSize(0.999999, 2)).toBe(0.99);
    expect(roundPrice(70_351.7, 5, false)).toBe(70_351); // 5 significant figures
    expect(roundPrice(70_351.2, 5, true)).toBe(70_352);
    expect(roundPrice(2_090.4567, 4, false)).toBe(2_090.4); // 5 significant figures
    expect(roundPrice(73.5678, 2, true)).toBe(73.568); // 5 significant figures, ≤ 4 decimals
    expect(roundPrice(0.123456, 0, false)).toBe(0.12345); // ≤ 6 decimals and 5 significant
  });
});
