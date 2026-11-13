/// The pinned launch board in the staff group, edited in place (owner's layout):
///
///   TOURBILLON LAUNCH live
///   Live N / 62  ▰▰▰▱▱▱▱▱▱▱▱▱
///   Next Update NN · HH:MM UTC · in X min
///   Held none            (or "Held 05, 12")
///
/// Before launch the Live line shows the launch time instead ("Launch 14:00 UTC · 1 Dec · in 3h 20m"), or "Launch time
/// not set". Update NN is scheduled at launch + (NN − 1) hours: Update 01 goes out at the launch moment, then one per
/// hour (a held update keeps the next one on time).
/// Full UTC / Moscow / New York times appear only in the /schedule command.

export const TOTAL = 62;
export const CELLS = 12;
export const TITLE = "TOURBILLON LAUNCH live";

export type BoardState = { launchAt: Date | null; now: Date; released: number[]; held: number[] };

const nn = (n: number) => String(n).padStart(2, "0");
const hhmm = (d: Date) => d.toISOString().slice(11, 16);
const dayMon = (d: Date) => `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}`;

export function bar(n: number): string {
  const filled = Math.max(0, Math.min(CELLS, Math.round((n / TOTAL) * CELLS)));
  return "▰".repeat(filled) + "▱".repeat(CELLS - filled);
}

export function until(from: Date, to: Date): string {
  const m = Math.max(0, Math.ceil((to.getTime() - from.getTime()) / 60_000));
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `in ${h}h ${m % 60}m`;
  return `in ${Math.floor(h / 24)}d ${h % 24}h`;
}

export const updateAt = (launchAt: Date, n: number) => new Date(launchAt.getTime() + (n - 1) * 3_600_000);

/// The next update not yet released or held, by schedule.
export function nextUpdate(s: BoardState): number | null {
  const done = new Set([...s.released, ...s.held]);
  for (let n = 1; n <= TOTAL; n++) if (!done.has(n)) return n;
  return null;
}

export function renderBoard(s: BoardState): string {
  const live = s.released.length;
  const launched = s.launchAt !== null && s.now >= s.launchAt;
  const first = !s.launchAt ? "Launch time not set" : launched ? `Live ${live} / ${TOTAL}  ${bar(live)}` : `Launch ${hhmm(s.launchAt)} UTC · ${dayMon(s.launchAt)} · ${until(s.now, s.launchAt)}`;
  const n = nextUpdate(s);
  const next = n === null ? "Next Update none · all shipped" : !s.launchAt ? `Next Update ${nn(n)} · time not set` : `Next Update ${nn(n)} · ${hhmm(updateAt(s.launchAt, n))} UTC · ${until(s.now, updateAt(s.launchAt, n))}`;
  const held = s.held.length === 0 ? "Held none" : `Held ${[...s.held].sort((a, b) => a - b).map(nn).join(", ")}`;
  return [TITLE, first, next, held].join("\n");
}

/// "1 Dec 14:00" in a time zone, built from parts so the output does not depend on the runtime's locale data.
function zone(d: Date, tz: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day} ${p.month} ${p.hour}:${p.minute}`;
}

/// The /schedule reply: the launch and the next updates in UTC, Moscow and New York (at most `rows` updates, to stay
/// within one Telegram message), then the last update.
export function renderSchedule(s: BoardState, rows = 12): string {
  if (!s.launchAt) return "Schedule\n\nLaunch time not set.";
  const line = (label: string, d: Date) => `${label} · ${zone(d, "UTC")} UTC · ${zone(d, "Europe/Moscow")} Moscow · ${zone(d, "America/New_York")} New York`;
  const out = ["Schedule", "", line("Launch", s.launchAt), ""];
  const n0 = nextUpdate(s) ?? TOTAL + 1;
  const done = new Set([...s.released, ...s.held]);
  let shown = 0;
  for (let n = n0; n <= TOTAL && shown < rows; n++) {
    if (done.has(n)) continue;
    out.push(line(`Update ${nn(n)}`, updateAt(s.launchAt, n)));
    shown++;
  }
  const lastShown = shown > 0 ? n0 + shown - 1 : TOTAL;
  if (lastShown < TOTAL) out.push("…", line(`Update ${TOTAL}`, updateAt(s.launchAt, TOTAL)));
  return out.join("\n");
}
