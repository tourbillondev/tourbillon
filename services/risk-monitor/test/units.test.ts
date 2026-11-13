import { describe, expect, spyOn, test } from "bun:test";
import { Conditions, emit } from "../src/alarm.ts";
import { capHigh, coverageState, DEFAULTS, equityMismatch, hlMarketDown } from "../src/checks.ts";
import { OutageTracker } from "../src/outage.ts";

const MIN = 60_000;

describe("outage timer", () => {
  test("15 minutes of continuous downtime trips once; a healthy pass resets; recovery is reported once", () => {
    const o = new OutageTracker(15 * MIN);
    expect(o.update("BTC", true, 0)).toBe("none");
    expect(o.update("BTC", true, 14 * MIN)).toBe("none");
    expect(o.update("BTC", false, 14.5 * MIN)).toBe("none"); // healthy inside the window: reset, no recovery
    expect(o.update("BTC", true, 15 * MIN)).toBe("none");
    expect(o.update("BTC", true, 29 * MIN)).toBe("none");
    expect(o.update("BTC", true, 30 * MIN)).toBe("trip");
    expect(o.update("BTC", true, 45 * MIN)).toBe("none"); // once only
    expect(o.update("ETH", true, 45 * MIN)).toBe("none"); // per market
    expect(o.update("BTC", false, 46 * MIN)).toBe("recovered");
    expect(o.update("BTC", false, 47 * MIN)).toBe("none");
  });
});

describe("checks", () => {
  test("coverage, caps, EQUITY tolerance and Hyperliquid health", () => {
    expect(coverageState(100, 101, DEFAULTS)).toBe("breached");
    expect(coverageState(109, 100, DEFAULTS)).toBe("low"); // 9% headroom
    expect(coverageState(110, 100, DEFAULTS)).toBe("ok");
    expect(coverageState(5, 0, DEFAULTS)).toBe("ok");
    expect(capHigh(91, 100, DEFAULTS)).toBe(true);
    expect(capHigh(90, 100, DEFAULTS)).toBe(false);
    expect(capHigh(1, 0, DEFAULTS)).toBe(false);
    // tolerance = max(1% of account value, $1,000)
    expect(equityMismatch(10_000, 10_999, 50_000, DEFAULTS)).toBe(false);
    expect(equityMismatch(10_000, 11_001, 50_000, DEFAULTS)).toBe(true);
    expect(equityMismatch(10_000, 14_000, 500_000, DEFAULTS)).toBe(false); // 1% of 500k = 5,000
    expect(equityMismatch(10_000, 16_000, 500_000, DEFAULTS)).toBe(true);
    expect(hlMarketDown(null, 100, DEFAULTS)).toBe(true);
    expect(hlMarketDown(101.5, 100, DEFAULTS)).toBe(true);
    expect(hlMarketDown(100.5, 100, DEFAULTS)).toBe(false);
    expect(hlMarketDown(150, null, DEFAULTS)).toBe(false); // router stale: raised as MARK_STALE instead
  });
});

describe("alarm lines", () => {
  test("a stable shape, announced once when raised and once when cleared", () => {
    const lines: Record<string, unknown>[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => {
      lines.push(JSON.parse(String(s)));
      return true;
    });
    try {
      const c = new Conditions();
      const a = { name: "MARK_STALE" as const, level: "alarm" as const, what: "stale", who: "signer operators", market: "BTC", values: { x: 1 } };
      c.set(true, a, "fresh again");
      c.set(true, a, "fresh again");
      c.set(true, { ...a, market: "ETH" }, "fresh again");
      c.set(false, a, "fresh again");
      c.set(false, a, "fresh again");
      emit({ name: "TREASURY_SENT", state: "event", level: "alarm", what: "sent", who: "treasury operator", market: null, values: { amount: 5 } });
    } finally {
      spy.mockRestore();
    }
    expect(lines.map((l) => `${l.name}:${l.market}:${l.state}`)).toEqual([
      "MARK_STALE:BTC:raised",
      "MARK_STALE:ETH:raised",
      "MARK_STALE:BTC:cleared",
      "TREASURY_SENT:null:event",
    ]);
    for (const l of lines) {
      expect(l.msg).toBe("alarm");
      expect(Object.keys(l).sort()).toEqual(["level", "market", "msg", "name", "state", "t", "values", "what", "who"]);
    }
  });
});
