import { lintText } from "@tourbillon/common/words.ts";

/// The words check for every update: the one full list the whole repo uses (playbook chapter 11:
/// services/common/src/words.ts, with its named allow entries, some limited to one file), on the kit texts and on
/// every line a patch adds. It includes the refusal of writing-tool names and of attribution lines.

/// The refused words in `text` (each by its rule name); `file` is the repo path for a patch line, so a file-scoped
/// allow entry applies only there.
export function wordHits(text: string, file?: string): string[] {
  return [...new Set(lintText(text.replaceAll("words-lint: allow", ""), file).map((f) => f.rule))];
}

export function addedLines(patch: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  let file = "";
  for (const line of patch.split("\n")) {
    const m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m) {
      file = m[1]!;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) out.push({ file, text: line.slice(1) });
  }
  return out;
}
