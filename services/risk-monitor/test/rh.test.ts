import { describe, expect, test } from "bun:test";
import { inventoryMismatch, markRound, quarterCapHigh, splitRatio } from "../src/rh.ts";

const W = 10n ** 18n;

describe("RH7 checks", () => {
  test("split: the median a split ratio away from the clamped published mark", () => {
    expect(splitRatio(20n * W, 39n * W)).toBe(0.5); // a 2-for-1 split: signers say 20, the clamp keeps 39
    expect(splitRatio(13n * W, 40n * W)).toBeCloseTo(1 / 3, 9); // 3-for-1
    expect(splitRatio(400n * W, 40n * W)).toBe(10); // a 1-for-10 reverse split
    expect(splitRatio(36n * W, 40n * W)).toBeNull(); // a 10% gap is not a split
    expect(splitRatio(25n * W, 40n * W)).toBeNull(); // a 37.5% drop, but no split ratio
    expect(splitRatio(0n, 40n * W)).toBeNull();
    expect(markRound(20n * W, 39n * W, true)).toBe("split");
  });

  test("anchored: outside the session the published value differs from the median", () => {
    expect(markRound(42n * W, 41n * W, false)).toBe("anchored");
    expect(markRound(42n * W, 41n * W, true)).toBeNull(); // in session the step clamp is ordinary
    expect(markRound(41n * W, 41n * W, false)).toBeNull();
  });

  test("quarter caps on closed days", () => {
    expect(quarterCapHigh(230_000, 1_000_000, 2500, 0.9)).toBe(true); // 230k of a 250k reduced cap
    expect(quarterCapHigh(200_000, 1_000_000, 2500, 0.9)).toBe(false);
    expect(quarterCapHigh(950_000, 1_000_000, 10_000, 0.9)).toBe(false); // full caps: that is cap-high's job
    expect(quarterCapHigh(1, 0, 2500, 0.9)).toBe(false);
  });

  test("inventory off its target by more than twice the band", () => {
    expect(inventoryMismatch(100, 300, 50)).toBe(true);
    expect(inventoryMismatch(250, 300, 50)).toBe(false);
    expect(inventoryMismatch(0, 0, 0)).toBe(false);
  });
});
