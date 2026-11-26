import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sh } from "./gate.ts";
import { pad, readMeta } from "./queue.ts";

/// Writes queue/NN/patch.diff and queue/NN/meta.json from the private authoring copy, where each update is one commit
/// whose message starts "Update NN:". The hand-written part of meta.json (group, title, what is new, how to verify,
/// deploy type, migration, live checks) comes from queue-src/NN.json; the files touched and the test names are read
/// from the commit itself, so they are always exact.
///   bun src/export.ts <authoring repo> <queue-src dir> <queue dir> NN [NN ...]

/// The test names in a test file, as "<file>: <describe> > <test>": test("…", …) and the conditional form
/// test.skipIf(cond)("…", …) that the anvil and Postgres tests use, with the name on the same line or the next; a
/// template's ${…} reads "<each route>".
export function testNames(source: string, file: string): string[] {
  const out: string[] = [];
  const describes: string[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    // the name on the next line: test.skipIf(!ok)(\n  "…",
    if (/^\s*test(?:\.skipIf\((?:[^()]|\([^()]*\))*\))?\(\s*$/.test(line) && i + 1 < lines.length) line = line.trimEnd() + lines[i + 1]!.trim();
    const d = /^\s*describe\("([^"]+)"/.exec(line);
    if (d) describes[line.search(/\S/)] = d[1]!;
    const t = /^\s*test(?:\.skipIf\((?:[^()]|\([^()]*\))*\))?\(\s*[`"](.+?)[`"]\s*,/.exec(line);
    if (t) {
      const ind = line.search(/\S/);
      const parent = describes.slice(0, ind).filter(Boolean).at(-1);
      out.push(`${file.split("/").pop()}: ${parent ? `${parent} > ` : ""}${t[1]!.replace(/\$\{\w+\}/g, "<each route>")}`);
    }
  }
  return out;
}

if (import.meta.main) {
  const [repo, src, queue, ...ns] = process.argv.slice(2);
  for (const n of ns.map(Number)) {
    const NN = pad(n);
    const commit = sh(["git", "log", "--format=%H", "-1", "--grep", `^Update ${NN}:`, "tech"], repo!).out.trim();
    if (!commit) throw new Error(`no commit "Update ${NN}:" on the tech branch`);
    const patch = sh(["git", "diff", "--binary", `${commit}~1`, commit], repo!).out;
    const files = sh(["git", "diff", "--name-only", `${commit}~1`, commit], repo!).out.trim().split("\n").filter(Boolean);
    const tests: string[] = [];
    for (const f of files.filter((x) => /\.test\.ts$/.test(x))) tests.push(...testNames(sh(["git", "show", `${commit}:${f}`], repo!).out, f));
    const hand = JSON.parse(readFileSync(join(src!, `${NN}.json`), "utf8"));
    const meta = { number: n, group: hand.group, title: hand.title, new: hand.new, verify: hand.verify, files, tests, deploy: hand.deploy, migration: hand.migration ?? false, checks: hand.checks ?? [] };
    const dir = join(queue!, NN);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "patch.diff"), patch);
    writeFileSync(join(dir, "meta.json"), `${JSON.stringify(meta, null, 1)}\n`);
    const { why } = readMeta(dir, n);
    console.log(`${NN}: ${files.length} files, ${tests.length} tests, ${commit.slice(0, 12)}${why.length ? `  PROBLEMS: ${why.join(" ")}` : ""}`);
  }
}
