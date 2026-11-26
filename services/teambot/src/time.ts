/**
 * Times for the team bot. Always shown in UTC, Moscow and New York, nothing else. Pure: the
 * current time is passed in.
 */

const fmt = (d: Date, tz: string, us = false) =>
  new Intl.DateTimeFormat(us ? "en-US" : "en-GB", { timeZone: tz, hour: us ? "numeric" : "2-digit", minute: "2-digit", hour12: us }).format(d);

/** "14:00" in UTC. */
export const utcClock = (d: Date) => fmt(d, "UTC");

/** "14:00 UTC · 17:00 Moscow · 9:00 AM New York" */
export const three = (d: Date) => `${fmt(d, "UTC")} UTC · ${fmt(d, "Europe/Moscow")} Moscow · ${fmt(d, "America/New_York", true)} New York`;

/** "14:00 · 17:00 · 9:00 AM" */
export const threeShort = (d: Date) => `${fmt(d, "UTC")} · ${fmt(d, "Europe/Moscow")} · ${fmt(d, "America/New_York", true)}`;

/** "Mon, 30 Nov" (UTC day). */
export const dayLabel = (d: Date) =>
  `${new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short" }).format(d)}, ${d.getUTCDate()} ${new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "short" }).format(d)}`; // the comma is ours, not the runtime's locale data

/** "due now", "in 25 min", "in 3h 10m", "in 2d 4h" (templates/bot-messages/README.md). */
export function inMins(d: Date, now: number): string {
  const m = Math.round((d.getTime() - now) / 60000);
  if (m <= 0) return "due now";
  if (m < 60) return `in ${m} min`;
  if (m < 48 * 60) return `in ${Math.floor(m / 60)}h ${m % 60}m`;
  return `in ${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

/** "2026-11-30 18:00" or "2026-11-30T18:00" (UTC), or a full ISO time ending in Z; else null. */
export function parseUtc(s: string | undefined | null): Date | null {
  const t = String(s ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(t)) {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  return m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!)) : null;
}

/** When update n posts (playbook 07 §3): the launch announcement at the launch minute, update NN at launch + NN slots. */
export const slotTime = (armedAt: string, n: number, slotMs: number) => new Date(Date.parse(armedAt) + n * slotMs);

/** "2026-11-30" (UTC day). */
export const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);
