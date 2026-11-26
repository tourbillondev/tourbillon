import { existsSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "@tourbillon/common/log.ts";
import { chatFor, DEFAULT_ENV_FILE, loadSecrets, redact } from "./config.ts";
import { Deduper } from "./dedupe.ts";
import { formatAlarm, SUMMARY_ONLY, type AlarmLine, type Links } from "./format.ts";
import { telegramClient, type Sender } from "./telegram.ts";

/// The alert bot "Tourbillon Alerts", alarms only (playbook 06 §1): it follows the risk monitor's JSON-line log and
/// posts every risk and ops alarm and information post to the Alert Test group, one post per change, never to the
/// staff group. It is send-only: the team bot (services/teambot) runs on the same bot and is its only Telegram reader
/// (getUpdates), and it alone posts the launch: the hourly set, release statuses, the board, the board poster,
/// Shipped today and the staff commands. Release emergencies are the team bot's too.
/// Owner announcements go through announce.ts (preview and confirmation). It never prints, logs or writes the token.
///   bun src/main.ts --follow <risk-monitor.log> [--follow <another.log>] [--dry-run]
///     [--env-file ~/.tourbillon/alerts.env] [--state-file ~/.tourbillon/alert-bot-state.json]
///     [--explorer <the explorer's /tx/ link>] [--guide <pinned guide link>] [--from-start]

export type Options = {
  follow: string[];
  dryRun: boolean;
  envFile: string;
  stateFile: string;
  explorer?: string;
  guide?: string;
  fromStart: boolean;
};

const MOVED = "moved to the team bot (services/teambot): this bot posts alarms only";

export function parseArgs(argv: string[]): Options {
  const o: Options = { follow: [], dryRun: false, envFile: DEFAULT_ENV_FILE, stateFile: join(homedir(), ".tourbillon", "alert-bot-state.json"), fromStart: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${k} needs a value`);
      return x;
    };
    if (k === "--follow") o.follow.push(v());
    else if (k === "--staff") throw new Error("--staff is gone: alarms never go to the staff group");
    else if (["--board", "--launch-at", "--summary-at", "--summary-utc"].includes(k)) throw new Error(`${k} is ${MOVED}`);
    else if (k === "--dry-run") o.dryRun = true;
    else if (k === "--from-start") o.fromStart = true;
    else if (k === "--env-file") o.envFile = v();
    else if (k === "--state-file") o.stateFile = v();
    else if (k === "--explorer") o.explorer = v();
    else if (k === "--guide") o.guide = v();
    else throw new Error(`unknown flag ${k}`);
  }
  if (o.follow.length === 0) throw new Error("give at least one --follow file");
  return o;
}

/// Turns one JSON line into an alarm post (or null). Release lines and everything else are ignored here.
export function postFor(line: string, dedupe: Deduper, links: Links): string | null {
  let x: Record<string, unknown>;
  try {
    x = JSON.parse(line);
  } catch {
    return null;
  }
  if (x.msg !== "alarm" || typeof x.name !== "string") return null;
  const a = x as unknown as AlarmLine;
  if (SUMMARY_ONLY.has(a.name)) return null;
  return dedupe.alarm(a) ? formatAlarm(a, links) : null;
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

/// Alarms and information posts: the Alert Test group only.
export async function run(o: Options, send: Sender, testChat: string, stop: () => boolean, tickMs = 2000): Promise<void> {
  const dedupe = new Deduper(o.stateFile);
  const links: Links = { tx: o.explorer ? (h) => `${o.explorer}${h}` : undefined, guide: o.guide };
  const tails = o.follow.map((f) => new Tail(f, o.fromStart));
  while (!stop()) {
    for (const t of tails) {
      for (const line of t.read()) {
        const text = postFor(line, dedupe, links);
        if (!text) continue;
        if (o.dryRun) {
          process.stdout.write(`--- would post to the test group\n${text}\n`);
          continue;
        }
        await send(testChat, text).catch((e) => log("error", "post failed", { error: (e as Error).message }));
      }
    }
    await Bun.sleep(tickMs);
  }
}

if (import.meta.main) {
  const o = parseArgs(process.argv.slice(2));
  const secrets = loadSecrets(o.envFile); // refuses when the two ids are the same
  const testChat = chatFor(secrets, false);
  const tg = telegramClient(secrets.token);
  let stopping = false;
  process.on("SIGINT", () => (stopping = true));
  process.on("SIGTERM", () => (stopping = true));
  log("info", "started", { alarmsTo: "test group", follow: o.follow, dryRun: o.dryRun });
  run(o, tg.send, testChat, () => stopping).catch((e) => {
    log("error", "fatal", { error: redact((e as Error).message, secrets.token) });
    process.exit(1);
  });
}
