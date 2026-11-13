import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { announce, parseAnnounceArgs } from "../src/announce.ts";
import { chatFor, parseEnv, redact, secretsFrom } from "../src/config.ts";
import { Deduper } from "../src/dedupe.ts";
import { formatAlarm, formatDustNote, formatRelease, formatShippedToday, type AlarmLine, type ReleaseLine } from "../src/format.ts";
import { parseArgs, postFor, run } from "../src/main.ts";
import { telegramSender } from "../src/telegram.ts";

// No test reads ~/.tourbillon/alerts.env or reaches the network: secrets are made up here, the sender is a fake.
const FAKE_TOKEN = "123456:fake-token-for-tests";
const alarm = (o: Partial<AlarmLine>): AlarmLine => ({ level: "alarm", msg: "alarm", name: "COVERAGE_BREACHED", state: "raised", what: "Elysium USDC no longer covers the stressed liability.", who: "admin: add capital", market: null, values: {}, ...o });
const rel = (o: Partial<ReleaseLine>): ReleaseLine => ({ kind: "release", status: "released", update: 7, title: "GET /v1/pool: NAV and coverage", what: "Deployed; post-deploy checks passed; GitHub release published.", who: "nobody", next: "Update 08 at 14:00 UTC.", link: "https://github.com/x/releases/update-07", proof: "https://github.com/x/releases/update-07", at: "2026-11-14T13:00:05Z", ...o });

describe("the Cofer look", () => {
  test("raised (🔴 for the most serious, 🟡 otherwise), cleared, recoveries, markets, links", () => {
    expect(formatAlarm(alarm({}))).toBe("🔴 ALERT · COVERAGE_BREACHED\n\nWhat happened: Elysium USDC no longer covers the stressed liability.\nWho acts: admin: add capital");
    const y = formatAlarm(alarm({ name: "CAP_HIGH", level: "warn", market: "BTC", what: "A cap is nearly used up on this market.", who: "admin: decide" }));
    expect(y.split("\n")[0]).toBe("🟡 ALERT · CAP_HIGH · BTC");
    expect(formatAlarm(alarm({ state: "cleared", what: "Coverage restored." }))).toBe("🟢 CLEARED · COVERAGE_BREACHED\n\nWhat happened: Coverage restored.");
    expect(formatAlarm(alarm({ name: "UNPAUSED", state: "event", what: "Unpaused: all opens." })).startsWith("🟢 CLEARED · UNPAUSED")).toBe(true);
    const withTx = formatAlarm(alarm({ name: "TIMELOCK_QUEUED", state: "event", values: { tx: "0xabc" } }), { tx: (h) => `https://explorer/tx/${h}` });
    expect(withTx.endsWith("https://explorer/tx/0xabc")).toBe(true);
    expect(formatAlarm(alarm({ name: "MARK_STALE" }), { guide: "https://t.me/c/1/2" }).endsWith("https://t.me/c/1/2")).toBe(true);
    // information posts: real events nobody has to act on, without the "Who acts" line
    for (const name of ["VAULT_SLASHED", "TIMELOCK_EXECUTED", "TIMELOCK_CANCELLED", "AUCTION_SETTLED"]) {
      const post = formatAlarm(alarm({ name, level: "warn", state: "event", what: "x happened.", who: "nobody" }));
      expect(post).toBe(`🟡 ALERT · ${name}\n\nWhat happened: x happened.`);
    }
    expect(formatAlarm(alarm({ name: "UNPAUSED", state: "event", what: "Unpaused: all opens.", who: "nobody" }))).not.toContain("Who acts");
  });

  test("release alerts and the daily summary", () => {
    expect(formatRelease(rel({}))).toBe("✅ SHIPPED AND RELEASED · Update 07\n\nGET /v1/pool: NAV and coverage\n\nWhat happened: Deployed; post-deploy checks passed; GitHub release published.\nWho acts: nobody\nNext step: Update 08 at 14:00 UTC.\nhttps://github.com/x/releases/update-07");
    expect(formatRelease(rel({ status: "held", link: undefined })).split("\n")[0]).toBe("🟡 HELD · Update 07");
    expect(formatRelease(rel({ status: "rolled_back" })).split("\n")[0]).toBe("🔴 ROLLED BACK · Update 07");
    const s = formatShippedToday("2026-11-14", [rel({ update: 9, title: "B" }), rel({ update: 8, title: "A" })]);
    expect(s).toBe("Shipped today · 2026-11-14 (UTC)\n\n2 updates released:\n• Update 08 · A · https://github.com/x/releases/update-07\n• Update 09 · B · https://github.com/x/releases/update-07");
    expect(formatShippedToday("2026-11-15", [])).toContain("No updates released today.");
    expect(formatShippedToday("2026-11-15", [])).not.toContain("rounding"); // the rounding note is separate now
    expect(formatDustNote("2026-11-15", { events: 3, usdc: 0.000003 })).toBe(
      "Buyback rounding · 2026-11-15 (UTC)\n\nWhat happened: the pool absorbed buyback rounding (at most 1 micro-USDC per source): 3 events, 0.000003 USDC.",
    );
  });
});

