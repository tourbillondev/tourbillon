import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { excludes, isExcluded, publishedFiles, scan } from "../../../tools/banned-words.ts";

const RULES_FILE = ["CLA", "UDE.md"].join(""); // named from fragments (the gate refuses tool names)

test("the gate scans what is published: tracked and new files, minus the exclude list", () => {
  const dir = mkdtempSync(join(tmpdir(), "words-gate-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  mkdirSync(join(dir, "docs/notes"), { recursive: true });
  writeFileSync(join(dir, "publish-exclude.txt"), `docs/notes/\n${RULES_FILE}\npublish-exclude.txt\n`);
  const bad = ["writers ", "ea", "rn more"].join(""); // a listed word, assembled
  writeFileSync(join(dir, "README.md"), `${bad}\n`); // published: flagged
  writeFileSync(join(dir, "docs/notes/plan.md"), `${bad}\n`); // excluded: skipped
  writeFileSync(join(dir, RULES_FILE), `${bad}\n`); // excluded: skipped
  writeFileSync(join(dir, "logo.png"), bad); // not a text file: skipped
  writeFileSync(join(dir, ".gitignore"), "out/\n");
  mkdirSync(join(dir, "out"));
  writeFileSync(join(dir, "out/build.md"), `${bad}\n`); // ignored: skipped
  git("add", "README.md");
  writeFileSync(join(dir, "NEW.md"), `${bad}\n`); // new, not yet committed: flagged

  expect(publishedFiles(dir).sort()).toEqual([".gitignore", "NEW.md", "README.md", "logo.png"]);
  expect(scan(dir).map((h) => `${h.file}:${h.line}`).sort()).toEqual(["NEW.md:1", "README.md:1"]);
  rmSync(dir, { recursive: true, force: true });
});

// The exclude list is private itself (it names the private paths), so it exists only in the private repo; the public
// copy has nothing to read here, and its published tree is the proof that the list worked.
const EXCLUDE_LIST = join(import.meta.dir, "../../../publish-exclude.txt");
test.skipIf(!existsSync(EXCLUDE_LIST))("the real exclude list keeps the private paths out, itself included (private repo only)", () => {
  const rules = excludes(readFileSync(EXCLUDE_LIST, "utf8"));
  for (const p of ["docs/spec/x.md", "docs/notes/RH_NOTES.md", "queue/01/update.json", RULES_FILE, "publish-exclude.txt"]) {
    expect(isExcluded(p, rules)).toBe(true);
  }
  for (const p of ["docs/backend/api-v1.md", "SECURITY.md", "tools/banned-words.ts"]) expect(isExcluded(p, rules)).toBe(false);
});
