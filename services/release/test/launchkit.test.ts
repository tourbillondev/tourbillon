import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { lintText } from "@tourbillon/common/words.ts";
import { buildKit, claimProblems, CLAIMS, DAY_HEAD, DAY_ROW, dayPage, days, factSheet, howPage, launchPage, pageTexts, texts, whatsNext, whatsNextX } from "../src/launchkit.ts";
import { DEFAULT_CHROME, type Assets } from "../src/posters.ts";
import { pngSize, posterFile, type KitUpdate } from "../src/queue.ts";
import { storedZipMany } from "../src/zip.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "launchkit-"));
const sh = (cmd: string[], cwd?: string) => Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
const chrome = existsSync(DEFAULT_CHROME);
const PNG1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const A: Assets = {
  font: "data:font/woff2;base64,AA==",
  silver: `data:image/png;base64,${PNG1.toString("base64")}`,
  white: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#fff"/></svg>').toString("base64")}`,
};
const upd = (n: number, title = `Update number ${n}`, type = "NEW"): KitUpdate => ({ n, type, title, status: "QUEUED", changelog: "", changelog_line: "", telegram: "", x: "" });
const list62 = Array.from({ length: 62 }, (_, i) => upd(i + 1, `Update ${i + 1}`, ["NEW", "HOW", "CMD", "BTS"][i % 4]!));

