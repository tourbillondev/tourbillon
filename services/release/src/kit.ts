import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pad, TOTAL, type KitUpdate } from "./queue.ts";

/// Builds the kit's updates.json (the texts the gate checks and the team bot posts) from queue-src/NN.json, the private
/// source of each update. The post texts there say {{SETTLEMENT}} where the settlement token's symbol goes; it is filled
/// from the deployment file's settlementSymbol (owner D1: every text reads the symbol from config), and a text with a
/// placeholder left is refused.
///   bun src/kit.ts --src ../../queue-src --kit <kit folder> (--deployment <deployment file> | --symbol USDG)

export type Post = { type: string; title: string; telegram: string; x: string; changelog: string };
export type Source = { group: string; title: string; post: Post };

export const fill = (text: string, symbol: string) => text.replaceAll("{{SETTLEMENT}}", symbol);

/// One kit entry. Throws a plain sentence when a placeholder is left or the source's title and the post's title differ.
export function kitEntry(n: number, s: Source, symbol: string): KitUpdate {
  if (!/^[A-Za-z0-9.]{1,12}$/.test(symbol)) throw new Error(`the settlement symbol "${symbol}" is not a token symbol`);
  const p = s.post;
  const e: KitUpdate = {
    n,
    type: p.type,
    title: fill(p.title, symbol),
    status: "QUEUED",
    changelog: fill(p.changelog, symbol),
    changelog_line: fill(p.changelog, symbol),
    telegram: fill(p.telegram, symbol),
    x: fill(p.x, symbol),
    group: s.group,
  };
  for (const [k, v] of Object.entries(e)) if (typeof v === "string" && /\{\{\w+\}\}/.test(v)) throw new Error(`update ${pad(n)}: ${k} still has a placeholder`);
  if (e.title !== s.title) throw new Error(`update ${pad(n)}: the post title "${e.title}" differs from the source title "${s.title}"`);
  return e;
}

export function buildKit(srcDir: string, symbol: string, total = TOTAL): KitUpdate[] {
  const out: KitUpdate[] = [];
  for (let n = 1; n <= total; n++) {
    const f = join(srcDir, `${pad(n)}.json`);
    if (!existsSync(f)) throw new Error(`queue-src has no ${pad(n)}.json`);
    out.push(kitEntry(n, JSON.parse(readFileSync(f, "utf8")) as Source, symbol));
  }
  return out;
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k: string) => {
    const i = a.indexOf(`--${k}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const src = opt("src") ?? join(import.meta.dir, "../../../queue-src");
  const kit = opt("kit");
  if (!kit) throw new Error("--kit <kit folder> is needed");
  const dep = opt("deployment");
  const symbol = dep ? String((JSON.parse(readFileSync(dep, "utf8")) as { settlementSymbol?: unknown }).settlementSymbol ?? "") : opt("symbol");
  if (!symbol) throw new Error("--deployment <file> (its settlementSymbol) or --symbol is needed");
  const list = buildKit(src, symbol);
  mkdirSync(kit, { recursive: true });
  writeFileSync(join(kit, "updates.json"), `${JSON.stringify(list, null, 1)}\n`);
  console.log(`updates.json: ${list.length} updates, settlement symbol ${symbol}`);
}
