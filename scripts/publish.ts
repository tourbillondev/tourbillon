import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { lintText, why } from "../services/common/src/words.ts";

/// Publishes the public copy of Tourbillon to the public repo (remote "public": tourbillondev/tourbillon), from the
/// private repo (origin: tourbillondev/tourbillon-private). The owner runs it by hand.
///   bun scripts/publish.ts            prepare and check only: export, checks, the exact file list; touches no remote
///   bun scripts/publish.ts --push     the same, then commit to the public repo's own history and push (owner only)
///   bun scripts/publish.ts --worktree --list   preview only: the working tree (tracked and new, not ignored) instead
///                                     of HEAD, to see what a publish would push after the next commit; never with --push
/// Steps:
/// 1. Export the committed tree at HEAD (never uncommitted work) into a temp folder, minus publish-exclude.txt.
/// 2. Refuse if any excluded path is still there, if any file matches a secret pattern, or if the words lint (Overview
///    section 9) finds anything in the published texts (.md, .txt, .json).
/// 3. With --push: clone the public repo into a temp folder, replace its files with the export (submodules kept as
///    pointers), commit as the repo's configured author (tourbillondev) on the public repo's own history (no private
///    history, ever), and push to its main branch. Never forced.

const ROOT = resolve(import.meta.dir, "..");
const sh = (cmd: string[], cwd = ROOT, env?: Record<string, string>) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: env ? { ...process.env, ...env } : undefined });
  if (r.exitCode !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed: ${r.stderr.toString().split("\n")[0]}`);
  return r.stdout.toString();
};

export function excludes(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

export const excluded = (path: string, rules: string[]) => rules.some((r) => (r.endsWith("/") ? path.startsWith(r) : path === r));

/// Secret patterns: refused anywhere in the export (keys, tokens, mnemonics, keystores, env files).
export const SECRET_PATTERNS: { what: string; re: RegExp }[] = [
  { what: "a PEM private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { what: "a GitHub token", re: /\b(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { what: "a Telegram bot token", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { what: "a labelled private key", re: /(private[_ ]?key|secret[_ ]?key|PRIVATE_KEY)\s*[:=]\s*["']?(0x)?[0-9a-fA-F]{64}\b/i },
  { what: "a mnemonic", re: /\b(mnemonic|seed phrase)\s*[:=]\s*["']?([a-z]+\s+){11,23}[a-z]+/i },
  { what: "an encrypted keystore", re: /"ciphertext"\s*:\s*"[0-9a-f]{32,}"/ },
  // anvil's first default key, built from halves so this file never contains it whole
  { what: "a well-known anvil key", re: new RegExp(["ac0974bec39a17e36ba4a6b4d238ff94", "4bacb478cbed5efcae784d7bf4f2ff80"].join("")) },
];
const SECRET_FILES = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12)|alerts\.env)$/;

export function secretFindings(path: string, text: string): string[] {
  const out: string[] = [];
  if (SECRET_FILES.test(path) && !path.endsWith(".env.example")) out.push(`${path}: a secrets file`);
  for (const p of SECRET_PATTERNS) if (p.re.test(text)) out.push(`${path}: ${p.what}`);
  return out;
}

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p, base) : [relative(base, p)];
  });
}

export type Prepared = { dir: string; files: string[]; submodules: { path: string; sha: string }[]; head: string; problems: string[] };

/// Steps 1 and 2: the export and every check. Touches no remote.
export function prepare(fromWorktree = false): Prepared {
  const rules = excludes(readFileSync(join(ROOT, "publish-exclude.txt"), "utf8"));
  const head = sh(["git", "rev-parse", "--short", "HEAD"]).trim();
  const dir = mkdtempSync(join(tmpdir(), "tourbillon-publish-"));
  const tar = join(dir, "..", `${dir.split("/").pop()}.tar`);
  if (fromWorktree) {
    const list = sh(["git", "ls-files", "--cached", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
    const subs = new Set(sh(["git", "ls-files", "-s"]).split("\n").filter((l) => l.startsWith("160000")).map((l) => l.split("\t")[1]));
    for (const f of list) {
      if (subs.has(f) || !existsSync(join(ROOT, f)) || statSync(join(ROOT, f)).isDirectory()) continue;
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      cpSync(join(ROOT, f), join(dir, f));
    }
  } else {
    sh(["git", "archive", "--format=tar", "-o", tar, "HEAD"]);
    sh(["tar", "-xf", tar, "-C", dir]);
    rmSync(tar, { force: true });
  }
  for (const f of walk(dir)) if (excluded(f, rules)) rmSync(join(dir, f), { force: true });
  for (const r of rules) if (r.endsWith("/")) rmSync(join(dir, r), { recursive: true, force: true });
  const submodules = sh(["git", "ls-tree", "-r", "HEAD"])
    .split("\n")
    .filter((l) => l.split(/\s+/)[1] === "commit")
    .map((l) => ({ sha: l.split(/\s+/)[2]!, path: l.split("\t")[1]! }));
  const files = walk(dir).sort();
  const problems: string[] = [];
  for (const f of files) {
    if (excluded(f, rules)) problems.push(`${f}: an excluded path is still in the export`);
    const text = readFileSync(join(dir, f), "utf8");
    problems.push(...secretFindings(f, text));
    if ([".md", ".txt", ".json"].includes(extname(f)) && !f.endsWith("bun.lock") && !f.includes(".gas-snapshot") && !f.endsWith("foundry.lock")) {
      for (const x of lintText(text)) problems.push(`${f}:${x.line}: "${x.match}": ${why(x.rule)}`);
    }
  }
  return { dir, files, submodules, head, problems };
}

/// Step 3 (owner only, with --push): commit the export on the public repo's own history and push.
function push(p: Prepared): void {
  const url = sh(["git", "remote", "get-url", "public"]).trim();
  const name = sh(["git", "config", "user.name"]).trim();
  const email = sh(["git", "config", "user.email"]).trim();
  if (name !== "tourbillondev") throw new Error(`the commit author must be tourbillondev (git config user.name is "${name}")`);
  const work = mkdtempSync(join(tmpdir(), "tourbillon-public-"));
  sh(["git", "clone", "--quiet", url, work]);
  for (const f of readdirSync(work)) if (f !== ".git") rmSync(join(work, f), { recursive: true, force: true });
  cpSync(p.dir, work, { recursive: true });
  sh(["git", "add", "-A"], work);
  for (const s of p.submodules) sh(["git", "update-index", "--add", "--cacheinfo", `160000,${s.sha},${s.path}`], work);
  const status = sh(["git", "status", "--porcelain"], work);
  if (!status.trim()) {
    console.log("nothing changed since the last publish: nothing pushed");
    return;
  }
  const when = new Date().toISOString().slice(0, 16).replace("T", " ");
  const env = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
  sh(["git", "commit", "--quiet", "-m", `Publish ${when} UTC`], work, env);
  sh(["git", "push", "--quiet", "origin", "HEAD:main"], work);
  console.log(`pushed to ${url} (main)`);
  rmSync(work, { recursive: true, force: true });
}

if (import.meta.main) {
  const doPush = process.argv.includes("--push");
  const fromWorktree = process.argv.includes("--worktree");
  if (doPush && fromWorktree) throw new Error("--worktree is a preview: a publish always exports committed HEAD");
  const p = prepare(fromWorktree);
  const dirs = new Map<string, number>();
  for (const f of p.files) dirs.set(f.includes("/") ? f.split("/").slice(0, 2).join("/") : ".", (dirs.get(f.includes("/") ? f.split("/").slice(0, 2).join("/") : ".") ?? 0) + 1);
  console.log(`export of ${fromWorktree ? `the working tree (preview, on top of HEAD ${p.head})` : `private HEAD ${p.head}`}: ${p.files.length} files and ${p.submodules.length} submodule pointers`);
  writeFileSync(join(p.dir, "..", `${p.dir.split("/").pop()}-files.txt`), p.files.join("\n") + "\n");
  if (process.argv.includes("--list")) for (const f of p.files) console.log(`  ${f}`);
  else for (const [d, n] of [...dirs].sort()) console.log(`  ${String(n).padStart(4)}  ${d}`);
  for (const s of p.submodules) console.log(`  submodule ${s.path} @ ${s.sha.slice(0, 12)}`);
  if (p.problems.length) {
    console.log(`\nREFUSED: ${p.problems.length} problem${p.problems.length === 1 ? "" : "s"}`);
    for (const x of p.problems) console.log(`  ${x}`);
    rmSync(p.dir, { recursive: true, force: true });
    process.exit(1);
  }
  console.log("\nchecks: no excluded path, no secret pattern, words lint clean");
  if (!doPush) {
    console.log("prepared only (no --push): nothing committed, no remote touched");
    rmSync(p.dir, { recursive: true, force: true });
  } else {
    push(p);
    rmSync(p.dir, { recursive: true, force: true });
  }
}
