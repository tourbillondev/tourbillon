import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bookProblems, loadBook, makeBook, type Config, type Update } from "../src/data.ts";
import { parseArgs, readEnv } from "../src/main.ts";
import { boardText, launchText, shippedTodayText, statusText } from "../src/messages.ts";
import { ACK_MS, ALARM_REPEAT_MS, BOARD_POSTER_AFTER_MS, createTeambot, heartbeatFile, inboxDir, RELEASE_STOPPED } from "../src/runner.ts";
import { blankState, loadState } from "../src/state.ts";
import { telegramClient, type Tg, type TgUpdate } from "../src/telegram.ts";
import { inMins, slotTime } from "../src/time.ts";

const STAFF = -100;
const TEST = -200;
const TOTAL = 62;
const LAUNCH = Date.UTC(2026, 11, 1, 14, 0);
const H = 60 * 60_000;

type Sent = { m: string; chat: number; text: string; file?: string; id: number };

function fakeTg(o: { failAt?: number } = {}) {
  const sent: Sent[] = [];
  let id = 1000;
  let calls = 0;
  const push = (m: string, chat: number, text: string, file?: string) => {
    calls++;
    if (o.failAt !== undefined && calls === o.failAt) throw new Error("Telegram could not be reached (sendPhoto)");
    const s = { m, chat, text, file, id: ++id };
    sent.push(s);
    return s.id;
  };
  const queue: TgUpdate[] = [];
  const tg: Tg = {
    send: async (chat, text) => push("send", chat, text),
    photo: async (chat, file, caption) => push("photo", chat, caption, file),
    document: async (chat, name, data, caption) => {
      expect(data[0]).toBe(0x50); // a zip: "PK"
      return push("document", chat, caption, name);
    },
    edit: async (chat, mid, text) => void sent.push({ m: "edit", chat, text, id: mid }),
    pin: async (chat, mid) => void sent.push({ m: "pin", chat, text: "", id: mid }),
    me: async () => "TourbillonAlertsBot",
    setCommands: async () => {},
    updates: async () => queue.splice(0),
    copy: async (chat, from, mid) => void sent.push({ m: "copy", chat, text: `${from}`, id: mid }),
  };
  return { tg, sent, queue };
}

const updates: Update[] = Array.from({ length: TOTAL }, (_, i) => ({
  n: i + 1,
  type: i % 2 ? "HOW" : "NEW",
  title: `Title ${i + 1}`,
  status: "planned",
  changelog: "",
  changelog_line: "",
  telegram: `Telegram text ${i + 1}`,
  x: `X text ${i + 1}`,
}));
const cfg: Config = {
  repo: "tourbillondev/tourbillon",
  explorer: "https://explorer.example",
  settlementSymbol: "USDG",
  contracts: [{ name: "MainspringPool", address: `0x${"1".repeat(40)}` }],
  socials: [{ name: "X", url: "https://x.example/tourbillon" }],
  videos: [{ title: "Buy a call", messageId: 7 }],
  health: [{ name: "api", url: "http://127.0.0.1:1/healthz" }],
};

let dir: string;
let t: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "teambot-"));
  for (const shape of ["square", "wide"]) {
    mkdirSync(join(dir, "posters", shape), { recursive: true });
    for (let n = 1; n <= TOTAL; n++) writeFileSync(join(dir, "posters", shape, `update-${String(n).padStart(2, "0")}-${shape}.png`), new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]));
  }
  mkdirSync(join(dir, "posters", "board"), { recursive: true });
  writeFileSync(join(dir, "posters", "launch.png"), new Uint8Array([0x89, 1]));
  writeFileSync(join(dir, "updates.json"), JSON.stringify(updates));
  writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));
  t = LAUNCH - 2 * H;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let seq = 0;
function notice(body: Record<string, unknown>, id = `r${++seq}-${String(body.type)}`) {
  mkdirSync(inboxDir(dir), { recursive: true });
  writeFileSync(join(inboxDir(dir), `${String(++seq).padStart(15, "0")}-${id}.json`), JSON.stringify({ id, kind: "notice", ...body }));
}

