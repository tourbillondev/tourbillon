import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { buildKit, fill, kitEntry, type Source } from "../src/kit.ts";
import { BOARD, boardHtml, commandOf, commandProof, contactSheet, dayOf, DEFAULT_CHROME, layout, posterCheck, posterHtml, render, type Assets } from "../src/posters.ts";
import { writeFileSync } from "node:fs";
import { pngSize, posterProblems, POSTERS_PENDING, SQUARE, WIDE } from "../src/queue.ts";
import { mkdirSync } from "node:fs";

const src = (title = "Paid in {{SETTLEMENT}}"): Source => ({
  group: "API",
  title: fill(title, "USDG"),
  post: { type: "NEW", title, telegram: "Send {{SETTLEMENT}} to the payee.", x: "Paid in {{SETTLEMENT}}.", changelog: "API: paid in {{SETTLEMENT}}." },
});

describe("posters pending the owner's design approval", () => {
  test("no posters folder: each update says pending; once it exists, missing posters are named as usual", () => {
    const kit = mkdtempSync(join(tmpdir(), "kit-"));
    try {
      expect(posterProblems(kit, 7)).toEqual([POSTERS_PENDING]);
      mkdirSync(join(kit, "posters"));
      expect(posterProblems(kit, 7)).toEqual(["The square poster is missing.", "The wide poster is missing."]);
    } finally {
      rmSync(kit, { recursive: true, force: true });
    }
  });
});

describe("the kit's texts", () => {
  test("the settlement symbol is filled from the deployment; status and group set", () => {
    expect(kitEntry(24, src(), "USDG")).toEqual({ n: 24, type: "NEW", title: "Paid in USDG", status: "QUEUED", changelog: "API: paid in USDG.", changelog_line: "API: paid in USDG.", telegram: "Send USDG to the payee.", x: "Paid in USDG.", group: "API" });
  });
  test("refused: a placeholder left, a title out of step, a symbol that is not one", () => {
    const left = src();
    left.post.x = "Paid in {{TOKEN}}.";
    expect(() => kitEntry(24, left, "USDG")).toThrow("update 24: x still has a placeholder");
    expect(() => kitEntry(24, { ...src(), title: "Something else" }, "USDG")).toThrow("differs from the source title");
    expect(() => kitEntry(24, src(), "US DG")).toThrow("not a token symbol");
  });
  // queue-src/ is private (the updates are published one an hour); this runs where it exists, the private repo
  test.skipIf(!existsSync(join(import.meta.dir, "../../../queue-src")))("the whole queue-src builds: 62 updates, no placeholder, one changelog line each (private repo only)", () => {
    const list = buildKit(join(import.meta.dir, "../../../queue-src"), "USDG");
    expect(list.map((u) => u.n)).toEqual(Array.from({ length: 62 }, (_, i) => i + 1));
    for (const u of list) {
      expect(JSON.stringify(u)).not.toContain("{{");
      expect(u.changelog_line).not.toContain("\n");
    }
  });
});

