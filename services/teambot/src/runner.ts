import fs from "node:fs";
import path from "node:path";
import { boardPoster, launchPoster, posterPath, roadmapPath, type Book } from "./data.ts";
import {
  ACK_NOTHING,
  ackText,
  ackWhich,
  alarmText,
  allLiveText,
  armedText,
  boardKey,
  boardText,
  changelogReply,
  clearedText,
  contractsText,
  currentDay,
  days,
  disarmedText,
  headingText,
  healthText,
  HELP,
  launchText,
  MENU,
  nextText,
  noDayText,
  NOT_SET,
  pausedText,
  posterCaption,
  posterNotLive,
  posterUsage,
  preflightText,
  REPLY_ONLY,
  resumedText,
  roadmapCaption,
  scheduleDay,
  shippedTodayText,
  socialsText,
  statusText,
  tgCopy,
  videosText,
  videoUsage,
  xCopy,
  zipCaption,
  zipName,
  type HealthRow,
} from "./messages.ts";
import { held, loadState, released, saveState, us, type Alarm, type State } from "./state.ts";
import type { Tg, TgMessage, TgUpdate } from "./telegram.ts";
import { utcDay } from "./time.ts";
import { storedZip } from "./zip.ts";

/// The team bot (playbook 06): the only poster of everything about the launch, in the staff group, and of every
/// release emergency, in Alert Test. It has no update clock of its own: it posts an update only when the release
/// system tells it, through notices in its inbox (services/release/src/notify.ts), and remembers every notice id, so
/// a notice written twice is posted once.
///   released        the hourly set (heading, square poster + Telegram text, its zip, wide poster + X text, its zip),
///                   then ✅ SHIPPED AND RELEASED; ALL N UPDATES ARE LIVE after the last; the board poster 30 minutes on
///   delayed / held / rolled_back      that status line only
///   launch          the launch announcement with the launch poster (once)
///   armed / disarmed / paused / resumed / preflight      the control messages (the day schedules after "armed")
///   test            the full set of update N to Alert Test only, marked TEST
///   alarm / cleared release emergencies: raised at once in Alert Test, repeated every 2 minutes with how long they have
///                   been open, /ack (a reply to the alarm, or /ack <name>) pauses one for 15 minutes; one CLEARED line
/// It also keeps the pinned board (edited in place, at least every 5 minutes), the daily "Shipped today" at 23:55 UTC
/// for that UTC day, the staff commands (staff group only), its own heartbeat file every tick, and watches the release
/// system's heartbeat (release-system-stopped). A dry run posts everything to Alert Test, marked DRY RUN.
/// state.json is saved after every post (each message id of a set too), so a restart neither repeats nor skips one.

export const TICK_MS = 10_000;
export const BOARD_REFRESH_MS = 5 * 60_000;
export const SAME_COMMAND_MS = 5_000;
export const SAME_REPLY_MS = 30_000;
export const ALARM_REPEAT_MS = 2 * 60_000;
export const ACK_MS = 15 * 60_000;
export const BOARD_POSTER_AFTER_MS = 30 * 60_000;
export const HEARTBEAT_STALE_MS = 2 * 60_000;
export const SHIPPED_AT = { h: 23, m: 55 }; // UTC
export const RELEASE_STOPPED = "release-system-stopped";
const KNOWN = new Set(["help", "start", "status", "next", "schedule", "poster", "changelog", "roadmap", "contracts", "socials", "videos", "video", "health"]);

export type Notice = { id: string; kind: "notice"; type: string; [k: string]: unknown };

export type TeambotDeps = {
  book: Book;
  tg: Tg;
  chat: number; // the staff group
  testChat: number; // Alert Test
  dryRun?: boolean; // everything to Alert Test, marked DRY RUN
  releaseHeartbeat?: string; // the release system's heartbeat file
  dustLog?: string; // the risk monitor's log (buyback rounding for Shipped today)
  now?: () => number;
  log?: (...a: unknown[]) => void;
  exists?: (p: string) => boolean;
  fetch?: typeof fetch; // for /health
  sleep?: (ms: number) => Promise<void>;
};

export const inboxDir = (dataDir: string) => path.join(dataDir, "inbox");
export const heartbeatFile = (dataDir: string) => path.join(dataDir, "heartbeat");

