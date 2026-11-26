import { pad, relUrl, tag, type Book, type Update } from "./data.ts";
import { held, nextDue, released, type Alarm, type State } from "./state.ts";
import { dayLabel, inMins, slotTime, three, threeShort, utcClock, utcDay } from "./time.ts";

/// Every message the team bot posts, word for word from the playbook's templates (templates/bot-messages/,
/// templates/alerts/release-emergency.md) with Tourbillon's values. Telegram HTML, except the two copy-ready captions
/// (plain text, so they paste cleanly). Pure: the current time is passed in.

export const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const TYPE: Record<string, string> = { NEW: "New", HOW: "How it works", CMD: "Command", BTS: "Behind the scenes" };
export const SLUG = "tourbillon";
const slot = (st: State, book: Book, n: number) => slotTime(st.launchAt!, n, book.slotMs);
const releasesUrl = (book: Book) => `https://github.com/${book.repo}/releases`;

/// "{{dot}} <b>{{KIND}} · {{subject}}</b>" then What happened / Users affected / What we did / Next.
export function incident(dot: string, kind: string, subject: string, f: { what?: string; users?: string; done?: string; next?: string }): string {
  const rows: [string, string | undefined][] = [
    ["What happened", f.what],
    ["Users affected", f.users ?? "No. Tourbillon keeps running."],
    ["What we did", f.done],
    ["Next", f.next],
  ];
  return `${dot} <b>${esc(kind)} · ${esc(subject)}</b>\n\n${rows
    .filter((r) => r[1])
    .map(([k, v]) => `<b>${k}:</b> ${esc(v)}`)
    .join("\n")}`;
}

// ---------------- launch and finish ----------------

/// The launch announcement, the caption of the launch poster (at the launch minute; under 1,024 characters).
export function launchText(st: State, book: Book): string {
  const first = slot(st, book, 1);
  const last = slot(st, book, book.total);
  const bot = [book.cfg.productBot, book.cfg.domain].filter(Boolean).join(" · ");
  return `🟢 <b>TOURBILLON IS LIVE</b>

Tourbillon is an options venue with no expiry, on Robinhood Chain. Buy a call, a put or a shape of up to four legs on tokenized stocks, BTC or ETH, and hold it for as long as you like: you pay funding along the price path instead of picking an expiry, settled in ${esc(book.cfg.settlementSymbol)}, and you can never lose more than you paid.

From ${three(first)}: one tech update every hour, ${book.total} in all, until ${dayLabel(last)}, ${utcClock(last)} UTC. Each one goes out only after it is live and checked.${bot ? `\n\n${esc(bot)}` : ""}`;
}

export function allLiveText(book: Book, now: number): string {
  return `🏁 <b>ALL ${book.total} UPDATES ARE LIVE</b>\n\nThe last one, Update ${pad(book.total)}, went out at ${three(new Date(now))}.\nEvery release: <a href="${releasesUrl(book)}">github.com/${book.repo}/releases</a>`;
}

// ---------------- control messages ----------------

export function armedText(changed: boolean, t: Date, book: Book): string {
  return `🟢 <b>${changed ? "LAUNCH TIME CHANGED" : "SCHEDULE ARMED"}</b>\n\n<b>Launch:</b> ${dayLabel(t)}, ${three(t)}\n${book.total} updates, one every hour. Update 1 goes out an hour after that minute.\nEach update goes out only after its checks pass. One that fails is held, never posted broken.`;
}

export const disarmedText = () =>
  incident("⏸", "SCHEDULE CANCELLED", "launch", { what: "The launch time was cleared from the server.", done: "No update will go out until a new launch time is set.", next: "A new time will be posted here." });

export const pausedText = (reason: string) =>
  incident("⏸", "PAUSED", "updates", { what: `Updates were paused from the server: ${reason}.`, done: "No new update goes out. One already posting finishes.", next: "A resume will be posted here." });

export function resumedText(st: State, book: Book, overdue: number): string {
  const nx = st.launchAt ? nextDue(st, book) : undefined;
  const next = overdue > 1 ? `${overdue} overdue updates go out first, 2 minutes apart, then the normal times.` : overdue === 1 ? "1 overdue update goes out first, then the normal times." : nx ? `Update ${pad(nx.n)} at ${three(slot(st, book, nx.n))}.` : "Nothing is waiting.";
  return incident("▶️", "RESUMED", "updates", { what: "The pause ended.", done: "Updates continue.", next });
}

