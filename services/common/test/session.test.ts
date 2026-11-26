import { expect, test } from "bun:test";
import { CALENDAR, EARLY_CLOSES, HOLIDAYS, isClosedDay, isRegularSession, overlapsRegularSession, yearOfDay } from "../src/session.ts";

const utc = (s: string) => Date.parse(s);

test("regular hours on a normal weekday, in both daylight-saving seasons", () => {
  // Tuesday 2026-11-24: New York is UTC−5 (standard time) → 09:30 = 14:30 UTC, 16:00 = 21:00 UTC
  expect(isRegularSession(utc("2026-11-24T14:29:59Z"))).toBe(false);
  expect(isRegularSession(utc("2026-11-24T14:30:00Z"))).toBe(true);
  expect(isRegularSession(utc("2026-11-24T20:59:59Z"))).toBe(true);
  expect(isRegularSession(utc("2026-11-24T21:00:00Z"))).toBe(false);
  // Wednesday 2026-07-15: UTC−4 (daylight time) → 09:30 = 13:30 UTC, 16:00 = 20:00 UTC
  expect(isRegularSession(utc("2026-07-15T13:29:00Z"))).toBe(false);
  expect(isRegularSession(utc("2026-07-15T13:30:00Z"))).toBe(true);
  expect(isRegularSession(utc("2026-07-15T19:59:00Z"))).toBe(true);
  expect(isRegularSession(utc("2026-07-15T20:00:00Z"))).toBe(false);
});

test("the daylight-saving switch days", () => {
  // Monday 2026-03-09, the first weekday after the spring switch (2026-03-08): already UTC−4
  expect(isRegularSession(utc("2026-03-09T13:30:00Z"))).toBe(true);
  expect(isRegularSession(utc("2026-03-09T13:29:00Z"))).toBe(false);
  // Monday 2026-11-02, the first weekday after the autumn switch (2026-11-01): back to UTC−5
  expect(isRegularSession(utc("2026-11-02T13:30:00Z"))).toBe(false);
  expect(isRegularSession(utc("2026-11-02T14:30:00Z"))).toBe(true);
});

test("weekends, holidays and early closes", () => {
  expect(isRegularSession(utc("2026-11-28T15:00:00Z"))).toBe(false); // Saturday
  expect(isRegularSession(utc("2026-11-29T15:00:00Z"))).toBe(false); // Sunday
  expect(isRegularSession(utc("2026-11-26T15:00:00Z"))).toBe(false); // Thanksgiving
  expect(isRegularSession(utc("2026-07-03T15:00:00Z"))).toBe(false); // Independence Day, observed
  // the day after Thanksgiving closes at 13:00 New York (18:00 UTC)
  expect(isRegularSession(utc("2026-11-27T17:59:00Z"))).toBe(true);
  expect(isRegularSession(utc("2026-11-27T18:00:00Z"))).toBe(false);
  for (const d of HOLIDAYS) expect(isRegularSession(utc(`${d}T16:00:00Z`))).toBe(false);
  for (const d of EARLY_CLOSES) expect(isRegularSession(utc(`${d}T15:00:00Z`))).toBe(true);
});

test("outside the listed years every time counts as closed (the cautious side)", () => {
  expect(isRegularSession(utc("2025-11-25T15:00:00Z"))).toBe(false);
  expect(isRegularSession(utc("2028-03-07T15:00:00Z"))).toBe(false);
});

test("a gap overlaps the session only if one of its minutes is inside it", () => {
  // Friday close to Monday open: a weekend gap has no regular minute
  expect(overlapsRegularSession(utc("2026-11-20T21:00:00Z"), utc("2026-11-23T14:30:00Z"))).toBe(false);
  // overnight Tuesday to Wednesday before the open
  expect(overlapsRegularSession(utc("2026-11-24T21:00:00Z"), utc("2026-11-25T14:00:00Z"))).toBe(false);
  // a gap that crosses Monday's open does
  expect(overlapsRegularSession(utc("2026-11-20T21:00:00Z"), utc("2026-11-23T14:31:00Z"))).toBe(true);
  // a short gap in the middle of the day does
  expect(overlapsRegularSession(utc("2026-11-24T16:00:00Z"), utc("2026-11-24T17:30:00Z"))).toBe(true);
});

// ------------------------------------------------------------------ the data file, checked against New York's clock


/// An independent reading of the session from New York's own clock (Intl), with the same lists.
const nyFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function viaIntl(ms: number): boolean {
  const p = Object.fromEntries(nyFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  if (!CALENDAR.years.some((y) => y.year === Number(p.year))) return false;
  if (p.weekday === "Sat" || p.weekday === "Sun" || HOLIDAYS.has(date)) return false;
  const m = Number(p.hour) * 60 + Number(p.minute);
  return m >= CALENDAR.hours.open && m < (EARLY_CLOSES.has(date) ? CALENDAR.hours.earlyClose : CALENDAR.hours.close);
}

test("the data file agrees with itself: day numbers are the dates, daylight saving switches at 02:00 New York", () => {
  const dayOf = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
  for (const y of CALENDAR.years) {
    expect(y.holidays).toEqual(y.holidayDates.map(dayOf));
    expect(y.earlyCloses).toEqual(y.earlyCloseDates.map(dayOf));
    // one second before the switch New York is on one offset, at the switch on the other
    const off = (t: number) => {
      const p = Object.fromEntries(nyFmt.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
      return (Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute)) / 1000 - Math.floor(t / 60) * 60) / 3600;
    };
    expect([off(y.dstStart - 60), off(y.dstStart)]).toEqual([-5, -4]);
    expect([off(y.dstEnd - 60), off(y.dstEnd)]).toEqual([-4, -5]);
    for (const d of [...y.holidays, ...y.earlyCloses]) expect(yearOfDay(d)).toBe(y.year);
  }
});

test("the data-driven session equals New York's own clock at 20,000 random moments and every switch edge", () => {
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed / 2 ** 31);
  const from = Date.parse("2025-12-20T00:00:00Z");
  const to = Date.parse("2028-01-10T00:00:00Z");
  const times: number[] = [];
  for (let i = 0; i < 20_000; i++) times.push(Math.floor((from + rnd() * (to - from)) / 60_000) * 60_000);
  for (const y of CALENDAR.years) for (const t of [y.dstStart, y.dstEnd]) for (const d of [-3600, -60, 0, 60, 3600]) times.push((t + d) * 1000);
  for (const t of times) expect(isRegularSession(t)).toBe(viaIntl(t));
});

test("closed days: weekends, holidays and unlisted years; an early close is a trading day", () => {
  expect(isClosedDay(Date.parse("2026-11-28T17:00:00Z"))).toBe(true);
  expect(isClosedDay(Date.parse("2026-11-26T15:00:00Z"))).toBe(true);
  expect(isClosedDay(Date.parse("2026-11-27T19:00:00Z"))).toBe(false);
  expect(isClosedDay(Date.parse("2026-11-24T23:00:00Z"))).toBe(false);
  expect(isClosedDay(Date.parse("2028-03-14T15:30:00Z"))).toBe(true);
});
