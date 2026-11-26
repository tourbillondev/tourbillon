import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/// The team bot's private data folder (playbook 06 §7), outside the repo, owned by the project user, mode 700, never
/// committed. It is the kit: the release system reads the same updates.json and posters.
///
///   updates.json                           [{ n, type, title, status, changelog, changelog_line, telegram, x }]
///   config.json                            { repo, explorer, settlementSymbol, contracts, socials, videos, health,
///                                            roadmapImage?, productBot?, domain? }
///   posters/square/update-NN-square.png    1080x1080
///   posters/wide/update-NN-wide.png        1200x675
///   posters/launch.png                     the launch announcement's poster
///   posters/board/board-LL.png             the board poster for LL of TOTAL live, drawn ahead
///   inbox/                                 notices from the release system (written there, read and removed here)
///   state.json, heartbeat                  written by the bot; never edited while it runs
/// Loaded once at start: a change needs a restart.

export type Update = { n: number; type: string; title: string; status: string; changelog: string; changelog_line: string; telegram: string; x: string };
export type Config = {
  repo: string;
  explorer: string;
  settlementSymbol: string;
  roadmapImage?: string;
  productBot?: string;
  domain?: string;
  contracts: { name: string; address: string; sourcify?: boolean }[];
  socials: { name: string; url: string }[];
  videos: { title: string; messageId: number; fromChat?: number }[];
  health: { name: string; url: string }[];
};
export type Book = { dataDir: string; updates: Update[]; byN: Map<number, Update>; total: number; repo: string; cfg: Config; slotMs: number; catchupMs: number };
export type Shape = "square" | "wide";

export const pad = (n: number) => String(n).padStart(2, "0");
export const tag = (n: number) => `update-${pad(n)}`;
export const relUrl = (book: Pick<Book, "repo">, n: number) => `https://github.com/${book.repo}/releases/tag/${tag(n)}`;
export const posterPath = (book: Pick<Book, "dataDir">, n: number, shape: Shape) => join(book.dataDir, "posters", shape, `update-${pad(n)}-${shape}.png`);
export const launchPoster = (book: Pick<Book, "dataDir">) => join(book.dataDir, "posters", "launch.png");
export const boardPoster = (book: Pick<Book, "dataDir">, live: number) => join(book.dataDir, "posters", "board", `board-${pad(live)}.png`);
export const roadmapPath = (book: Book) => (book.cfg.roadmapImage ? join(book.dataDir, book.cfg.roadmapImage) : null);

const isStr = (x: unknown): x is string => typeof x === "string";

/// The problems with updates.json and config.json, as plain sentences.
export function bookProblems(updates: unknown, cfg: unknown): string[] {
  const why: string[] = [];
  if (!Array.isArray(updates) || updates.length === 0) why.push("updates.json is not a list of updates.");
  else
    (updates as Record<string, unknown>[]).forEach((u, i) => {
      if (u?.n !== i + 1) why.push(`updates.json: entry ${i + 1} has n ${String(u?.n)} (they must be 1, 2, 3 … in order).`);
      for (const k of ["type", "title", "status", "telegram", "x"]) if (!isStr(u?.[k]) || !(u[k] as string).trim()) why.push(`updates.json: update ${i + 1} has no ${k}.`);
    });
  const c = cfg as Record<string, unknown> | null;
  if (!c || typeof c !== "object") return [...why, "config.json is not an object."];
  if (!isStr(c.repo) || !/^[\w.-]+\/[\w.-]+$/.test(c.repo)) why.push("config.json: repo is owner/name.");
  if (!isStr(c.explorer) || !/^https:\/\//.test(c.explorer)) why.push("config.json: explorer is an https link.");
  if (!isStr(c.settlementSymbol) || !/^[A-Za-z0-9.]{1,12}$/.test(c.settlementSymbol)) why.push("config.json: settlementSymbol is the settlement token's symbol (from the deployment file).");
  for (const k of ["contracts", "socials", "videos", "health"]) if (!Array.isArray(c[k])) why.push(`config.json: ${k} is a list.`);
  for (const x of (Array.isArray(c.contracts) ? c.contracts : []) as Record<string, unknown>[]) if (!isStr(x?.name) || !isStr(x?.address) || !/^0x[0-9a-fA-F]{40}$/.test(x.address)) why.push("config.json: every contract has a name and an address.");
  for (const x of (Array.isArray(c.videos) ? c.videos : []) as Record<string, unknown>[]) if (!isStr(x?.title) || !Number.isInteger(x?.messageId)) why.push("config.json: every video has a title and a messageId.");
  for (const x of (Array.isArray(c.health) ? c.health : []) as Record<string, unknown>[]) if (!isStr(x?.name) || !isStr(x?.url) || !/^https?:\/\//.test(x.url)) why.push("config.json: every health check has a name and a url.");
  return why;
}

export function makeBook(dataDir: string, updates: Update[], cfg: Config, o: { slotMs?: number; catchupMs?: number } = {}): Book {
  const list = updates.map((u) => ({ ...u, changelog: u.changelog ?? "", changelog_line: u.changelog_line ?? "" }));
  return { dataDir, updates: list, byN: new Map(list.map((u) => [u.n, u])), total: list.length, repo: cfg.repo, cfg, slotMs: o.slotMs ?? 60 * 60_000, catchupMs: o.catchupMs ?? 2 * 60_000 };
}

/// Loads and checks the data folder; refuses to start on any problem rather than guess.
export function loadBook(dataDir: string, o: { slotMs?: number } = {}): Book {
  const read = (f: string) => {
    const p = join(dataDir, f);
    if (!existsSync(p)) throw new Error(`the data folder has no ${f}`);
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      throw new Error(`${f} in the data folder is not valid JSON`);
    }
  };
  const updates = read("updates.json");
  const cfg = read("config.json");
  const why = bookProblems(updates, cfg);
  if (why.length) throw new Error(why.join(" "));
  return makeBook(dataDir, updates as Update[], cfg as Config, o);
}
