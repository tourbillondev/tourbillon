import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadBook } from "./data.ts";
import { createTeambot } from "./runner.ts";
import { telegramClient } from "./telegram.ts";

/// The Tourbillon team bot (playbook 06), on the "Tourbillon Alerts" bot. The only Telegram reader (getUpdates) and
/// the only poster of the launch: see runner.ts.
///   bun src/main.ts --data <data folder> [--release-heartbeat <release data folder>/heartbeat]
///     [--dust-log <risk-monitor.log>] [--env-file ~/.tourbillon/alerts.env] [--dry-run [--telegram-api http://127.0.0.1:<port>]]
/// --telegram-api (the local Telegram stand-in, services/release/dryrun) is refused outside a dry run.
/// The env file (written by the owner, mode 600, never committed): ALERT_BOT_TOKEN, OPS_CHAT_ID (the staff group),
/// TEST_CHAT_ID (Alert Test). The token is never printed, logged or posted.

export type Options = { data: string; releaseHeartbeat?: string; dustLog?: string; envFile: string; dryRun: boolean; telegramApi?: string };

export function parseArgs(argv: string[]): Options {
  const o: Partial<Options> & { envFile: string; dryRun: boolean } = { envFile: join(homedir(), ".tourbillon", "alerts.env"), dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = () => {
      const x = argv[++i];
      if (x === undefined || x.startsWith("--")) throw new Error(`${k} needs a value`);
      return x;
    };
    if (k === "--data") o.data = v();
    else if (k === "--release-heartbeat") o.releaseHeartbeat = v();
    else if (k === "--dust-log") o.dustLog = v();
    else if (k === "--env-file") o.envFile = v();
    else if (k === "--dry-run") o.dryRun = true;
    else if (k === "--telegram-api") o.telegramApi = v();
    else throw new Error(`unknown option ${k}`);
  }
  if (!o.data) throw new Error("--data <the team bot's data folder> is needed");
  if (o.telegramApi && (!o.dryRun || !/^http:\/\/127\.0\.0\.1:\d+$/.test(o.telegramApi))) throw new Error("--telegram-api is only for a dry run, and only http://127.0.0.1:<port>");
  return o as Options;
}

/// ALERT_BOT_TOKEN, OPS_CHAT_ID and TEST_CHAT_ID from the env file. Refuses a file others can read, a missing value,
/// and the same chat for both (an alarm or a test could land in the staff group).
export function readEnv(path: string): { token: string; chat: number; testChat: number } {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    throw new Error(`the env file ${path} cannot be read`);
  }
  if ((mode & 0o077) !== 0) throw new Error(`the env file ${path} is readable by others: chmod 600 it`);
  const kv = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) kv.set(m[1]!, m[2]!.replace(/^["']|["']$/g, ""));
  }
  const token = kv.get("ALERT_BOT_TOKEN") ?? "";
  if (!/^\d+:[\w-]{20,}$/.test(token)) throw new Error(`${path}: ALERT_BOT_TOKEN is missing or not a bot token`);
  const id = (k: string) => {
    const x = kv.get(k) ?? "";
    if (!/^-\d+$/.test(x)) throw new Error(`${path}: ${k} is missing or not a group id (it starts with -)`);
    return Number(x);
  };
  const chat = id("OPS_CHAT_ID");
  const testChat = id("TEST_CHAT_ID");
  if (chat === testChat) throw new Error(`${path}: OPS_CHAT_ID and TEST_CHAT_ID are the same; refusing to start`);
  return { token, chat, testChat };
}

if (import.meta.main) {
  try {
    const o = parseArgs(process.argv.slice(2));
    const env = readEnv(o.envFile);
    const hide = (s: string) => s.split(env.token).join("<token>");
    const bot = createTeambot({
      book: loadBook(o.data),
      tg: telegramClient(env.token, { api: o.telegramApi }),
      chat: env.chat,
      testChat: env.testChat,
      dryRun: o.dryRun,
      releaseHeartbeat: o.releaseHeartbeat,
      dustLog: o.dustLog,
      log: (...a) => console.log("[teambot]", ...a.map((x) => hide(String(x)))),
    });
    const run = bot.start();
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (run.stop(), process.exit(0)));
  } catch (e) {
    console.error(`[teambot] not started: ${(e as Error).message}`);
    process.exit(1);
  }
}
