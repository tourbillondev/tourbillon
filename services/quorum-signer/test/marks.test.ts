import { describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import { cryptoMark, MAX_AGE_MS, median, outsideBand, stockMark } from "../src/marks.ts";

const NOW = 1_795_014_000_000;
const p = (px: string, ageMs = 1_000) => ({ px: parseEther(px), atMs: NOW - ageMs });

describe("the 1% band", () => {
  test("exactly 1% passes, a hair more is refused, both directions", () => {
    expect(outsideBand(parseEther("101"), parseEther("100"), 100n)).toBe(false);
    expect(outsideBand(parseEther("99"), parseEther("100"), 100n)).toBe(false);
    expect(outsideBand(parseEther("101.000001"), parseEther("100"), 100n)).toBe(true);
    expect(outsideBand(parseEther("98.999999"), parseEther("100"), 100n)).toBe(true);
  });

  test("fuzz: the band check matches its definition", () => {
    let seed = 7;
    const r = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed);
    for (let i = 0; i < 2_000; i++) {
      const b = BigInt(r()) * 10n ** 12n + 1n;
      const a = b + BigInt(r() % 3_000_000) * 10n ** 9n - 1_500_000n * 10n ** 9n;
      if (a <= 0n) continue;
      const diff = a > b ? a - b : b - a;
      expect(outsideBand(a, b, 100n)).toBe(diff * 10_000n > b * 100n);
    }
  });
});

describe("stocks: the on-chain token price, checked against the equity reference in session", () => {
  test("in session and agreeing: the on-chain price is voted", () => {
    expect(stockMark(p("412.3"), p("412.0", 30_000), NOW, true)).toEqual({ ok: true, px: parseEther("412.3"), atMs: NOW - 1_000, note: "checked" });
  });

  test("in session: no reference, a stale reference, or more than 1% apart means no vote", () => {
    expect(stockMark(p("412"), null, NOW, true)).toEqual({ ok: false, reason: "no-reference" });
    expect(stockMark(p("412"), p("412", MAX_AGE_MS.reference + 1), NOW, true)).toEqual({ ok: false, reason: "stale-reference" });
    expect(stockMark(p("420"), p("412"), NOW, true)).toEqual({ ok: false, reason: "disagree" });
  });

  test("out of session: the token price alone (the anchor band caps it on the board)", () => {
    expect(stockMark(p("420"), null, NOW, false)).toEqual({ ok: true, px: parseEther("420"), atMs: NOW - 1_000, note: "out-of-session" });
    expect(stockMark(p("420"), p("300"), NOW, false).ok).toBe(true); // a closed reference is not used
  });

  test("never without a fresh on-chain price, in or out of session", () => {
    for (const s of [true, false]) {
      expect(stockMark(null, p("412"), NOW, s)).toEqual({ ok: false, reason: "no-onchain" });
      expect(stockMark(p("412", MAX_AGE_MS.voted + 1), p("412"), NOW, s)).toEqual({ ok: false, reason: "stale-onchain" });
      expect(stockMark({ px: parseEther("412"), atMs: NOW + 6_000 }, p("412"), NOW, s)).toEqual({ ok: false, reason: "stale-onchain" }); // from the future
    }
  });
});

describe("crypto: the exchange median, checked against Pyth", () => {
  test("median of odd and even counts, whatever the order", () => {
    expect(median([3n, 1n, 2n])).toBe(2n);
    expect(median([4n, 1n, 3n, 2n])).toBe(2n); // (2 + 3) / 2 rounded down
    expect(median([10n])).toBe(10n);
  });

  test("three exchanges agree with Pyth: the median is voted, timed at its oldest input", () => {
    const r = cryptoMark([p("97100", 2_000), p("97130", 1_000), p("97120", 3_000)], p("97125"), NOW);
    expect(r).toEqual({ ok: true, px: parseEther("97120"), atMs: NOW - 3_000, note: "checked" });
  });

  test("one wild exchange cannot move the median", () => {
    const r = cryptoMark([p("97100"), p("97130"), p("150000")], p("97125"), NOW);
    expect(r.ok && r.px).toBe(parseEther("97130"));
  });

  test("fewer than two fresh exchanges, no Pyth, stale Pyth, or more than 1% from Pyth: no vote", () => {
    expect(cryptoMark([p("97100"), null, p("97100", MAX_AGE_MS.voted + 1)], p("97100"), NOW)).toEqual({ ok: false, reason: "too-few-exchanges" });
    expect(cryptoMark([p("97100"), p("97110")], null, NOW)).toEqual({ ok: false, reason: "no-pyth" });
    expect(cryptoMark([p("97100"), p("97110")], p("97100", MAX_AGE_MS.reference + 1), NOW)).toEqual({ ok: false, reason: "stale-pyth" });
    expect(cryptoMark([p("97100"), p("97110")], p("95000"), NOW)).toEqual({ ok: false, reason: "disagree" });
  });

  test("two exchanges are enough", () => {
    expect(cryptoMark([p("97100"), null, p("97110")], p("97100"), NOW)).toEqual({ ok: true, px: parseEther("97105"), atMs: NOW - 1_000, note: "checked" });
  });
});