function bot(o: { failAt?: number; dryRun?: boolean; releaseHeartbeat?: string; dustLog?: string } = {}) {
  const f = fakeTg(o);
  const b = createTeambot({ book: loadBook(dir), tg: f.tg, chat: STAFF, testChat: TEST, now: () => t, log: () => {}, dryRun: o.dryRun, releaseHeartbeat: o.releaseHeartbeat, dustLog: o.dustLog, sleep: async () => {} });
  return { b, ...f };
}
const msg = (chat: number, text: string, extra: Record<string, unknown> = {}): TgUpdate => ({ update_id: ++seq, message: { message_id: ++seq, chat: { id: chat }, from: { is_bot: false }, text, ...extra } });

describe("notices from the release system", () => {
  test("released: the hourly set in order, then the status line, in the staff group only", async () => {
    const { b, sent } = bot();
    notice({ type: "armed", at: new Date(LAUNCH).toISOString(), changed: false });
    await b.inboxTick();
    sent.length = 0;
    t = LAUNCH + H;
    notice({ type: "released", n: 1, what: "Deployed and checked.", next: "Update 02 at 16:00 UTC.", link: "https://github.com/tourbillondev/tourbillon/releases/tag/update-01" });
    await b.inboxTick();
    expect(sent.map((s) => s.m)).toEqual(["send", "photo", "document", "photo", "document", "send"]);
    expect(sent.every((s) => s.chat === STAFF)).toBe(true);
    expect(sent[0]!.text).toBe("<b>Tech Updates: Update 01 Released</b>");
    expect(sent[1]!.text).toBe(`Update 01 of ${TOTAL}\n\nTelegram text 1\n\nGitHub: https://github.com/tourbillondev/tourbillon/releases/tag/update-01`);
    expect(sent[1]!.file).toEndWith("update-01-square.png");
    expect(sent[2]!.file).toBe("tourbillon-update-01-square.zip");
    expect(sent[3]!.text).toBe("For X · 19 characters\n\nUpdate 01: X text 1");
    expect(sent[4]!.file).toBe("tourbillon-update-01-wide.zip");
    expect(sent[5]!.text).toStartWith("✅ SHIPPED AND RELEASED · Update 01 · release update-01\n\nTitle 1\n\nDeployed and checked.\nNext: Update 02 at 16:00 UTC.");
    expect(b.st.u[1]!.outcome).toBe("released");
    expect(existsSync(join(inboxDir(dir), "x"))).toBe(false);
  });

  test("a notice written twice is posted once; a restart does not repeat it", async () => {
    const { b, sent } = bot();
    notice({ type: "released", n: 2, what: "w", next: "n" }, "r9-released-02");
    await b.inboxTick();
    notice({ type: "released", n: 2, what: "w", next: "n" }, "r9-released-02");
    await b.inboxTick();
    expect(sent.length).toBe(6);
    const again = bot();
    notice({ type: "released", n: 2, what: "w", next: "n" }, "r9-released-02");
    await again.b.inboxTick();
    expect(again.sent.length).toBe(0);
  });

  test("a failure part way resumes with the rest, once each, in order", async () => {
    const first = bot({ failAt: 4 }); // the wide poster fails
    notice({ type: "released", n: 3, what: "w", next: "n" });
    await first.b.inboxTick();
    expect(first.sent.map((s) => s.m)).toEqual(["send", "photo", "document"]);
    expect(readFileSync(join(inboxDir(dir), (require("node:fs").readdirSync(inboxDir(dir)) as string[])[0]!), "utf8")).toContain("released"); // kept for the retry
    const second = bot(); // a restart
    await second.b.inboxTick();
    expect(second.sent.map((s) => s.m)).toEqual(["photo", "document", "send"]);
    expect(second.sent[0]!.file).toEndWith("update-03-wide.png");
  });

  test("held, delayed and rolled back post only their status line; delayed then released gives the full set", async () => {
    const { b, sent } = bot();
    notice({ type: "held", n: 5, what: "Tests failed.", next: "Update 06 keeps its time." });
    notice({ type: "rolled_back", n: 6, what: "Live check failed.", next: "Fixed and released again." });
    notice({ type: "delayed", n: 7, what: "GitHub is slow.", next: "SHIPPED AND RELEASED follows when it goes through." });
    await b.inboxTick();
    expect(sent.map((s) => s.text.split("\n")[0])).toEqual(["🟡 HELD · Update 05 · release update-05", "🔴 ROLLED BACK · Update 06 · release update-06", "🟡 RELEASE DELAYED · Update 07 · release update-07"]);
    notice({ type: "released", n: 7, what: "w", next: "n" });
    await b.inboxTick();
    expect(sent.length).toBe(9);
    expect(sent.at(-1)!.text).toStartWith("✅ SHIPPED AND RELEASED · Update 07");
  });

  test("test: the full set to Alert Test only, marked TEST, and nothing changes state", async () => {
    const { b, sent } = bot();
    notice({ type: "test", n: 4, what: "A test of the full set.", next: "Nothing: this was a test." });
    await b.inboxTick();
    expect(sent.length).toBe(6);
    expect(sent.every((s) => s.chat === TEST)).toBe(true);
    expect(sent[0]!.text).toStartWith("TEST · ");
    expect(sent[5]!.text).toStartWith("TEST · ✅ SHIPPED AND RELEASED · Update 04");
    expect(b.st.u[4]).toBeUndefined();
  });

  test("a dry run posts everything to Alert Test, marked DRY RUN, never the staff group", async () => {
    const { b, sent } = bot({ dryRun: true });
    notice({ type: "released", n: 1, what: "w", next: "n" });
    await b.inboxTick();
    await b.boardTick(true);
    expect(sent.length).toBeGreaterThan(6);
    expect(sent.every((s) => s.chat === TEST)).toBe(true);
    expect(sent.filter((s) => s.m !== "pin" && s.m !== "document").every((s) => s.text.startsWith("DRY RUN · "))).toBe(true);
  });

  test("armed posts the armed message and each day's schedule; launch goes once, with its poster, only when armed", async () => {
    const { b, sent } = bot();
    notice({ type: "launch" });
    await b.inboxTick();
    expect(sent.length).toBe(0); // not armed: nothing
    notice({ type: "armed", at: new Date(LAUNCH).toISOString(), changed: false });
    await b.inboxTick();
    expect(sent[0]!.text).toStartWith("🟢 <b>SCHEDULE ARMED</b>");
    expect(sent[0]!.text).toContain("14:00 UTC · 17:00 Moscow · 9:00 AM New York");
    expect(sent.slice(1).map((s) => s.text.split("\n")[0])).toEqual(["<b>Day 1 · from Tue, 1 Dec</b>", "<b>Day 2 · from Wed, 2 Dec</b>", "<b>Day 3 · from Thu, 3 Dec</b>"]);
    sent.length = 0;
    t = LAUNCH;
    notice({ type: "launch" });
    notice({ type: "launch" }, "launch-again");
    await b.inboxTick();
    expect(sent.length).toBe(1);
    expect(sent[0]!.m).toBe("photo");
    expect(sent[0]!.file).toEndWith("launch.png");
    expect(sent[0]!.text).toStartWith("🟢 <b>TOURBILLON IS LIVE</b>");
  });

  test("ALL N UPDATES ARE LIVE after the last, once", async () => {
    const { b, sent } = bot();
    for (let n = 1; n <= TOTAL; n++) b.st.u[n] = n < TOTAL ? { outcome: "released", at: new Date(t).toISOString() } : {};
    notice({ type: "released", n: TOTAL, what: "w", next: "n" });
    await b.inboxTick();
    expect(sent.at(-1)!.text).toStartWith(`🏁 <b>ALL ${TOTAL} UPDATES ARE LIVE</b>`);
    expect(b.st.finishedPosted).toBe(true);
  });

  test("paused, resumed, disarmed and preflight messages", async () => {
    const { b, sent } = bot();
    notice({ type: "paused", reason: "a planned check" });
    notice({ type: "resumed", overdue: 2 });
    notice({ type: "preflight", bad: [[14, ["poster missing."]]], total: TOTAL });
    notice({ type: "disarmed" });
    await b.inboxTick();
    expect(sent[0]!.text).toContain("Updates were paused from the server: a planned check.");
    expect(sent[1]!.text).toContain("2 overdue updates go out first, 2 minutes apart, then the normal times.");
    expect(sent[2]!.text).toBe(`🟡 <b>PREFLIGHT · 61 of ${TOTAL} ready</b>\n\n<b>14</b> poster missing.\n\n<i>Each one is held at its hour unless fixed.</i>`);
    expect(sent[3]!.text).toContain("SCHEDULE CANCELLED");
  });

  test("an unreadable notice is removed and the rest still post", async () => {
    const { b, sent } = bot();
    mkdirSync(inboxDir(dir), { recursive: true });
    writeFileSync(join(inboxDir(dir), "000000000000000-bad.json"), "{ not json");
    notice({ type: "held", n: 9, what: "w", next: "n" });
    await b.inboxTick();
    expect(sent.length).toBe(1);
  });
});

