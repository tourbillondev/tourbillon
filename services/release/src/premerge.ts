/// The pre-merge check: may v2-arena be merged into main now?
///   bun src/premerge.ts [--branch v2-arena] [--kit <kit dir>] [--queue <queue dir>] [--out <report.md>]
/// On a throwaway copy only (nothing is pushed, nothing live changes):
///   1. fresh copy of the public main; merge the branch into it (a conflict stops here, naming the files);
///   2. the full test suites on the merge: services (types, tests), banned words, sdk, tools/mcp, the app, contracts;
///   3. every update still in the queue, in order, applied on top exactly as the release system will apply it
///      (patch and changelog line, committed as tourbillondev), with the full suites after each one.
/// Exit 0 and "PRE-MERGE CHECK PASSED" only if every step passes. The report names main and the branch by commit, so
/// the merge that is pushed later must be of exactly those two (if main moved, run it again).
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { applyUpdate, gateFolder, sh } from "./gate.ts";
import { pad, patchPaths, TOTAL } from "./queue.ts";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1]! : d;
};
const PUBLIC = "https://github.com/tourbillondev/tourbillon.git";
const branch = arg("branch", "v2-arena");
const kitDir = arg("kit", join(homedir(), "project-private", "kit-v2", "tourbillon-teambot-data"));
const queueDir = arg("queue", join(homedir(), "project-private", "queue"));
const out = arg("out", join(homedir(), "project-private", "v2", "premerge", `premerge-${new Date().toISOString().replace(/[:.]/g, "-")}.md`));
const LAUNCH = Date.parse("2026-11-18T23:00:00Z");
const ID = ["-c", "user.name=tourbillondev", "-c", "user.email=355136030+tourbillondev@users.noreply.github.com"];

const lines: string[] = [];
const say = (s: string) => (console.log(s), lines.push(s));
let failed = false;
const finish = (code: number) => {
  sh(["mkdir", "-p", join(out, "..")], tmpdir());
  writeFileSync(out, `${lines.join("\n")}\n`);
  console.log(`report: ${out}`);
  rmSync(tree, { recursive: true, force: true });
  process.exit(code);
};

const tree = mkdtempSync(join(tmpdir(), "project-premerge-"));
say(`# Pre-merge check: ${branch} into main`);
say("");
const cl = sh(["git", "clone", "-q", "--branch", "main", PUBLIC, tree], tmpdir());
if (!cl.ok) (say(`FAIL could not copy the public main: ${cl.err.split("\n")[0]}`), finish(1));
const main = sh(["git", "rev-parse", "HEAD"], tree).out.trim();
const f = sh(["git", "fetch", "-q", "origin", branch], tree);
if (!f.ok) (say(`FAIL could not read ${branch}: ${f.err.split("\n")[0]}`), finish(1));
const br = sh(["git", "rev-parse", "FETCH_HEAD"], tree).out.trim();
say(`main ${main} · ${branch} ${br} · ${new Date().toISOString()}`);

// which updates are still to come: one after the highest "Update NN:" commit on main
const subjects = sh(["git", "log", "--format=%s", "main"], tree).out.split("\n");
const done = Math.max(0, ...subjects.map((s) => /^Update (\d{2}):/.exec(s)?.[1]).filter(Boolean).map(Number));
const from = done + 1;
say(`updates on main: 01-${pad(done)}; still to come: ${pad(from)}-${pad(TOTAL)}`);
say("");

const m = sh(["git", ...ID, "merge", "--no-ff", "-q", "-m", `Merge ${branch} into main`, br], tree);
if (!m.ok) {
  const files = sh(["git", "diff", "--name-only", "--diff-filter=U"], tree).out.trim().split("\n").filter(Boolean);
  say(`FAIL the merge conflicts in: ${files.join(", ") || m.err.split("\n")[0]}`);
  finish(1);
}
say(`PASS merge (no conflict): ${sh(["git", "rev-parse", "HEAD"], tree).out.trim().slice(0, 12)}`);

