import { mkdirSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/// The one way the release system reaches Telegram: notices for the team bot, written as files into its inbox
/// (services/teambot/src/runner.ts). The team bot posts them, and remembers every id, so a notice written twice is
/// posted once. Each file is written to a temporary name first, so the team bot never reads half a notice.

export type Notifier = (id: string, body: Record<string, unknown>) => void;

export function inboxNotifier(inbox: string, now: () => number = Date.now): Notifier {
  return (id, body) => {
    mkdirSync(inbox, { recursive: true, mode: 0o700 });
    const name = `${String(now()).padStart(15, "0")}-${id}`;
    const tmp = join(inbox, `${name}.tmp`);
    writeFileSync(tmp, JSON.stringify({ id, kind: "notice", ...body }), { mode: 0o600 });
    renameSync(tmp, join(inbox, `${name}.json`));
  };
}

/// Heartbeats: each side writes its own file every tick; "missing" means older than this.
export const HEARTBEAT_STALE_MS = 2 * 60_000;

export function beat(file: string, now: number): void {
  writeFileSync(file, new Date(now).toISOString(), { mode: 0o600 });
  utimesSync(file, new Date(now), new Date(now));
}

/// How old a heartbeat file is, in ms (Infinity when it is missing).
export function beatAge(file: string, now: number): number {
  try {
    return now - statSync(file).mtimeMs;
  } catch {
    return Infinity;
  }
}