describe("release emergencies", () => {
  const raise = () => notice({ type: "alarm", alarm: { name: "update-gate-failed", what: "Update 14: tests failed.", who: "Dev fixes the folder.", n: 14, postAt: new Date(LAUNCH + 14 * H).toISOString() } });

  test("raised at once in Alert Test, repeated every 2 minutes with how long it is open, never in the staff group", async () => {
    const { b, sent } = bot();
    raise();
    await b.inboxTick();
    expect(sent.length).toBe(1);
    expect(sent[0]!.chat).toBe(TEST);
    expect(sent[0]!.text).toStartWith("🔴 ALERT · update-gate-failed\n\nWhat happened: Update 14: tests failed (Update 14, posting at");
    expect(sent[0]!.text).toEndWith("/ack pauses this alarm for 15 minutes.");
    t += ALARM_REPEAT_MS - 1;
    await b.alarmTick();
    expect(sent.length).toBe(1);
    t += 1;
    await b.alarmTick();
    expect(sent.length).toBe(2);
    expect(sent[1]!.text).toContain("Still open after 2m.");
  });

  test("/ack as a reply pauses it for 15 minutes; then it repeats again", async () => {
    const { b, sent } = bot();
    raise();
    await b.inboxTick();
    await b.handle(msg(TEST, "/ack", { reply_to_message: { message_id: sent[0]!.id, chat: { id: TEST } } }));
    expect(sent[1]!.text).toStartWith("Paused for 15 minutes: update-gate-failed.");
    t += ACK_MS - 1;
    await b.alarmTick();
    expect(sent.length).toBe(2);
    t += ALARM_REPEAT_MS + 1;
    await b.alarmTick();
    expect(sent.length).toBe(3);
  });

  test("/ack in the staff group does nothing; /ack with two open asks which", async () => {
    const { b, sent } = bot();
    raise();
    notice({ type: "alarm", alarm: { name: "deploy-main-failed", what: "x", who: "Dev." } });
    await b.inboxTick();
    await b.handle(msg(STAFF, "/ack"));
    expect(sent.length).toBe(2);
    await b.handle(msg(TEST, "/ack"));
    expect(sent[2]!.text).toStartWith("Which one? Send /ack update-gate-failed");
    await b.handle(msg(TEST, "/ack deploy-main-failed"));
    expect(b.st.alarms["deploy-main-failed"]!.ackUntil).toBe(t + ACK_MS);
  });

  test("one CLEARED line; a clear for something never raised is not sent", async () => {
    const { b, sent } = bot();
    notice({ type: "cleared", name: "never-raised", reason: "x" });
    raise();
    notice({ type: "cleared", name: "update-gate-failed", reason: "fixed and released" });
    notice({ type: "cleared", name: "update-gate-failed", reason: "fixed and released" }, "clear-twice");
    await b.inboxTick();
    expect(sent.map((s) => s.text.split("\n")[0])).toEqual(["🔴 ALERT · update-gate-failed", "🟢 CLEARED · update-gate-failed (fixed and released)"]);
    t += 10 * ALARM_REPEAT_MS;
    await b.alarmTick();
    expect(sent.length).toBe(2);
  });

  test("the same alarm raised again updates it without a second message", async () => {
    const { b, sent } = bot();
    raise();
    notice({ type: "alarm", alarm: { name: "update-gate-failed", what: "Update 14 is held.", who: "Dev." } }, "alarm-late");
    await b.inboxTick();
    expect(sent.length).toBe(1);
    expect(b.st.alarms["update-gate-failed"]!.what).toBe("Update 14 is held.");
  });
});

