import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { applyUpdate, sh } from "./gate.ts";
import { tag, type DeployType, type LiveCheck } from "./queue.ts";

/// Build, deploy and rollback. Versioned release folders and a `current` symlink per target (testnet, then mainnet):
///   <buildsDir>/core/, <buildsDir>/update-NN/      each built tree: dependencies installed, tests passed (built once)
///   <target root>/releases/<UTC stamp>-update-NN/  a copy of the built tree, one per deploy
///   <target root>/current -> releases/...          the live one; the service units run from <target root>/current
/// Rollback = point `current` back at the previous release folder and restart the same roles.

export type Cmd = { cmd: string[]; cwd?: string }; // cwd relative to the release folder
export type Role = "api" | "keeper";

export type Target = {
  name: string; // "testnet" | "mainnet"
  chainId: number; // 46630 | 4663
  root: string;
  baseUrl: string; // where the live checks reach this target's api role (e.g. http://127.0.0.1:8443)
  enabled: boolean;
  restart: Record<Role, string[][]>; // e.g. { api: [["sudo","systemctl","restart","project-api"]], keeper: [...] }
  migrate: string[][]; // run in <release>/services before the restart, for db+ updates
  checks: LiveCheck[]; // always checked after a deploy (e.g. /healthz)
  links?: [string, string][]; // files the service needs that are not in git, linked into every release folder: ["services/.env", "/home/tourbillon/project/services/.env"]
};

export type DeployConfig = {
  repoDir: string; // a clone of the public repo; update commits are made here (never pushed by the job)
  buildsDir: string;
  install: Cmd[];
  tests: Cmd[];
  targets: Target[];
  checkTimeoutMs: number;
  keepReleases: number; // release folders kept per target (older ones are removed; the live and previous never)
};

export type Run = (cmd: string[], cwd: string) => { ok: boolean; out: string; err: string };
export const realRun: Run = (cmd, cwd) => sh(cmd, cwd);

export const releasesDir = (root: string) => join(root, "releases");
export const currentLink = (root: string) => join(root, "current");
const firstLine = (s: string) => s.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
const stamp = (t: number) => new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/// The release folder name `current` points at, or null.
export function currentRelease(root: string): string | null {
  const l = currentLink(root);
  if (!lstatSync(l, { throwIfNoEntry: false })?.isSymbolicLink()) return null;
  return basename(readlinkSync(l));
}

/// Points `current` at a release folder atomically (a new link, renamed over the old one).
export function switchTo(root: string, name: string): void {
  const target = join(releasesDir(root), name);
  if (!existsSync(target)) throw new Error(`release folder ${name} does not exist`);
  const tmp = `${currentLink(root)}.new`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, currentLink(root));
}

/// Writes the tree of `commit` into a fresh folder (replacing a half-built one).
function exportTree(repoDir: string, commit: string, dir: string): string | null {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tar = `${dir}.tar`;
  const a = sh(["git", "archive", "--format=tar", "-o", tar, commit], repoDir);
  if (!a.ok) return `the tree could not be exported: ${firstLine(a.err)}`;
  const x = sh(["tar", "-xf", tar, "-C", dir], repoDir);
  rmSync(tar, { force: true });
  if (!x.ok) return `the tree could not be unpacked: ${firstLine(x.err)}`;
  return null;
}

function runAll(cmds: Cmd[], dir: string, run: Run, what: string): string | null {
  for (const c of cmds) {
    const r = run(c.cmd, join(dir, c.cwd ?? "."));
    if (!r.ok) return `${what} failed (${c.cmd.join(" ")} in ${c.cwd ?? "."}): ${failLines(r.out + "\n" + r.err)}`;
  }
  return null;
}

/** The lines that say what failed: failing test names first, then error lines, then the last line. */
const failLines = (s: string) => {
  const lines = s.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const pick = (re: RegExp) => lines.filter((l) => re.test(l)).slice(0, 3).join(" | ");
  return (pick(/^\(fail\)/) || pick(/^error:|\berror TS\d+|banned-words: \d+ hit/) || pick(/\bfail|error|✗/i) || lines.slice(-2).join(" | ")).slice(0, 400);
};

/// The launch base's build (once, before launch): its tree, dependencies installed, tests run.
export function buildCore(cfg: DeployConfig, base: string, run: Run = realRun): { ok: true; dir: string } | { ok: false; why: string } {
  const dir = join(cfg.buildsDir, "core");
  const e = exportTree(cfg.repoDir, base, dir);
  if (e) return { ok: false, why: e };
  const w = runAll(cfg.install, dir, run, "install") ?? runAll(cfg.tests, dir, run, "the tests");
  return w ? { ok: false, why: w } : { ok: true, dir };
}