export function createTeambot(d: TeambotDeps) {
  const { book, tg } = d;
  if (d.chat === d.testChat) throw new Error("the staff group and Alert Test are the same chat: refusing to start (a test or an alarm could land in the staff group)");
  const now = d.now ?? Date.now;
  const log = d.log ?? ((...a: unknown[]) => console.log("[teambot]", ...a));
  const exists = d.exists ?? fs.existsSync;
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const dataDir = book.dataDir;
  const st: State = loadState(dataDir);
  const save = () => saveState(dataDir, st);
  const DRY = d.dryRun ? "DRY RUN · " : "";
  const staff = d.dryRun ? d.testChat : d.chat; // a dry run never posts in the staff group
  const sentence = (e: unknown) => {
    const m = e instanceof Error ? e.message : String(e);
    return m.endsWith(".") ? m : `${m}.`;
  };

  // ---------------- one post, once: each step's message id is saved before the next ----------------
  async function step(key: string, i: number, send: () => Promise<number>): Promise<void> {
    const p = (st.progress[key] ||= []);
    if (p[i] !== undefined) return;
    p[i] = await send();
    save();
  }

  async function hourlySet(key: string, n: number, chat: number, label: string): Promise<boolean> {
    const u = book.byN.get(n);
    if (!u) {
      log(`notice for update ${n}, which is not in updates.json: skipped`);
      return false;
    }
    const sq = posterPath(book, n, "square");
    const wide = posterPath(book, n, "wide");
    await step(key, 0, () => tg.send(chat, `${label}${headingText(n)}`));
    await step(key, 1, () => tg.photo(chat, sq, `${label}${tgCopy(book, u)}`));
    await step(key, 2, () => tg.document(chat, zipName(n, "square"), storedZip(path.basename(sq), fs.readFileSync(sq)), zipCaption(n, "square")));
    await step(key, 3, () => tg.photo(chat, wide, `${label}${xCopy(u)}`));
    await step(key, 4, () => tg.document(chat, zipName(n, "wide"), storedZip(path.basename(wide), fs.readFileSync(wide)), zipCaption(n, "wide")));
    return true;
  }

  // ---------------- release emergencies ----------------
  async function sendAlarm(a: Alarm): Promise<void> {
    const id = await tg.send(d.testChat, alarmText(a, now(), DRY));
    a.messageIds.push(id);
    a.lastSentAt = now();
    save();
  }

  async function raise(name: string, what: string, who: string, n?: number, postAt?: string): Promise<void> {
    const a = st.alarms[name];
    if (a) {
      Object.assign(a, { what, who, n, postAt }); // a newer report of the same alarm: the next repeat says it
      save();
      return;
    }
    const fresh: Alarm = { name, what, who, n, postAt, openedAt: now(), lastSentAt: 0, ackUntil: 0, messageIds: [] };
    st.alarms[name] = fresh;
    save();
    await sendAlarm(fresh);
  }

  async function clear(name: string, reason: string): Promise<void> {
    if (!st.alarms[name]) return; // a clear for something never raised here is not sent
    await tg.send(d.testChat, clearedText(name, reason, DRY));
    delete st.alarms[name];
    save();
  }

  async function alarmTick(): Promise<void> {
    for (const a of Object.values(st.alarms)) {
      if (now() < a.ackUntil) continue;
      if (now() - a.lastSentAt < ALARM_REPEAT_MS) continue;
      try {
        await sendAlarm(a);
      } catch (e) {
        log("could not repeat an alarm", a.name, sentence(e));
      }
    }
  }

  /// /ack in Alert Test: a reply to the alarm, /ack <name>, or /ack alone when one is open.
  async function ack(m: TgMessage, arg: string): Promise<void> {
    const open = Object.values(st.alarms);
    let a: Alarm | undefined;
    if (m.reply_to_message) a = open.find((x) => x.messageIds.includes(m.reply_to_message!.message_id));
    if (!a && arg) a = open.find((x) => x.name === arg.trim());
    if (!a && !arg && open.length === 1) a = open[0];
    if (!a) {
      await tg.send(d.testChat, open.length ? ackWhich(open.map((x) => x.name)) : ACK_NOTHING);
      return;
    }
    a.ackUntil = now() + ACK_MS;
    a.lastSentAt = now(); // the 2-minute repeats start again when the pause ends
    save();
    await tg.send(d.testChat, ackText(a.name));
  }

  // ---------------- notices from the release system ----------------
  async function handleNotice(nt: Notice): Promise<boolean> {
    const n = Number(nt.n);
    const key = nt.id;
    switch (nt.type) {
      case "launch": {
        if (st.launchPosted || !st.launchAt) return true;
        const poster = launchPoster(book);
        await step(key, 0, () => (exists(poster) ? tg.photo(staff, poster, `${DRY}${launchText(st, book)}`, true) : tg.send(staff, `${DRY}${launchText(st, book)}`)));
        st.launchPosted = true;
        save();
        return true;
      }
      case "armed": {
        const t = new Date(String(nt.at));
        if (Number.isNaN(t.getTime())) return true;
        st.launchAt = t.toISOString();
        save();
        await step(key, 0, () => tg.send(staff, `${DRY}${armedText(nt.changed === true, t, book)}`));
        for (let day = 1; day <= days(book); day++) await step(key, day, () => tg.send(staff, `${DRY}${scheduleDay(st, book, day)!}`));
        return true;
      }
      case "disarmed":
        st.launchAt = null;
        save();
        await step(key, 0, () => tg.send(staff, `${DRY}${disarmedText()}`));
        return true;
      case "paused":
        st.paused = { reason: String(nt.reason ?? "planned pause") };
        save();
        await step(key, 0, () => tg.send(staff, `${DRY}${pausedText(st.paused!.reason)}`));
        return true;
      case "resumed":
        st.paused = null;
        save();
        await step(key, 0, () => tg.send(staff, `${DRY}${resumedText(st, book, Number(nt.overdue ?? 0))}`));
        return true;
      case "preflight": {
        // the release system sends [n, reasons[]] pairs
        const bad = Array.isArray(nt.bad) ? (nt.bad as unknown[]).map((b) => (Array.isArray(b) ? { n: Number(b[0]), why: [b[1]].flat().join(" ") } : { n: Number((b as { n: number }).n), why: [(b as { why: unknown }).why].flat().join(" ") })) : [];
        await step(key, 0, () => tg.send(staff, `${DRY}${preflightText(bad, Number(nt.total ?? book.total))}`));
        return true;
      }
      case "released": {
        if (!(await hourlySet(key, n, staff, DRY))) return true;
        const s = us(st, n);
        const link = typeof nt.link === "string" ? nt.link : undefined;
        if (!s.statusSent?.released) {
          const id = await tg.send(staff, `${DRY}${statusText("released", n, book.byN.get(n)!.title, String(nt.what ?? ""), String(nt.next ?? ""), link)}`);
          Object.assign(s, { outcome: "released", at: new Date(now()).toISOString(), link, statusSent: { ...s.statusSent, released: id } });
          st.boardPoster = { due: now() + BOARD_POSTER_AFTER_MS, live: released(st, book).length }; // only the latest is kept
          save();
        }
        if (released(st, book).length === book.total && !st.finishedPosted) {
          await tg.send(staff, `${DRY}${allLiveText(book, now())}`);
          st.finishedPosted = true;
          save();
        }
        return true;
      }
      case "delayed":
      case "held":
      case "rolled_back": {
        const u = book.byN.get(n);
        if (!u) return true;
        const s = us(st, n);
        const kind = nt.type as "delayed" | "held" | "rolled_back";
        if (s.statusSent?.[kind] === undefined) {
          const id = await tg.send(staff, `${DRY}${statusText(kind, n, u.title, String(nt.what ?? ""), String(nt.next ?? ""))}`);
          Object.assign(s, { outcome: kind, statusSent: { ...s.statusSent, [kind]: id } });
          save();
        }
        return true;
      }
      case "test": {
        // the full set and its status line, to Alert Test only
        if (!(await hourlySet(key, n, d.testChat, "TEST · "))) return true;
        await step(key, 5, () => tg.send(d.testChat, `TEST · ${statusText("released", n, book.byN.get(n)!.title, String(nt.what ?? ""), String(nt.next ?? ""))}`));
        return true;
      }
      case "alarm": {
        const a = nt.alarm as { name?: string; what?: string; who?: string; n?: number; postAt?: string } | undefined;
        if (a?.name) await raise(a.name, a.what ?? "", a.who ?? "Dev checks.", a.n, a.postAt);
        return true;
      }
      case "cleared":
        if (typeof nt.name === "string") await clear(nt.name, String(nt.reason ?? "fixed"));
        return true;
      default:
        log(`unknown notice type ${String(nt.type)}: skipped`);
        return true;
    }
  }

  async function inboxTick(): Promise<void> {
    const dir = inboxDir(dataDir);
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
      const p = path.join(dir, f);
      let nt: Notice;
      try {
        nt = JSON.parse(fs.readFileSync(p, "utf8")) as Notice;
        if (typeof nt.id !== "string" || !/^[\w.-]{1,120}$/.test(nt.id) || typeof nt.type !== "string") throw new Error("bad");
      } catch {
        log(`unreadable notice ${f}: removed`);
        fs.rmSync(p, { force: true });
        continue;
      }
      if (!st.done.includes(nt.id)) {
        try {
          await handleNotice(nt);
        } catch (e) {
          log("posting failed; retried next tick", nt.id, sentence(e)); // never dropped: the file stays
          return; // keep the order: nothing after it is posted first
        }
        st.done.push(nt.id);
        if (st.done.length > 5000) st.done.splice(0, st.done.length - 5000);
        delete st.progress[nt.id];
        save();
      }
      fs.rmSync(p, { force: true });
    }
  }

  // ---------------- the board and its poster ----------------
  let lastBoard = { key: "", at: 0 };
  async function boardTick(force = false): Promise<void> {
    const text = `${DRY}${boardText(st, book, now())}`;
    const key = boardKey(text);
    if (!force && key === lastBoard.key && now() - lastBoard.at < BOARD_REFRESH_MS) return;
    try {
      if (st.board) {
        try {
          await tg.edit(staff, st.board, text);
        } catch (e) {
          const m = e instanceof Error ? e.message : "";
          if (/not modified/i.test(m)) {
            /* the same text */
          } else if (/not found|can't be edited|MESSAGE_ID_INVALID/i.test(m)) st.board = null;
          else throw e;
        }
      }
      if (!st.board) {
        st.board = await tg.send(staff, text);
        save();
        await tg.pin(staff, st.board).catch((e) => log('could not pin the board (make the bot an admin with "Pin messages"):', sentence(e)));
      }
      lastBoard = { key, at: now() };
    } catch (e) {
      log("board error", sentence(e));
    }
  }

  async function boardPosterTick(): Promise<void> {
    const bp = st.boardPoster;
    if (!bp || now() < bp.due) return;
    const text = `${DRY}${boardText(st, book, now())}`;
    const img = boardPoster(book, bp.live);
    try {
      if (held(st, book).length || !exists(img)) await tg.send(staff, text); // an update is held (or no image): the board as text
      else await tg.photo(staff, img, text, true);
      st.boardPoster = null;
      save();
    } catch (e) {
      bp.due = now() + ALARM_REPEAT_MS; // a failed send retries in 2 minutes
      save();
      log("board poster failed; retried in 2 minutes", sentence(e));
    }
  }

  // ---------------- Shipped today, 23:55 UTC ----------------
  async function shippedTick(): Promise<void> {
    const t = new Date(now());
    if (t.getUTCHours() !== SHIPPED_AT.h || t.getUTCMinutes() < SHIPPED_AT.m) return;
    const day = utcDay(now());
    if (st.shipped.includes(day)) return;
    const any = released(st, book).some((u) => utcDay(Date.parse(st.u[u.n]!.at ?? "0")) === day);
    if (!any) return; // nothing released that day: nothing posted
    try {
      await tg.send(staff, `${DRY}${shippedTodayText(st, book, day, now())}`);
      st.shipped.push(day);
      save();
    } catch (e) {
      log("Shipped today failed; retried next tick", sentence(e));
    }
  }

  /// Buyback rounding (the risk monitor's dust-absorbed lines), summed per UTC day for Shipped today.
  function dustTick(): void {
    if (!d.dustLog || !fs.existsSync(d.dustLog)) return;
    const size = fs.statSync(d.dustLog).size;
    if (size < st.dustOffset) st.dustOffset = 0; // the log was rotated
    if (size === st.dustOffset) return;
    const fd = fs.openSync(d.dustLog, "r");
    const buf = Buffer.alloc(size - st.dustOffset);
    fs.readSync(fd, buf, 0, buf.length, st.dustOffset);
    fs.closeSync(fd);
    const text = buf.toString("utf8");
    const end = text.lastIndexOf("\n") + 1; // whole lines only
    for (const line of text.slice(0, end).split("\n")) {
      try {
        const x = JSON.parse(line) as { name?: string; t?: string; values?: { events?: number; amount?: number; symbol?: string } };
        if (x.name !== "dust-absorbed") continue;
        const day = utcDay(x.t ? Date.parse(x.t) : now());
        const cur = st.dust[day] ?? { events: 0, amount: 0, symbol: x.values?.symbol ?? book.cfg.settlementSymbol };
        st.dust[day] = { events: cur.events + Number(x.values?.events ?? 0), amount: cur.amount + Number(x.values?.amount ?? 0), symbol: cur.symbol };
      } catch {
        /* not a JSON line */
      }
    }
    st.dustOffset += Buffer.byteLength(text.slice(0, end));
    save();
  }

  // ---------------- heartbeats ----------------
  function beat(): void {
    const f = heartbeatFile(dataDir);
    fs.writeFileSync(f, new Date(now()).toISOString(), { mode: 0o600 });
    fs.utimesSync(f, new Date(now()), new Date(now()));
  }

  async function watchRelease(): Promise<void> {
    if (!d.releaseHeartbeat) return;
    let age = Infinity;
    try {
      age = now() - fs.statSync(d.releaseHeartbeat).mtimeMs;
    } catch {
      /* missing */
    }
    if (age > HEARTBEAT_STALE_MS) await raise(RELEASE_STOPPED, `The release system has stopped: its heartbeat is ${Number.isFinite(age) ? `${Math.floor(age / 60_000)} minutes old` : "missing"}. No update is built, deployed or released until it runs again`, "Dev: on the server, check the release system (systemctl status tourbillon-ship and its log) and start it again.");
    else await clear(RELEASE_STOPPED, "the release system is running again");
  }

  // ---------------- staff commands ----------------
  async function health(): Promise<HealthRow[]> {
    const f = d.fetch ?? fetch;
    return Promise.all(
      book.cfg.health.map(async (h): Promise<HealthRow> => {
        const t0 = now();
        try {
          const r = await f(h.url, { signal: AbortSignal.timeout(8000) });
          return { name: h.name, status: r.status, ok: r.ok, ms: now() - t0 };
        } catch {
          return { name: h.name };
        }
      }),
    );
  }

  async function command(cmd: string, arg: string): Promise<unknown> {
    const n = parseInt(arg, 10);
    const say = (html: string) => tg.send(d.chat, html);
    switch (cmd) {
      case "help":
      case "start":
        return say(HELP);
      case "status":
        return say(boardText(st, book, now()));
      case "next":
        return say(nextText(st, book, now()));
      case "schedule": {
        if (!st.launchAt) return say(NOT_SET);
        const day = n || currentDay(st, book, now());
        return say(scheduleDay(st, book, day) ?? noDayText(day));
      }
      case "poster": {
        if (!book.byN.has(n)) return say(posterUsage);
        if (st.u[n]?.outcome !== "released") return say(posterNotLive(n));
        for (const shape of ["square", "wide"] as const) {
          const p = posterPath(book, n, shape);
          if (exists(p)) await tg.photo(d.chat, p, posterCaption(n, shape === "wide"));
        }
        return;
      }
      case "changelog":
        return say(changelogReply(st, book));
      case "roadmap": {
        const cap = roadmapCaption(st, book);
        const img = roadmapPath(book);
        return img && exists(img) ? tg.photo(d.chat, img, cap, true) : say(cap);
      }
      case "contracts":
        return say(contractsText(book));
      case "socials":
        return say(socialsText(book));
      case "videos":
        return say(videosText(book));
      case "video": {
        const v = book.cfg.videos[n - 1];
        if (!v) return say(videoUsage(book));
        return tg.copy(d.chat, v.fromChat ?? d.chat, v.messageId);
      }
      case "health":
        return say(healthText(await health(), st, now()));
      default:
        return null;
    }
  }

  let me: string | null = null;
  const lastCmd = new Map<string, number>();
  const lastReply = new Map<number, number>();

  async function reply(m: TgMessage): Promise<void> {
    const to = m.reply_to_message!;
    if (!me || !to.from?.is_bot || to.from.username?.toLowerCase() !== me.toLowerCase()) return; // not one of ours
    if (m.is_topic_message && to.message_id === m.message_thread_id) return; // a message in a topic, not a reply
    if (now() - (lastReply.get(to.message_id) ?? -Infinity) < SAME_REPLY_MS) return; // a busy thread: answer once
    lastReply.set(to.message_id, now());
    for (const [id, at] of lastReply) if (now() - at >= SAME_REPLY_MS) lastReply.delete(id);
    await tg.send(d.chat, REPLY_ONLY).catch((e) => log("reply error", sentence(e)));
  }

  /// One update from Telegram: staff commands in the staff group; /ack in Alert Test; from people only.
  async function handle(up: TgUpdate): Promise<void> {
    st.offset = up.update_id + 1;
    save();
    const m = up.message;
    if (!m || m.from?.is_bot) return;
    const text = m.text?.trim() ?? "";
    const [head = "", ...rest] = text.split(/\s+/);
    const [cmd = "", at] = head.startsWith("/") ? head.slice(1).toLowerCase().split("@") : [""];
    if (at && (!me || at !== me.toLowerCase())) return; // a command for another bot
    if (m.chat?.id === d.testChat) {
      if (cmd === "ack") await ack(m, rest.join(" ")).catch((e) => log("ack error", sentence(e)));
      return;
    }
    if (m.chat?.id !== d.chat) return;
    if (!cmd) {
      if (m.reply_to_message) await reply(m);
      return;
    }
    if (!KNOWN.has(cmd)) return;
    const key = `${cmd} ${rest.join(" ")}`;
    if (now() - (lastCmd.get(key) ?? 0) < SAME_COMMAND_MS) return; // the same command twice in a row: answer once
    lastCmd.set(key, now());
    await command(cmd, rest.join(" ")).catch((e) => log("command error", cmd, sentence(e)));
  }

  async function setup(): Promise<void> {
    me = await tg.me().catch((e) => (log("getMe failed", sentence(e)), null));
    await tg.setCommands(d.chat, MENU).catch((e) => log("setMyCommands failed", sentence(e)));
  }

  async function pollOnce(timeoutSec = 25): Promise<void> {
    if (!me) me = await tg.me().catch(() => null);
    let ups: TgUpdate[];
    try {
      ups = await tg.updates(st.offset, timeoutSec);
    } catch (e) {
      log("getUpdates", sentence(e));
      await sleep(5000);
      return;
    }
    for (const up of ups) await handle(up);
  }

  async function tick(): Promise<void> {
    try {
      beat();
      await inboxTick();
      await alarmTick();
      await watchRelease();
      dustTick();
      await boardPosterTick();
      await shippedTick();
      await boardTick();
    } catch (e) {
      log("tick error", sentence(e));
    }
  }

  let running = false;
  function start(): { stop: () => void } {
    running = true;
    fs.mkdirSync(inboxDir(dataDir), { recursive: true, mode: 0o700 });
    log(`up: ${book.total} updates, ${st.launchAt ? `armed for ${st.launchAt}` : "not armed"}${d.dryRun ? ", DRY RUN (Alert Test only)" : ""}`);
    void (async () => {
      await setup();
      while (running) await pollOnce();
    })();
    void (async () => {
      await boardTick(true);
      while (running) {
        await tick();
        await sleep(TICK_MS);
      }
    })();
    return { stop: () => void (running = false) };
  }

  return { st, tick, inboxTick, alarmTick, boardTick, boardPosterTick, shippedTick, dustTick, watchRelease, handle, setup, pollOnce, start, beat };
}

export type Teambot = ReturnType<typeof createTeambot>;