describe("heartbeats", () => {
  test("writes its own heartbeat every tick", async () => {
    const { b } = bot();
    await b.tick();
    expect(readFileSync(heartbeatFile(dir), "utf8")).toBe(new Date(t).toISOString());
  });

  test("a stale or missing release heartbeat raises release-system-stopped; a fresh one clears it", async () => {
    const hb = join(dir, "release-heartbeat");
    const { b, sent } = bot({ releaseHeartbeat: hb });
    await b.watchRelease();
    expect(sent[0]!.text).toStartWith(`🔴 ALERT · ${RELEASE_STOPPED}\n\nWhat happened: The release system has stopped: its heartbeat is missing.`);
    expect(sent[0]!.chat).toBe(TEST);
    writeFileSync(hb, "x");
    utimesSync(hb, new Date(t - 3 * 60_000), new Date(t - 3 * 60_000));
    await b.watchRelease();
    expect(sent.length).toBe(1); // still open: one message, the repeats come from the alarm tick
    utimesSync(hb, new Date(t), new Date(t));
    await b.watchRelease();
    expect(sent[1]!.text).toBe(`🟢 CLEARED · ${RELEASE_STOPPED} (the release system is running again)`);
  });
});

describe("the board, the board poster and Shipped today", () => {
  test("posted and pinned once, then edited in place; refreshed only on change or after 5 minutes", async () => {
    const { b, sent } = bot();
    await b.boardTick(true);
    expect(sent.map((s) => s.m)).toEqual(["send", "pin"]);
    expect(sent[0]!.text).toStartWith("<b>TOURBILLON LAUNCH live</b>");
    await b.boardTick();
    expect(sent.length).toBe(2);
    b.st.launchAt = new Date(LAUNCH).toISOString();
    await b.boardTick();
    expect(sent[2]!.m).toBe("edit");
    expect(sent[2]!.id).toBe(sent[0]!.id);
    expect(loadState(dir).board).toBe(sent[0]!.id);
  });

  test("the board's states", () => {
    const book = loadBook(dir);
    const st = blankState();
    expect(boardText(st, book, t)).toContain("Next    launch time not set");
    st.launchAt = new Date(LAUNCH).toISOString();
    st.u[1] = { outcome: "released", at: new Date(LAUNCH + H).toISOString() };
    st.u[2] = { outcome: "held" };
    const text = boardText(st, book, LAUNCH + H + 60_000);
    expect(text).toContain(` 1 / ${TOTAL}   ▱▱▱▱▱▱▱▱▱▱▱▱`);
    expect(text).toContain("Next    Update 03 · New");
    expect(text).toContain("Queue   ● running");
    expect(text).toContain("Held    02");
    expect(text).toContain("<b>Last:</b> Update 01 · Title 1");
  });

  test("the board poster goes 30 minutes after a release, only the latest, as text when an update is held", async () => {
    const { b, sent } = bot();
    writeFileSync(join(dir, "posters", "board", "board-02.png"), new Uint8Array([1]));
    b.st.launchAt = new Date(LAUNCH).toISOString();
    notice({ type: "released", n: 1, what: "w", next: "n" });
    await b.inboxTick();
    t += 10 * 60_000;
    notice({ type: "released", n: 2, what: "w", next: "n" });
    await b.inboxTick();
    sent.length = 0;
    t += BOARD_POSTER_AFTER_MS - 1;
    await b.boardPosterTick();
    expect(sent.length).toBe(0);
    t += 1;
    await b.boardPosterTick();
    expect(sent.length).toBe(1);
    expect(sent[0]!.m).toBe("photo");
    expect(sent[0]!.file).toEndWith("board-02.png");
    await b.boardPosterTick();
    expect(sent.length).toBe(1); // once
    notice({ type: "held", n: 4, what: "w", next: "n" });
    notice({ type: "released", n: 3, what: "w", next: "n" });
    await b.inboxTick();
    sent.length = 0;
    t += BOARD_POSTER_AFTER_MS;
    await b.boardPosterTick();
    expect(sent[0]!.m).toBe("send"); // a held update: the board as text
  });

  test("Shipped today at 23:55 UTC, once, only on days with releases, with the proof links and the buyback rounding", async () => {
    const dust = join(dir, "risk.log");
    const day = Date.UTC(2026, 11, 1);
    writeFileSync(dust, `${JSON.stringify({ name: "dust-absorbed", t: new Date(day + 3 * H).toISOString(), values: { events: 2, amount: 0.000002, symbol: "USDG" } })}\nnot json\n`);
    const { b, sent } = bot({ dustLog: dust });
    t = day + 23 * H + 54 * 60_000;
    b.dustTick();
    await b.shippedTick();
    expect(sent.length).toBe(0); // no release that day
    b.st.u[1] = { outcome: "released", at: new Date(day + 15 * H).toISOString(), link: "https://github.com/tourbillondev/tourbillon/releases/tag/update-01" };
    await b.shippedTick();
    expect(sent.length).toBe(0); // 23:54
    t += 60_000;
    await b.shippedTick();
    await b.shippedTick();
    expect(sent.length).toBe(1);
    expect(sent[0]!.text).toBe(
      "Shipped today · 2026-12-01 (UTC)\n23:55 UTC · 02:55 Moscow · 18:55 New York\n\n1 update released:\n• Update 01 · Title 1 · https://github.com/tourbillondev/tourbillon/releases/tag/update-01\n\nBuyback rounding: the pool absorbed 2 events, 0.000002 USDG (at most one smallest unit per source).",
    );
  });
});