export function preflightText(bad: { n: number; why: string }[], total: number): string {
  return bad.length
    ? `🟡 <b>PREFLIGHT · ${total - bad.length} of ${total} ready</b>\n\n${bad.map((b) => `<b>${pad(b.n)}</b> ${esc(b.why)}`).join("\n")}\n\n<i>Each one is held at its hour unless fixed.</i>`
    : `🟢 <b>PREFLIGHT ALL CLEAR</b>\n\n${total} of ${total} updates are ready: status checked, posters on the server, changelog lines and GitHub releases in place.`;
}

// ---------------- the hourly set ----------------

export const headingText = (n: number) => `<b>Tech Updates: Update ${pad(n)} Released</b>`;
/// Under the square poster: ready to paste into the Telegram channel.
export const tgCopy = (book: Book, u: Update) => `Update ${pad(u.n)} of ${book.total}\n\n${u.telegram}\n\nGitHub: ${relUrl(book, u.n)}`;
/// Under the wide poster: ready to paste into X, with its length.
export function xCopy(u: Update): string {
  const text = `Update ${pad(u.n)}: ${u.x}`;
  return `For X · ${text.length} characters\n\n${text}`;
}
export const zipName = (n: number, shape: "square" | "wide") => `${SLUG}-update-${pad(n)}-${shape}.zip`;
export const zipCaption = (n: number, shape: "square" | "wide") => `Update ${pad(n)} · ${shape} poster, full quality (${shape === "square" ? "1080x1080" : "1200x675"} PNG)`;

/// The status line (templates/bot-messages/status-lines.md): the first line, then title, what, Next and the link.
export function statusText(kind: "released" | "delayed" | "held" | "rolled_back", n: number, title: string, what: string, next: string, link?: string): string {
  const head = { released: "✅ SHIPPED AND RELEASED", delayed: "🟡 RELEASE DELAYED", held: "🟡 HELD", rolled_back: "🔴 ROLLED BACK" }[kind];
  return `${head} · Update ${pad(n)} · release ${tag(n)}\n\n${esc(title)}\n\n${esc(what)}\nNext: ${esc(next)}${link ? `\n${esc(link)}` : ""}`;
}

// ---------------- release emergencies (Alert Test) ----------------

export function alarmText(a: Alarm, now: number, label = ""): string {
  const mins = Math.floor((now - a.openedAt) / 60_000);
  const when = a.n && a.postAt ? ` (Update ${pad(a.n)}, posting at ${three(new Date(a.postAt))})` : "";
  return `${label}🔴 ALERT · ${esc(a.name)}\n\nWhat happened: ${esc(a.what.replace(/\.$/, ""))}${when}.\nWho acts: ${esc(a.who)}\n${mins > 0 ? `Still open after ${mins}m. ` : ""}/ack pauses this alarm for 15 minutes.`;
}
export const ackText = (name: string) => `Paused for 15 minutes: ${esc(name)}. It repeats every 2 minutes after that if it is still open.`;
export const ackWhich = (names: string[]) => `Which one? Send /ack ${esc(names[0] ?? "")} (open: ${esc(names.join(", "))}).`;
export const ACK_NOTHING = "Nothing is open.";
export const clearedText = (name: string, reason: string, label = "") => `${label}🟢 CLEARED · ${esc(name)} (${esc(reason)})`;

// ---------------- the pinned board ----------------

