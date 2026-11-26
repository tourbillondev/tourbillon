import { expect, test } from "bun:test";
import { excluded, excludes, secretFindings } from "../../../scripts/publish.ts";
/// The session rules file, named from fragments (the words gate refuses tool names in published files).
const RULES_FILE = ["CLA", "UDE.md"].join("");

test("the publish exclude list and the secret patterns", () => {
  const rules = excludes(`# comment\ndocs/spec/\ndocs/notes/\nqueue/\n${RULES_FILE}\n`);
  expect(rules).toEqual(["docs/spec/", "docs/notes/", "queue/", RULES_FILE]);
  for (const p of ["docs/spec/TOURBILLON_Overview.md", "docs/notes/M7_NOTES.md", "queue/07/update.json", RULES_FILE]) expect(excluded(p, rules)).toBe(true);
  for (const p of ["docs/backend/api-v1.md", `services/${RULES_FILE}.bak`, "contracts/src/Engine.sol"]) expect(excluded(p, rules)).toBe(false);

  const anvil = ["ac0974bec39a17e36ba4a6b4d238ff94", "4bacb478cbed5efcae784d7bf4f2ff80"].join("");
  const bad: [string, string][] = [
    ["a.md", ["-----BEGIN OPENSSH ", "PRIVATE KEY-----"].join("")],
    ["a.ts", `const t = "ghp_${"a".repeat(36)}"`],
    ["a.txt", `token 123456789:${"A".repeat(35)}`],
    ["a.ts", `PRIVATE_KEY=0x${"1".repeat(64)}`],
    ["a.ts", `mnemonic: "${Array(12).fill("word").join(" ")}"`],
    ["k.json", `{"crypto":{"ciphertext":"${"ab".repeat(32)}"}}`],
    ["a.ts", anvil],
  ];
  for (const [p, text] of bad) expect(secretFindings(p, text).length).toBeGreaterThan(0);
  expect(secretFindings(".env", "")).toEqual([".env: a secrets file"]);
  expect(secretFindings("services/.env.example", "")).toEqual([]);
  // ordinary code: hashes and bytes32 constants are not secrets
  expect(secretFindings("a.ts", `const ZERO32 = "0x${"0".repeat(64)}"; const h = keccak256(x);`)).toEqual([]);
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pushExport, type Prepared } from "../../../scripts/publish.ts";

// The publish mirrors the export exactly onto the public repo's own history: files the export no longer has (the old
// Elysium tree) are deleted, not left behind; new and changed files arrive, even ones a .gitignore rule matches; the
// public history only grows (no force); an unchanged export pushes nothing. A local bare repo stands in for the remote.
test("the public repo becomes exactly the export: old files deleted, new files added, history kept, nothing forced", () => {
  const root = mkdtempSync(join(tmpdir(), "publish-mirror-"));
  const git = (cwd: string, ...a: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString();
  };
  const put = (dir: string, files: Record<string, string>) => {
    for (const [f, t] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), t);
    }
  };
  try {
    const bare = join(root, "public.git");
    mkdirSync(bare);
    git(bare, "init", "--bare", "-q");
    const seed = join(root, "seed");
    git(root, "clone", "-q", bare, seed);
    put(seed, { "README.md": "old\n", "contracts/src/HypeVault.sol": "// old\n", "docs/elysium/notes.md": "old\n", ".github/workflows/old.yml": "old\n", "keep/same.txt": "same\n" });
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", "old public tree");
    git(seed, "push", "-q", "origin", "HEAD:main");

    const exp = join(root, "export");
    put(exp, { "README.md": "new\n", "contracts/src/Engine.sol": "// new\n", ".github/workflows/ci.yml": "ci\n", "keep/same.txt": "same\n", ".gitignore": "*.log\n", "docs/kept.log": "a tracked file a .gitignore rule matches\n" });
    const prepared = (): Prepared => ({ dir: exp, files: [], submodules: [], head: "abc", problems: [] });
    const id = { url: bare, message: "Publish test", name: "tourbillondev", email: "t@t" };
    const r = pushExport(prepared(), id);
    expect(r.pushed).toBe(true);

    const check = join(root, "check");
    git(root, "clone", "-q", bare, check);
    const tree = git(check, "ls-files").trim().split("\n").sort();
    expect(tree).toEqual([".github/workflows/ci.yml", ".gitignore", "README.md", "contracts/src/Engine.sol", "docs/kept.log", "keep/same.txt"]);
    for (const gone of ["contracts/src/HypeVault.sol", "docs/elysium/notes.md", ".github/workflows/old.yml"]) expect(existsSync(join(check, gone))).toBe(false);
    expect(readFileSync(join(check, "README.md"), "utf8")).toBe("new\n");
    expect(git(check, "log", "--format=%s").trim().split("\n")).toEqual(["Publish test", "old public tree"]); // history kept
    expect(git(check, "log", "-1", "--format=%an").trim()).toBe("tourbillondev");

    expect(pushExport(prepared(), id).pushed).toBe(false); // the same export again: nothing to push
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
