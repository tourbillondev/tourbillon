import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTION_MAX, folder, forbiddenPaths, pad, patchPaths, posterProblems, readKit, readMeta, tag, telegramCaption, TITLE_MAX, TOTAL, X_MAX, type KitUpdate, type Meta, POSTERS_PENDING } from "./queue.ts";
import { addedLines, wordHits } from "./words.ts";

/// The gate: everything that stops an update from going out at its hour, as plain sentences. Empty = ready.
///   meta.json complete and in step with the kit's updates.json (same title, same group);
///   the words check clean on the title, both posts, the changelog line and every line the patch adds;
///   the Telegram caption and the X text within their limits; both posters present, PNG, the exact sizes;
///   patch.diff present, touching no core contract and no private path, and applying cleanly onto the previous update.
/// The tests run when the update is built (the build step), not here.

export type GateResult = { n: number; m?: Meta; k?: KitUpdate; patch?: string; why: string[] };

export const sh = (cmd: string[], cwd: string, input?: string, env?: Record<string, string>) => {
  const r = Bun.spawnSync(cmd, { cwd, stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env } });
  return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString() };
};

export function textProblems(n: number, k: KitUpdate, repo: string, total = TOTAL): string[] {
  const why: string[] = [];
  for (const [name, t] of [
    ["title", k.title],
    ["telegram", k.telegram],
    ["x", k.x],
    ["changelog line", k.changelog_line],
  ] as const) {
    for (const w of wordHits(t)) why.push(`updates.json ${name}: "${w}" is not allowed.`);
  }
  if (!k.telegram.trim() || !k.x.trim()) why.push("updates.json: the Telegram or X text is empty.");
  if (k.title.length > TITLE_MAX) why.push(`The title is ${k.title.length} characters; at most ${TITLE_MAX}.`);
  if (k.changelog_line.includes("\n")) why.push("The changelog line must be one line.");
  const cap = telegramCaption(repo, n, k, total).length;
  if (cap > CAPTION_MAX) why.push(`The Telegram post is ${cap} characters with its heading and link; Telegram allows ${CAPTION_MAX} under a photo.`);
  if (k.x.length > X_MAX) why.push(`The X post is ${k.x.length} characters; X allows ${X_MAX}.`);
  return why;
}

export function patchProblems(patch: string): string[] {
  const why: string[] = [];
  const paths = patchPaths(patch);
  if (!paths.length) why.push("patch.diff changes no file.");
  const bad = forbiddenPaths(paths);
  if (bad.length) why.push(`patch.diff touches ${bad.join(", ")}: an update never changes a core contract or a private path.`);
  const hits = new Map<string, Set<string>>();
  for (const l of addedLines(patch)) for (const w of wordHits(l.text, l.file)) (hits.get(l.file) ?? hits.set(l.file, new Set()).get(l.file)!).add(w);
  for (const [f, ws] of hits) why.push(`patch.diff adds ${[...ws].map((w) => `"${w}"`).join(", ")} in ${f}.`);
  return why;
}

/// The checks that need only the queue folder and the kit (no build tree).
export function gateFolder(queueDir: string, kitDir: string, n: number, repo: string, total = TOTAL): GateResult {
  const dir = folder(queueDir, n);
  if (!existsSync(dir)) return { n, why: [`The folder queue/${pad(n)} is missing.`] };
  const { m, why } = readMeta(dir, n);
  let k: KitUpdate | undefined;
  try {
    k = readKit(kitDir).get(n);
  } catch {
    why.push("The kit's updates.json could not be read.");
  }
  if (!k) why.push(`Update ${pad(n)} is not in the kit's updates.json.`);
  else {
    why.push(...textProblems(n, k, repo, total));
    if (m && m.title !== k.title) why.push(`meta.json title "${m.title}" differs from the kit's "${k.title}": keep them in step.`);
    if (m && k.group && m.group !== k.group) why.push(`meta.json group ${m.group} differs from the kit's ${k.group}.`);
  }
  why.push(...posterProblems(kitDir, n));
  const pp = join(dir, "patch.diff");
  let patch: string | undefined;
  if (!existsSync(pp)) why.push("patch.diff is missing.");
  else {
    patch = readFileSync(pp, "utf8");
    why.push(...patchProblems(patch));
  }
  return { n, m, k, patch, why };
}