describe("staff commands", () => {
  test("answered in the staff group only, from people, our own commands only, the same one twice in 5 seconds once", async () => {
    const { b, sent } = bot();
    await b.setup();
    await b.handle(msg(STAFF, "/next"));
    expect(sent[0]!.text).toBe("The launch time is not set yet.");
    await b.handle(msg(STAFF, "/next"));
    expect(sent.length).toBe(1);
    await b.handle(msg(-300, "/status"));
    await b.handle(msg(STAFF, "/status@OtherBot"));
    await b.handle({ update_id: ++seq, message: { message_id: 1, chat: { id: STAFF }, from: { is_bot: true }, text: "/status" } });
    await b.handle(msg(STAFF, "hello"));
    await b.handle(msg(STAFF, "/unknown"));
    expect(sent.length).toBe(1);
    await b.handle(msg(STAFF, "/status@TourbillonAlertsBot"));
    expect(sent[1]!.text).toStartWith("<b>TOURBILLON LAUNCH live</b>");
  });

  test("/poster only for a released update; /contracts, /videos and /video", async () => {
    const { b, sent } = bot();
    await b.handle(msg(STAFF, "/poster 14"));
    expect(sent[0]!.text).toBe("Update 14 is not live yet. Its posters are shared here at its hour.");
    b.st.u[14] = { outcome: "released", at: new Date(t).toISOString() };
    t += 6000;
    await b.handle(msg(STAFF, "/poster 14"));
    expect(sent.slice(1).map((s) => s.text)).toEqual(["Update 14 · square, for Telegram and Instagram", "Update 14 · wide, for X"]);
    await b.handle(msg(STAFF, "/contracts"));
    expect(sent.at(-1)!.text).toContain("<b>Tourbillon contracts</b>\nRobinhood Chain mainnet, chain 4663");
    await b.handle(msg(STAFF, "/videos"));
    expect(sent.at(-1)!.text).toContain("Desktop, on testnet with test USDG");
    await b.handle(msg(STAFF, "/video 1"));
    expect(sent.at(-1)!.m).toBe("copy");
    await b.handle(msg(STAFF, "/video 9"));
    expect(sent.at(-1)!.text).toBe("Send it with a number from 1 to 1, like /video 3.");
  });

  test("a reply to one of our messages gets the command list, once per 30 seconds per message", async () => {
    const { b, sent } = bot();
    await b.setup();
    const ours = { message_id: 55, chat: { id: STAFF }, from: { is_bot: true, username: "TourbillonAlertsBot" } };
    await b.handle(msg(STAFF, "what?", { reply_to_message: ours }));
    await b.handle(msg(STAFF, "and?", { reply_to_message: ours }));
    expect(sent.length).toBe(1);
    expect(sent[0]!.text).toStartWith("I answer commands only:");
    await b.handle(msg(STAFF, "x", { reply_to_message: { ...ours, message_id: 56, from: { is_bot: true, username: "Other" } } }));
    expect(sent.length).toBe(1);
  });
});