describe("storedZipMany", () => {
  test("every file comes back byte for byte, in order, stored; unzip finds no error", () => {
    const d = tmp();
    try {
      const files = [
        { name: "update-01-square.png", data: new Uint8Array(PNG1) },
        { name: "update-02-square.png", data: new TextEncoder().encode("second file, a little longer") },
        { name: "empty.txt", data: new Uint8Array(0) },
      ];
      writeFileSync(join(d, "k.zip"), storedZipMany(files, new Date(Date.UTC(2026, 10, 26, 12))));
      expect(sh(["unzip", "-tq", "k.zip"], d).exitCode).toBe(0);
      const listing = sh(["unzip", "-Z1", "k.zip"], d).stdout.toString().trim().split("\n");
      expect(listing).toEqual(files.map((f) => f.name));
      expect(sh(["unzip", "-v", "k.zip"], d).stdout.toString()).not.toContain("Defl");
      for (const f of files) expect(new Uint8Array(sh(["unzip", "-p", "k.zip", f.name], d).stdout)).toEqual(f.data);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  test("refused: no files, a path or odd name, the same name twice", () => {
    const f = { name: "a.png", data: new Uint8Array(1) };
    expect(() => storedZipMany([])).toThrow("no files");
    expect(() => storedZipMany([{ ...f, name: "../a.png" }])).toThrow("a plain file name is needed");
    expect(() => storedZipMany([{ ...f, name: "dir/a.png" }])).toThrow("a plain file name is needed");
    expect(() => storedZipMany([{ ...f, name: "" }])).toThrow("a plain file name is needed");
    expect(() => storedZipMany([f, f])).toThrow("a.png twice");
  });
});

describe("the kit's texts", () => {
  const all = (symbol: string) => JSON.stringify(texts(symbol, 62));
  test("every text passes the words list", () => {
    const T = texts("USDG", 62);
    const strings = [T.launch.headline, T.launch.sub, ...T.launch.points, ...T.how.flatMap((h) => [h.title, ...h.body]), ...T.products.flat(), ...T.mechanics.flat(), ...T.laws, ...T.chain, ...T.rollout.flat(), T.footer];
    for (const s of strings) expect(lintText(s)).toEqual([]);
  });
  test("the settlement symbol comes from the deployment; the six laws are the spec's words; the footer says independent", () => {
    expect(all("USDG")).toContain("Settled in USDG");
    expect(all("XYZ6")).toContain("Settled in XYZ6");
    expect(all("XYZ6")).not.toContain("USDG");
    expect(texts("USDG", 62).laws).toHaveLength(6);
    expect(texts("USDG", 62).laws[2]).toBe("Sells always work. Pauses stop new opens only.");
    expect(texts("USDG", 62).footer).toStartWith("Independent project. Robinhood Chain is used as a network only.");
  });
  test("no unverified claims: no 'first', no dates on the rollout, no percentage", () => {
    const s = all("USDG").toLowerCase();
    expect(s).not.toMatch(/\bfirst options\b|\bthe first\b/);
    expect(s).not.toMatch(/\d+\s*%|\b20\d\d\b/);
  });
  test("every claim names a file and the words that prove it", () => {
    for (const c of CLAIMS) {
      expect(c.file).toMatch(/^(contracts|docs)\//);
      expect(c.has.length).toBeGreaterThan(5);
    }
  });
});

describe("the pages", () => {
  test("day sheets: 24 rows a day, the last day as many as remain; height = header + rows", () => {
    expect(days(list62)).toBe(3);
    expect([1, 2, 3].map((d) => dayPage(list62, d, A).size)).toEqual([
      { w: 1080, h: 2186 },
      { w: 1080, h: 2186 },
      { w: 1080, h: DAY_HEAD + DAY_ROW * 14 },
    ]);
    const d3 = dayPage(list62, 3, A).html;
    expect(d3).toContain("Day 3 · updates 49 to 62");
    expect(d3).toContain("Hour 49");
    expect(d3).not.toContain("Update 48<");
  });
  test("titles are escaped and every shown text is collected for the words list", () => {
    const l = [upd(1, "Receipts <bundle> & proofs")];
    const p = dayPage(l, 1, A);
    expect(p.html).toContain("Receipts &lt;bundle&gt; &amp; proofs");
    expect(pageTexts(p.html)).toEqual(["Day 1 · updates 01 to 01", "Receipts <bundle> & proofs"]);
    // every page's texts are collected, whatever other attributes the element carries
    expect(pageTexts(whatsNext(list62, A, "USDG").html)).toContain("Each one goes out only after it is live and checked.");
    expect(pageTexts(dayPage(list62, 2, A).html)).toHaveLength(25);
  });
  test("sizes and file names follow the playbook's kit list", () => {
    expect(launchPage({ w: 1080, h: 1080 }, A, "USDG", 62)).toMatchObject({ file: "launch-announcement-square.png", size: { w: 1080, h: 1080 } });
    expect(launchPage({ w: 1200, h: 675 }, A, "USDG", 62)).toMatchObject({ file: "launch-announcement-wide-for-X.png", size: { w: 1200, h: 675 } });
    expect([1, 2, 3, 4].map((i) => howPage(i, A, "USDG", 62).file)).toEqual(["how-it-works-1.png", "how-it-works-2.png", "how-it-works-3.png", "how-it-works-4.png"]);
    expect(factSheet(A, "USDG", 62)).toMatchObject({ file: "fact-sheet.jpg", size: { w: 1240, h: 1754 } });
    expect(whatsNext(list62, A, "USDG")).toMatchObject({ file: "whats-next.png", size: { w: 1080, h: 1460 } });
    expect(whatsNextX(list62, A)).toMatchObject({ file: "whats-next-x.png", size: { w: 1200, h: 675 } });
  });
  test("the roadmap counts each day's updates by kind", () => {
    const h = whatsNext(list62, A, "USDG").html;
    expect(h).toContain("Updates 01 to 24");
    expect(h).toContain("Updates 49 to 62");
    expect(h).toContain("6 new");
  });
});

describe("the claims check", () => {
  const repo = (files: Record<string, string>) => {
    const d = tmp();
    sh(["git", "init", "-q", "-b", "tech"], d);
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(join(d, f, ".."), { recursive: true });
      writeFileSync(join(d, f), body);
    }
    sh(["git", "add", "-A"], d);
    sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "t"], d);
    return d;
  };
  const proving = () => {
    const files: Record<string, string> = {};
    for (const c of CLAIMS) files[c.file] = (files[c.file] ?? "") + c.has + "\n";
    return files;
  };
  test("a tree that says every claim: no problem", () => {
    const d = repo(proving());
    try {
      expect(claimProblems(d)).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  test("a claim the code no longer says, or a file gone, is named", () => {
    const files = proving();
    files["contracts/src/TempoBlend.sol"] = "MAX_PARTS = 3\n";
    delete files["contracts/src/VolFeed.sol"];
    const d = repo(files);
    try {
      expect(claimProblems(d)).toEqual(['"A Movement mixes up to four tempos": contracts/src/TempoBlend.sol does not say "MAX_PARTS = 4"', '"Vol published on chain for any contract to read": contracts/src/VolFeed.sol does not say "contract VolFeed"']);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  const author = join(process.env.HOME ?? "", "tourbillon-work/author");
  test.skipIf(!existsSync(join(author, ".git")))("the authoring copy's last update says every claim", () => {
    expect(claimProblems(author)).toEqual([]);
  });
});

describe("the whole kit, drawn", () => {
  const kit = (n: number) => {
    const d = tmp();
    mkdirSync(join(d, "design"));
    writeFileSync(join(d, "design", "Inter.woff2"), "AA");
    writeFileSync(join(d, "design", "silver-mark.png"), PNG1);
    writeFileSync(join(d, "design", "white-mark.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#fff"/></svg>');
    for (const s of ["square", "wide"]) mkdirSync(join(d, "posters", s), { recursive: true });
    const l = Array.from({ length: n }, (_, i) => upd(i + 1));
    writeFileSync(join(d, "updates.json"), JSON.stringify(l));
    return { d, l };
  };
  test("refused before drawing: a poster missing", () => {
    const { d } = kit(2);
    try {
      expect(() => buildKit(d, "USDG")).toThrow("the square poster of update 01 is missing");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  test.skipIf(!chrome)(
    "every file at its size, one A4 page, both zips whole, the launch poster for the team bot, a manifest that matches",
    () => {
      const { d, l } = kit(3);
      try {
        for (const u of l) for (const s of ["square", "wide"]) writeFileSync(posterFile(d, u.n, s as "square" | "wide"), PNG1);
        const files = buildKit(d, "USDG");
        const out = join(d, "launch-kit");
        expect(files).toEqual(readdirSync(out).filter((f) => f !== "MANIFEST.sha256").sort());
        expect(files).toHaveLength(15); // the playbook's 17 files with one day sheet, not three (three updates fill one day)
        const size = (f: string) => pngSize(readFileSync(join(out, f)));
        expect(size("launch-announcement-square.png")).toEqual({ w: 1080, h: 1080 });
        expect(size("launch-announcement-wide-for-X.png")).toEqual({ w: 1200, h: 675 });
        expect(size("how-it-works-3.png")).toEqual({ w: 1080, h: 1080 });
        expect(size("whats-next.png")).toEqual({ w: 1080, h: 1460 });
        expect(size("whats-next-day-1.png")).toEqual({ w: 1080, h: DAY_HEAD + DAY_ROW * 3 });
        expect(size("whats-next-x.png")).toEqual({ w: 1200, h: 675 });
        const jpg = readFileSync(join(out, "fact-sheet.jpg"));
        expect([jpg[0], jpg[1]]).toEqual([0xff, 0xd8]);
        const pdf = readFileSync(join(out, "fact-sheet.pdf")).toString("latin1");
        expect(pdf).toStartWith("%PDF");
        expect(pdf).toMatch(/\/MediaBox \[0 0 59[45]\.\d+ 841\.\d+\]/);
        for (const s of ["square", "wide"]) {
          const z = `tourbillon-posters-${s}-3.zip`;
          expect(sh(["unzip", "-tq", z], out).exitCode).toBe(0);
          expect(sh(["unzip", "-Z1", z], out).stdout.toString().trim().split("\n")).toEqual([1, 2, 3].map((n) => `update-0${n}-${s}.png`));
        }
        expect(readFileSync(join(d, "posters", "launch.png"))).toEqual(readFileSync(join(out, "launch-announcement-square.png")));
        expect(sh(["shasum", "-a", "256", "-c", "MANIFEST.sha256"], out).exitCode).toBe(0);
        expect(readFileSync(join(out, "MANIFEST.sha256"), "utf8").trim().split("\n")).toHaveLength(15);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
