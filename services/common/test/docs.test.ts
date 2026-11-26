import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// The public docs stay current (playbook 03 §1.5): every test docs/invariants.md names exists in contracts/test, and
// every file it links exists.
const ROOT = resolve(import.meta.dir, "../../..");

function solFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? solFiles(p) : p.endsWith(".sol") ? [p] : [];
  });
}

test("docs/invariants.md names only tests that exist, and links only files that exist", () => {
  const doc = readFileSync(join(ROOT, "docs/invariants.md"), "utf8");
  const names = [...new Set([...doc.matchAll(/`((?:test|testFuzz|invariant)_\w+)`/g)].map((m) => m[1]!))];
  expect(names.length).toBeGreaterThan(40);
  const sources = solFiles(join(ROOT, "contracts/test")).map((f) => readFileSync(f, "utf8")).join("\n");
  expect(names.filter((n) => !sources.includes(`function ${n}(`))).toEqual([]);
  const links = [...doc.matchAll(/\]\((\.\.\/[^)]+)\)/g)].map((m) => m[1]!);
  expect(links.filter((l) => !existsSync(resolve(ROOT, "docs", l)))).toEqual([]);
});
