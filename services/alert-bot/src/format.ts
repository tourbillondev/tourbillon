/// Posts in the Cofer look:
///   "🟡 ALERT · name" (🔴 for the most serious), a blank line, "What happened: …", "Who acts: …", a link;
///   "🟢 CLEARED · name" when a condition ends. The name is the playbook's (06b §1): lower-dash, with the market
///   joined by a dash (mark-stale-STK1).
/// Release statuses, the board and Shipped today are the team bot's (services/teambot), not this bot's.
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
  "coverage-breached",
  "drawdown-paused",
  "venue-down-paused",
  "pause-failed",
  "hedger-silent",
  "equity-mismatch",
  "buyback-failed",
  "matched-uncovered",
  "role-changed",
  "transfer-stuck",
  "split-mismatch",
]);

/// Events that report a return to normal: posted as 🟢 CLEARED.
export const RECOVERY_EVENTS = new Set(["venue-recovered", "unpaused"]);

/// Real events the team should see but nobody has to act on: posted without the "Who acts" line (information posts).
export const INFO = new Set(["vault-slashed", "timelock-executed", "timelock-cancelled", "unpaused", "auction-settled", "session-anchored"]);

export type Links = { tx?: (hash: string) => string; guide?: string };

export function formatAlarm(a: AlarmLine, links: Links = {}): string {
  const title = a.market ? `${a.name}-${a.market}` : a.name;
  const tx = typeof a.values?.tx === "string" ? (a.values.tx as string) : null;
  const link = tx && links.tx ? links.tx(tx) : (links.guide ?? null);
  if (a.state === "cleared" || (a.state === "event" && RECOVERY_EVENTS.has(a.name))) {
    return [`🟢 CLEARED · ${title}`, "", `What happened: ${a.what}`, ...(link ? [link] : [])].join("\n");
  }
  const icon = RED.has(a.name) ? "🔴" : "🟡";
  const who = INFO.has(a.name) ? [] : [`Who acts: ${a.who}`];
  return [`${icon} ALERT · ${title}`, "", `What happened: ${a.what}`, ...who, ...(link ? [link] : [])].join("\n");
}

/// Never an alert: buyback rounding (the team bot sums it into Shipped today from the same log).
export const SUMMARY_ONLY = new Set(["dust-absorbed"]);
