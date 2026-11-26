import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { announce, parseAnnounceArgs } from "../src/announce.ts";
import { chatFor, parseEnv, redact, secretsFrom } from "../src/config.ts";
import { Deduper } from "../src/dedupe.ts";
import { formatAlarm, type AlarmLine } from "../src/format.ts";
import { parseArgs, postFor, run } from "../src/main.ts";
import { telegramSender } from "../src/telegram.ts";

// No test reads ~/.tourbillon/alerts.env or reaches the network: secrets are made up here, the sender is a fake.
const FAKE_TOKEN = "123456:fake-token-for-tests";
const alarm = (o: Partial<AlarmLine>): AlarmLine => ({ level: "alarm", msg: "alarm", name: "coverage-breached", state: "raised", what: "Available USDC no longer covers the stressed liability.", who: "admin: add capital", market: null, values: {}, ...o });

describe("the alarm look", () => {
  test("raised (🔴 for the most serious, 🟡 otherwise), cleared, recoveries, markets, links", () => {
    expect(formatAlarm(alarm({}))).toBe("🔴 ALERT · coverage-breached\n\nWhat happened: Available USDC no longer covers the stressed liability.\nWho acts: admin: add capital");
    const y = formatAlarm(alarm({ name: "cap-high", level: "warn", market: "BTC", what: "A cap is nearly used up on this market.", who: "admin: decide" }));
    expect(y.split("\n")[0]).toBe("🟡 ALERT · cap-high-BTC");
    expect(formatAlarm(alarm({ state: "cleared", what: "Coverage restored." }))).toBe("🟢 CLEARED · coverage-breached\n\nWhat happened: Coverage restored.");
    expect(formatAlarm(alarm({ name: "unpaused", state: "event", what: "Unpaused: all opens." })).startsWith("🟢 CLEARED · unpaused")).toBe(true);
    const withTx = formatAlarm(alarm({ name: "timelock-queued", state: "event", values: { tx: "0xabc" } }), { tx: (h) => `https://explorer/tx/${h}` });
    expect(withTx.endsWith("https://explorer/tx/0xabc")).toBe(true);
    expect(formatAlarm(alarm({ name: "mark-stale" }), { guide: "https://t.me/c/1/2" }).endsWith("https://t.me/c/1/2")).toBe(true);
    // information posts: real events nobody has to act on, without the "Who acts" line
    for (const name of ["vault-slashed", "timelock-executed", "timelock-cancelled", "auction-settled"]) {
      const post = formatAlarm(alarm({ name, level: "warn", state: "event", what: "x happened.", who: "nobody" }));
      expect(post).toBe(`🟡 ALERT · ${name}\n\nWhat happened: x happened.`);
    }
    expect(formatAlarm(alarm({ name: "unpaused", state: "event", what: "Unpaused: all opens.", who: "nobody" }))).not.toContain("Who acts");
  });

});

