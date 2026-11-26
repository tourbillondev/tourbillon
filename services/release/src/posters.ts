import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pad, pngSize, posterFile, SQUARE, TOTAL, WIDE, type KitUpdate } from "./queue.ts";

/// The kit renderer (playbook 07 §2, 08 §2) for Tourbillon's approved poster design: option A3 (owner, 2026-11-25),
/// from the website's own theme. A bold top bar (the white mark, "TOURBILLON · TECH UPDATE", the day), the navy
/// field with cobalt / lavender / ice glows, a glass text panel (the update number in Inter Black, the title in Inter
/// ExtraBold, a letter-spaced type label, the command if the update gives one) and the silver ring artwork beside it.
/// Every poster is drawn ahead into the kit (posters/square/update-NN-square.png 1080x1080, posters/wide/
/// update-NN-wide.png 1200x675, posters/board/board-LL.png for LL of TOTAL live), reviewed on the contact sheet, and
/// read from the kit by the gate and the team bot; nothing is drawn at the hour. Before writing anything it checks
/// every poster: no text overflows (a long title steps down to at most 70% of its size, never further), the header
/// is clear of the artwork, every text block sits on one left line, the visible text is the kit's own, and with
/// --proof-repo every command shown exists in that update's commit.
///   bun src/posters.ts --kit <kit folder> [--only 1,2,3] [--proof-repo <authoring copy>] [--chrome <path>]
/// The design assets live in the kit's design/ folder (private, never in the repo): Inter.woff2 (SIL OFL 1.1, its
/// licence beside it), silver-mark.png, white-mark.svg.

export const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const TYPES: Record<string, string> = { NEW: "New", HOW: "How it works", CMD: "Command", BTS: "Behind the scenes" };
type Size = { w: number; h: number };
export type Assets = { font: string; silver: string; white: string }; // data URIs
export const BOARD = { w: 1080, h: 1080 };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/// A title with a line-break point after each slash, so an API path wraps there instead of overflowing.
const breakable = (s: string) => esc(s).replaceAll("/", "/<wbr>");
export const dayOf = (n: number) => `Day ${Math.ceil(n / 24)}`;

/// The command an update's Telegram text gives, if any (a line starting with "cd " or "bun ").
export function commandOf(telegram: string): string | null {
  return telegram.split("\n").map((l) => l.trim()).filter((l) => /^(cd |bun )/.test(l)).at(-1) ?? null;
}

/// The design assets from the kit's design/ folder, as data URIs.
export function loadAssets(kitDir: string): Assets {
  const d = join(kitDir, "design");
  const need = (f: string) => {
    if (!existsSync(join(d, f))) throw new Error(`the kit's design/ folder has no ${f}`);
    return readFileSync(join(d, f)).toString("base64");
  };
  return { font: `data:font/woff2;base64,${need("Inter.woff2")}`, silver: `data:image/png;base64,${need("silver-mark.png")}`, white: `data:image/svg+xml;base64,${need("white-mark.svg")}` };
}

export const FIELD = "radial-gradient(110% 85% at 88% 12%,#2a4fb4 0%,transparent 56%),radial-gradient(85% 65% at 6% 104%,#7d8fe8aa 0%,transparent 52%),linear-gradient(160deg,#0c1b35 0%,#0a1426 58%,#111e31 100%)";
export const GLASS = "background:linear-gradient(150deg,#d3e3ff17,#c0d6ff06);border:1px solid #bedaff33;box-shadow:inset 0 1px 0 #ffffff24,0 18px 50px #050b1873;backdrop-filter:blur(18px)";

function frame(z: Size, a: Assets, right: string, panel: string, extraCss = ""): string {
  const wide = z.w > z.h;
  const v = Math.min(z.w, z.h) / 100;
  const M = v * 7.4; // the margin, all four sides
  const bar = v * 13;
  const art = wide ? z.h * 0.68 : z.h * 0.2;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Inter;src:url(${a.font}) format("woff2");font-weight:100 900}