describe("start-up refusals and data", () => {
  test("the staff group and Alert Test must differ", () => {
    expect(() => createTeambot({ book: loadBook(dir), tg: fakeTg().tg, chat: STAFF, testChat: STAFF })).toThrow("the same chat");
  });

  test("a state file that cannot be read stops the bot", () => {
    writeFileSync(join(dir, "state.json"), "{ broken");
    expect(() => bot()).toThrow("could not be read");
  });

  test("updates.json and config.json are checked", () => {
    expect(bookProblems(updates, cfg)).toEqual([]);
    expect(bookProblems([{ ...updates[0], n: 2 }], cfg)[0]).toContain("entry 1 has n 2");
    expect(bookProblems(updates, { ...cfg, settlementSymbol: "" })[0]).toContain("settlementSymbol");
    expect(bookProblems(updates, { ...cfg, contracts: [{ name: "x", address: "0x1" }] })[0]).toContain("every contract");
    writeFileSync(join(dir, "config.json"), "nope");
    expect(() => loadBook(dir)).toThrow("not valid JSON");
  });

  test("the env file: mode 600, a bot token, two different group ids", () => {
    const p = join(dir, "alerts.env");
    const tok = `123456:${"a".repeat(30)}`;
    writeFileSync(p, `ALERT_BOT_TOKEN=${tok}\nOPS_CHAT_ID=-100\nTEST_CHAT_ID=-200\n`);
    chmodSync(p, 0o644);
    expect(() => readEnv(p)).toThrow("readable by others");
    chmodSync(p, 0o600);
    expect(readEnv(p)).toEqual({ token: tok, chat: -100, testChat: -200 });
    writeFileSync(p, `ALERT_BOT_TOKEN=${tok}\nOPS_CHAT_ID=-100\nTEST_CHAT_ID=-100\n`);
    expect(() => readEnv(p)).toThrow("the same");
    expect(() => parseArgs([])).toThrow("--data");
    expect(() => parseArgs(["--data"])).toThrow("needs a value");
    expect(parseArgs(["--data", dir, "--dry-run"]).dryRun).toBe(true);
    expect(() => parseArgs(["--data", dir, "--telegram-api", "http://127.0.0.1:18101"])).toThrow("only for a dry run");
    expect(() => parseArgs(["--data", dir, "--dry-run", "--telegram-api", "https://api.telegram.org"])).toThrow("only for a dry run");
    expect(parseArgs(["--data", dir, "--dry-run", "--telegram-api", "http://127.0.0.1:18101"]).telegramApi).toBe("http://127.0.0.1:18101");
  });

  test("times: update NN at launch + NN hours; in X", () => {
    expect(slotTime(new Date(LAUNCH).toISOString(), 1, H).getTime()).toBe(LAUNCH + H);
    expect(inMins(new Date(t + 25 * 60_000), t)).toBe("in 25 min");
    expect(inMins(new Date(t + 190 * 60_000), t)).toBe("in 3h 10m");
    expect(inMins(new Date(t + 52 * H), t)).toBe("in 2d 4h");
  });

  test("the launch text and status lines read the settlement symbol and stay under Telegram's caption limit", () => {
    const book = makeBook(dir, updates, cfg);
    const st = { ...blankState(), launchAt: new Date(LAUNCH).toISOString() };
    const text = launchText(st, book);
    expect(text).toContain("settled in USDG");
    expect(text.length).toBeLessThan(1024);
    expect(statusText("held", 5, "T", "w.", "n.")).toBe("🟡 HELD · Update 05 · release update-05\n\nT\n\nw.\nNext: n.");
    expect(shippedTodayText(st, book, "2026-12-01", LAUNCH)).toContain("No updates released today.");
  });
});

