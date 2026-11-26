import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintText } from "@tourbillon/common/words.ts";
import { DEFAULT_CHROME, FIELD, GLASS, loadAssets, TYPES, type Assets } from "./posters.ts";
import { pad, pngSize, posterFile, type KitUpdate } from "./queue.ts";
import { storedZipMany } from "./zip.ts";

/// The launch kit (playbook 08 §1: the 17-file structure), in the owner's approved design (option A3, from the
/// website's theme) and with the spec's own wording (Overview §2–§6). Videos are not part of it until RH14 (D8).
///   launch-announcement-square.png 1080x1080 · launch-announcement-wide-for-X.png 1200x675
///   how-it-works-1..4.png 1080x1080 · fact-sheet.jpg 1240x1754 · fact-sheet.pdf A4
///   whats-next.png 1080x1460 · whats-next-day-1.png, -day-2.png 1080x2186 · whats-next-day-3.png 1080x(rows)
///   whats-next-x.png 1200x675 · posters-square-at-a-glance.png · posters-wide-at-a-glance.png
///   tourbillon-posters-square-62.zip · tourbillon-posters-wide-62.zip · MANIFEST.sha256
/// Before anything is written: every text passes the words list, every page lays out without overflow, and with
/// --proof-repo every claim is found in the code it names (a kit never states what is not true). The team bot's
/// launch poster (posters/launch.png) is the square launch announcement.
///   bun src/launchkit.ts --kit <kit folder> --symbol USDG [--proof-repo <authoring copy>] [--chrome <path>]

export const SLUG = "tourbillon";
export type Page = { file: string; size: { w: number; h: number }; html: string };

/// Each claim the kit states, with where the code says so (checked with --proof-repo against the last update's tree).
export const CLAIMS: { claim: string; file: string; has: string }[] = [
  { claim: "Decay runs at any pace from 1 hour to 30 days", file: "contracts/src/TempoMath.sol", has: "MAX_TEMPO = 30 days" },
  { claim: "Decay runs at any pace from 1 hour to 30 days", file: "contracts/src/TempoMath.sol", has: "MIN_TEMPO = 1 hours" },
  { claim: "A Movement mixes up to four tempos", file: "contracts/src/TempoBlend.sol", has: "MAX_PARTS = 4" },
  { claim: "Shapes of up to four legs, held as one position", file: "contracts/src/StrategyMath.sol", has: "MAX_LEGS = 4" },
  { claim: "Each mark is sampled every 5 minutes", file: "contracts/src/PathFunding.sol", has: "P0 = 5 minutes" },
  { claim: "Anyone can take the sample; the contract reads the price itself", file: "contracts/src/PathFundingBook.sol", has: "Permissionless sampling" },
  { claim: "A buyer never loses more than they paid; no margin, no liquidation", file: "docs/invariants.md", has: "A buyer never loses more than they paid" },
  { claim: "Sells always work; pauses stop new opens only", file: "docs/invariants.md", has: "Sells always work" },
  { claim: "Writers lock the exact worst case of what they sell", file: "docs/invariants.md", has: "exact worst case" },
  { claim: "An hourly receipts root on Robinhood Chain", file: "contracts/src/ReceiptRoots.sol", has: "contract ReceiptRoots" },
  { claim: "Vol published on chain for any contract to read", file: "contracts/src/VolFeed.sol", has: "contract VolFeed" },
  { claim: "Admin through a Safe and a timelock", file: "contracts/script/DeployM7.s.sol", has: "Timelock" },
];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/// The page frame: the A3 top bar and field, a glass panel area, the silver ring where there is room.
function page(z: { w: number; h: number }, a: Assets, label: string, right: string, body: string, css: string, art: string | null): string {
  const v = Math.min(z.w, z.h) / 100;
  const M = v * 7.4;
  const bar = Math.min(v * 13, 140);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Inter;src:url(${a.font}) format("woff2");font-weight:100 900}
