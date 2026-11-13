/// Posts in the Cofer look:
///   "🟡 ALERT · NAME" (🔴 for the most serious), a blank line, "What happened: …", "Who acts: …", a link;
///   "🟢 CLEARED · NAME" when a condition ends;
///   release alerts "✅ SHIPPED AND RELEASED · Update NN" (deployed and published in one run), "🟡 RELEASE DELAYED ·
///   Update NN" (live on the system; the public copy and the GitHub release retrying), "🟡 HELD · Update NN",
///   "🔴 ROLLED BACK · Update NN";
///   a daily "Shipped today" summary.
/// Plain text (no markup), so nothing needs escaping. Wording follows the spec's rules (Overview section 9).

/// The risk-monitor's stable alarm line (services/risk-monitor/src/alarm.ts).
export type AlarmLine = {
  level: "alarm" | "warn";
  msg: "alarm";
  name: string;
  state: "raised" | "cleared" | "event";
  what: string;
  who: string;
  market: string | null;
  values: Record<string, unknown>;
};

/// The most serious alarms: posted with 🔴.
export const RED = new Set([
  "COVERAGE_BREACHED",
  "DRAWDOWN_PAUSED",
  "VENUE_DOWN_PAUSED",
  "PAUSE_FAILED",
  "HEDGER_SILENT",
  "EQUITY_MISMATCH",
  "BUYBACK_FAILED",
  "MATCHED_UNCOVERED",
  "ROLE_CHANGED",
]);

/// Events that report a return to normal: posted as 🟢 CLEARED.
export const RECOVERY_EVENTS = new Set(["VENUE_RECOVERED", "UNPAUSED"]);

/// Real events the team should see but nobody has to act on: posted without the "Who acts" line (information posts).
export const INFO = new Set(["VAULT_SLASHED", "TIMELOCK_EXECUTED", "TIMELOCK_CANCELLED", "UNPAUSED", "AUCTION_SETTLED"]);

export type Links = { tx?: (hash: string) => string; guide?: string };

export function formatAlarm(a: AlarmLine, links: Links = {}): string {
  const title = a.market ? `${a.name} · ${a.market}` : a.name;
  const tx = typeof a.values?.tx === "string" ? (a.values.tx as string) : null;
  const link = tx && links.tx ? links.tx(tx) : (links.guide ?? null);
  if (a.state === "cleared" || (a.state === "event" && RECOVERY_EVENTS.has(a.name))) {
    return [`🟢 CLEARED · ${title}`, "", `What happened: ${a.what}`, ...(link ? [link] : [])].join("\n");
  }
  const icon = RED.has(a.name) ? "🔴" : "🟡";
  const who = INFO.has(a.name) ? [] : [`Who acts: ${a.who}`];
  return [`${icon} ALERT · ${title}`, "", `What happened: ${a.what}`, ...who, ...(link ? [link] : [])].join("\n");
}

/// A release event, as the release pipeline writes it (one JSON line per outcome).
export type ReleaseLine = {
  kind: "release";
  status: "released" | "delayed" | "held" | "rolled_back";
  update: number; // 1–62
  title: string; // the update's one-line title
  what: string; // what happened, one sentence
  who: string; // who acts
  next: string; // the next step
  link?: string; // GitHub release, or the failed check's log
  proof?: string; // the proof link for the daily summary (released only)
  at: string; // ISO time
};

const nn = (n: number) => String(n).padStart(2, "0");

export function formatRelease(r: ReleaseLine): string {
  const heads: Record<ReleaseLine["status"], string> = {
    released: "✅ SHIPPED AND RELEASED",
    delayed: "🟡 RELEASE DELAYED",
    held: "🟡 HELD",
    rolled_back: "🔴 ROLLED BACK",
  };
  const head = `${heads[r.status]} · Update ${nn(r.update)}`;
  return [head, "", r.title, "", `What happened: ${r.what}`, `Who acts: ${r.who}`, `Next step: ${r.next}`, ...(r.link ? [r.link] : [])].join("\n");
}

/// Alarms never posted on their own because nobody has to act: they appear only as a line in the daily summary.
export const SUMMARY_ONLY = new Set(["DUST_ABSORBED"]);

/// The once-a-day "Shipped today" summary for the staff group: every update released that UTC day, with its proof link.
export function formatShippedToday(day: string, released: ReleaseLine[]): string {
  const body =
    released.length === 0
      ? ["No updates released today."]
      : [`${released.length} update${released.length === 1 ? "" : "s"} released:`, ...[...released].sort((a, b) => a.update - b.update).map((r) => `• Update ${nn(r.update)} · ${r.title}${r.proof ? ` · ${r.proof}` : ""}`)];
  return [`Shipped today · ${day} (UTC)`, "", ...body].join("\n");
}

/// The once-a-day buyback-rounding note for the Alert Test group (an information post; only on a day with some).
export function formatDustNote(day: string, dust: { events: number; usdc: number }): string {
  return [`Buyback rounding · ${day} (UTC)`, "", `What happened: the pool absorbed buyback rounding (at most 1 micro-USDC per source): ${dust.events} event${dust.events === 1 ? "" : "s"}, ${dust.usdc.toFixed(6)} USDC.`].join("\n");
}
