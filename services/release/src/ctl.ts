import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";

/// Server commands for the release job (on the server only; never from Telegram). Each command is a file in the
/// job's inbox; the job applies it within its next tick and this prints the answer.
///   tourbillon-release arm 2026-12-01T14:00:00Z    the launch time (UTC): Update 01 then, one every hour
///   tourbillon-release status
///   tourbillon-release hold 15 "reason"            keep an update back (HELD); the next stays on time
///   tourbillon-release release 15                  a held, failed or rolled-back update back in the queue: its checks
///                                          and build run again
///   tourbillon-release pause "reason" | resume
///   tourbillon-release disarm                      only before any update has gone out
///   tourbillon-release deploy-main 30cce40         after the last update: put that commit (the public main's tip) live on
///                                          testnet, then mainnet, checked, rolled back on failure; prints each step
///   [--config ~/.tourbillon-release/release.json]
/// (tourbillon-release is a shortcut for: bun /home/tourbillon/tourbillon-ship/services/release/src/ctl.ts)

export const COMMANDS = ["arm", "disarm", "pause", "resume", "hold", "release", "verify", "status", "preflight", "test", "deploy-main"];

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let configPath: string | undefined;
  const ci = argv.indexOf("--config");
  if (ci >= 0) {
    configPath = argv[ci + 1];
    argv.splice(ci, 2);
  }
  const [cmd = "", arg, ...rest] = argv;
  if (!COMMANDS.includes(cmd)) {
    console.log(`usage: tourbillon-release ${COMMANDS.join("|")} [arg] ["reason"]`);
    process.exit(2);
  }
  const cfg = loadConfig(configPath);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inbox = join(cfg.dataDir, "inbox");
  mkdirSync(inbox, { recursive: true, mode: 0o700 });
  const tmp = join(inbox, `${id}.tmp`);
  writeFileSync(tmp, JSON.stringify({ id, cmd, arg, rest: rest.join(" ") || undefined }), { mode: 0o600 });
  renameSync(tmp, join(inbox, `${id}.json`));
  const state = join(cfg.dataDir, "state.json");
  const until = Date.now() + 30_000;
  for (;;) {
    if (existsSync(state)) {
      try {
        const st = JSON.parse(readFileSync(state, "utf8")) as { lastControl?: { id: string; text: string } };
        if (st.lastControl?.id === id) {
          console.log(st.lastControl.text);
          if (cmd === "deploy-main" && st.lastControl.text.startsWith("Deploying")) process.exitCode = await follow(state, id);
          break;
        }
      } catch {
        /* being written */
      }
    }
    if (Date.now() > until) {
      console.log("No answer in 30 seconds: is the release job running? The command stays in the inbox and is applied when it starts.");
      process.exitCode = 1;
      break;
    }
    await Bun.sleep(300);
  }
}

/// Prints each step of a deploy-main as the job writes it, until it is live, failed or rolled back (exit 0 only if live).
async function follow(state: string, id: string): Promise<number> {
  let shown = 0;
  const until = Date.now() + 90 * 60_000;
  while (Date.now() < until) {
    try {
      const m = (JSON.parse(readFileSync(state, "utf8")) as { main?: { id: string; phase: string; lines: string[] } }).main;
      if (m?.id === id) {
        for (; shown < m.lines.length; shown++) console.log(m.lines[shown]);
        if (["live", "failed", "rolled_back"].includes(m.phase)) {
          console.log(m.phase === "live" ? "DEPLOY-MAIN LIVE" : `DEPLOY-MAIN ${m.phase.replace("_", " ").toUpperCase()}`);
          return m.phase === "live" ? 0 : 1;
        }
      }
    } catch {
      /* being written */
    }
    await Bun.sleep(1000);
  }
  console.log("Still running after 90 minutes: check tourbillon-release status and the release job's log.");
  return 1;
}