export function boardText(st: State, book: Book, now: number): string {
  const total = book.total;
  const done = released(st, book).length;
  const fill = Math.round((done / total) * 12);
  const bar = "▰".repeat(fill) + "▱".repeat(12 - fill);
  const nx = st.launchAt ? nextDue(st, book) : undefined;
  const h = held(st, book).map((u) => pad(u.n));
  let queue = "○ not armed";
  if (st.launchAt) queue = st.paused ? `⏸ paused: ${st.paused.reason}` : done === total ? "✓ finished" : now < Date.parse(st.launchAt) ? "◷ armed" : "● running";
  const lines = [`Live    ${String(done).padStart(2)} / ${total}   ${bar}`];
  if (nx && done < total) {
    const t = slot(st, book, nx.n);
    lines.push(`Next    Update ${pad(nx.n)} · ${TYPE[nx.type] ?? ""}`, `        ${threeShort(t)}`, `        ${dayLabel(t)} · ${inMins(t, now)}`);
  } else if (!st.launchAt) lines.push("Next    launch time not set");
  lines.push(`Queue   ${queue}`, `Held    ${h.length ? h.join(", ") : "none"}`);
  const last = released(st, book).sort((a, b) => Date.parse(st.u[b.n]!.at ?? "0") - Date.parse(st.u[a.n]!.at ?? "0"))[0];
  let out = `<b>TOURBILLON LAUNCH live</b>\n<pre>${esc(lines.join("\n"))}</pre>`;
  if (last) out += `\n<b>Last:</b> Update ${pad(last.n)} · ${esc(last.title)}\n<a href="${relUrl(book, last.n)}">${esc(`github.com/${book.repo}/releases/tag/${tag(last.n)}`)}</a>`;
  out += `\n\n<i>Times: UTC · Moscow · New York. Updated ${utcClock(new Date(now))} UTC.</i>`;
  return out;
}
/// The board without its "Updated" time, to tell whether anything real changed.
export const boardKey = (text: string) => text.replace(/Updated \d\d:\d\d UTC/, "");

// ---------------- Shipped today (23:55 UTC) ----------------