/// The pre-release half: the update's patch committed onto the previous update (in a throwaway work tree of the
/// repo), its tree written to <buildsDir>/update-NN, dependencies installed, the tests run. Nothing live changes.
export function buildUpdate(cfg: DeployConfig, n: number, prevCommit: string, patch: string, title: string, changelogLine: string, at: number, run: Run = realRun): { ok: true; commit: string; dir: string } | { ok: false; why: string } {
  const tree = mkdtempSync(join(tmpdir(), "project-build-"));
  rmSync(tree, { recursive: true, force: true });
  const add = sh(["git", "worktree", "add", "--detach", "-q", tree, prevCommit], cfg.repoDir);
  if (!add.ok) return { ok: false, why: `the previous update ${prevCommit.slice(0, 12)} could not be checked out: ${firstLine(add.err)}` };
  let commit: string;
  try {
    const a = applyUpdate(tree, n, patch, title, changelogLine, at);
    if (!a.ok) return { ok: false, why: a.why };
    commit = a.commit;
  } finally {
    sh(["git", "worktree", "remove", "--force", tree], cfg.repoDir);
    rmSync(tree, { recursive: true, force: true });
  }
  const dir = join(cfg.buildsDir, tag(n));
  const e = exportTree(cfg.repoDir, commit, dir);
  if (e) return { ok: false, why: e };
  const w = runAll(cfg.install, dir, run, "install") ?? runAll(cfg.tests, dir, run, "the tests");
  return w ? { ok: false, why: w } : { ok: true, commit, dir };
}

/// A merged commit of the public main (deploy-main): its tree written to <buildsDir>/<name>, dependencies installed,
/// the same tests as every update. Nothing live changes.
export function buildCommit(cfg: DeployConfig, commit: string, name: string, run: Run = realRun): { ok: true; dir: string } | { ok: false; why: string } {
  const dir = join(cfg.buildsDir, name);
  const e = exportTree(cfg.repoDir, commit, dir);
  if (e) return { ok: false, why: e };
  const w = runAll(cfg.install, dir, run, "install") ?? runAll(cfg.tests, dir, run, "the tests");
  return w ? { ok: false, why: w } : { ok: true, dir };
}

/// Does the built tree add a database migration that the live release on this target does not have?
export function addsMigration(t: Target, builtDir: string): boolean {
  const j = (dir: string) => {
    try {
      return (JSON.parse(readFileSync(join(dir, "services", "drizzle", "meta", "_journal.json"), "utf8")) as { entries?: { tag: string }[] }).entries?.map((e) => e.tag) ?? [];
    } catch {
      return [];
    }
  };
  const cur = currentRelease(t.root);
  const live = new Set(cur ? j(join(releasesDir(t.root), cur)) : []);
  return j(builtDir).some((tag) => !live.has(tag));
}

/// Copies a built tree into a target as a new release folder; gives back its name.
export function placeRelease(t: Target, builtDir: string, name: string, now: number): string {
  const rel = `${stamp(now)}-${name}`;
  const dest = join(releasesDir(t.root), rel);
  mkdirSync(releasesDir(t.root), { recursive: true });
  const r = sh(["rsync", "-a", "--delete", `${builtDir}/`, `${dest}/`], t.root);
  if (!r.ok) throw new Error(`the release folder could not be written: ${firstLine(r.err)}`);
  for (const [rel, target] of t.links ?? []) {
    if (!existsSync(target)) throw new Error(`the release folder needs ${target}, which is missing`);
    mkdirSync(dirname(join(dest, rel)), { recursive: true });
    rmSync(join(dest, rel), { force: true });
    symlinkSync(target, join(dest, rel));
  }
  return rel;
}

/// One live check request may take this long (the first read after a restart warms every cache).
export const CHECK_REQUEST_TIMEOUT_MS = 15_000;

/// Every live check, retried until all pass or the time runs out. The failures, as plain sentences.
export async function liveChecks(t: Target, checks: LiveCheck[], timeoutMs: number, fetchFn: typeof fetch = fetch, sleep = (ms: number) => Bun.sleep(ms), now: () => number = Date.now): Promise<string[]> {
  const deadline = now() + timeoutMs;
  const failing = new Map<string, string>();
  for (;;) {
    failing.clear();
    for (const c of checks) {
      const url = t.baseUrl.replace(/\/$/, "") + c.path;
      try {
        const r = await fetchFn(url, { signal: AbortSignal.timeout(CHECK_REQUEST_TIMEOUT_MS) });
        const body = await r.text();
        const want = c.status ?? 200;
        if (r.status !== want) failing.set(c.name, `${c.name}: ${c.path} answered ${r.status}${want !== 200 ? ` (expected ${want})` : ""}.`);
        else if (c.expect && !body.includes(c.expect)) failing.set(c.name, `${c.name}: ${c.path} answered without "${c.expect}".`);
      } catch {
        failing.set(c.name, `${c.name}: ${c.path} did not answer.`);
      }
    }
    if (!failing.size || now() >= deadline) break;
    await sleep(1000);
  }
  return [...failing.values()];
}

