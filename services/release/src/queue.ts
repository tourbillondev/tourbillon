import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/// The private release queue: one folder per update, queue/NN/ (NN = 01 ... 62), never published:
///   patch.diff   the code change, a git patch onto the previous update (git diff --binary)
///   meta.json    number, group, title, what is new, how to verify, files touched, test names, deploy type, live checks
/// The posting texts and posters come from the kit folder (tourbillon-teambot-data): updates.json and posters/.

export const TOTAL = 62;
export const SQUARE = { w: 1080, h: 1080 };
export const WIDE = { w: 1200, h: 675 };
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024; // Telegram's limit for a photo
export const CAPTION_MAX = 1024; // Telegram's limit for a photo caption
export const X_MAX = 280;
export const TITLE_MAX = 80;

export const GROUPS = ["API", "PROOF", "SDK", "AGENT", "DATA", "MONITOR", "OPS", "DOCS"] as const;
export const DEPLOY_TYPES = ["none", "api", "keeper", "db+"] as const;
export type DeployType = (typeof DEPLOY_TYPES)[number];

/// A live check run after the deploy: an HTTP path on the target's base URL that must answer `status` (default 200)
/// and, when given, contain this text in its body.
export type LiveCheck = { name: string; path: string; expect?: string; status?: number };

export type Meta = {
  number: number;
  group: (typeof GROUPS)[number];
  title: string;
  new: string; // one line: what is new
  verify: { what: string; how: string };
  files: string[];
  tests: string[];
  deploy: DeployType;
  migration: boolean;
  checks: LiveCheck[];
};

/// One update's posting content from the kit's updates.json.
export type KitUpdate = { n: number; type: string; title: string; status: string; changelog: string; changelog_line: string; telegram: string; x: string; group?: string };

export const pad = (n: number) => String(n).padStart(2, "0");
export const folder = (queueDir: string, n: number) => join(queueDir, pad(n));

/// The release tag prefix (checked once against GitHub: no update-NN release existed, so update-NN matches the kit).
export let TAG_PREFIX = "update-";
export const setTagPrefix = (p: string) => {
  if (!/^[a-z]+-$/.test(p)) throw new Error(`tag prefix "${p}" must be lower-case letters and a dash`);
  TAG_PREFIX = p;
};
export const tag = (n: number) => `${TAG_PREFIX}${pad(n)}`;
export const releaseUrl = (repo: string, n: number) => `https://github.com/${repo}/releases/tag/${tag(n)}`;

/// What the posts carry (the team bot's look).
export const telegramCaption = (repo: string, n: number, u: KitUpdate, total = TOTAL) => `Update ${pad(n)} of ${total}\n\n${u.telegram}\n\nGitHub: ${releaseUrl(repo, n)}`;
export const xText = (u: KitUpdate) => u.x;

export function readKit(kitDir: string): Map<number, KitUpdate> {
  const p = join(kitDir, "updates.json");
  const list = JSON.parse(readFileSync(p, "utf8")) as KitUpdate[];
  return new Map(list.map((u) => [u.n, u]));
}

export const posterFile = (kitDir: string, n: number, shape: "square" | "wide") => join(kitDir, "posters", shape, `update-${pad(n)}-${shape}.png`);

const META_KEYS = ["number", "group", "title", "new", "verify", "files", "tests", "deploy", "migration", "checks"];

