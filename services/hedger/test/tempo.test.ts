import { describe, expect, test } from "bun:test";
import { blendDelta, blendValue, delta, value } from "../src/tempo.ts";

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
const DAY = 86_400;

describe("TempoMath port", () => {
  test("reference values from the spec and the M0 tests", () => {
    expect(rel(value(true, 100, 100, 5000, DAY), 0.92525)).toBeLessThan(1e-5);
    expect(rel(value(true, 120, 100, 4000, 7 * DAY), 20.0204)).toBeLessThan(1e-5);
    expect(rel(value(false, 100, 120, 4000, 7 * DAY), 20.0204)).toBeLessThan(1e-5);
    expect(rel(value(true, 100, 100, 5000, 3 * DAY), 1.602446)).toBeLessThan(1e-5); // Overview: Rise, 3-day
    const week = value(true, 100, 100, 5000, 7 * DAY);
    expect(rel(week + value(false, 100, 100, 5000, 7 * DAY), 4.894716)).toBeLessThan(1e-5); // Swing
    expect(rel(week - value(true, 100, 110, 5000, 7 * DAY), 2.081145)).toBeLessThan(1e-5); // 100/110 spread
    expect(rel(value(false, 100, 90, 5000, 7 * DAY), 0.269764)).toBeLessThan(1e-5); // Fall 90
  });

  test("parity: call − put = S − K", () => {
    for (const s of [50, 90, 100, 110, 200]) {
      expect(Math.abs(value(true, s, 100, 6000, 2 * DAY) - value(false, s, 100, 6000, 2 * DAY) - (s - 100))).toBeLessThan(1e-9);
    }
  });

  test("analytic delta equals a central finite difference", () => {
    for (const sigma of [1000, 4500, 9000, 30_000]) {
      for (const tempo of [3600, DAY, 7 * DAY, 30 * DAY]) {
        for (const s of [50, 80, 95, 99.9, 100.1, 105, 130, 190]) {
          for (const isCall of [true, false]) {
            const h = s * 1e-6;
            const fd = (value(isCall, s + h, 100, sigma, tempo) - value(isCall, s - h, 100, sigma, tempo)) / (2 * h);
            expect(Math.abs(delta(isCall, s, 100, sigma, tempo) - fd)).toBeLessThan(1e-6);
          }
        }
      }
    }
  });

  test("delta bounds and monotonicity; put = call − 1 (also exactly at S = K); continuity at the strike", () => {
    expect(delta(false, 100, 100, 5000, DAY)).toBeCloseTo(delta(true, 100, 100, 5000, DAY) - 1, 12);
    let prevC = -1;
    for (let s = 40; s <= 250; s += 0.5) {
      const c = delta(true, s, 100, 5000, DAY);
      const p = delta(false, s, 100, 5000, DAY);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
      expect(p).toBeGreaterThanOrEqual(-1);
      expect(p).toBeLessThanOrEqual(0);
      expect(Math.abs(c - p - 1)).toBeLessThan(1e-12);
      expect(c).toBeGreaterThanOrEqual(prevC);
      prevC = c;
    }
    expect(Math.abs(delta(true, 100 - 1e-9, 100, 5000, DAY) - delta(true, 100 + 1e-9, 100, 5000, DAY))).toBeLessThan(1e-6);
  });

  test("a Movement is the weighted sum; domain refused", () => {
    const parts = [
      { tempo: 3600, weight: 0.2 },
      { tempo: DAY, weight: 0.5 },
      { tempo: 7 * DAY, weight: 0.3 },
    ];
    const v = 0.2 * value(true, 105, 100, 6000, 3600) + 0.5 * value(true, 105, 100, 6000, DAY) + 0.3 * value(true, 105, 100, 6000, 7 * DAY);
    expect(Math.abs(blendValue(true, 105, 100, 6000, parts) - v)).toBeLessThan(1e-12);
    const d = 0.2 * delta(false, 95, 100, 6000, 3600) + 0.5 * delta(false, 95, 100, 6000, DAY) + 0.3 * delta(false, 95, 100, 6000, 7 * DAY);
    expect(Math.abs(blendDelta(false, 95, 100, 6000, parts) - d)).toBeLessThan(1e-12);
    expect(() => value(true, 100, 100, 5000, 3599)).toThrow("out of range");
    expect(() => value(true, 0, 100, 5000, DAY)).toThrow("positive");
  });
});
