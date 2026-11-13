import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { lintText, why } from "../src/words.ts";

/// Words lint (launch core): checks published texts against the spec's wording rules (Overview section 9). The release
/// pipeline runs it on every update's texts before release; a finding holds the update.
///   bun common/scripts/words-lint.ts <file or directory> [...]   (exit 1 on any finding)
/// Directories are walked for .md, .txt and .json files. JSON is checked on its keys and string values (API field
/// names included).

const TEXT = new Set([".md", ".txt", ".json"]);

function files(p: string): string[] {
  const st = statSync(p);
  if (st.isFile()) return [p];
  return readdirSync(p).flatMap((f) => (f === "node_modules" || f.startsWith(".") ? [] : files(join(p, f)))).filter((f) => TEXT.has(extname(f)));
}

function jsonText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(jsonText).join("\n");
  if (v && typeof v === "object") return Object.entries(v).map(([k, x]) => `${k}\n${jsonText(x)}`).join("\n");
  return "";
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
  process.stderr.write("usage: words-lint <file or directory> [...]\n");
  process.exit(2);
}
let n = 0;
for (const f of paths.flatMap(files)) {
  const raw = readFileSync(f, "utf8");
  let text = raw;
  if (extname(f) === ".json") {
    try {
      text = jsonText(JSON.parse(raw));
    } catch {
      text = raw;
    }
  }
  for (const x of lintText(text)) {
    n++;
    process.stdout.write(`${f}:${x.line}: "${x.match}": ${why(x.rule)}\n  ${x.text}\n`);
  }
}
process.stdout.write(n === 0 ? "words lint: clean\n" : `words lint: ${n} finding${n === 1 ? "" : "s"}\n`);
process.exit(n === 0 ? 0 : 1);
