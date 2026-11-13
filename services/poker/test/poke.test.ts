import { describe, expect, test } from "bun:test";
import { ALARM_AFTER_MISSED, decidePoke, missedWindows, windowsDueIn, windowStart } from "../src/poke.ts";

const W = 1_800_000_000 - (1_800_000_000 % 300); // a window start

describe("poke timing", () => {
  test("window start", () => {
    expect(windowStart(W)).toBe(W);
    expect(windowStart(W + 299)).toBe(W);
    expect(windowStart(W + 300)).toBe(W + 300);
  });

  test("primary pokes from +5 s, backup from +35 s, only while the window is unsampled", () => {
    const prev = W - 300;
    expect(decidePoke("primary", W + 4, prev)).toBe("wait");
    expect(decidePoke("primary", W + 5, prev)).toBe("poke");
    expect(decidePoke("backup", W + 34, prev)).toBe("wait");
    expect(decidePoke("backup", W + 35, prev)).toBe("poke");
    expect(decidePoke("primary", W + 100, W + 6)).toBe("sampled");
    expect(decidePoke("backup", W + 100, W + 6)).toBe("sampled");
    expect(decidePoke("primary", W + 10, 0)).toBe("poke"); // never sampled
  });

  test("missed windows count whole windows only; alarm at 3 (15 minutes)", () => {
    expect(missedWindows(W + 10, W - 300)).toBe(0); // the previous window had its sample
    expect(missedWindows(W + 10, W - 600)).toBe(1);
    expect(missedWindows(W + 299, W - 900)).toBe(2);
    expect(missedWindows(W + 10, W - 1200)).toBe(ALARM_AFTER_MISSED);
    expect(missedWindows(W + 10, W + 5)).toBe(0);
    expect(missedWindows(W + 10, 0)).toBe(0);
  });

  test("windows due in a phase: those whose +40 s point falls inside it", () => {
    expect(windowsDueIn(W, W + 300)).toEqual([W]); // a 5-minute phase aligned to a window
    expect(windowsDueIn(W + 100, W + 400)).toEqual([W + 300]); // starts after W+40, ends after W+340
    expect(windowsDueIn(W + 30, W + 41)).toEqual([W]);
    expect(windowsDueIn(W + 41, W + 300)).toEqual([]); // W's +40 s passed before the phase began
    expect(windowsDueIn(W, W + 1800)).toHaveLength(6); // 30 minutes
    // the step 9 run, phase C (23:43:33 to 23:48:43 wall time, windows at :x5:05 wall): one window due
    expect(windowsDueIn(W + 268, W + 578)).toEqual([W + 300]);
  });
});
