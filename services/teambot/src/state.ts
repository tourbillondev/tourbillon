import fs from "node:fs";
import path from "node:path";
import type { Book, Update } from "./data.ts";

/// What the team bot has done, in the data folder's state.json. Written after every post (to a temporary file,
/// flushed, then renamed over the old one), so a restart neither repeats nor skips a post. A file that cannot be read
/// stops the bot rather than starting over (starting over could post twice).

export type Outcome = "released" | "delayed" | "held" | "rolled_back";

export type UpdateState = {
  outcome?: Outcome; // the last outcome the release system told
  at?: string; // when it was released (ISO)
  link?: string; // its GitHub release
  posts?: Partial<Record<"head" | "square" | "squareZip" | "wide" | "wideZip", number>>; // message ids of the hourly set
  statusSent?: Partial<Record<Outcome, number>>; // each status line once
};

export type Alarm = { name: string; what: string; who: string; n?: number; postAt?: string; openedAt: number; lastSentAt: number; ackUntil: number; messageIds: number[] };

export type State = {
  launchAt: string | null; // from the release system's "armed" notice
  paused: { reason: string } | null;
  board: number | null; // the pinned board's message id
  offset: number; // the next Telegram update id to read
  done: string[]; // notice ids fully handled (the last 5,000)
  progress: Record<string, number[]>; // message ids of a notice being posted (step by step)
  u: Record<string, UpdateState>;
  launchPosted: boolean;
  finishedPosted: boolean;
  alarms: Record<string, Alarm>; // release emergencies open now
  boardPoster: { due: number; live: number } | null; // the next board poster (only the latest)
  shipped: string[]; // UTC days whose Shipped today went out
  dust: Record<string, { events: number; amount: number; symbol: string }>; // buyback rounding per UTC day
  dustOffset: number; // how far the risk monitor's log has been read
};

export const blankState = (): State => ({
  launchAt: null,
  paused: null,
  board: null,
  offset: 0,
  done: [],
  progress: {},
  u: {},
  launchPosted: false,
  finishedPosted: false,
  alarms: {},
  boardPoster: null,
  shipped: [],
  dust: {},
  dustOffset: 0,
});

export const statePath = (dataDir: string) => path.join(dataDir, "state.json");

export function loadState(dataDir: string): State {
  const p = statePath(dataDir);
  if (!fs.existsSync(p)) return blankState();
  try {
    return { ...blankState(), ...(JSON.parse(fs.readFileSync(p, "utf8")) as Partial<State>) };
  } catch {
    throw new Error("state.json in the data folder could not be read. Fix or restore it before starting (starting blank could post updates twice).");
  }
}

export function saveState(dataDir: string, st: State): void {
  const p = statePath(dataDir);
  const tmp = `${p}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(st, null, 1));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
}

export const us = (st: State, n: number): UpdateState => (st.u[n] ||= {});
export const released = (st: State, book: Book): Update[] => book.updates.filter((u) => st.u[u.n]?.outcome === "released");
export const held = (st: State, book: Book): Update[] => book.updates.filter((u) => ["held", "rolled_back"].includes(st.u[u.n]?.outcome ?? ""));
/// The first update not yet released, held or rolled back.
export const nextDue = (st: State, book: Book): Update | undefined => book.updates.find((u) => !["released", "held", "rolled_back"].includes(st.u[u.n]?.outcome ?? ""));
