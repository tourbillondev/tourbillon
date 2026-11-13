import { expect, test } from "bun:test";
import { applyEvents, DUE_BEHIND_S, selectDue, type Series } from "../src/walker.ts";

const BTC = "0x4254430000000000000000000000000000000000000000000000000000000000" as const;
const ETH = "0x4554480000000000000000000000000000000000000000000000000000000000" as const;

test("open raw follows Opened, Bought and Sold in order; never below zero", () => {
  const m = new Map<bigint, Series>();
  applyEvents(m, [
    { kind: "opened", id: 1n, market: BTC },
    { kind: "bought", id: 1n, raw: 100n },
    { kind: "bought", id: 1n, raw: 50n },
    { kind: "opened", id: 2n, market: ETH },
    { kind: "sold", id: 1n, raw: 30n },
    { kind: "opened", id: 1n, market: BTC }, // reopening the same id changes nothing
  ]);
  expect(m.get(1n)).toEqual({ id: 1n, market: BTC, openRaw: 120n });
  expect(m.get(2n)?.openRaw).toBe(0n);
  applyEvents(m, [{ kind: "sold", id: 1n, raw: 500n }]);
  expect(m.get(1n)?.openRaw).toBe(0n);
});

test("M4: writes hold raw of their series until unwritten; a write-only series is walked like a bought one", () => {
  const m = new Map<bigint, Series>();
  const writes = new Map<bigint, bigint>();
  applyEvents(
    m,
    [
      { kind: "opened", id: 7n, market: BTC }, // a shape series (ShapeOpened)
      { kind: "written", writeId: 1n, id: 7n, raw: 300n },
      { kind: "bought", id: 7n, raw: 100n }, // a buyer on the same series (ShapeBought)
      { kind: "written", writeId: 2n, id: 7n, raw: 50n },
    ],
    writes,
  );
  expect(m.get(7n)?.openRaw).toBe(450n);
  // later scans remember each write's series: Unwritten names only the write
  applyEvents(m, [{ kind: "unwritten", writeId: 1n, raw: 120n }], writes);
  expect(m.get(7n)?.openRaw).toBe(330n);
  applyEvents(m, [{ kind: "unwritten", writeId: 1n, raw: 180n }, { kind: "sold", id: 7n, raw: 100n }], writes);
  expect(m.get(7n)?.openRaw).toBe(50n);
  applyEvents(m, [{ kind: "unwritten", writeId: 99n, raw: 1n }], writes); // an unknown write changes nothing
  expect(m.get(7n)?.openRaw).toBe(50n);
  // still held by write 2: due once 8 intervals behind
  const due = selectDue(m.values(), new Map([[7n, 1000]]), new Map([[BTC, 1000 + DUE_BEHIND_S]]));
  expect(due.map((s) => s.id)).toEqual([7n]);
});

test("only series with open positions at least 8 intervals behind are due", () => {
  const series: Series[] = [
    { id: 1n, market: BTC, openRaw: 10n }, // 40 min behind: due
    { id: 2n, market: BTC, openRaw: 10n }, // 39 min 59 s behind: not yet
    { id: 3n, market: BTC, openRaw: 0n }, // far behind but nobody holds it
    { id: 4n, market: ETH, openRaw: 5n }, // ETH far behind: due
  ];
  const latest = new Map<string, number>([
    [BTC, 10_000],
    [ETH, 20_000],
  ]);
  const cursorAt = new Map<bigint, number>([
    [1n, 10_000 - DUE_BEHIND_S],
    [2n, 10_000 - DUE_BEHIND_S + 1],
    [3n, 0],
    [4n, 1_000],
  ]);
  expect(selectDue(series, cursorAt, latest).map((s) => s.id)).toEqual([1n, 4n]);
});