export function shippedTodayText(st: State, book: Book, day: string, now: number): string {
  const list = released(st, book).filter((u) => utcDay(Date.parse(st.u[u.n]!.at ?? "0")) === day).sort((a, b) => a.n - b.n);
  const body = list.length ? [`${list.length} update${list.length === 1 ? "" : "s"} released:`, ...list.map((u) => `• Update ${pad(u.n)} · ${esc(u.title)} · ${esc(st.u[u.n]!.link ?? relUrl(book, u.n))}`)] : ["No updates released today."];
  const d = st.dust[day];
  const dust = d && d.events > 0 ? ["", `Buyback rounding: the pool absorbed ${d.events} event${d.events === 1 ? "" : "s"}, ${d.amount.toFixed(6)} ${esc(d.symbol || book.cfg.settlementSymbol)} (at most one smallest unit per source).`] : [];
  const t = new Date(now);
  const clock = (tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(t);
  return [`Shipped today · ${day} (UTC)`, `${clock("UTC")} UTC · ${clock("Europe/Moscow")} Moscow · ${clock("America/New_York")} New York`, "", ...body, ...dust].join("\n");
}

// ---------------- schedule ----------------

export function scheduleDay(st: State, book: Book, d: number): string | null {
  const list = book.updates.filter((u) => Math.ceil(u.n / 24) === d);
  if (!list.length) return null;
  const rows = list.map((u) => {
    const o = st.u[u.n]?.outcome;
    const mark = o === "released" ? "✓" : o === "held" || o === "rolled_back" ? "⏸" : " ";
    return `<code>${pad(u.n)}${mark}</code> ${threeShort(slot(st, book, u.n))}  ${esc(u.title)}`;
  });
  return `<b>Day ${d} · from ${dayLabel(slot(st, book, list[0]!.n))}</b>\n<i>UTC · Moscow · New York</i>\n\n${rows.join("\n")}`;
}
export const days = (book: Book) => Math.ceil(book.total / 24);
export function currentDay(st: State, book: Book, now: number): number {
  return Math.min(days(book), Math.max(1, Math.floor((now - Date.parse(st.launchAt!)) / (24 * book.slotMs)) + 1));
}

// ---------------- staff-group commands ----------------

export const HELP = `<b>Tourbillon team bot</b>

/status  the launch board
/next  the next 3 updates and when
/schedule 1  the day 1 list (2, 3)
/poster 14  both posters of a released update
/changelog  the latest releases
/roadmap  the roadmap
/contracts  every contract, with explorer links
/socials  our links
/videos  the demo videos, then /video 3
/health  is everything up

<i>Pause, resume and hold are done from the server only.</i>`;

export const MENU: [string, string][] = [
  ["status", "the launch board"],
  ["next", "the next 3 updates"],
  ["schedule", "a day of updates"],
  ["poster", "posters of a released update"],
  ["changelog", "latest releases"],
  ["roadmap", "the roadmap"],
  ["contracts", "contracts and links"],
  ["socials", "our links"],
  ["videos", "demo videos"],
  ["health", "is everything up"],
  ["help", "all commands"],
];

export const REPLY_ONLY = "I answer commands only: /status, /next, /schedule, /poster N, /changelog, /roadmap, /contracts, /socials, /videos, /health, /help.";
export const NOT_SET = "The launch time is not set yet.";

export function nextText(st: State, book: Book, now: number): string {
  if (!st.launchAt) return NOT_SET;
  const list = book.updates.filter((u) => st.u[u.n]?.outcome !== "released").slice(0, 3);
  if (!list.length) return `All ${book.total} updates are live.`;
  return `<b>Next updates</b>\n<i>UTC · Moscow · New York</i>\n\n${list
    .map((u) => `<b>${pad(u.n)}</b> · ${esc(u.title)}\n${threeShort(slot(st, book, u.n))} · ${inMins(slot(st, book, u.n), now)}${["held", "rolled_back"].includes(st.u[u.n]?.outcome ?? "") ? " · ⏸ held" : ""}`)
    .join("\n\n")}`;
}
export const noDayText = (d: number) => `There is no day ${d}. Try /schedule 1.`;
export const posterUsage = "Send it with a number, like /poster 14.";
export const posterNotLive = (n: number) => `Update ${pad(n)} is not live yet. Its posters are shared here at its hour.`;
export const posterCaption = (n: number, wide: boolean) => `Update ${pad(n)} · ${wide ? "wide, for X" : "square, for Telegram and Instagram"}`;

export function changelogReply(st: State, book: Book): string {
  const last = released(st, book).sort((a, b) => b.n - a.n).slice(0, 3);
  if (!last.length) return `Nothing released yet. All releases will be at github.com/${book.repo}/releases`;
  return `<b>Latest releases</b>\n\n${last.map((u) => `<b>${pad(u.n)}</b> · ${esc(u.title)}\n<a href="${relUrl(book, u.n)}">${tag(u.n)}</a>`).join("\n\n")}\n\nAll: <a href="${releasesUrl(book)}">github.com/${book.repo}/releases</a>`;
}

export function roadmapCaption(st: State, book: Book): string {
  const lines: string[] = [];
  for (let d = 1; d <= days(book); d++) {
    const a = (d - 1) * 24 + 1;
    const b = Math.min(d * 24, book.total);
    lines.push(`<b>Day ${d}</b> · updates ${a} to ${b} · ${released(st, book).filter((u) => u.n >= a && u.n <= b).length} live`);
  }
  return `<b>Roadmap</b>\n${book.total} updates, one every hour.\n\n${lines.join("\n")}\n\n/schedule 1 for a full day.`;
}

export function contractsText(book: Book): string {
  const { cfg } = book;
  return `<b>Tourbillon contracts</b>\nRobinhood Chain mainnet, chain 4663\n\n${cfg.contracts
    .map((c) => `<b>${esc(c.name)}</b>\n<code>${c.address}</code>\n<a href="${esc(cfg.explorer)}/address/${c.address}">explorer</a>${c.sourcify ? ` · <a href="https://repo.sourcify.dev/4663/${c.address}">source verified</a>` : ""}`)
    .join("\n\n")}`;
}
export const socialsText = (book: Book) => `<b>Tourbillon links</b>\n\n${book.cfg.socials.map((s) => `<b>${esc(s.name)}:</b> ${esc(s.url)}`).join("\n")}`;
export const videosText = (book: Book) =>
  `<b>Demo videos</b>\n<i>Desktop, on testnet with test ${esc(book.cfg.settlementSymbol)}</i>\n\n${book.cfg.videos.map((v, i) => `${i + 1}. ${esc(v.title)}`).join("\n")}\n\nSend /video 3 to get one.`;
export const videoUsage = (book: Book) => `Send it with a number from 1 to ${book.cfg.videos.length}, like /video 3.`;

export type HealthRow = { name: string; status?: number; ok?: boolean; ms?: number };
export function healthText(rows: HealthRow[], st: State, now: number): string {
  const lines = rows.map((r) => (r.status === undefined ? `❌ ${esc(r.name)} · no answer` : `${r.ok ? "✅" : "❌"} ${esc(r.name)} · ${r.status} · ${r.ms} ms`));
  const q = !st.launchAt ? "not armed" : st.paused ? `paused (${esc(st.paused.reason)})` : "running";
  return `<b>Health</b>\n\n${lines.join("\n")}\n\nUpdates: ${q}\n<i>Checked ${three(new Date(now))}</i>`;
}