/// "2026-12-01 14:00 UTC": the release time written into the changelog line (the release notes feed reads it).
export const changelogTime = (t: number) => `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/// Adds the update's changelog line under "## [Unreleased]" in a "### Tech updates" section (made on first use):
///   - Update 01 · 2026-12-01 14:00 UTC: Public status endpoint: Chain, latest block, indexer lag and feed ages.
export function withChangelogLine(changelog: string, n: number, line: string, at: number): string {
  if (changelog.split("\n").some((l) => l.startsWith(`- Update ${pad(n)} · `))) return changelog;
  const entry = `- Update ${pad(n)} · ${changelogTime(at)}: ${line}`;
  const lines = changelog.split("\n");
  const sec = lines.indexOf("### Tech updates");
  if (sec >= 0) {
    let end = sec + 1;
    while (end < lines.length && lines[end]!.startsWith("- ")) end++;
    lines.splice(end, 0, entry);
    return lines.join("\n");
  }
  const un = lines.findIndex((l) => l.startsWith("## [Unreleased]"));
  if (un < 0) throw new Error('CHANGELOG.md has no "## [Unreleased]" heading');
  let i = un + 1;
  while (i < lines.length && !lines[i]!.startsWith("### ") && !lines[i]!.startsWith("## ")) i++;
  lines.splice(i, 0, "### Tech updates", entry, "");
  return lines.join("\n");
}

export const AUTHOR = { name: "tourbillondev", email: "355136030+tourbillondev@users.noreply.github.com" }; // the public repo's own author

/// Applies a patch in a git work tree, adds the changelog line, and commits it as the update. A plain reason on failure.
export function applyUpdate(tree: string, n: number, patch: string, title: string, changelogLine: string, at: number): { ok: true; commit: string } | { ok: false; why: string } {
  const check = sh(["git", "apply", "--check", "--index", "-"], tree, patch);
  if (!check.ok) return { ok: false, why: `patch.diff does not apply onto the previous update: ${check.err.split("\n")[0]}` };
  if (!sh(["git", "apply", "--index", "-"], tree, patch).ok) return { ok: false, why: "patch.diff could not be applied." };
  if (changelogLine) {
    const p = join(tree, "CHANGELOG.md");
    try {
      writeFileSync(p, withChangelogLine(readFileSync(p, "utf8"), n, changelogLine, at));
    } catch (e) {
      return { ok: false, why: `the changelog line could not be added: ${(e as Error).message}` };
    }
    sh(["git", "add", "CHANGELOG.md"], tree);
  }
  const c = sh(["git", "-c", `user.name=${AUTHOR.name}`, "-c", `user.email=${AUTHOR.email}`, "commit", "-q", "--no-verify", "-m", `Update ${pad(n)}: ${title}`], tree);
  if (!c.ok) return { ok: false, why: `the update could not be committed: ${c.err.split("\n")[0]}` };
  return { ok: true, commit: sh(["git", "rev-parse", "HEAD"], tree).out.trim() };
}

/// onlyPosters: updates whose one finding is that their posters wait for the owner's design approval.
export type Preflight = { results: GateResult[]; ready: number; total: number; tests: { n: number; ok: boolean; why?: string }[]; onlyPosters: number };

/// Every update, in order, in a fresh clone of `repoDir` at `base`: each ready update is applied and committed so the
/// next one is checked onto it, as at release time. With `test`, the full test commands run after each update.
/// A held update is skipped, as at its hour. Changes nothing outside the throwaway clone.
export function preflight(o: { repoDir: string; base: string; queueDir: string; kitDir: string; repo: string; total?: number; only?: number[]; upTo?: number; test?: { cmd: string[]; cwd?: string }[]; install?: { cmd: string[]; cwd?: string }[]; log?: (s: string) => void }): Preflight {
  const total = o.total ?? TOTAL;
  const tree = mkdtempSync(join(tmpdir(), "project-preflight-"));
  const cl = sh(["git", "clone", "-q", "--no-hardlinks", o.repoDir, tree], tmpdir());
  if (!cl.ok) throw new Error(`a fresh copy of ${o.repoDir} could not be made: ${cl.err.split("\n")[0]}`);
  const co = sh(["git", "checkout", "-q", "--detach", o.base], tree);
  if (!co.ok) throw new Error(`the base ${o.base} could not be checked out: ${co.err.split("\n")[0]}`);
  const results: GateResult[] = [];
  const tests: Preflight["tests"] = [];
  try {
    for (let n = 1; n <= Math.min(total, o.upTo ?? total); n++) {
      if (!existsSync(folder(o.queueDir, n))) break; // the queue ends here (not built yet)
      const r = gateFolder(o.queueDir, o.kitDir, n, o.repo, total);
      // posters pending the owner's design approval hold the update at its hour, but every other check still runs: the
      // change is applied (and tested) so the next update is checked onto it
      const blocking = r.why.filter((w) => w !== POSTERS_PENDING);
      if (!blocking.length && r.patch && r.k) {
        const a = applyUpdate(tree, n, r.patch, r.k.title, r.k.changelog_line, Date.now());
        if (!a.ok) r.why.push(a.why);
        else if (o.test && (!o.only || o.only.includes(n))) {
          let why: string | undefined;
          for (const c of [...(o.install ?? []), ...o.test]) {
            const x = sh(c.cmd, join(tree, c.cwd ?? "."));
            if (!x.ok) {
              why = `${c.cmd.join(" ")} (in ${c.cwd ?? "."}) failed: ${lastLines(x.out + "\n" + x.err)}`;
              break;
            }
          }
          tests.push({ n, ok: !why, why });
          o.log?.(`${pad(n)} ${why ? `tests FAIL: ${why}` : "tests pass"}`);
          if (why) r.why.push(`The tests fail after this update: ${why}`);
        }
      }
      if (!o.only || o.only.includes(n)) results.push(r);
    }
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
  const onlyPosters = results.filter((r) => r.why.length > 0 && r.why.every((w) => w === POSTERS_PENDING)).length;
  return { results, ready: results.filter((r) => !r.why.length).length, total: results.length, tests, onlyPosters };
}

/** The lines that say what failed: failing test names first, then error lines, then the last line. */
const lastLines = (s: string) => {
  const lines = s.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const pick = (re: RegExp) => lines.filter((l) => re.test(l)).slice(0, 3).join(" | ");
  return (pick(/^\(fail\)/) || pick(/^error:|\berror TS\d+|banned-words: \d+ hit/) || pick(/\bfail|error|✗/i) || lines.slice(-2).join(" | ")).slice(0, 400);
};

/// The preflight report, plain text, in the team-bot look.
export function preflightText(p: Preflight): string {
  const bad = p.results.filter((r) => r.why.length);
  if (!bad.length) return `🟢 PREFLIGHT ALL CLEAR\n\n${p.total} of ${p.total} queued updates are ready: texts checked, posters the right size, every change applies in order${p.tests.length ? ", tests pass after each one" : ""}.`;
  if (p.onlyPosters === bad.length)
    return `🟡 PREFLIGHT · ${p.ready} of ${p.total} ready · ${p.onlyPosters} wait only for posters pending owner approval\n\nEvery other check passes: texts checked, every change applies in order${p.tests.length ? ", tests pass after each one" : ""}.`;
  return `🟡 PREFLIGHT · ${p.ready} of ${p.total} ready${p.onlyPosters ? ` · ${p.onlyPosters} wait only for posters pending owner approval` : ""}\n\n${bad.filter((r) => !r.why.every((w) => w === POSTERS_PENDING)).map((r) => `${pad(r.n)} (${tag(r.n)}) ${r.why.join(" ")}`).join("\n")}\n\nEach one is held at its hour unless fixed.`;
}