*{margin:0;padding:0;box-sizing:border-box}html,body{width:${z.w}px;height:${z.h}px;overflow:hidden}
body{font-family:Inter,sans-serif;color:#f2f6ff;background:${FIELD};position:relative;-webkit-font-smoothing:antialiased}
.cap{font-weight:600;font-size:${v * 1.9}px;letter-spacing:${v * 0.42}px;text-transform:uppercase;line-height:1}
.top{position:absolute;left:0;right:0;top:0;height:${bar}px;background:linear-gradient(90deg,#0a1426f5,#0c1b35e6);border-bottom:1px solid #bedaff26;display:flex;align-items:center;justify-content:space-between;padding:0 ${M}px}
.brand{display:flex;width:fit-content;align-items:center;gap:${v * 1.4}px;color:#dce9ff}.brand img{width:${v * 4.6}px;height:${v * 4.6}px}.brand .cap{font-size:${v * 2}px}
.right{color:#ffffff;font-weight:800}
.art{position:absolute;${wide ? `right:${M * 0.8}px;top:${bar + (z.h - bar - art) / 2}px;width:${art}px` : `right:${M}px;top:${bar + v * 2.5}px;width:${art}px`};filter:drop-shadow(0 0 ${v * 4}px #4664f773)}
.panel{position:absolute;left:${M}px;${wide ? `top:${bar + M * 0.8}px;bottom:${M}px;width:${z.w * 0.52}px` : `right:${M}px;bottom:${M}px;top:${bar + v * 5 + art}px`};border-radius:${v * 2.6}px;${GLASS};padding:${v * 4.2}px;display:flex;flex-direction:column;justify-content:center;gap:${v * 3.2}px;overflow:hidden}
.mid{display:flex;flex-direction:column;gap:${v * (wide ? 1.9 : 2.4)}px}
.num{font-weight:900;line-height:.82;letter-spacing:-${v * 0.55}px;background:linear-gradient(180deg,#ffffff 30%,#c8d7ff 100%);-webkit-background-clip:text;color:transparent;font-variant-numeric:tabular-nums;font-size:${v * (wide ? 17 : 14)}px}
.of{font-weight:600;color:#9fb3dd;font-size:${v * 2.2}px;margin-left:${v * 1.1}px}
.title{text-wrap:balance;font-weight:800;line-height:1.06;letter-spacing:-${v * 0.06}px;color:#ffffff;font-size:${v * (wide ? 4.6 : 4.8)}px}
.chips{display:flex;gap:${v * 1.1}px;align-items:center}
.chip{padding:${v * 0.95}px ${v * 1.6}px;border-radius:${v * 4}px;color:#dce9ff;border:1px solid #a3b8ef59;background:#4664f72e}
.cmd{font-weight:500;font-size:${v * 2}px;color:#e3efff;background:#070f1fcc;border:1px solid #bedaff2b;border-radius:${v * 1.2}px;padding:${v * 1.25}px ${v * 1.7}px;white-space:nowrap;overflow:hidden}
.cmd b{color:#92b8ff;font-weight:700;margin-right:${v * 0.9}px}
${extraCss}
</style></head><body><img class="art" src="${a.silver}">
<div class="top"><div class="brand"><img src="${a.white}"><span class="cap">${right.startsWith("BOARD:") ? "Tourbillon launch live" : "Tourbillon · Tech update"}</span></div><span class="cap right" data-proof="right">${esc(right.replace(/^BOARD:/, ""))}</span></div>
<div class="panel" id="panel" data-fit>${panel}</div>
<script>
const P=document.getElementById("panel"),T=document.querySelector(".title");
const over=b=>b.scrollHeight>b.clientHeight+1||b.scrollWidth>b.clientWidth+1;
// the title's own box reports a pixel or two of descender below its line box, so only its width is checked; the
// panel's height covers the rest
const wider=b=>b.scrollWidth>b.clientWidth+1;
let scale=1;if(T){const base=parseFloat(getComputedStyle(T).fontSize);while((over(P)||wider(T))&&scale>0.701){scale-=0.03;T.style.fontSize=(base*scale)+"px"}}
const fit=[...document.querySelectorAll("[data-fit]")].some(over);
const R=q=>document.querySelector(q)?.getBoundingClientRect();const h=R(".brand"),g=R(".art");
const clash=!!(h&&g&&h.left<g.right&&h.right>g.left&&h.top<g.bottom&&h.bottom>g.top);
const cols=[...document.querySelectorAll("[data-col]")].map(e=>e.getBoundingClientRect().left);
document.body.dataset.overflow=String(fit);document.body.dataset.clash=String(clash);
document.body.dataset.aligned=String(cols.length>0&&Math.max(...cols)-Math.min(...cols)<=1.5);document.body.dataset.scale=scale.toFixed(2);
document.body.dataset.text=[...document.querySelectorAll("[data-proof]")].map(e=>e.dataset.proof+"="+e.textContent.trim()).join("|");
</script></body></html>`;
}

/// An update poster (option A3).
export function posterHtml(u: Pick<KitUpdate, "n" | "title" | "type" | "telegram">, size: Size, a: Assets, total = TOTAL): string {
  const cmd = commandOf(u.telegram ?? "");
  const panel = `<div class="mid">
    <div data-col><span class="num" data-proof="num">${pad(u.n)}</span><span class="of">of ${total}</span></div>
    <div class="title" data-col data-proof="title">${breakable(u.title)}</div>
    <div class="chips" data-col><span class="chip cap" data-proof="type">${esc(TYPES[u.type] ?? u.type)}</span></div>
  </div>${cmd ? `<div class="cmd" data-fit data-col><b>&rsaquo;</b><span data-proof="cmd">${esc(cmd)}</span></div>` : ""}`;
  return frame(size, a, dayOf(u.n), panel);
}

/// A board poster, drawn ahead for `live` of `total` live (option A3): the live count, the 12-cell bar, and the next
/// update with its title (none once all are live). The team bot sends it 30 minutes after a release with the board's
/// text (and its times) as the caption, or the board as text whenever an update is held.
export function boardHtml(live: number, next: Pick<KitUpdate, "n" | "title"> | null, a: Assets, total = TOTAL): string {
  const v = BOARD.w / 100;
  const filled = Math.max(0, Math.min(12, Math.round((live / total) * 12)));
  const cells = Array.from({ length: 12 }, (_, i) => `<i class="${i < filled ? "on" : ""}"></i>`).join("");
  const panel = `<div class="mid">
    <div data-col><span class="num" data-proof="num">${live}</span><span class="of">of ${total} live</span></div>
    <div class="bar" data-col>${cells}</div>
    ${next ? `<div class="chips" data-col><span class="chip cap">Next · Update ${pad(next.n)}</span></div><div class="title" data-col data-proof="title">${breakable(next.title)}</div>` : `<div class="title" data-col data-proof="title">All ${total} updates are live</div>`}
  </div>`;
  const css = `.bar{display:flex;gap:${v * 0.9}px;width:100%}.bar i{display:block;flex:1;height:${v * 2.4}px;border-radius:${v * 0.5}px;background:#ffffff14;border:1px solid #bedaff33}.bar i.on{background:linear-gradient(90deg,#4664f7,#afbbfc);border-color:#afbbfc}`;
  return frame(BOARD, a, `BOARD:${live === total ? "All live" : `${live} / ${total}`}`, panel, css);
}

function chromeRun(chrome: string, args: string[]): { out: string; ok: boolean } {
  const dir = mkdtempSync(join(tmpdir(), "tourbillon-poster-"));
  try {
    const r = Bun.spawnSync([chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--virtual-time-budget=3000", `--user-data-dir=${join(dir, "profile")}`, ...args], { stdout: "pipe", stderr: "pipe" });
    return { out: r.stdout.toString(), ok: r.exitCode === 0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export type Layout = { overflow: boolean; clash: boolean; aligned: boolean; scale: number; text: Record<string, string> };

/// How Chrome lays the poster out: overflow, the header against the artwork, the text blocks' left line, the title's
/// scale, and the visible text by field.
export function layout(html: string, size: Size, chrome = DEFAULT_CHROME): Layout {
  const dir = mkdtempSync(join(tmpdir(), "tourbillon-poster-"));
  try {
    writeFileSync(join(dir, "p.html"), html);
    const dom = chromeRun(chrome, [`--window-size=${size.w},${size.h}`, "--dump-dom", `file://${join(dir, "p.html")}`]).out;
    if (!/data-overflow="(true|false)"/.test(dom)) throw new Error("Chrome did not lay out the poster");
    const flag = (k: string) => new RegExp(`data-${k}="true"`).test(dom);
    const text = Object.fromEntries(
      (/data-text="([^"]*)"/.exec(dom)?.[1] ?? "")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
        .split("|").filter(Boolean)
        .map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1).replace(/​/g, "")]),
    );
    return { overflow: flag("overflow"), clash: flag("clash"), aligned: flag("aligned"), scale: Number(/data-scale="([\d.]+)"/.exec(dom)?.[1] ?? "1"), text };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/// The problems with an update poster's layout, as plain sentences (empty when it is fine).
export function posterCheck(u: Pick<KitUpdate, "n" | "title" | "type" | "telegram">, l: Layout, total = TOTAL): string[] {
  const why: string[] = [];
  if (l.overflow) why.push("text overflows its box even at 70% of the title size");
  if (l.clash) why.push("the header overlaps the artwork");
  if (!l.aligned) why.push("the text blocks are not on one left line");
  if (l.text.num !== pad(u.n)) why.push(`the number shows ${l.text.num}`);
  if (l.text.title !== u.title) why.push("the title is not the kit's");
  if (l.text.type !== (TYPES[u.type] ?? u.type)) why.push("the type is not the kit's");
  if ((l.text.cmd ?? null) !== commandOf(u.telegram ?? "")) why.push("the command is not the update's own");
  if (l.text.right !== dayOf(u.n)) why.push("the day is wrong");
  void total;
  return why;
}

/// Draws one poster to `out` at its exact size. Throws a plain sentence when Chrome is missing or the size is off.
export function render(html: string, size: Size, out: string, chrome = DEFAULT_CHROME): void {
  if (!existsSync(chrome)) throw new Error(`Chrome was not found at ${chrome} (pass --chrome)`);
  const dir = mkdtempSync(join(tmpdir(), "tourbillon-poster-"));
  try {
    writeFileSync(join(dir, "p.html"), html);
    const r = chromeRun(chrome, [`--window-size=${size.w},${size.h}`, `--screenshot=${out}`, `file://${join(dir, "p.html")}`]);
    if (!r.ok || !existsSync(out)) throw new Error("Chrome could not draw the poster");
    const s = pngSize(readFileSync(out));
    if (!s || s.w !== size.w || s.h !== size.h) throw new Error(`the poster came out ${s?.w}x${s?.h}, not ${size.w}x${size.h}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/// Every command a poster shows names a script that exists in its own update's commit (`proofRepo`: the authoring
/// copy, branch tech, one commit per update).
export function commandProof(u: Pick<KitUpdate, "n" | "telegram">, proofRepo: string): string[] {
  const cmd = commandOf(u.telegram ?? "");
  if (!cmd) return [];
  const commit = Bun.spawnSync(["git", "log", "--format=%H", "-1", "--grep", `^Update ${pad(u.n)}:`, "tech"], { cwd: proofRepo }).stdout.toString().trim();
  if (!commit) return [`no commit for update ${pad(u.n)} to check its command against`];
  const dirPart = /^cd (\S+) &&/.exec(cmd)?.[1] ?? "";
  return [...cmd.matchAll(/\bbun ([\w./-]+\.ts)\b/g)].map((m) => join(dirPart, m[1]!)).filter((p) => Bun.spawnSync(["git", "cat-file", "-e", `${commit}:${p}`], { cwd: proofRepo }).exitCode !== 0).map((p) => `the command's script ${p} is not in update ${pad(u.n)}'s commit`);
}

/// Checks every poster first (layout, kit text, and with `proofRepo` the commands), then draws them all: the update
/// posters, and the board posters for 0 to `total` live. Nothing is written when any check fails.
export function renderKit(kitDir: string, list: KitUpdate[], o: { chrome?: string; proofRepo?: string; board?: boolean; total?: number } = {}): { scaled: number[] } {
  const chrome = o.chrome ?? DEFAULT_CHROME;
  const total = o.total ?? TOTAL;
  const a = loadAssets(kitDir);
  const bad: string[] = [];
  const scaled = new Set<number>();
  for (const u of list) {
    for (const [shape, size] of [["square", SQUARE], ["wide", WIDE]] as const) {
      const l = layout(posterHtml(u, size, a, total), size, chrome);
      if (l.scale < 1) scaled.add(u.n);
      for (const w of posterCheck(u, l, total)) bad.push(`${pad(u.n)} ${shape}: ${w}`);
    }
    if (o.proofRepo) for (const w of commandProof(u, o.proofRepo)) bad.push(`${pad(u.n)}: ${w}`);
  }
  if (bad.length) throw new Error(`posters refused:\n${bad.join("\n")}`);
  for (const u of list)
    for (const [shape, size] of [["square", SQUARE], ["wide", WIDE]] as const) {
      mkdirSync(join(kitDir, "posters", shape), { recursive: true });
      render(posterHtml(u, size, a, total), size, posterFile(kitDir, u.n, shape), chrome);
    }
  if (o.board) {
    mkdirSync(join(kitDir, "posters", "board"), { recursive: true });
    const byN = new Map(list.map((u) => [u.n, u]));
    for (let live = 0; live <= total; live++) {
      const next = live < total ? (byN.get(live + 1) ?? null) : null;
      const html = boardHtml(live, next, a, total);
      const l = layout(html, BOARD, chrome);
      if (l.overflow || l.clash || !l.aligned) throw new Error(`board poster ${pad(live)}: ${l.overflow ? "overflow " : ""}${l.clash ? "header over the artwork " : ""}${l.aligned ? "" : "not on one line"}`);
      render(html, BOARD, join(kitDir, "posters", "board", `board-${pad(live)}.png`), chrome);
    }
  }
  return { scaled: [...scaled].sort((x, y) => x - y) };
}

/// The owner's review page: every square poster, eight to a row, with its number and title.
export function contactSheet(list: KitUpdate[]): string {
  const cell = (u: KitUpdate) => `<figure><img src="posters/square/update-${pad(u.n)}-square.png"><figcaption>${pad(u.n)} · ${esc(u.title)}</figcaption></figure>`;
  return `<!doctype html><meta charset="utf-8"><title>Tourbillon posters</title><style>body{background:#0a1426;color:#dce9ff;font:13px Inter,-apple-system,sans-serif;margin:24px}div{display:grid;grid-template-columns:repeat(8,1fr);gap:12px}img{width:100%;display:block;border-radius:6px}figure{margin:0}figcaption{margin-top:4px}</style><h1>The ${list.length} update posters</h1><div>${list.map(cell).join("")}</div>`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const kit = opt("kit");
  if (!kit) throw new Error("--kit <kit folder> is needed (it holds updates.json and design/)");
  const all = JSON.parse(readFileSync(join(kit, "updates.json"), "utf8")) as KitUpdate[];
  const only = opt("only")?.split(",").map(Number);
  const list = only ? all.filter((u) => only.includes(u.n)) : all;
  const { scaled } = renderKit(kit, list, { chrome: opt("chrome"), proofRepo: opt("proof-repo"), board: !only, total: all.length });
  writeFileSync(join(kit, "contact-sheet.html"), contactSheet(all));
  console.log(`${list.length * 2} update posters${only ? "" : ` and ${all.length + 1} board posters`} drawn into ${kit}/posters; titles stepped down to fit: ${scaled.length ? scaled.map(pad).join(", ") : "none"}; review ${kit}/contact-sheet.html`);
}
