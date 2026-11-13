import { existsSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "@tourbillon/common/log.ts";
import { chatFor, DEFAULT_ENV_FILE, loadSecrets, redact } from "./config.ts";
import { Deduper } from "./dedupe.ts";
import { formatAlarm, formatDustNote, formatRelease, formatShippedToday, SUMMARY_ONLY, type AlarmLine, type Links, type ReleaseLine } from "./format.ts";
export type { ReleaseLine };
import { renderBoard, renderSchedule } from "./board.ts";
import { telegramClient, type Sender, type Telegram } from "./telegram.ts";

/// The team alert bot "Tourbillon Alerts" (launch core). Routing (owner's, final):
/// - the Alert Test group gets every risk and ops alarm and the information posts (including a once-a-day buyback-rounding
///   note on days with some), always, before and after launch; **alarms never go to the staff group**;
/// - release alerts (RELEASED / HELD / ROLLED BACK, written by the release pipeline once it runs) go to the staff
///   group, with a copy to the Alert Test group; the once-a-day "Shipped today" summary goes to the staff group;
/// - with --board, the staff group gets the pinned launch board ("TOURBILLON LAUNCH live"), edited in place, and the
///   bot answers /schedule (full UTC / Moscow / New York times) in the chat that asked.
/// Owner announcements go through announce.ts (preview and confirmation). It never prints, logs or writes the token.
///   bun src/main.ts --follow <risk-monitor.log> [--follow <releases.log>] [--board [--launch-at 2026-12-01T14:00:00Z]]
///     [--dry-run]
///     [--env-file ~/.tourbillon/alerts.env] [--state-file ~/.tourbillon/alert-bot-state.json] [--summary-utc 23:55]
///     [--explorer https://testnet.elysium.kinetiq.xyz/tx/] [--guide <pinned guide link>] [--from-start]

export type Options = {
  follow: string[];
  board: boolean;
  launchAt: Date | null;
  dryRun: boolean;
  envFile: string;
  stateFile: string;
  summaryUtc: string;
  explorer?: string;
  guide?: string;
  fromStart: boolean;
};

export function parseArgs(argv: string[]): Options {
  const o: Options = { follow: [], board: false, launchAt: null, dryRun: false, envFile: DEFAULT_ENV_FILE, stateFile: join(homedir(), ".tourbillon", "alert-bot-state.json"), summaryUtc: "23:55", fromStart: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${k} needs a value`);
      return x;
    };
    if (k === "--follow") o.follow.push(v());
    else if (k === "--staff") throw new Error("--staff is gone: alarms never go to the staff group; staff posts are the board (--board) and announce.ts");
    else if (k === "--board") o.board = true;
    else if (k === "--launch-at") {
      const d = new Date(v());
      if (Number.isNaN(d.getTime())) throw new Error("--launch-at is an ISO time, e.g. 2026-12-01T14:00:00Z");
      o.launchAt = d;
    }
    else if (k === "--dry-run") o.dryRun = true;
    else if (k === "--from-start") o.fromStart = true;
    else if (k === "--env-file") o.envFile = v();
    else if (k === "--state-file") o.stateFile = v();
    else if (k === "--summary-utc") o.summaryUtc = v();
    else if (k === "--explorer") o.explorer = v();
    else if (k === "--guide") o.guide = v();
    else throw new Error(`unknown flag ${k}`);
  }
  if (o.follow.length === 0) throw new Error("give at least one --follow file");
  if (!/^\d\d:\d\d$/.test(o.summaryUtc)) throw new Error("--summary-utc is HH:MM (UTC)");
  return o;
}

/// A post and where it may go: "alarm" posts (risk and ops alarms, information posts) go to the Alert Test group only;
/// "release" posts (RELEASED / HELD / ROLLED BACK) go to the staff group with a copy to the Alert Test group.
export type Post = { text: string; route: "alarm" | "release" };

/// Turns one JSON line into a post (or null): alarm lines and release lines; everything else is ignored.
export function postFor(line: string, dedupe: Deduper, links: Links): Post | null {
  let x: Record<string, unknown>;
  try {
    x = JSON.parse(line);
  } catch {
    return null;
  }
  if (x.msg === "alarm" && typeof x.name === "string") {
    const a = x as unknown as AlarmLine;
    if (SUMMARY_ONLY.has(a.name)) {
      // nothing to do: no alert, one line in the day's summary
      const t = typeof x.t === "string" ? x.t : new Date().toISOString();
      dedupe.addDust(t.slice(0, 10), `dust:${t}:${JSON.stringify(a.values)}`, Number(a.values.events ?? 0), Number(a.values.usdc ?? 0));
      return null;
    }
    return dedupe.alarm(a) ? { text: formatAlarm(a, links), route: "alarm" } : null;
  }
  if (x.kind === "release") {
    const r = x as unknown as ReleaseLine;
    return dedupe.release(r) ? { text: formatRelease(r), route: "release" } : null;
  }
  return null;
}

/// A file followed from its current end (or its start), line by line.
class Tail {
  private pos: number;
  private buf = "";
  constructor(private readonly path: string, fromStart: boolean) {
    this.pos = !fromStart && existsSync(path) ? statSync(path).size : 0;
  }
  read(): string[] {
    if (!existsSync(this.path)) return [];
    const size = statSync(this.path).size;
    if (size < this.pos) this.pos = 0; // rotated
    if (size === this.pos) return [];
    const fd = openSync(this.path, "r");
    const b = Buffer.alloc(size - this.pos);
    readSync(fd, b, 0, b.length, this.pos);
    this.pos = size;
    this.buf += b.toString("utf8");
    const parts = this.buf.split("\n");
    this.buf = parts.pop() ?? "";
    return parts.filter((p) => p.trim().length > 0);
  }
}

/// The board in the staff group: posted and pinned once, then edited when its text changes.
export async function keepBoard(o: Options, tg: Pick<Telegram, "send" | "edit" | "pin">, staffChat: string, dedupe: Deduper, now = new Date()): Promise<string> {
  const text = renderBoard({ launchAt: o.launchAt, now, ...dedupe.progress() });
  const b = dedupe.boardMessage();
  if (b.text === text) return text;
  if (o.dryRun) {
    process.stdout.write(`--- board (would ${b.messageId ? "edit" : "post and pin"} in the staff group)\n${text}\n`);
    return text;
  }
  if (b.messageId) await tg.edit(staffChat, b.messageId, text);
  else {
    const id = await tg.send(staffChat, text);
    if (typeof id === "number") await tg.pin(staffChat, id);
    if (typeof id === "number") dedupe.setBoard(id, text);
    return text;
  }
  dedupe.setBoard(b.messageId, text);
  return text;
}

/// /schedule (or /schedule@bot) from the staff or test group: the full schedule, in the chat that asked.
export async function answerCommands(o: Options, tg: Pick<Telegram, "send" | "updates">, chats: string[], dedupe: Deduper, now = new Date()): Promise<number> {
  const ups = await tg.updates(dedupe.updateOffset);
  let answered = 0;
  for (const u of ups) {
    dedupe.updateOffset = u.update_id + 1;
    const chat = String(u.message?.chat.id ?? "");
    const cmd = (u.message?.text ?? "").trim().split(/[\s@]/)[0];
    if (cmd !== "/schedule" || !chats.includes(chat)) continue;
    const reply = renderSchedule({ launchAt: o.launchAt, now, ...dedupe.progress() });
    if (o.dryRun) process.stdout.write(`--- /schedule reply\n${reply}\n`);
    else await tg.send(chat, reply);
    answered++;
  }
  return answered;
}

/// Alarms and information posts (and the daily buyback-rounding note): the Alert Test group only, never the staff group.
/// Release alerts: the staff group with a copy to the Alert Test group. "Shipped today": the staff group. The board and
/// /schedule run with --board.
export async function run(
  o: Options,
  send: Sender,
  chats: { test: string; staff: string | null },
  stop: () => boolean,
  tickMs = 2000,
  board?: { tg: Telegram },
): Promise<void> {
  const testChat = chats.test;
  const dedupe = new Deduper(o.stateFile);
  const links: Links = { tx: o.explorer ? (h) => `${o.explorer}${h}` : undefined, guide: o.guide };
  const tails = o.follow.map((f) => new Tail(f, o.fromStart));
  const post = async (text: string, to: string[]) => {
    if (o.dryRun) {
      process.stdout.write(`--- would post to ${to.map((c) => (c === testChat ? "the test group" : "the staff group")).join(" and ")}\n${text}\n`);
      return;
    }
    for (const c of to) await send(c, text);
  };
  while (!stop()) {
    for (const t of tails) {
      for (const line of t.read()) {
        const p = postFor(line, dedupe, links);
        if (p) {
          // alarms: the test group only; release alerts: the staff group, then a copy to the test group
          const to = p.route === "release" && chats.staff ? [chats.staff, testChat] : [testChat];
          try {
            await post(p.text, to);
          } catch (e) {
            log("error", "post failed", { error: (e as Error).message });
          }
        }
      }
    }
    // the daily summary, once, at the set UTC time
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.toISOString().slice(11, 16) >= o.summaryUtc) {
      // "Shipped today" to the staff group, once the release pipeline runs (a day with release lines)
      if (chats.staff && dedupe.releasesOn(day) && dedupe.summary(day)) {
        await post(formatShippedToday(day, dedupe.releasedOn(day)), [chats.staff]).catch((e) => log("error", "summary failed", { error: (e as Error).message }));
      }
      // the buyback-rounding note to the Alert Test group, only on a day with some
      const dust = dedupe.dustOn(day);
      if (dust && dust.events > 0 && dedupe.summary(`dust:${day}`)) {
        await post(formatDustNote(day, dust), [testChat]).catch((e) => log("error", "dust note failed", { error: (e as Error).message }));
      }
    }
    if (board && o.board && chats.staff) {
      await keepBoard(o, board.tg, chats.staff, dedupe).catch((e) => log("error", "board failed", { error: (e as Error).message }));
      await answerCommands(o, board.tg, [chats.staff, testChat], dedupe).catch((e) => log("error", "commands failed", { error: (e as Error).message }));
    }
    await Bun.sleep(tickMs);
  }
}

if (import.meta.main) {
  const o = parseArgs(process.argv.slice(2));
  const secrets = loadSecrets(o.envFile); // refuses when the two ids are the same
  const testChat = chatFor(secrets, false); // alarms and summaries: the Alert Test group, always
  const tg = telegramClient(secrets.token);
  let stopping = false;
  process.on("SIGINT", () => (stopping = true));
  process.on("SIGTERM", () => (stopping = true));
  log("info", "started", { alarmsTo: "test group", releasesTo: "staff group + test copy", board: o.board ? "staff group" : "off", launchAt: o.launchAt?.toISOString() ?? "not set", follow: o.follow, dryRun: o.dryRun });
  run(o, tg.send, { test: testChat, staff: secrets.opsChatId }, () => stopping, 2000, o.board ? { tg } : undefined).catch((e) => {
    log("error", "fatal", { error: redact((e as Error).message, secrets.token) });
    process.exit(1);
  });
}