describe("the Telegram client", () => {
  const tok = `123456:${"b".repeat(30)}`;
  test("waits out 429 and tries again; errors never carry the token", async () => {
    const waits: number[] = [];
    let n = 0;
    const f = (async () => {
      n++;
      if (n === 1) return new Response(JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } }), { status: 429 });
      if (n === 2) return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }));
      return new Response(JSON.stringify({ ok: false, error_code: 400, description: `bad request ${tok}` }), { status: 400 });
    }) as unknown as typeof fetch;
    const tg = telegramClient(tok, { fetch: f, wait: async (ms) => void waits.push(ms) });
    expect(await tg.send(STAFF, "hi")).toBe(9);
    expect(waits).toEqual([4000]);
    const err = await tg.send(STAFF, "x").catch((e: Error) => e.message);
    expect(err).toContain("Telegram said 400");
    expect(err).not.toContain(tok);
  });

  test("a network failure is tried again, then reported without the request", async () => {
    const f = (async () => {
      throw new Error(`fetch failed https://api.telegram.org/bot${tok}/sendMessage`);
    }) as unknown as typeof fetch;
    const waits: number[] = [];
    const tg = telegramClient(tok, { fetch: f, wait: async (ms) => void waits.push(ms) });
    const err = await tg.send(STAFF, "x").catch((e: Error) => e.message);
    expect(err).toBe("Telegram could not be reached (sendMessage)");
    expect(waits).toEqual([2000, 4000, 6000]);
  });
});

