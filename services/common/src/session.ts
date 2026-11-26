import { readFileSync } from "node:fs";

/// The regular US equity session (owner, G2): 09:30–16:00 New York time, Monday to Friday, without US market
/// holidays, closing at 13:00 on early-close days. Daylight saving follows New York's own clock.
/// One data file, `contracts/calendar/us-regular-session.json`, feeds both this module (the signers) and the on-chain
/// SessionCalendar, and the algorithm below is the contract's own, so the two answer alike (checked on anvil).
/// (U): Robinhood Chain's own trading hours are not confirmed (owner queue Q11); the holidays are the US exchanges'
/// published calendar as known now; both are re-checked before mainnet.
/// Outside the years listed every time counts as closed: the cautious side (marks are anchored and band-capped).

type YearData = {
  year: number;
  dstStart: number; // UTC seconds
  dstEnd: number;
  holidays: number[]; // day numbers: days since 1970-01-01, New York dates
  earlyCloses: number[];
  holidayDates: string[];
  earlyCloseDates: string[];
};
export type CalendarFile = { hours: { open: number; close: number; earlyClose: number }; years: YearData[] };

export const CALENDAR_PATH = new URL("../../../contracts/calendar/us-regular-session.json", import.meta.url);
export const CALENDAR: CalendarFile = JSON.parse(readFileSync(CALENDAR_PATH, "utf8"));

const DAY = 86_400;
const years = new Map(CALENDAR.years.map((y) => [y.year, y]));
const kind = new Map<number, "holiday" | "early">();
for (const y of CALENDAR.years) {
  for (const d of y.holidays) kind.set(d, "holiday");
  for (const d of y.earlyCloses) kind.set(d, "early");
}

/// Readable lists, for tests and logs.
export const HOLIDAYS: ReadonlySet<string> = new Set(CALENDAR.years.flatMap((y) => y.holidayDates));
export const EARLY_CLOSES: ReadonlySet<string> = new Set(CALENDAR.years.flatMap((y) => y.earlyCloseDates));
export const CALENDAR_YEARS: readonly number[] = CALENDAR.years.map((y) => y.year);

/// The civil year of a day number (H. Hinnant's days-to-civil), as SessionCalendar._yearOfDay.
export function yearOfDay(z0: number): number {
  const z = z0 + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const y = yoe + era * 400;
  return mp >= 10 ? y + 1 : y;
}

/// New York day number and minute of `t` (Unix seconds), and whether that day's year is listed.
function local(t: number): { listed: boolean; day: number; minute: number } {
  const y = years.get(yearOfDay(Math.floor(t / DAY)));
  const offset = y && t >= y.dstStart && t < y.dstEnd ? 4 * 3600 : 5 * 3600;
  const l = t - offset;
  const day = Math.floor(l / DAY);
  return { listed: years.has(yearOfDay(day)), day, minute: Math.floor((l - day * DAY) / 60) };
}

const weekend = (day: number) => {
  const wd = (((day + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday; 0 = Sunday
  return wd === 0 || wd === 6;
};

/// True when `ms` (Unix milliseconds) falls inside a regular session.
export function isRegularSession(ms: number): boolean {
  const { listed, day, minute } = local(Math.floor(ms / 1000));
  if (!listed || weekend(day)) return false;
  const k = kind.get(day);
  if (k === "holiday") return false;
  const h = CALENDAR.hours;
  return minute >= h.open && minute < (k === "early" ? h.earlyClose : h.close);
}

/// True on a weekend or holiday (New York date), and in any year not listed (as SessionCalendar.isClosedDay).
export function isClosedDay(ms: number): boolean {
  const { listed, day } = local(Math.floor(ms / 1000));
  return !listed || weekend(day) || kind.get(day) === "holiday";
}

/// True when any minute in [fromMs, toMs) is inside a regular session (checked minute by minute; gaps are short).
export function overlapsRegularSession(fromMs: number, toMs: number): boolean {
  const start = Math.ceil(fromMs / 60_000) * 60_000;
  for (let t = start; t < toMs; t += 60_000) if (isRegularSession(t)) return true;
  return false;
}