const chrome = existsSync(DEFAULT_CHROME);
// tiny stand-in assets (the real ones live in the private kit's design/ folder): a 1x1 PNG, a plain SVG, no font file
const A: Assets = {
  font: "data:font/woff2;base64,AA==",
  silver: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  white: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#fff"/></svg>').toString("base64")}`,
};
const u1 = { n: 1, title: "Builder sandbox: the whole stack on your machine, one command", type: "CMD", telegram: "One command.\n\ncd services && bun common/scripts/sandbox.ts" };
describe("the posters (option A3)", () => {
  test("the template: number, escaped title, type, day and the update's own command (none when it gives none)", () => {
    const h = posterHtml({ ...u1, n: 31, title: "Receipts <bundle> & proofs" }, SQUARE, A, 62);
    expect(h).toContain(">31</span>");
    expect(h).toContain("of 62");
    expect(h).toContain("Receipts &lt;bundle&gt; &amp; proofs");
    expect(h).toContain(">Day 2<");
    expect(h).toContain("cd services &amp;&amp; bun common/scripts/sandbox.ts");
    expect(posterHtml({ ...u1, telegram: "No command here." }, WIDE, A)).not.toContain('class="cmd"');
    expect(posterHtml({ ...u1, n: 16, title: "GET /v1/markets" }, SQUARE, A)).toContain("GET /<wbr>v1/<wbr>markets");
    expect([commandOf(u1.telegram), commandOf("plain text"), dayOf(24), dayOf(25), dayOf(62)]).toEqual(["cd services && bun common/scripts/sandbox.ts", null, "Day 1", "Day 2", "Day 3"]);
    expect(contactSheet([{ n: 1, type: "CMD", title: "A & B", status: "", changelog: "", changelog_line: "", telegram: "", x: "" }])).toContain("01 · A &amp; B");
  });
  test("the board poster: the live count, the bar and the next update; all live at the end", () => {
    const b = boardHtml(5, { n: 6, title: "Indexer: matched entries" }, A, 62);
    expect(b).toContain(">5</span>");
    expect(b).toContain("of 62 live");
    expect(b).toContain("Next · Update 06");
    expect((b.match(/<i class="on">/g) ?? []).length).toBe(1);
    expect(boardHtml(62, null, A, 62)).toContain("All 62 updates are live");
  });
  test("the layout check names what is wrong", () => {
    const ok = { overflow: false, clash: false, aligned: true, scale: 1, text: { num: "01", title: u1.title, type: "Command", cmd: "cd services && bun common/scripts/sandbox.ts", right: "Day 1" } };
    expect(posterCheck(u1, ok)).toEqual([]);
    expect(posterCheck(u1, { ...ok, overflow: true, clash: true, aligned: false, text: { ...ok.text, title: "Other", right: "Day 2" } })).toEqual([
      "text overflows its box even at 70% of the title size", "the header overlaps the artwork", "the text blocks are not on one left line", "the title is not the kit's", "the day is wrong",
    ]);
  });
  test("the command proof: a script missing from the update's own commit is named", () => {
    const repo = mkdtempSync(join(tmpdir(), "proof-"));
    try {
      const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: repo });
      git("init", "-q", "-b", "tech");
      mkdirSync(join(repo, "services/common/scripts"), { recursive: true });
      writeFileSync(join(repo, "services/common/scripts/sandbox.ts"), "x");
      git("add", "-A");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "Update 01: sandbox");
      expect(commandProof(u1, repo)).toEqual([]);
      expect(commandProof({ n: 1, telegram: "cd services && bun common/scripts/missing.ts" }, repo)).toEqual(["the command's script services/common/scripts/missing.ts is not in update 01's commit"]);
      expect(commandProof({ n: 2, telegram: u1.telegram }, repo)).toEqual(["no commit for update 02 to check its command against"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
  test.skipIf(!chrome)("Chrome: a long title steps down and fits, an absurd one is refused; posters come out at their exact sizes", () => {
    const l = layout(posterHtml(u1, SQUARE, A), SQUARE);
    expect(posterCheck(u1, l)).toEqual([]);
    const long = { ...u1, title: "GET /v1/markets/{market}/session: hours, the weekend clamp, caps in use and more words besides" };
    const ll = layout(posterHtml(long, SQUARE, A), SQUARE);
    expect(ll.scale).toBeLessThan(1);
    expect(ll.overflow).toBe(false);
    expect(layout(posterHtml({ ...u1, title: "word ".repeat(150) }, WIDE, A), WIDE).overflow).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "poster-test-"));
    try {
      for (const [name, size, html] of [["s.png", SQUARE, posterHtml(u1, SQUARE, A)], ["w.png", WIDE, posterHtml(u1, WIDE, A)], ["b.png", BOARD, boardHtml(1, { n: 2, title: "Next one" }, A)]] as const) {
        render(html, size, join(dir, name));
        expect(pngSize(readFileSync(join(dir, name)))).toEqual(size);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