type Step = { name: string; cmd: string[]; cwd: string; when?: () => boolean };
const run = (s: Step): boolean => {
  if (s.when && !s.when()) return true;
  const t0 = Date.now();
  const r = sh(s.cmd, join(tree, s.cwd));
  const secs = Math.round((Date.now() - t0) / 1000);
  if (r.ok) return true;
  const why = `${r.out}\n${r.err}`.split("\n").filter((l) => /\(fail\)|error|FAIL|✗|hit/i.test(l)).slice(0, 4).join(" | ") || r.err.split("\n").slice(-2).join(" | ");
  say(`  FAIL ${s.name} (${secs} s): ${why.slice(0, 400)}`);
  return false;
};
const has = (p: string) => () => existsSync(join(tree, p));
const INSTALL: Step[] = [
  { name: "install services", cmd: ["bun", "install", "--frozen-lockfile"], cwd: "services" },
  { name: "install sdk", cmd: ["bun", "install", "--frozen-lockfile"], cwd: "sdk", when: has("sdk/package.json") },
  { name: "install tools/mcp", cmd: ["bun", "install", "--frozen-lockfile"], cwd: "tools/mcp", when: has("tools/mcp/package.json") },
  { name: "install app", cmd: ["bun", "install", "--frozen-lockfile"], cwd: "app", when: has("app/package.json") },
];
const SUITES: Step[] = [
  { name: "services types", cmd: ["bunx", "tsc", "--noEmit"], cwd: "services" },
  { name: "services tests", cmd: ["bun", "test"], cwd: "services" },
  { name: "banned words", cmd: ["bun", "tools/banned-words.ts", "."], cwd: "." },
  { name: "sdk", cmd: ["sh", "-c", "bunx tsc --noEmit && bun test"], cwd: "sdk", when: has("sdk/package.json") },
  { name: "tools/mcp", cmd: ["bun", "test"], cwd: "tools/mcp", when: has("tools/mcp/package.json") },
  { name: "app", cmd: ["sh", "-c", "bunx tsc --noEmit && bun test ./test"], cwd: "app", when: has("app/package.json") },
];
const CONTRACTS: Step = { name: "contracts (forge test)", cmd: ["forge", "test"], cwd: "contracts" };

const suites = (label: string, withContracts: boolean): boolean => {
  const t0 = Date.now();
  let ok = INSTALL.every(run);
  if (ok) for (const s of SUITES) ok = run(s) && ok;
  if (ok && withContracts) ok = run(CONTRACTS);
  say(`${ok ? "PASS" : "FAIL"} ${label} (${Math.round((Date.now() - t0) / 1000)} s)`);
  if (!ok) failed = true;
  return ok;
};

suites("full suites on the merge, contracts included", true);
for (let n = from; n <= TOTAL; n++) {
  const g = gateFolder(queueDir, kitDir, n, "tourbillondev/tourbillon", TOTAL);
  if (g.why.length || !g.patch || !g.k) {
    say(`FAIL update ${pad(n)}: its gate refuses it: ${g.why.join(" ")}`);
    failed = true;
    continue;
  }
  const a = applyUpdate(tree, n, g.patch, g.k.title, g.k.changelog_line, LAUNCH + n * 3_600_000);
  if (!a.ok) {
    say(`FAIL update ${pad(n)}: ${a.why} (files: ${patchPaths(g.patch).join(", ")})`);
    failed = true;
    continue;
  }
  suites(`update ${pad(n)} applied on top, full suites`, patchPaths(g.patch).some((p) => p.startsWith("contracts/")));
}
say("");
say(failed ? "PRE-MERGE CHECK FAILED: do not merge." : `PRE-MERGE CHECK PASSED: merging ${branch} ${br.slice(0, 12)} into main ${main.slice(0, 12)} passed for every remaining update (each applies, builds and tests on it).`);
finish(failed ? 1 : 0);