/// Reads meta.json; gives back the problems as plain sentences instead of throwing.
export function readMeta(dir: string, n: number): { m?: Meta; why: string[] } {
  const p = join(dir, "meta.json");
  if (!existsSync(p)) return { why: ["meta.json is missing."] };
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { why: ["meta.json is not valid JSON."] };
  }
  const why: string[] = [];
  for (const k of META_KEYS) if (!(k in j)) why.push(`meta.json: "${k}" is missing.`);
  for (const k of Object.keys(j)) if (!META_KEYS.includes(k)) why.push(`meta.json: unknown field "${k}".`);
  if (why.length) return { why };
  if (j.number !== n) why.push(`meta.json: number is ${String(j.number)}, the folder is ${pad(n)}.`);
  if (!GROUPS.includes(j.group as Meta["group"])) why.push(`meta.json: group "${String(j.group)}" is not one of ${GROUPS.join(", ")}.`);
  if (!DEPLOY_TYPES.includes(j.deploy as DeployType)) why.push(`meta.json: deploy "${String(j.deploy)}" is not one of ${DEPLOY_TYPES.join(", ")}.`);
  for (const k of ["title", "new"]) if (typeof j[k] !== "string" || !(j[k] as string).trim()) why.push(`meta.json: "${k}" is empty.`);
  const v = j.verify as Meta["verify"];
  if (!v || typeof v.what !== "string" || typeof v.how !== "string" || !v.what.trim() || !v.how.trim()) why.push('meta.json: "verify" needs "what" and "how".');
  for (const k of ["files", "tests"]) if (!Array.isArray(j[k]) || !(j[k] as unknown[]).length || (j[k] as unknown[]).some((x) => typeof x !== "string")) why.push(`meta.json: "${k}" must be a non-empty list of strings.`);
  if (typeof j.migration !== "boolean") why.push('meta.json: "migration" must be true or false.');
  if (!Array.isArray(j.checks) || (j.checks as LiveCheck[]).some((c) => typeof c?.name !== "string" || typeof c?.path !== "string" || !c.path.startsWith("/") || (c.status !== undefined && !Number.isInteger(c.status)))) why.push('meta.json: "checks" must be a list of {name, path starting with /, expect?, status?}.');
  if (why.length) return { why };
  return { m: j as unknown as Meta, why };
}

/// Width and height from a PNG's header, or null when the file is not a PNG.
export function pngSize(bytes: Uint8Array): { w: number; h: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return null;
  if (String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: v.getUint32(16), h: v.getUint32(20) };
}

/// The sentence the gate gives every update while the kit has no posters at all: the owner has not approved a poster
/// design yet (owner, RH10), so none are drawn. Once posters/ exists, every poster is checked as usual.
export const POSTERS_PENDING = "posters pending owner approval.";

export function posterProblems(kitDir: string, n: number): string[] {
  if (!existsSync(join(kitDir, "posters"))) return [POSTERS_PENDING];
  const why: string[] = [];
  for (const [shape, want] of [
    ["square", SQUARE],
    ["wide", WIDE],
  ] as const) {
    const p = posterFile(kitDir, n, shape);
    if (!existsSync(p)) {
      why.push(`The ${shape} poster is missing.`);
      continue;
    }
    if (statSync(p).size > PHOTO_MAX_BYTES) why.push(`The ${shape} poster is over Telegram's 10 MB photo limit.`);
    const s = pngSize(readFileSync(p));
    if (!s) why.push(`The ${shape} poster is not a PNG.`);
    else if (s.w !== want.w || s.h !== want.h) why.push(`The ${shape} poster is ${s.w}x${s.h}; it must be ${want.w}x${want.h}.`);
  }
  return why;
}

/// The paths a git patch touches (both sides of every file header, renames and copies included).
export function patchPaths(patch: string): string[] {
  const out = new Set<string>();
  for (const line of patch.split("\n")) {
    let m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
    if (m) {
      out.add(m[1]!);
      out.add(m[2]!);
      continue;
    }
    m = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line);
    if (m) out.add(m[1]!);
  }
  return [...out].sort();
}

/// Paths an update may never touch: the core contracts and their libraries, the contract build settings, and
/// anything private (an update's change goes public as it is).
export const FORBIDDEN = ["contracts/src/", "contracts/lib/", "contracts/foundry.toml", ".gitmodules", ".env", "services/.env", "private-docs/", ["CLA", "UDE.md"].join("")]; // the last: the repo's rules file for its writing tool

export function forbiddenPaths(paths: string[]): string[] {
  return paths.filter((p) => FORBIDDEN.some((r) => (r.endsWith("/") ? p.startsWith(r) : p === r)) || /(^|\/)\.env$/.test(p));
}
