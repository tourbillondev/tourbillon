// Starts and checks the local Telegram stand-in for one dry-run folder. Each folder has its own port (the config's
// telegramApi) and its own record file. A port already in use stops the run with a clear error: one run's posts must
// never land in another run's record.
//   bun dryrun/telegram-recorder.ts start <run folder>   starts it in the background and writes fake-telegram.pid
//   bun dryrun/telegram-recorder.ts next-port            the next port no run folder uses yet (from 18101)
import { spawn } from "node:child_process";
import { existsSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const FIRST_PORT = 18101;
const SCRIPT = resolve(import.meta.dir, "fake-telegram.ts");

/** The stand-in's port from a run folder's config (telegramApi must be a local address). */
export function portOf(configFile: string): number {
  const api = (JSON.parse(readFileSync(configFile, "utf8")) as { telegramApi?: string }).telegramApi;
  if (!api) throw new Error(`${configFile} has no telegramApi`);
  const u = new URL(api);
  if (u.hostname !== "127.0.0.1" || !u.port) throw new Error(`telegramApi must be http://127.0.0.1:<port>, not ${api}`);
  return Number(u.port);
}

/** The next port from FIRST_PORT that no run folder under root has in its config. */
export function nextPort(root: string): number {
  let max = FIRST_PORT - 1;
  for (const d of existsSync(root) ? readdirSync(root) : []) {
    const f = join(root, d, "release.dryrun.json");
    if (!existsSync(f)) continue;
    try {
      max = Math.max(max, portOf(f));
    } catch {
      // a folder without a local telegramApi uses no port
    }
  }
  return max + 1;
}

/** Whether anything listens on 127.0.0.1:port (a connect answers) or the port cannot be taken. */
export async function portInUse(port: number): Promise<boolean> {
  const answers = await new Promise<boolean>((ok) => {
    const s = connect({ host: "127.0.0.1", port });
    s.once("connect", () => (s.destroy(), ok(true)));
    s.once("error", () => ok(false));
    s.setTimeout(1000, () => (s.destroy(), ok(false)));
  });
  if (answers) return true;
  return new Promise<boolean>((ok) => {
    const srv = createServer();
    srv.once("error", () => ok(true));
    srv.listen({ host: "127.0.0.1", port, exclusive: true }, () => srv.close(() => ok(false)));
  });
}

/** What the stand-in on this port says about itself, or null if none answers. */
export async function whoami(port: number): Promise<{ record: string; pid: number } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/whoami`, { signal: AbortSignal.timeout(1000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { record?: unknown; pid?: unknown };
    return typeof j.record === "string" && typeof j.pid === "number" ? { record: j.record, pid: j.pid } : null;
  } catch {
    return null;
  }
}

/** Starts the stand-in on port, recording to record. Refuses a port in use; gives back the pid once it answers as ours. */
export async function startRecorder(port: number, record: string, log: string): Promise<number> {
  record = resolve(record);
  if (await portInUse(port)) {
    const who = await whoami(port);
    throw new Error(
      `port ${port} is already in use${who ? ` by a Telegram recorder writing to ${who.record} (pid ${who.pid})` : " by another program"}. ` +
        "Stop it first: this run will not post through another run's recorder.",
    );
  }
  const out = openSync(log, "a");
  const child = spawn("bun", [SCRIPT, String(port), record], { detached: true, stdio: ["ignore", out, out] });
  child.unref();
  let exited: number | null = null;
  child.once("exit", (code) => (exited = code ?? -1));
  for (let i = 0; i < 50; i++) {
    const who = await whoami(port);
    if (who && who.pid === child.pid && who.record === record) return child.pid!;
    if (who && who.pid !== child.pid) {
      child.kill();
      throw new Error(`port ${port} was taken by another recorder (pid ${who.pid}, writing to ${who.record}) while this one started`);
    }
    if (exited !== null) break;
    await Bun.sleep(200);
  }
  child.kill();
  const tail = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").slice(-3).join("\n") : "";
  throw new Error(`the Telegram recorder did not start on port ${port}${tail ? `:\n${tail}` : ""}`);
}

if (import.meta.main) {
  const [cmd, D] = process.argv.slice(2);
  try {
    if (cmd === "next-port") console.log(nextPort(join(homedir(), "project-private")));
    else if (cmd === "start" && D) {
      const port = portOf(join(D, "release.dryrun.json"));
      const pid = await startRecorder(port, join(D, "telegram-record.jsonl"), join(D, "fake-telegram.log"));
      writeFileSync(join(D, "fake-telegram.pid"), `${pid}\n`);
      console.log(`fake telegram on ${port} (pid ${pid}), recording to ${join(D, "telegram-record.jsonl")}`);
    } else {
      console.log("usage: telegram-recorder.ts start <run folder> | next-port");
      process.exit(2);
    }
  } catch (e) {
    console.error(`STOP: ${(e as Error).message}`);
    process.exit(1);
  }
}
