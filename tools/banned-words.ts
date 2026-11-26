#!/usr/bin/env bun
/// The words gate (CI and after every change): the one words list (services/common/src/words.ts) on every tracked
/// text file that is published, i.e. the repo minus publish-exclude.txt, the same tree the publish script exports.
/// Private files (the specs, the notes, the queue, the session rules file) quote the rules and are never published.
///
///   bun tools/banned-words.ts [root]        exit 1 and one line per finding, or "banned-words: clean"

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { lintText, why } from "../services/common/src/words.ts";

const TEXT = /\.(ts|tsx|js|mjs|sol|md|json|toml|ya?ml|sql|html|txt|sh)$|\.env\.example$/;
const SKIP = new Set(["bun.lock", "package-lock.json"]);

export type Hit = { file: string; line: number; rule: string; match: string; text: string };

export function excludes(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

export const isExcluded = (path: string, rules: string[]) =>
  rules.some((r) => (r.endsWith("/") ? path.startsWith(r) : path === r));

/// The files the publish script would export: tracked files, plus new files not yet committed (and not ignored), so a
/// check before a commit sees what the commit will publish.
export function publishedFiles(root: string): string[] {
  const list = join(root, "publish-exclude.txt");
  const rules = existsSync(list) ? excludes(readFileSync(list, "utf8")) : [];
  const tracked = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  return tracked.filter((p) => !isExcluded(p, rules));
}

export function scan(root: string): Hit[] {
  const hits: Hit[] = [];
  for (const file of publishedFiles(root)) {
    const name = file.split("/").pop()!;
    if (!TEXT.test(name) || SKIP.has(name)) continue;
    const p = join(root, file);
    if (!existsSync(p) || !statSync(p).isFile()) continue; // submodules are tracked as folders
    for (const x of lintText(readFileSync(p, "utf8"), file)) hits.push({ file, line: x.line, rule: x.rule, match: x.match, text: x.text.slice(0, 140) });
  }
  return hits;
}

if (import.meta.main) {
  const root = process.argv[2] ?? join(import.meta.dir, "..");
  const hits = scan(root);
  for (const h of hits) console.error(`${h.file}:${h.line}  "${h.match}"  ${why(h.rule)}\n    ${h.text}`);
  if (hits.length) {
    console.error(`banned-words: ${hits.length} finding(s)`);
    process.exit(1);
  }
  console.log("banned-words: clean");
}