*{margin:0;padding:0;box-sizing:border-box}html,body{width:${z.w}px;height:${z.h}px;overflow:hidden}
body{font-family:Inter,sans-serif;color:#f2f6ff;background:${FIELD};position:relative;-webkit-font-smoothing:antialiased}
.cap{font-weight:600;font-size:${v * 1.9}px;letter-spacing:${v * 0.42}px;text-transform:uppercase;line-height:1}
.top{position:absolute;left:0;right:0;top:0;height:${bar}px;background:linear-gradient(90deg,#0a1426f5,#0c1b35e6);border-bottom:1px solid #bedaff26;display:flex;align-items:center;justify-content:space-between;padding:0 ${M}px}
.brand{display:flex;width:fit-content;align-items:center;gap:${v * 1.4}px;color:#dce9ff}.brand img{width:${v * 4.6}px;height:${v * 4.6}px}.brand .cap{font-size:${v * 2}px}
.right{color:#ffffff;font-weight:800}
.glass{border-radius:${v * 2.6}px;${GLASS}}
.chip{display:inline-block;padding:${v * 0.95}px ${v * 1.6}px;border-radius:${v * 4}px;color:#dce9ff;border:1px solid #a3b8ef59;background:#4664f72e}
.h{font-weight:900;line-height:.95;letter-spacing:-${v * 0.2}px;color:#fff;text-wrap:balance}
.t{font-weight:800;line-height:1.08;color:#fff;text-wrap:balance}
.p{font-weight:500;color:#cfdcff;line-height:1.4}
${art ? `.art{position:absolute;${art};filter:drop-shadow(0 0 ${v * 4}px #4664f773)}` : ""}
${css}
</style></head><body>${art ? `<img class="art" src="${a.silver}">` : ""}
<div class="top"><div class="brand"><img src="${a.white}"><span class="cap">${esc(label)}</span></div><span class="cap right">${esc(right)}</span></div>
${body}
<script>const o=[...document.querySelectorAll("[data-fit]")].some(b=>b.scrollHeight>b.clientHeight+2||b.scrollWidth>b.clientWidth+1)||[...document.querySelectorAll("[data-whole]")].some(b=>b.scrollHeight>b.clientHeight+1||b.scrollWidth>b.clientWidth+1);document.body.dataset.overflow=String(o);</script>
</body></html>`;
}

// ---------------- the texts (Overview §2–§6, with the settlement symbol from the deployment) ----------------
export function texts(symbol: string, total: number) {
  return {
    launch: {
      headline: "Options that never expire.",
      sub: `On tokenized stocks and crypto, on Robinhood Chain. Settled in ${symbol}.`,
      points: ["Any tempo, 1 hour to 30 days", "Never lose more than you paid", "Sell any time"],
    },
    how: [
      { title: "Pick a tempo, not an expiry", body: ["Your option never expires. Its units shrink a little each day: the daily cost, paid in kind.", "Choose the pace from 1 hour to 30 days, or a Movement that mixes up to four tempos."] },
      { title: "Funding follows the price path", body: ["Each market's mark is sampled every 5 minutes, by anyone. The contract reads the price itself.", "Every position is charged along that same recorded path, whoever touches it and whenever."] },
      { title: "Never lose more than you paid", body: ["You pay up front. There is no margin and no liquidation.", "Selling always works: a pause stops new opens only."] },
      { title: "Write against exact collateral", body: ["Sell any shape and lock the exact worst case, computed on chain. A spread locks its width.", "A covered Rise locks the tokenized stock itself. You receive the funding your buyer pays."] },
    ],
    products: [
      ["Rise / Fall", "Calls and puts that never expire. Sell any time."],
      ["Tempo", "The decay pace, from 1 hour to 30 days."],
      ["Movement", "Up to four tempos in one option, like a ladder that never needs rolling."],
      ["Spread", "Buy one strike, sell a farther one. The most it pays is the gap."],
      ["Swing", "A Rise and a Fall at the same strike: a big move either way pays."],
      ["Guard", "For stock-token holders: lock the stock, buy a Fall, write a Rise above it."],
      ["Band", "A condor: the writer receives funding while the price stays in a range."],
      ["Write", `Sell any shape against exact collateral: ${symbol}, or the tokenized stock for a covered Rise.`],
      ["Vol quotes", "Makers quote a volatility for a band of strikes and tempos; trades fill at the best price."],
    ] as [string, string][],
    mechanics: [
      ["Price", "A signer quorum relays each asset's mark on Robinhood Chain, with a reference check."],
      ["Vol", "The same quorum posts a vol per market; maker quotes and fills tighten it."],
      ["Fill", "Every buy fills at the cheapest of maker quotes, written offers and the Mainspring pool."],
      ["Funding", "Marks sampled every 5 minutes by anyone; every position charged along that path."],
      ["Collateral", "Writers lock the exact worst case of what they sell, computed on chain."],
      ["Hedging", "The pool hedges stock delta on Robinhood Chain itself, and crypto at an exchange."],
      ["Receipts", "Trades, vol finals and NAV snapshots roll into an hourly root on Robinhood Chain."],
    ] as [string, string][],
    laws: [
      "A buyer never loses more than they paid. No margin, no liquidation.",
      "No price without a fresh, cross-checked mark. If none, opens on that market close.",
      "Sells always work. Pauses stop new opens only.",
      "Every writer's collateral covers the exact worst case of what they sold.",
      "Funding follows the recorded price path. No caller supplies a price.",
      "No single key can set a price, a vol or an admin action.",
    ],
    chain: [`Robinhood Chain (Arbitrum Orbit, settling to Ethereum)`, `Settlement in ${symbol}`, "Admin through a Safe and a timelock; the guardian can only pause opens", "Vol published on chain for any contract to read"],
    rollout: [
      ["T0 Core", "Rise and Fall on top tokenized stocks and BTC/ETH, path funding, the Mainspring pool"],
      ["T1 Shapes", "Spreads, Swing, Guard, Band, and writing"],
      ["T2 First-party mark", "Robinhood Chain's own mark as the primary source, the quorum as a cross-check"],
      ["T3 Open book", "Maker quotes, best-of-three fills, a weekly risk auction, the public vol feed"],
      ["T4 Full shelf", "The rest of the tokenized-stock shelf, agent mandates, MCP"],
    ] as [string, string][],
    footer: `Independent project. Robinhood Chain is used as a network only. ${total} tech updates, one every hour.`,
  };
}

// ---------------- the pages ----------------
export function launchPage(z: { w: number; h: number }, a: Assets, symbol: string, total: number): Page {
  const wide = z.w > z.h;
  const v = Math.min(z.w, z.h) / 100;
  const M = v * 7.4;
  const T = texts(symbol, total).launch;
  const art = wide ? `right:${M * 0.8}px;top:${v * 13 + (z.h - v * 13 - z.h * 0.68) / 2}px;width:${z.h * 0.68}px` : `right:${M}px;top:${v * 15.5}px;width:${z.h * 0.24}px`;
  const panel = wide ? `left:${M}px;top:${v * 13 + M * 0.8}px;bottom:${M}px;width:${z.w * 0.52}px` : `left:${M}px;right:${M}px;bottom:${M}px;top:${v * 18 + z.h * 0.24}px`;
  const body = `<div class="glass panel" data-fit><div class="h" data-txt>${esc(T.headline)}</div><div class="p sub" data-txt>${esc(T.sub)}</div><div class="pts">${T.points.map((p) => `<span class="chip cap" data-txt>${esc(p)}</span>`).join("")}</div></div>`;
  const css = `.panel{position:absolute;${panel};padding:${v * 4.2}px;display:flex;flex-direction:column;justify-content:center;gap:${v * 2.6}px;overflow:hidden}.h{font-size:${v * (wide ? 7.4 : 8.6)}px}.sub{font-size:${v * (wide ? 2.7 : 3)}px;max-width:95%}.pts{display:flex;flex-wrap:wrap;gap:${v * 1.1}px}`;
  return { file: wide ? "launch-announcement-wide-for-X.png" : "launch-announcement-square.png", size: z, html: page(z, a, "Tourbillon · Launch", "Robinhood Chain", body, css, art) };
}

export function howPage(i: number, a: Assets, symbol: string, total: number): Page {
  const z = { w: 1080, h: 1080 };
  const v = 10.8;
  const M = v * 7.4;
  const s = texts(symbol, total).how[i - 1]!;
  const body = `<div class="glass panel" data-fit><div class="n">${i}</div><div class="t" data-txt>${esc(s.title)}</div>${s.body.map((b) => `<p class="p" data-txt>${esc(b)}</p>`).join("")}</div>`;
  const css = `.panel{position:absolute;left:${M}px;right:${M}px;bottom:${M}px;top:${v * 18 + z.h * 0.24}px;padding:${v * 3.8}px ${v * 4.2}px;display:flex;flex-direction:column;justify-content:center;gap:${v * 1.9}px;overflow:hidden}
.n{font-weight:900;font-size:${v * 11}px;line-height:.82;background:linear-gradient(180deg,#ffffff 30%,#c8d7ff 100%);-webkit-background-clip:text;color:transparent}.t{font-size:${v * 5.2}px}.p{font-size:${v * 2.6}px}`;
  return { file: `how-it-works-${i}.png`, size: z, html: page(z, a, "Tourbillon · How it works", `${i} / 4`, body, css, `right:${M}px;top:${v * 15.5}px;width:${z.h * 0.24}px`) };
}

export function factSheet(a: Assets, symbol: string, total: number): Page {
  const z = { w: 1240, h: 1754 };
  const v = 12.4;
  const M = v * 6;
  const T = texts(symbol, total);
  const card = (title: string, inner: string, cls = "") => `<section class="glass card ${cls}"><div class="cap ct">${esc(title)}</div>${inner}</section>`;
  const rows = (r: [string, string][]) => `<dl>${r.map(([k, d]) => `<dt data-txt>${esc(k)}</dt><dd class="p" data-txt>${esc(d)}</dd>`).join("")}</dl>`;
  const body = `<div class="sheet" data-fit>
  <header><div class="h" data-txt>${esc(T.launch.headline)}</div><div class="p lead" data-txt>${esc(T.launch.sub)} A buyer can never lose more than they paid, and selling is never paused.</div></header>
  <div class="grid">
    ${card("What you can trade", rows(T.products))}
    ${card("How it works", rows(T.mechanics))}
    ${card("The six laws", `<ol>${T.laws.map((l) => `<li class="p" data-txt>${esc(l)}</li>`).join("")}</ol>`)}
    ${card("Chain and settlement", `<ul>${T.chain.map((l) => `<li class="p" data-txt>${esc(l)}</li>`).join("")}</ul>`)}
    ${card("Rollout (no dates; each wave ships when its gate is met)", rows(T.rollout), "wide")}
  </div>
  <footer class="p" data-txt>${esc(T.footer)}</footer>
</div>`;
  const css = `.sheet{position:absolute;left:${M}px;right:${M}px;top:${v * 11 + M * 0.6}px;bottom:${M * 0.8}px;display:flex;flex-direction:column;gap:${v * 2}px;overflow:hidden}
.h{font-size:${v * 5.8}px}.lead{font-size:${v * 1.7}px;margin-top:${v * 1.1}px;max-width:88%}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:${v * 1.6}px;align-content:stretch;flex:1}
.card{padding:${v * 2.1}px ${v * 2.3}px}.card.wide{grid-column:1/3}
.ct{color:#92b8ff;margin-bottom:${v * 1.4}px;font-size:${v * 1.25}px}
dl{display:grid;grid-template-columns:auto 1fr;column-gap:${v * 1.4}px;row-gap:${v * 0.95}px}dt{font-weight:800;font-size:${v * 1.36}px;color:#fff;white-space:nowrap}dd{font-size:${v * 1.3}px}
ol,ul{padding-left:${v * 1.6}px;display:flex;flex-direction:column;gap:${v * 0.85}px}li{font-size:${v * 1.36}px}
footer{font-size:${v * 1.1}px;color:#9fb3dd;margin-top:auto}`;
  return { file: "fact-sheet.jpg", size: z, html: page(z, a, "Tourbillon · Fact sheet", "Robinhood Chain", body, css, null) };
}

const dayList = (list: KitUpdate[], d: number) => list.filter((u) => Math.ceil(u.n / 24) === d);
const groupCount = (list: KitUpdate[]) => {
  const c = new Map<string, number>();
  for (const u of list) c.set(TYPES[u.type] ?? u.type, (c.get(TYPES[u.type] ?? u.type) ?? 0) + 1);
  return [...c].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([k, n]) => `${n} ${k.toLowerCase()}`);
};
export const days = (list: KitUpdate[]) => Math.ceil(list.length / 24);

export function whatsNext(list: KitUpdate[], a: Assets, symbol: string): Page {
  const z = { w: 1080, h: 1460 };
  const v = 10.8;
  const M = v * 7.4;
  const T = texts(symbol, list.length);
  const dayCards = Array.from({ length: days(list) }, (_, i) => {
    const l = dayList(list, i + 1);
    return `<div class="glass day"><div class="cap dl">Day ${i + 1}</div><div class="t dt" data-txt>Updates ${pad(l[0]!.n)} to ${pad(l.at(-1)!.n)}</div><div class="counts">${groupCount(l).map((g) => `<div class="p" data-txt>${esc(g)}</div>`).join("")}</div></div>`;
  }).join("");
  const body = `<div class="col" data-fit>
  <div><div class="h" data-txt>${list.length} tech updates, one every hour.</div><div class="p lead" data-txt>Each one goes out only after it is live and checked.</div></div>
  <div class="days">${dayCards}</div>
  <div class="glass roll"><div class="cap dl">Then the rollout</div>${T.rollout.map(([k, d]) => `<div class="rr"><b data-txt>${esc(k)}</b><span class="p" data-txt>${esc(d)}</span></div>`).join("")}</div>
</div>`;
  const css = `.col{position:absolute;left:${M}px;right:${M}px;top:${v * 13 + M * 0.8}px;bottom:${M}px;display:flex;flex-direction:column;justify-content:space-between;gap:${v * 3}px;overflow:hidden}.counts{display:flex;flex-direction:column;gap:${v * 0.6}px}
.h{font-size:${v * 6.4}px}.lead{font-size:${v * 2.5}px;margin-top:${v * 1.4}px}
.days{display:grid;grid-template-columns:repeat(${days(list)},1fr);gap:${v * 1.6}px}.day{padding:${v * 2.6}px;display:flex;flex-direction:column;gap:${v * 1.2}px}
.dl{color:#92b8ff}.dt{font-size:${v * 3.2}px}.day .p{font-size:${v * 2.1}px}
.roll{padding:${v * 3.4}px;display:flex;flex-direction:column;gap:${v * 2}px}.rr{display:grid;grid-template-columns:${v * 22}px 1fr;gap:${v * 1.6}px;align-items:baseline}.rr b{font-weight:800;font-size:${v * 2.2}px}.rr .p{font-size:${v * 2}px}`;
  return { file: "whats-next.png", size: z, html: page(z, a, "Tourbillon · What's next", `${list.length} updates`, body, css, null) };
}

export const DAY_HEAD = 266;
export const DAY_ROW = 80;
export function dayPage(list: KitUpdate[], d: number, a: Assets): Page {
  const l = dayList(list, d);
  const z = { w: 1080, h: DAY_HEAD + DAY_ROW * l.length };
  const v = 10.8;
  const M = v * 7.4;
  const rows = l.map((u, i) => `<div class="row ${i % 2 ? "" : "alt"}"><span class="nn">${pad(u.n)}</span><span class="tt" data-txt data-whole>${esc(u.title)}</span><span class="hr cap">Hour ${u.n}</span></div>`).join("");
  const body = `<div class="hd"><div class="t" data-txt>Day ${d} · updates ${pad(l[0]!.n)} to ${pad(l.at(-1)!.n)}</div><div class="cap sub">Each at its hour, counted from the launch</div></div><div class="list" data-fit>${rows}</div>`;
  const css = `.hd{position:absolute;left:${M}px;right:${M}px;top:${v * 13 + v * 2.4}px;height:${DAY_HEAD - v * 13 - v * 2.4}px}.hd .t{font-size:${v * 4.2}px}.sub{color:#92b8ff;margin-top:${v * 1.2}px}
.list{position:absolute;left:${M}px;right:${M}px;top:${DAY_HEAD}px;height:${DAY_ROW * l.length}px;overflow:hidden}
.row{height:${DAY_ROW - 8}px;margin-bottom:8px;border-radius:${v * 1.4}px;display:grid;grid-template-columns:${v * 8}px 1fr auto;align-items:center;gap:${v * 1.6}px;padding:0 ${v * 2}px;border:1px solid #bedaff1f;background:#0a142699}
.row.alt{background:linear-gradient(150deg,#d3e3ff12,#c0d6ff05)}
.nn{font-weight:900;font-size:${v * 3.2}px;color:#fff}.tt{font-weight:700;font-size:${v * 1.95}px;line-height:1.16;color:#f2f6ff;max-height:${DAY_ROW - 16}px;overflow:hidden;text-wrap:balance}.hr{color:#9fb3dd;white-space:nowrap}`;
  return { file: `whats-next-day-${d}.png`, size: z, html: page(z, a, "Tourbillon · What's next", `Day ${d}`, body, css, null) };
}

export function whatsNextX(list: KitUpdate[], a: Assets): Page {
  const z = { w: 1200, h: 675 };
  const v = 6.75;
  const M = v * 7.4;
  const cards = Array.from({ length: days(list) }, (_, i) => {
    const l = dayList(list, i + 1);
    return `<div class="glass day"><div class="cap dl">Day ${i + 1}</div><div class="t dt" data-txt>Updates ${pad(l[0]!.n)} to ${pad(l.at(-1)!.n)}</div><div class="p" data-txt>${esc(groupCount(l).join(" · "))}</div></div>`;
  }).join("");
  const body = `<div class="col" data-fit><div class="h" data-txt>${list.length} tech updates, one every hour.</div><div class="days">${cards}</div></div>`;
  const css = `.col{position:absolute;left:${M}px;right:${M}px;top:${v * 13 + M * 0.8}px;bottom:${M}px;display:flex;flex-direction:column;justify-content:center;gap:${v * 4}px;overflow:hidden}.h{font-size:${v * 7.4}px}
.days{display:grid;grid-template-columns:repeat(${days(list)},1fr);gap:${v * 2}px}.day{padding:${v * 3.4}px;display:flex;flex-direction:column;gap:${v * 1.6}px}.dl{color:#92b8ff}.dt{font-size:${v * 4}px}.day .p{font-size:${v * 2.5}px}`;
  return { file: "whats-next-x.png", size: z, html: page(z, a, "Tourbillon · What's next", "Robinhood Chain", body, css, null) };
}

/// All posters of one shape on one sheet (the sizes follow the update count: 16 columns for squares, 11 for wides).
export function glance(list: KitUpdate[], kitDir: string, shape: "square" | "wide", a: Assets): Page {
  const cols = shape === "square" ? 16 : 11;
  const W = shape === "square" ? 2592 : 2556;
  const pad0 = 48;
  const gap = 10;
  const head = 110;
  const tw = (W - 2 * pad0 - (cols - 1) * gap) / cols;
  const th = shape === "square" ? tw : (tw * 675) / 1200;
  const rows = Math.ceil(list.length / cols);
  const H = Math.round(head + pad0 + rows * th + (rows - 1) * gap + pad0);
  const imgs = list.map((u) => `<img src="data:image/png;base64,${readFileSync(posterFile(kitDir, u.n, shape)).toString("base64")}">`).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Inter;src:url(${a.font}) format("woff2");font-weight:100 900}
*{margin:0;padding:0;box-sizing:border-box}html,body{width:${W}px;height:${H}px;overflow:hidden}
body{background:${FIELD};font-family:Inter,sans-serif;color:#fff}
.hd{position:absolute;left:${pad0}px;top:${pad0 * 0.7}px;display:flex;align-items:center;gap:18px}.hd img{width:56px;height:56px}
.hd b{font-weight:900;font-size:44px}.hd span{font-weight:600;font-size:22px;letter-spacing:7px;text-transform:uppercase;color:#9fb3dd}
.g{position:absolute;left:${pad0}px;top:${head + pad0 * 0.4}px;display:grid;grid-template-columns:repeat(${cols},${tw}px);gap:${gap}px}.g img{width:${tw}px;height:${th}px;border-radius:6px;display:block}
</style></head><body><div class="hd"><img src="${a.white}"><b>All ${list.length} update posters</b><span>${shape === "square" ? "square" : "wide, for X"}</span></div><div class="g">${imgs}</div>
<script>document.body.dataset.overflow="false";</script></body></html>`;
  return { file: `posters-${shape}-at-a-glance.png`, size: { w: W, h: H }, html };
}

// ---------------- drawing and checks ----------------
function chrome(bin: string, args: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "tourbillon-kit-"));
  try {
    return Bun.spawnSync([bin, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--virtual-time-budget=4000", `--user-data-dir=${join(dir, "p")}`, ...args], { stdout: "pipe", stderr: "pipe" }).stdout.toString();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/// The texts a page shows (its [data-txt] elements), for the words list.
export const pageTexts = (html: string) => [...html.matchAll(/<[^>]*\bdata-txt\b[^>]*>([^<]*)</g)].map((m) => m[1]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"'));

export function claimProblems(proofRepo: string): string[] {
  const head = Bun.spawnSync(["git", "log", "--format=%H", "-1", "tech"], { cwd: proofRepo }).stdout.toString().trim();
  return CLAIMS.filter((c) => {
    const r = Bun.spawnSync(["git", "show", `${head}:${c.file}`], { cwd: proofRepo });
    return r.exitCode !== 0 || !r.stdout.toString().includes(c.has);
  }).map((c) => `"${c.claim}": ${c.file} does not say "${c.has}"`);
}

export function buildKit(kitDir: string, symbol: string, o: { chrome?: string; proofRepo?: string } = {}): string[] {
  const bin = o.chrome ?? DEFAULT_CHROME;
  const a = loadAssets(kitDir);
  const list = JSON.parse(readFileSync(join(kitDir, "updates.json"), "utf8")) as KitUpdate[];
  for (const u of list) for (const s of ["square", "wide"] as const) if (!existsSync(posterFile(kitDir, u.n, s))) throw new Error(`the ${s} poster of update ${pad(u.n)} is missing: draw the posters first`);
  const out = join(kitDir, "launch-kit");
  const pages: Page[] = [
    launchPage({ w: 1080, h: 1080 }, a, symbol, list.length),
    launchPage({ w: 1200, h: 675 }, a, symbol, list.length),
    ...[1, 2, 3, 4].map((i) => howPage(i, a, symbol, list.length)),
    factSheet(a, symbol, list.length),
    whatsNext(list, a, symbol),
    ...Array.from({ length: days(list) }, (_, i) => dayPage(list, i + 1, a)),
    whatsNextX(list, a),
    glance(list, kitDir, "square", a),
    glance(list, kitDir, "wide", a),
  ];
  // checks first: words, layout, claims
  const bad: string[] = [];
  for (const p of pages)
    for (const t of pageTexts(p.html)) {
      if (t.includes("words-lint")) bad.push(`${p.file}: a kit text cannot carry a words-lint marker: "${t}"`);
      for (const f of lintText(t)) bad.push(`${p.file}: "${f.rule}" in "${t}"`);
    }
  if (o.proofRepo) bad.push(...claimProblems(o.proofRepo));
  const dir = mkdtempSync(join(tmpdir(), "tourbillon-kit-pages-"));
  try {
    for (const p of pages) {
      const f = join(dir, p.file.replace(/\.\w+$/, ".html"));
      writeFileSync(f, p.html);
      if (/data-overflow="true"/.test(chrome(bin, [`--window-size=${p.size.w},${p.size.h}`, "--dump-dom", `file://${f}`]))) bad.push(`${p.file}: text overflows`);
    }
    if (bad.length) throw new Error(`launch kit refused:\n${bad.join("\n")}`);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    for (const p of pages) {
      const f = join(dir, p.file.replace(/\.\w+$/, ".html"));
      const png = join(out, p.file.replace(/\.jpg$/, ".png"));
      chrome(bin, [`--window-size=${p.size.w},${p.size.h}`, `--screenshot=${png}`, `file://${f}`]);
      const s = existsSync(png) ? pngSize(readFileSync(png)) : null;
      if (!s || s.w !== p.size.w || s.h !== p.size.h) throw new Error(`${p.file} came out ${s?.w}x${s?.h}, not ${p.size.w}x${p.size.h}`);
      if (p.file.endsWith(".jpg")) {
        const r = Bun.spawnSync(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "92", png, "--out", join(out, p.file)], { stdout: "pipe", stderr: "pipe" });
        if (r.exitCode !== 0) throw new Error(`${p.file}: the JPEG could not be made`);
        rmSync(png);
      }
    }
    // the fact sheet as an A4 PDF: the same page, scaled to the A4 width
    const fact = pages.find((p) => p.file === "fact-sheet.jpg")!;
    const a4 = join(dir, "fact-sheet-a4.html");
    // A4 at print resolution is 793.7 x 1122.5 CSS px; a hair under the smaller ratio keeps it to one page
    const zoom = Math.floor(Math.min(793.7 / 1240, 1122.5 / 1754) * 1000) / 1000 - 0.002;
    writeFileSync(a4, fact.html.replace("<style>", `<style>@page{size:A4;margin:0}html{zoom:${zoom};background:#0a1426;-webkit-print-color-adjust:exact;print-color-adjust:exact}`));
    chrome(bin, ["--no-pdf-header-footer", `--print-to-pdf=${join(out, "fact-sheet.pdf")}`, `file://${a4}`]);
    if (!existsSync(join(out, "fact-sheet.pdf"))) throw new Error("fact-sheet.pdf could not be made");
    const pdf = readFileSync(join(out, "fact-sheet.pdf")).toString("latin1");
    const pagesN = (pdf.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    if (pagesN !== 1) throw new Error(`fact-sheet.pdf has ${pagesN} pages, not one A4 page`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // the two zips, stored so every PNG stays exact
  for (const s of ["square", "wide"] as const)
    writeFileSync(join(out, `${SLUG}-posters-${s}-${list.length}.zip`), storedZipMany(list.map((u) => ({ name: `update-${pad(u.n)}-${s}.png`, data: readFileSync(posterFile(kitDir, u.n, s)) }))));
  // the team bot's launch poster
  copyFileSync(join(out, "launch-announcement-square.png"), join(kitDir, "posters", "launch.png"));
  // the fingerprint list
  const files = readdirSync(out).filter((f) => f !== "MANIFEST.sha256").sort();
  writeFileSync(join(out, "MANIFEST.sha256"), files.map((f) => `${new Bun.CryptoHasher("sha256").update(readFileSync(join(out, f))).digest("hex")}  ${f}`).join("\n") + "\n");
  return files;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const kit = opt("kit");
  const symbol = opt("symbol");
  if (!kit || !symbol) throw new Error("--kit <kit folder> and --symbol <settlement symbol> are needed");
  const files = buildKit(kit, symbol, { chrome: opt("chrome"), proofRepo: opt("proof-repo") });
  console.log(`${files.length} kit files in ${kit}/launch-kit (plus MANIFEST.sha256):\n${files.join("\n")}`);
}