describe("the poster zips", () => {
  test("each zip holds only its poster, byte for byte", async () => {
    const zips: { name: string; data: Uint8Array }[] = [];
    const f = fakeTg();
    f.tg.document = async (_c, name, data) => (zips.push({ name, data }), 1);
    const b = createTeambot({ book: loadBook(dir), tg: f.tg, chat: STAFF, testChat: TEST, now: () => t, log: () => {} });
    notice({ type: "released", n: 12, what: "w", next: "n" });
    await b.inboxTick();
    expect(zips.map((z) => z.name)).toEqual(["tourbillon-update-12-square.zip", "tourbillon-update-12-wide.zip"]);
    for (const [i, shape] of (["square", "wide"] as const).entries()) {
      const z = zips[i]!.data;
      const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
      expect(v.getUint32(0, true)).toBe(0x04034b50);
      expect(v.getUint16(8, true)).toBe(0); // stored, not recompressed
      const size = v.getUint32(18, true);
      const nameLen = v.getUint16(26, true);
      const name = new TextDecoder().decode(z.slice(30, 30 + nameLen));
      expect(name).toBe(`update-12-${shape}.png`);
      const body = z.slice(30 + nameLen, 30 + nameLen + size);
      expect(Buffer.from(body).equals(readFileSync(join(dir, "posters", shape, `update-12-${shape}.png`)))).toBe(true);
      const entries = [...Buffer.from(z).toString("latin1").matchAll(/PK\x01\x02/g)].length;
      expect(entries).toBe(1); // one file only
    }
  });
});