describe("one post per change", () => {
  test("conditions post on raise and on clear only; a clear never raised here is skipped; events once; releases once; across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "alert-bot-"));
    const file = join(dir, "state.json");
    const d = new Deduper(file);
    expect(d.alarm(alarm({ state: "cleared" }))).toBe(false);
    expect(d.alarm(alarm({}))).toBe(true);
    expect(d.alarm(alarm({}))).toBe(false);
    expect(d.alarm(alarm({ market: "ETH" }))).toBe(true); // per market
    expect(d.alarm(alarm({ state: "cleared" }))).toBe(true);
    expect(d.alarm(alarm({ state: "cleared" }))).toBe(false);
    const ev = alarm({ name: "TREASURY_SENT", state: "event", values: { tx: "0x1" } });
    expect(d.alarm(ev)).toBe(true);
    expect(d.alarm(ev)).toBe(false);
    expect(d.release(rel({}))).toBe(true);
    expect(d.release(rel({}))).toBe(false);
    expect(d.release(rel({ status: "held" }))).toBe(true);
    expect(d.summary("2026-11-14")).toBe(true);
    expect(d.summary("2026-11-14")).toBe(false);
    const again = new Deduper(file); // a restart
    expect(again.alarm(ev)).toBe(false);
    expect(again.alarm(alarm({ market: "ETH" }))).toBe(false);
    expect(again.release(rel({}))).toBe(false);
    expect(again.releasedOn("2026-11-14").map((r) => r.update)).toEqual([7]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("secrets and targets", () => {
  test("the test group by default, the staff group only with --staff; the same id for both is refused; missing keys refused", () => {
    const s = secretsFrom(parseEnv(`ALERT_BOT_TOKEN=${FAKE_TOKEN}\nOPS_CHAT_ID=-100111\nTEST_CHAT_ID="-100222"\n# comment\n`));
    expect(chatFor(s, false)).toBe("-100222");
    expect(chatFor(s, true)).toBe("-100111");
    expect(() => secretsFrom({ ALERT_BOT_TOKEN: FAKE_TOKEN, OPS_CHAT_ID: "-1", TEST_CHAT_ID: "-1" })).toThrow("refusing to start");
    expect(() => secretsFrom({ OPS_CHAT_ID: "-1", TEST_CHAT_ID: "-2" })).toThrow("ALERT_BOT_TOKEN is missing");
    expect(() => parseArgs(["--follow", "a.log", "--staff"])).toThrow("alarms never go to the staff group");
    expect(parseArgs(["--follow", "a.log", "--board", "--launch-at", "2026-12-01T14:00:00Z"]).launchAt?.toISOString()).toBe("2026-12-01T14:00:00.000Z");
    expect(parseArgs(["--follow", "a.log"]).board).toBe(false);
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
  test("follows files, posts each change once to the chosen chat, ignores other lines; dry run sends nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alert-bot-run-"));
    const mon = join(dir, "risk-monitor.log");
    const rels = join(dir, "releases.log");
    writeFileSync(mon, "");
    writeFileSync(rels, "");
    const sent: { chat: string; text: string }[] = [];
    let ticks = 0;
    const o = { ...parseArgs(["--follow", mon, "--follow", rels, "--summary-utc", "23:59"]), stateFile: join(dir, "s.json") };
    appendFileSync(mon, JSON.stringify({ t: "x", level: "info", msg: "started" }) + "\n"); // not an alarm
    appendFileSync(mon, JSON.stringify(alarm({})) + "\n" + JSON.stringify(alarm({})) + "\n");
    appendFileSync(rels, JSON.stringify(rel({})) + "\n");
    await run({ ...o, fromStart: true }, async (chat, text) => void sent.push({ chat, text }), { test: "-100222", staff: "-100111" }, () => ++ticks > 2, 10);
    // the alarm to the test group only; the release alert to the staff group, then a copy to the test group
    expect(sent.map((s) => `${s.chat} ${s.text.split("\n")[0]}`)).toEqual(["-100222 🔴 ALERT · COVERAGE_BREACHED", "-100111 ✅ SHIPPED AND RELEASED · Update 07", "-100222 ✅ SHIPPED AND RELEASED · Update 07"]);
    // dry run: nothing reaches the sender
    const dry: string[] = [];
    let t2 = 0;
    await run({ ...o, fromStart: true, dryRun: true, stateFile: join(dir, "s2.json") }, async (_c, text) => void dry.push(text), { test: "-100222", staff: "-100111" }, () => ++t2 > 1, 10);
    expect(dry).toEqual([]);
    expect(postFor("not json", new Deduper(null), {})).toBeNull();
    // DUST_ABSORBED is never an alert: it is summed for the day's summary, once per line
    const dd = new Deduper(null);
    const dust = JSON.stringify({ t: "2026-11-14T10:00:00Z", ...alarm({ name: "DUST_ABSORBED", level: "warn", state: "event", values: { events: 2, usdc: 0.000002 } }) });
    expect(postFor(dust, dd, {})).toBeNull();
    expect(postFor(dust, dd, {})).toBeNull();
    expect(dd.dustOn("2026-11-14")).toEqual({ events: 2, usdc: 0.000002 });
    rmSync(dir, { recursive: true, force: true });
  });
});

import { checkPosts, TELEGRAM_LIMIT } from "../src/post.ts";
import { readFileSync, readdirSync } from "node:fs";

describe("prepared posts", () => {
  test("every prepared post fits Telegram's limit (emoji count twice); an empty or oversized post is refused before sending", () => {
    const dir = join(import.meta.dir, "../posts");
    const texts = readdirSync(dir).sort().map((f) => readFileSync(join(dir, f), "utf8").replace(/\n+$/, ""));
    expect(texts.length).toBe(5);
    expect(() => checkPosts(texts)).not.toThrow();
    expect("🟡".length).toBe(2);
    expect(() => checkPosts(["x".repeat(TELEGRAM_LIMIT + 1)])).toThrow("over Telegram");
    expect(() => checkPosts(["  "])).toThrow("empty");
    for (const t of texts) expect(wordingWarnings(t)).toEqual([]);
  });
});

import { bar, renderBoard, renderSchedule } from "../src/board.ts";
import { answerCommands, keepBoard } from "../src/main.ts";
import { wordingWarnings } from "../src/post.ts";

describe("the launch board", () => {
  const L = new Date("2026-12-01T14:00:00Z");
  test("before launch: the launch time or 'not set'; after: Live N / 62 with a 12-cell bar, the next update, held", () => {
    expect(renderBoard({ launchAt: null, now: new Date("2026-11-20T10:00:00Z"), released: [], held: [] })).toBe(
      "TOURBILLON LAUNCH live\nLaunch time not set\nNext Update 01 · time not set\nHeld none",
    );
    expect(renderBoard({ launchAt: L, now: new Date("2026-12-01T10:40:00Z"), released: [], held: [] })).toBe(
      "TOURBILLON LAUNCH live\nLaunch 14:00 UTC · 1 Dec · in 3h 20m\nNext Update 01 · 14:00 UTC · in 3h 20m\nHeld none", // Update 01 at the launch moment
    );
    expect(renderBoard({ launchAt: L, now: new Date("2026-12-01T20:47:00Z"), released: [1, 2, 3, 4, 6, 7], held: [5] })).toBe(
      "TOURBILLON LAUNCH live\nLive 6 / 62  ▰▱▱▱▱▱▱▱▱▱▱▱\nNext Update 08 · 21:00 UTC · in 13 min\nHeld 05", // launch + 7 h
    );
    expect(bar(0)).toBe("▱".repeat(12));
    expect(bar(31)).toBe("▰".repeat(6) + "▱".repeat(6));
    expect(bar(62)).toBe("▰".repeat(12));
    const all = Array.from({ length: 62 }, (_, i) => i + 1);
    expect(renderBoard({ launchAt: L, now: new Date("2026-12-04T05:00:00Z"), released: all, held: [] }).split("\n")[2]).toBe("Next Update none · all shipped");
  });

  test("/schedule: UTC, Moscow and New York, within one message", () => {
    const sch = renderSchedule({ launchAt: L, now: new Date("2026-12-01T10:00:00Z"), released: [], held: [] });
    expect(sch.split("\n")[2]).toBe("Launch · 1 Dec 14:00 UTC · 1 Dec 17:00 Moscow · 1 Dec 09:00 New York");
    expect(sch).toContain("Update 01 · 1 Dec 14:00 UTC");
    expect(sch).toContain("Update 62 · 4 Dec 03:00 UTC"); // launch + 61 h
    expect(sch.length).toBeLessThan(4096);
    expect(renderSchedule({ launchAt: null, now: L, released: [], held: [] })).toContain("Launch time not set");
  });

  test("posted and pinned once in the staff group, then edited only when the text changes", async () => {
    const calls: string[] = [];
    const tg = { send: async (c: string) => (calls.push(`send ${c}`), 42), pin: async (c: string, id: number) => void calls.push(`pin ${c} ${id}`), edit: async (c: string, id: number) => void calls.push(`edit ${c} ${id}`) };
    const d = new Deduper(null);
    const o = { ...parseArgs(["--follow", "x", "--board"]) };
    await keepBoard(o, tg, "-100staff", d, new Date("2026-11-20T10:00:00Z"));
    await keepBoard(o, tg, "-100staff", d, new Date("2026-11-20T10:05:00Z")); // same text: nothing
    d.release(rel({ status: "held", update: 1 }));
    await keepBoard(o, tg, "-100staff", d, new Date("2026-11-20T10:06:00Z"));
    expect(calls).toEqual(["send -100staff", "pin -100staff 42", "edit -100staff 42"]);
  });

  test("/schedule answered in the chat that asked, only from the staff and test groups", async () => {
    const sent: string[] = [];
    const tg = {
      send: async (c: string) => void sent.push(c),
      updates: async () => [
        { update_id: 1, message: { chat: { id: -100111 }, text: "/schedule" } },
        { update_id: 2, message: { chat: { id: -100222 }, text: "/schedule@tourbillonalertbot" } },
        { update_id: 3, message: { chat: { id: -999 }, text: "/schedule" } },
        { update_id: 4, message: { chat: { id: -100111 }, text: "hello" } },
      ],
    };
    const d = new Deduper(null);
    expect(await answerCommands(parseArgs(["--follow", "x", "--board"]), tg, ["-100111", "-100222"], d)).toBe(2);
    expect(sent).toEqual(["-100111", "-100222"]);
    expect(d.updateOffset).toBe(5);
  });
});

describe("routing", () => {
  test("alarms and information posts go to the test group only; release alerts to the staff group with a test copy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alert-bot-route-"));
    const mon = join(dir, "m.log");
    writeFileSync(mon, JSON.stringify(alarm({})) + "\n" + JSON.stringify(alarm({ name: "TIMELOCK_EXECUTED", state: "event", values: { tx: "0x9" } })) + "\n" + JSON.stringify(rel({})) + "\n");
    const toChats: string[] = [];
    const staffCalls: string[] = [];
    const tg = { send: async (c: string, t: string) => (staffCalls.push(`${c}:${t.split("\n")[0]}`), 7), edit: async () => {}, pin: async () => {}, updates: async () => [] };
    let ticks = 0;
    const o = { ...parseArgs(["--follow", mon, "--board", "--summary-utc", "23:59"]), fromStart: true, stateFile: join(dir, "s.json") };
    await run(o, async (c) => void toChats.push(c), { test: "-100test", staff: "-100staff" }, () => ++ticks > 1, 5, { tg: tg as never });
    expect(toChats).toEqual(["-100test", "-100test", "-100staff", "-100test"]); // alarm, information post, release (staff, then copy)
    expect(staffCalls).toEqual(["-100staff:TOURBILLON LAUNCH live"]); // the board (through the Telegram client)
    rmSync(dir, { recursive: true, force: true });
  });

  test("announcement wording warnings (Overview section 9)", () => {
    expect(wordingWarnings("Launch is on Monday. NAV and funding received are on the board.")).toEqual([]);
    expect(wordingWarnings("Earn 12% APY, risk-free!").length).toBe(3); // income, return and risk-free
    expect(wordingWarnings("the official partner")).toEqual(['"official" or affiliation wording about Hyperliquid, Kinetiq or a venue']);
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
    expect(await announce("Launch on Monday. Earn 12% APY", true, secrets, t.io)).toBe("sent");
    expect(t.out[0]).toContain("this goes to the Alert Test group exactly as written");
    expect(t.out.some((l) => l.startsWith("warning:"))).toBe(true); // the wording check runs on a test post too
    expect(t.asked).toEqual(['Type "post" to send it to the Alert Test group, anything else to cancel: ']);
    expect(t.sent).toEqual(["-100test:Launch on Monday. Earn 12% APY"]);
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

describe("the daily posts", () => {
  test("Shipped today to the staff group on a day with release lines; the rounding note to the test group on a day with some", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alert-bot-daily-"));
    const mon = join(dir, "m.log");
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(
      mon,
      [
        JSON.stringify({ t: `${today}T01:00:00Z`, ...alarm({ name: "DUST_ABSORBED", level: "warn", state: "event", values: { events: 2, usdc: 0.000002 } }) }),
        JSON.stringify(rel({ at: `${today}T02:00:00Z` })),
      ].join("\n") + "\n",
    );
    const sent: string[] = [];
    let ticks = 0;
    const o = { ...parseArgs(["--follow", mon, "--summary-utc", "00:00"]), fromStart: true, stateFile: join(dir, "s.json") };
    await run(o, async (c, t) => void sent.push(`${c} ${t.split("\n")[0]}`), { test: "-100test", staff: "-100staff" }, () => ++ticks > 2, 5);
    expect(sent).toEqual([
      "-100staff ✅ SHIPPED AND RELEASED · Update 07",
      "-100test ✅ SHIPPED AND RELEASED · Update 07",
      `-100staff Shipped today · ${today} (UTC)`,
      `-100test Buyback rounding · ${today} (UTC)`,
    ]);
    // before launch (no release lines, no rounding): nothing daily at all
    const quiet: string[] = [];
    let t2 = 0;
    const empty = join(dir, "empty.log");
    writeFileSync(empty, "");
    await run({ ...o, follow: [empty], stateFile: join(dir, "s2.json") }, async (c, t) => void quiet.push(`${c} ${t}`), { test: "-100test", staff: "-100staff" }, () => ++t2 > 2, 5);
    expect(quiet).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("release delayed", () => {
  test("live on the system, public release retrying: one RELEASE DELAYED, then the normal SHIPPED AND RELEASED; the board counts it live, not held", () => {
    const d = new Deduper(null);
    const delayed = rel({ status: "delayed", what: "Deployed and checked: live on the system. The public copy and the GitHub release failed and are retrying.", who: "release owner: watch the retries", next: "SHIPPED AND RELEASED follows when the public release succeeds.", link: undefined });
    expect(formatRelease(delayed)).toBe(
      "🟡 RELEASE DELAYED · Update 07\n\nGET /v1/pool: NAV and coverage\n\nWhat happened: Deployed and checked: live on the system. The public copy and the GitHub release failed and are retrying.\nWho acts: release owner: watch the retries\nNext step: SHIPPED AND RELEASED follows when the public release succeeds.",
    );
    expect(postFor(JSON.stringify(delayed), d, {})?.route).toBe("release");
    expect(postFor(JSON.stringify(delayed), d, {})).toBeNull(); // a retry writes it again: posted once
    expect(d.progress()).toEqual({ released: [7], held: [] }); // live, not held
    expect(d.releasedOn("2026-11-14")).toEqual([]); // not in Shipped today yet
    const done = postFor(JSON.stringify(rel({})), d, {});
    expect(done?.text.split("\n")[0]).toBe("✅ SHIPPED AND RELEASED · Update 07");
    expect(d.progress()).toEqual({ released: [7], held: [] });
    expect(d.releasedOn("2026-11-14").map((r) => r.update)).toEqual([7]);
  });
});