describe("one post per change", () => {
  test("conditions post on raise and on clear only; a clear never raised here is skipped; events once; across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "alert-bot-"));
    const file = join(dir, "state.json");
    const d = new Deduper(file);
    expect(d.alarm(alarm({ state: "cleared" }))).toBe(false);
    expect(d.alarm(alarm({}))).toBe(true);
    expect(d.alarm(alarm({}))).toBe(false);
    expect(d.alarm(alarm({ market: "ETH" }))).toBe(true); // per market
    expect(d.alarm(alarm({ state: "cleared" }))).toBe(true);
    expect(d.alarm(alarm({ state: "cleared" }))).toBe(false);
    const ev = alarm({ name: "treasury-sent", state: "event", values: { tx: "0x1" } });
    expect(d.alarm(ev)).toBe(true);
    expect(d.alarm(ev)).toBe(false);
    const again = new Deduper(file); // a restart
    expect(again.alarm(ev)).toBe(false);
    expect(again.alarm(alarm({ market: "ETH" }))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("secrets and targets", () => {
  test("the test group by default; the same id for both is refused; missing keys refused; the launch flags moved to the team bot", () => {
    const s = secretsFrom(parseEnv(`ALERT_BOT_TOKEN=${FAKE_TOKEN}\nOPS_CHAT_ID=-100111\nTEST_CHAT_ID="-100222"\n# comment\n`));
    expect(chatFor(s, false)).toBe("-100222");
    expect(chatFor(s, true)).toBe("-100111");
    expect(() => secretsFrom({ ALERT_BOT_TOKEN: FAKE_TOKEN, OPS_CHAT_ID: "-1", TEST_CHAT_ID: "-1" })).toThrow("refusing to start");
    expect(() => secretsFrom({ OPS_CHAT_ID: "-1", TEST_CHAT_ID: "-2" })).toThrow("ALERT_BOT_TOKEN is missing");
    expect(() => parseArgs(["--follow", "a.log", "--staff"])).toThrow("alarms never go to the staff group");
    for (const flag of ["--board", "--launch-at", "--summary-at", "--summary-utc"]) expect(() => parseArgs(["--follow", "a.log", flag, "x"])).toThrow("moved to the team bot");
    expect(() => parseArgs([])).toThrow("--follow");
  });

  test("the token never appears in an error or a log line", async () => {
    expect(redact(`GET https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage failed`, FAKE_TOKEN)).not.toContain(FAKE_TOKEN);
    const throwing = (async (url: string) => {
      throw new Error(`connect failed for ${url}`);
    }) as unknown as typeof fetch;
    const err = await telegramSender(FAKE_TOKEN, throwing)("-1", "x").catch((e) => (e as Error).message);
    expect(err).toContain("[token]");
    expect(err).not.toContain(FAKE_TOKEN);
    const status = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    const err2 = await telegramSender(FAKE_TOKEN, status)("-1", "x").catch((e) => (e as Error).message);
    expect(err2).toBe("telegram: HTTP 401");
    const described = (async () => Response.json({ ok: false, description: "Bad Request: chat not found" }, { status: 400 })) as unknown as typeof fetch;
    expect(await telegramSender(FAKE_TOKEN, described)("-1", "x").catch((e) => (e as Error).message)).toBe("telegram: HTTP 400 (Bad Request: chat not found)");
  });
});

describe("the loop", () => {
  test("follows files, posts each alarm change once to the test group, ignores release lines and other lines; dry run sends nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alert-bot-run-"));
    const mon = join(dir, "risk-monitor.log");
    writeFileSync(mon, "");
    const sent: { chat: string; text: string }[] = [];
    let ticks = 0;
    const o = { ...parseArgs(["--follow", mon]), stateFile: join(dir, "s.json") };
    appendFileSync(mon, JSON.stringify({ t: "x", level: "info", msg: "started" }) + "\n"); // not an alarm
    appendFileSync(mon, JSON.stringify(alarm({})) + "\n" + JSON.stringify(alarm({})) + "\n");
    appendFileSync(mon, JSON.stringify({ kind: "release", status: "released", update: 7, title: "x", what: "y", next: "z", at: "2026-11-14T13:00:05Z" }) + "\n"); // the team bot's, never posted here
    await run({ ...o, fromStart: true }, async (chat, text) => void sent.push({ chat, text }), "-100222", () => ++ticks > 2, 10);
    expect(sent.map((s) => `${s.chat} ${s.text.split("\n")[0]}`)).toEqual(["-100222 🔴 ALERT · coverage-breached"]);
    const dry: string[] = [];
    let t2 = 0;
    await run({ ...o, fromStart: true, dryRun: true, stateFile: join(dir, "s2.json") }, async (_c, text) => void dry.push(text), "-100222", () => ++t2 > 1, 10);
    expect(dry).toEqual([]);
    expect(postFor("not json", new Deduper(null), {})).toBeNull();
    // dust-absorbed is never an alert (the team bot sums it into Shipped today)
    const dust = JSON.stringify({ t: "2026-11-14T10:00:00Z", ...alarm({ name: "dust-absorbed", level: "warn", state: "event", values: { events: 2, amount: 0.000002, symbol: "USDG" } }) });
    expect(postFor(dust, new Deduper(null), {})).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("an old state file with release and board fields still loads; only the alarm state is kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "alert-bot-old-"));
    const file = join(dir, "state.json");
    writeFileSync(file, JSON.stringify({ conditions: { "coverage-breached:*": "raised" }, seen: [], released: [{ update: 1 }], board: { messageId: 5, text: "x" }, updateOffset: 9 }));
    const d = new Deduper(file);
    expect(d.alarm(alarm({}))).toBe(false); // still raised
    expect(d.alarm(alarm({ state: "cleared" }))).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8"))).sort()).toEqual(["conditions", "seen"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

import { checkPosts, fillSettlement, TELEGRAM_LIMIT } from "../src/post.ts";
import { readFileSync, readdirSync } from "node:fs";

describe("prepared posts", () => {
  test("every prepared post fits Telegram's limit (emoji count twice); an empty or oversized post is refused before sending", () => {
    const dir = join(import.meta.dir, "../posts");
    // filled with the settlement token's symbol, as post.ts does from the deployment file (RH8)
    const texts = readdirSync(dir).sort().map((f) => fillSettlement(readFileSync(join(dir, f), "utf8").replace(/\n+$/, ""), "USDG"));
    expect(texts.length).toBe(6); // the setup posts, the intro and the guide in two parts
    expect(() => checkPosts(texts)).not.toThrow();
    expect("🟡".length).toBe(2);
    expect(() => checkPosts(["x".repeat(TELEGRAM_LIMIT + 1)])).toThrow("over Telegram");
    expect(() => checkPosts(["  "])).toThrow("empty");
    for (const t of texts) expect(wordingWarnings(t)).toEqual([]);
  });
});

import { wordingWarnings } from "../src/post.ts";

describe("routing", () => {
  test("alarms and information posts go to the test group only, each once; release lines are never posted here", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alert-bot-route-"));
    const mon = join(dir, "m.log");
    const lines = [
      alarm({}),
      alarm({ name: "timelock-executed", state: "event", values: { tx: "0x9" } }),
      ...(["vault-slashed", "timelock-cancelled", "unpaused", "auction-settled", "receipt-root-missing", "collateral-short", "signer-spread", "treasury-gap"] as const).map((name) => alarm({ name, state: "event", values: { tx: `0x${name}` } })),
      ...(["released", "delayed", "held", "rolled_back"] as const).map((status, i) => ({ kind: "release", status, update: 7 + i, title: "t", what: "w", next: "n", at: "2026-11-14T13:00:05Z" })),
    ];
    writeFileSync(mon, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const toChats: string[] = [];
    const texts: string[] = [];
    let ticks = 0;
    const o = { ...parseArgs(["--follow", mon]), fromStart: true, stateFile: join(dir, "s.json") };
    await run(o, async (c, t) => void (toChats.push(c), texts.push(t.split("\n")[0]!)), "-100test", () => ++ticks > 1, 5);
    expect(toChats).toEqual(Array(10).fill("-100test"));
    expect(texts.some((t) => /RELEASED|DELAYED|HELD|ROLLED/.test(t))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("announcement wording warnings (Overview section 9)", () => {
    expect(wordingWarnings("Launch is on Monday. NAV and funding received are on the board.")).toEqual([]);
    expect(wordingWarnings("Earn 12% APY, risk-free!").length).toBe(3); // income, return and risk-free; words-lint: allow
    const aff = wordingWarnings("the official partner"); // words-lint: allow
    expect(aff).toHaveLength(2); // one warning per word
    expect(aff.every((w) => w.startsWith("affiliation wording:"))).toBe(true);
    expect(wordingWarnings("Writers receive funding received; NAV can fall.")).toEqual([]);
  });
});

describe("owner announcements", () => {
  const secrets = { token: FAKE_TOKEN, opsChatId: "-100staff", testChatId: "-100test" };
  const io = (answer: string) => {
    const out: string[] = [];
    const sent: string[] = [];
    const asked: string[] = [];
    return { out, sent, asked, io: { write: (s: string) => void out.push(s), ask: async (q: string) => (asked.push(q), answer), send: async (c: string, t: string) => (sent.push(`${c}:${t}`), 42) } };
  };

  test("--test: same preview, wording check and typed confirmation, posted to the Alert Test group", async () => {
    expect(parseAnnounceArgs(["--test", "--file", "a.txt"]).test).toBe(true);
    expect(parseAnnounceArgs(["--file", "a.txt"]).test).toBe(false);
    expect(() => parseAnnounceArgs(["--staff", "--file", "a.txt"])).toThrow("unknown flag --staff");
    const t = io("post");
    expect(await announce("Launch on Monday. Earn 12% APY", true, secrets, t.io)).toBe("sent"); // words-lint: allow
    expect(t.out[0]).toContain("this goes to the Alert Test group exactly as written");
    expect(t.out.some((l) => l.startsWith("warning:"))).toBe(true); // the wording check runs on a test post too
    expect(t.asked).toEqual(['Type "post" to send it to the Alert Test group, anything else to cancel: ']);
    expect(t.sent).toEqual(["-100test:Launch on Monday. Earn 12% APY"]); // words-lint: allow
    expect(t.out.at(-1)).toBe("sent to the Alert Test group (message 42)\n");
  });

  test("without --test it goes to the staff group; anything but \"post\" sends nothing; oversized text is refused", async () => {
    const s = io(" post ");
    expect(await announce("Launch on Monday.", false, secrets, s.io)).toBe("sent");
    expect(s.out[0]).toContain("this goes to the STAFF group");
    expect(s.sent).toEqual(["-100staff:Launch on Monday."]);
    for (const answer of ["", "yes", "Post", "p"]) {
      const c = io(answer);
      expect(await announce("Launch on Monday.", true, secrets, c.io)).toBe("cancelled");
      expect(c.sent).toEqual([]);
    }
    const big = io("post");
    await expect(announce("x".repeat(4097), true, secrets, big.io)).rejects.toThrow();
    expect(big.sent).toEqual([]);
  });
});

describe("the pinned guide", () => {
  test("two posts, each well under one message (3,000 of 4,096 units), naming every red and information alarm", async () => {
    const { RED, INFO } = await import("../src/format.ts");
    const { fillSettlement, checkPosts } = await import("../src/post.ts");
    const raw = ["posts/d-guide-1.txt", "posts/d-guide-2.txt"].map((f) => readFileSync(join(import.meta.dir, "..", f), "utf8").trimEnd());
    expect(() => checkPosts(raw)).toThrow("placeholder left"); // never sent without the settlement token's symbol
    const parts = raw.map((t) => fillSettlement(t, "USDG")); // the symbol from the deployment file (owner D1)
    checkPosts(parts);
    expect(parts[0]).toContain("available USDG no longer covers");
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(3000); // JS length counts UTF-16 units, as Telegram does
    expect(parts[0]!.startsWith("Tourbillon Alerts: what each post means (part 1 of 2)")).toBe(true);
    expect(parts[1]!.startsWith("Tourbillon Alerts: what each post means (part 2 of 2)")).toBe(true);
    const all = parts.join("\n");
    for (const name of [...RED, ...INFO]) expect(all).toContain(name);
    expect(all).not.toContain("copy here"); // nothing is copied between groups
  });
});