/// The roles restarted for each deploy type. The api role is restarted for every update, so the live server always runs
/// from `current` (it serves the changelog feed, the docs links and the release's own files); keeper and database
/// updates restart the keeper too.
export const rolesFor = (d: DeployType): Role[] => (d === "none" || d === "api" ? ["api"] : ["api", "keeper"]);

function restart(t: Target, roles: Role[], run: Run): string | null {
  for (const role of roles)
    for (const c of t.restart[role] ?? []) {
      const x = run(c, t.root);
      if (!x.ok) return `${t.name}: restarting ${role} failed (${firstLine(x.err || x.out)}).`;
    }
  return null;
}

/// Removes old release folders, keeping the newest `keep` and never the live or the previous one.
export function prune(t: Target, keep: number, protect: string[]): void {
  const all = existsSync(releasesDir(t.root)) ? readdirSync(releasesDir(t.root)).sort() : [];
  for (const r of all.slice(0, Math.max(0, all.length - keep))) if (!protect.includes(r)) rmSync(join(releasesDir(t.root), r), { recursive: true, force: true });
}

export type TargetResult = { target: string; release: string; prev: string };
export type DeployOutcome =
  | { status: "live"; done: TargetResult[] }
  | { status: "rolled_back"; failed: string; why: string[]; back: { target: string; to: string; healthy: boolean }[] };

/// The live half, target by target (testnet first): copy the built tree into a new release folder, run additive
/// migrations if any, switch `current`, restart the update's roles, run the live checks. If any check fails on any
/// target, every target this update switched goes back to its previous release, restarts, and is checked again.
export async function deploy(
  cfg: DeployConfig,
  n: number,
  builtDir: string,
  deployType: DeployType,
  migration: boolean,
  checks: LiveCheck[],
  o: { run?: Run; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number; afterTarget?: (t: Target, restartedAt: number) => Promise<string | null>; name?: string; migrationFor?: (t: Target) => boolean } = {},
): Promise<DeployOutcome> {
  const run = o.run ?? realRun;
  const now = o.now ?? Date.now;
  const roles = rolesFor(deployType);
  const done: TargetResult[] = [];
  const back = async (failed: string, why: string[]): Promise<DeployOutcome> => {
    const out: { target: string; to: string; healthy: boolean }[] = [];
    for (const d of done.reverse()) {
      const t = cfg.targets.find((x) => x.name === d.target)!;
      switchTo(t.root, d.prev);
      const r = restart(t, roles.length ? roles : [], run);
      const w = r ? [r] : await liveChecks(t, t.checks, cfg.checkTimeoutMs, o.fetch, o.sleep, now);
      out.push({ target: t.name, to: d.prev, healthy: w.length === 0 });
    }
    return { status: "rolled_back", failed, why, back: out };
  };
  for (const t of cfg.targets.filter((x) => x.enabled)) {
    const prev = currentRelease(t.root);
    if (!prev) return back(t.name, [`${t.name}: nothing is live yet. Place the launch base first (setup-target).`]);
    let rel: string;
    try {
      rel = placeRelease(t, builtDir, o.name ?? tag(n), now());
    } catch (e) {
      return back(t.name, [`${t.name}: ${(e as Error).message}`]);
    }
    done.push({ target: t.name, release: rel, prev });
    if (o.migrationFor ? o.migrationFor(t) : migration)
      for (const m of t.migrate) {
        const x = run(m, join(releasesDir(t.root), rel, "services"));
        if (!x.ok) return back(t.name, [`${t.name}: the database step failed (${firstLine(x.err || x.out)}).`]);
      }
    switchTo(t.root, rel);
    const restartedAt = now();
    const r = restart(t, roles, run);
    const why = r ? [r] : await liveChecks(t, [...t.checks, ...checks], cfg.checkTimeoutMs, o.fetch, o.sleep, now);
    if (!why.length && o.afterTarget) {
      const extra = await o.afterTarget(t, restartedAt); // e.g. the team bot's heartbeat after the mainnet restart
      if (extra) why.push(extra);
    }
    if (why.length) return back(t.name, why.map((w) => (w.startsWith(`${t.name}:`) ? w : `${t.name}: ${w}`)));
  }
  for (const d of done) prune(cfg.targets.find((x) => x.name === d.target)!, cfg.keepReleases, [d.release, d.prev]);
  return { status: "live", done };
}

/// One-time set-up of a target: the launch base's built tree as the first release folder, `current` pointing at it.
export function setupTarget(t: Target, coreDir: string, now = Date.now()): string {
  const rel = placeRelease(t, coreDir, "base", now);
  switchTo(t.root, rel);
  return rel;
}
