import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { addsMigration, buildCommit, buildUpdate, deploy, type DeployConfig, type Run, type Target } from "./deploy.ts";
import { gateFolder } from "./gate.ts";
import { beat, beatAge, HEARTBEAT_STALE_MS, type Notifier } from "./notify.ts";
import { PublishError } from "./publish.ts";
import { sh } from "./gate.ts";
import { folder, pad, readKit, readMeta, tag, TOTAL, type KitUpdate, type LiveCheck } from "./queue.ts";

/// The release system: the work for each update, and the one that tells the team bot what to post. It never posts
/// updates or status lines itself (the team bot does, from the notices in its inbox: notify.ts). Nothing runs until it
/// is armed with a launch time. At the launch minute the team bot posts the launch announcement; update NN posts at
/// launch + NN x slot, to the minute.
///   30 minutes before (the window): the gate, the build (patch onto the previous update, install, tests), the
///     deploy to testnet then mainnet with live checks (rolled back if one fails), then the public push and the
///     GitHub release. All of it finishes before the minute; then the update waits, ready.
///   Anything that fails in the window opens a release emergency at once (the team bot repeats it every 2 minutes in
///     Alert Test until it clears; /ack pauses it). Fixed in time (`release N`), the work runs again.
///   At the minute: ready -> "released" (the team bot posts the full set and the status line). Still failing -> HELD
///     (or ROLLED BACK), and the next update keeps its time. Live but not yet published -> RELEASE DELAYED, retried
///     every 2 minutes, then released.
///   After a pause, overdue updates go out one at a time, 2 minutes apart.
/// It writes its own heartbeat every tick and watches the team bot's; if the team bot stops, that one emergency is sent
/// straight to Alert Test (send-only), because the team bot cannot send it.
/// state.json is saved before and after each step, so a restart never repeats or skips anything.
///
/// After the last update: `deploy-main <commit>` puts a merged commit of the public main live the same way, through
/// the same steps (build, the same tests, testnet then mainnet, the database step when it adds a migration, every live
/// check, the team bot's heartbeat, automatic rollback). Only between :05 and :25 UTC, only the commit that is the
/// public main's tip now and contains what is live, never while an update is pending. Nothing is posted when it goes
/// live; a failure is a release emergency in Alert Test like any other, until a later deploy-main goes live.

export const SLOT_MS = 60 * 60_000;
export const LEAD_MS = 30 * 60_000;
export const CATCHUP_MS = 2 * 60_000;
export const RETRY_MS = 2 * 60_000;
export const ALARM_REPEAT_MS = 2 * 60_000;
export const PING_EVERY_MS = 60_000;
export const TICK_MS = 10_000;

export type UState = "failed" | "live" | "ready" | "released" | "delayed" | "held" | "rolled_back";
export type UpdateState = {
  state?: UState;
  commit?: string;
  why?: string;
  failKind?: "held" | "rolled_back"; // what a failure becomes if it is still not fixed at the minute
  alarm?: string; // the release emergency open for it
  publishStep?: "push" | "github";
  url?: string;
  at?: string;
  retryAt?: number;
  releases?: string[]; // "testnet:<folder>" per target
  workStartedAt?: number;
  workMs?: number; // how long its full cycle took (gate to GitHub release)
  steps?: Record<string, number>; // ms per step, for the cycle-time report
};
export type MainPhase = "queued" | "building" | "deploying" | "live" | "failed" | "rolled_back";
export type MainDeploy = { id: string; commit: string; subject: string; from: string; phase: MainPhase; why?: string; releases?: string[]; lines: string[]; startedAt: number; endedAt?: number };
export type State = {
  launchAt: string | null;
  paused: { reason: string; at: string } | null;
  base: string;
  head?: string; // the commit live now; the next update builds onto it
  u: Record<string, UpdateState>;
  lastPostAt: number;
  lastControl: { id: string; text: string } | null;
  seq: number; // numbers the notices
  teambotAlarm: { openedAt: number; lastSentAt: number } | null;
  lastPingAt: number;
  launchPosted: boolean; // the launch announcement was handed to the team bot
  main?: MainDeploy; // the last deploy-main (the one running, or the last finished)
  mainAlarm?: string; // the release emergency open for a failed deploy-main
};

/// Out at its minute (or held there): nothing more happens to it unless the owner runs `release N`.
const DONE: UState[] = ["released", "delayed", "held", "rolled_back"];
/// Deployed on every target: later updates may build on it.
const ON_LIVE: UState[] = ["live", "ready", "released", "delayed"];

export function loadState(dataDir: string, base: string): State {
  const p = join(dataDir, "state.json");
  const blank: State = { launchAt: null, paused: null, base, u: {}, lastPostAt: 0, lastControl: null, seq: 0, teambotAlarm: null, lastPingAt: 0, launchPosted: false };
  if (!existsSync(p)) return blank;
  try {
    return { ...blank, ...(JSON.parse(readFileSync(p, "utf8")) as Partial<State>) };
  } catch {
    throw new Error("state.json could not be read: fix or restore it before starting (starting blank could release updates twice)");
  }
}

export function saveState(dataDir: string, st: State): void {
  const p = join(dataDir, "state.json");
  const fd = openSync(`${p}.tmp`, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(st, null, 1));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(`${p}.tmp`, p);
}

export type Status = "released" | "delayed" | "held" | "rolled_back";
export type ReleaseLine = { kind: "release"; status: Status; update: number; title: string; what: string; next: string; link?: string; at: string };

/// The emergency names (services/teambot/README.md); each update's carries its number (release-tests-failed-07).
export const ALARM = {
  gate: "release-gate-failed",
  build: "release-build-failed",
  tests: "release-tests-failed",
  deploy: "release-deploy-failed",
  live: "release-live-check-failed",
  push: "release-push-failed",
  github: "release-github-failed",
  notReady: "release-not-ready",
  mainBuild: "release-main-build-failed",
  mainTests: "release-main-tests-failed",
  mainDeploy: "release-main-deploy-failed",
  mainLive: "release-main-live-check-failed",
  teambot: "teambot-heartbeat-missing",
} as const;

export type AlarmSender = { send: (chat: string, text: string) => Promise<number> };

export type RunnerDeps = {
  dataDir: string;
  queueDir: string;
  kitDir: string;
  repo: string; // tourbillondev/tourbillon
  deployCfg: DeployConfig;
  publish: (n: number, commit: string, k: KitUpdate) => Promise<string>; // push, then the GitHub release; gives back its address
  /// The commit the next update is built onto: the latest public main when it contains the commit live now, else the
  /// commit live now (then the push is refused as before). Without it, every update builds onto the one before.
  buildBase?: (liveHead: string) => { commit: string; note: string };
  notify: Notifier; // notices for the team bot
  teambotHeartbeat?: string; // the team bot's heartbeat file
  teambotTarget?: string; // the target whose restart restarts the team bot (mainnet); its heartbeat is a live check there
  alarm?: AlarmSender; // send-only, for the one emergency the team bot cannot send (its own heartbeat)
  alertChat?: string; // Alert Test
  alarmLabel?: string; // a dry run marks it
  ping?: () => Promise<void>; // the outside check, while healthy
  releasesLog: string;
  base: string;
  run?: Run;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  total?: number;
  slotMs?: number;
  leadMs?: number;
  catchupMs?: number;
  heartbeatWaitMs?: number; // how long a restarted team bot has to write a fresh heartbeat (default 2.5 minutes)
  /// The public main's tip now (fetched into the repo, so its tree can be built), for deploy-main.
  readMain?: () => { ok: true; commit: string } | { ok: false; why: string };
  /// deploy-main only between :05 and :25 UTC (default on; only a dry run turns it off).
  mainWindow?: boolean;
  log?: (msg: string) => void;
};

const utc = (t: number) => new Date(t).toISOString().slice(11, 16);

export function createRunner(d: RunnerDeps) {
  const now = d.now ?? Date.now;
  const total = d.total ?? TOTAL;
  const slotMs = d.slotMs ?? SLOT_MS;
  const leadMs = d.leadMs ?? LEAD_MS;
  const catchupMs = d.catchupMs ?? CATCHUP_MS;
  const sleep = d.sleep ?? ((ms: number) => Bun.sleep(ms));
  const log = d.log ?? ((m: string) => console.log(`[release] ${m}`));
  mkdirSync(join(d.dataDir, "inbox"), { recursive: true, mode: 0o700 });
  const st = loadState(d.dataDir, d.base);
  const save = () => saveState(d.dataDir, st);
  const us = (n: number) => (st.u[n] ||= {});
  const due = (n: number) => Date.parse(st.launchAt!) + n * slotMs; // the launch announcement at the launch minute; update NN at launch + NN hours
  const kit = (n: number): KitUpdate | undefined => {
    try {
      return readKit(d.kitDir).get(n);
    } catch {
      return undefined;
    }
  };
  const title = (n: number) => kit(n)?.title ?? `Update ${pad(n)}`;
  const chainHead = () => st.head ?? st.base;
  const notice = (key: string, body: Record<string, unknown>) => {
    st.seq += 1;
    save();
    d.notify(`r${st.seq}-${key}`, body);
  };
  const nextText = (n: number) => {
    for (let m = n + 1; m <= total; m++) if (!DONE.includes(st.u[m]?.state as UState)) return `Update ${pad(m)} at ${utc(due(m))} UTC.`;
    return `All ${total} updates are done.`;
  };
  const postAt = (n: number) => new Date(due(n)).toISOString();

  function logLine(status: Status, n: number, what: string, next: string, link?: string): void {
    const l: ReleaseLine = { kind: "release", status, update: n, title: title(n), what, next, link, at: new Date(now()).toISOString() };
    appendFileSync(d.releasesLog, `${JSON.stringify(l)}\n`);
    log(`${status} ${tag(n)}`);
  }

  // ---------------- emergencies (sent by the team bot) ----------------
  function openAlarm(n: number, base: string, what: string, who = `Dev fixes it, then on the server: tourbillon-release release ${n}.`): void {
    const name = `${base}-${pad(n)}`; // one alarm per update: two updates failing the same way never share one
    const s = us(n);
    if (s.alarm && s.alarm !== name) notice(`clear-${s.alarm}`, { type: "cleared", name: s.alarm, reason: "replaced by a newer alarm for the same update" });
    s.alarm = name;
    save();
    notice(`alarm-${name}`, { type: "alarm", alarm: { name, what, who, n, postAt: postAt(n) } });
  }
  function clearAlarm(n: number, reason: string): void {
    const s = us(n);
    if (!s.alarm) return;
    const name = s.alarm;
    s.alarm = undefined;
    save();
    notice(`clear-${name}`, { type: "cleared", name, reason });
  }

  function fail(n: number, name: string, why: string, kind: "held" | "rolled_back"): void {
    Object.assign(us(n), { state: "failed", why, failKind: kind, at: new Date(now()).toISOString() });
    save();
    log(`failed in its window ${tag(n)}: ${why}`);
    openAlarm(n, name, `${why} (while preparing Update ${pad(n)}, before its posting time).`);
  }

  // ---------------- the work, in the 30-minute window ----------------
  async function work(n: number): Promise<void> {
    const s = us(n);
    s.workStartedAt = now();
    s.steps = {};
    save();
    const t0 = Date.now();
    const lap = (k: string, from: number) => ((s.steps![k] = Date.now() - from), Date.now());
    const g = gateFolder(d.queueDir, d.kitDir, n, d.repo, total);
    let t = lap("gate", t0);
    if (g.why.length) return fail(n, ALARM.gate, `The gate refused it: ${g.why.join(" ")} Nothing was deployed.`, "held");
    const onto = d.buildBase ? d.buildBase(chainHead()) : { commit: chainHead(), note: "the update live now" };
    log(`building ${tag(n)} onto ${onto.commit.slice(0, 12)} (${onto.note})`);
    const b = buildUpdate(d.deployCfg, n, onto.commit, g.patch!, g.k!.title, g.k!.changelog_line, due(n), d.run);
    t = lap("build and tests", t);
    if (!b.ok) return fail(n, /the tests failed/.test(b.why) ? ALARM.tests : ALARM.build, `${b.why.replace(/\.$/, "")}. Nothing was deployed.`, "held");
    s.commit = b.commit;
    save();
    const { m: meta } = readMeta(folder(d.queueDir, n), n);
    if (!meta) return fail(n, ALARM.gate, "meta.json could not be read. Nothing was deployed.", "held");
    const out = await deploy(d.deployCfg, n, b.dir, meta.deploy, meta.migration, checksUpTo(n), { run: d.run, fetch: d.fetch, sleep: d.sleep, now, afterTarget: teambotCheck });
    t = lap("deploy and live checks", t);
    if (out.status === "rolled_back") {
      const backs = out.back.map((x) => `${x.target} is back on ${x.to}${x.healthy ? " and its checks pass" : ", but its checks FAIL too"}`).join("; ");
      const restartFailed = out.why.some((w) => /restarting \w+ failed|nothing is live|release folder|database step/.test(w));
      return fail(n, restartFailed ? ALARM.deploy : ALARM.live, `Deployed; ${restartFailed ? "a deploy step" : "a live check"} failed: ${out.why.join(" ")} Rolled back automatically: ${backs || "nothing had switched"}`, "rolled_back");
    }
    Object.assign(s, { state: "live", why: undefined, releases: out.done.map((x) => `${x.target}:${x.release}`) });
    st.head = b.commit;
    save();
    await tryPublish(n);
    lap("public push and GitHub release", t);
    if (s.state === "ready") s.workMs = Date.now() - t0;
    save();
  }

  // ---------------- deploy-main: a merged commit of the public main ----------------
  const mainSay = (m: MainDeploy, line: string) => {
    m.lines.push(`${utc(now())} ${line}`);
    save();
    log(`deploy-main ${m.commit.slice(0, 12)}: ${line}`);
  };
  function mainLogLine(m: MainDeploy): void {
    appendFileSync(d.releasesLog, `${JSON.stringify({ kind: "deploy-main", status: m.phase, commit: m.commit, from: m.from, subject: m.subject, what: m.why ?? `Live on ${(m.releases ?? []).map((r) => r.split(":")[0]).join(" and ")}; live checks pass.`, releases: m.releases, at: new Date(now()).toISOString() })}\n`);
  }
  function mainFail(m: MainDeploy, alarm: string, phase: "failed" | "rolled_back", why: string): void {
    Object.assign(m, { phase, why, endedAt: now() });
    mainSay(m, why);
    mainLogLine(m);
    const name = `${alarm}-${m.commit.slice(0, 7)}`;
    if (st.mainAlarm && st.mainAlarm !== name) notice(`clear-${st.mainAlarm}`, { type: "cleared", name: st.mainAlarm, reason: "replaced by a newer deploy-main alarm" });
    st.mainAlarm = name;
    save();
    notice(`alarm-${name}`, { type: "alarm", alarm: { name, what: `${why} (deploy-main ${m.commit.slice(0, 12)}: ${m.subject})`, who: "Dev fixes it on main (merge as usual), then on the server in a :05-:25 window: tourbillon-release deploy-main <the new main commit>." } });
  }

  async function mainTick(): Promise<void> {
    const m = st.main;
    if (!m || m.phase !== "queued") return;
    const t0 = Date.now(); // real time: the build is real work even under a test clock
    m.phase = "building";
    mainSay(m, "building: install and the full tests");
    const name = `main-${m.commit.slice(0, 12)}`;
    const b = buildCommit(d.deployCfg, m.commit, name, d.run);
    if (!b.ok) return mainFail(m, /the tests failed/.test(b.why) ? ALARM.mainTests : ALARM.mainBuild, "failed", `${b.why.replace(/\.$/, "")}. Nothing was deployed.`);
    m.phase = "deploying";
    mainSay(m, `built and tested in ${Math.round((Date.now() - t0) / 1000)} s; deploying to ${d.deployCfg.targets.filter((t) => t.enabled).map((t) => t.name).join(", then ")}`);
    const migrates = new Map(d.deployCfg.targets.map((t) => [t.name, addsMigration(t, b.dir)]));
    if ([...migrates.values()].some(Boolean)) mainSay(m, "it adds a database migration: the database step runs before each restart");
    const out = await deploy(d.deployCfg, 0, b.dir, "db+", false, checksUpTo(total), { run: d.run, fetch: d.fetch, sleep: d.sleep, now, afterTarget: teambotCheck, name: `main-${m.commit.slice(0, 7)}`, migrationFor: (t) => migrates.get(t.name) ?? false });
    if (out.status === "rolled_back") {
      const backs = out.back.map((x) => `${x.target} is back on ${x.to}${x.healthy ? " and its checks pass" : ", but its checks FAIL too"}`).join("; ");
      const stepFailed = out.why.some((w) => /restarting \w+ failed|nothing is live|release folder|database step/.test(w));
      return mainFail(m, stepFailed ? ALARM.mainDeploy : ALARM.mainLive, "rolled_back", `Deployed; ${stepFailed ? "a deploy step" : "a live check"} failed: ${out.why.join(" ")} Rolled back automatically: ${backs || "nothing had switched"}.`);
    }
    Object.assign(m, { phase: "live", why: undefined, releases: out.done.map((x) => `${x.target}:${x.release}`), endedAt: now() });
    st.head = m.commit;
    save();
    mainSay(m, `LIVE on ${out.done.map((x) => `${x.target} (${x.release})`).join(" and ")}; every live check passes`);
    mainLogLine(m);
    if (st.mainAlarm) {
      const n = st.mainAlarm;
      st.mainAlarm = undefined;
      save();
      notice(`clear-${n}`, { type: "cleared", name: n, reason: `main ${m.commit.slice(0, 12)} is live` });
    }
  }

  /// Why deploy-main may not start now (null when it may).
  function mainRefusal(arg: string | undefined): { why: string } | { commit: string; subject: string } {
    const want = (arg ?? "").trim().toLowerCase();
    if (!st.launchAt) return { why: "Not armed: the release system has not run its updates." };
    const notOut = Array.from({ length: total }, (_, i) => i + 1).filter((n) => st.u[n]?.state !== "released");
    if (notOut.length) return { why: `Refused: update${notOut.length > 1 ? "s" : ""} ${notOut.slice(0, 5).map(pad).join(", ")}${notOut.length > 5 ? " ..." : ""} not released yet. deploy-main runs only after all ${total} are out.` };
    if (st.paused) return { why: `Refused: paused (${st.paused.reason}). Resume first.` };
    if (st.main && ["queued", "building", "deploying"].includes(st.main.phase)) return { why: `Refused: deploy-main ${st.main.commit.slice(0, 12)} is still ${st.main.phase}.` };
    const min = new Date(now()).getUTCMinutes();
    if ((d.mainWindow ?? true) && !(min >= 5 && min < 25)) return { why: `Refused: it is ${utc(now())} UTC. deploy-main starts only between :05 and :25 past the hour.` };
    if (!d.readMain) return { why: "Refused: this release job cannot read the public main." };
    const r = d.readMain();
    if (!r.ok) return { why: `Refused: the public main could not be read (${r.why}).` };
    const subject = sh(["git", "log", "-1", "--format=%s", r.commit], d.deployCfg.repoDir).out.trim();
    const show = `The public main is ${r.commit.slice(0, 12)} (${subject}).`;
    if (!/^[0-9a-f]{7,40}$/.test(want)) return { why: `Refused: name the commit to deploy. ${show} To deploy it: tourbillon-release deploy-main ${r.commit.slice(0, 7)}` };
    if (!r.commit.startsWith(want)) return { why: `Refused: ${want} is not the public main's tip. ${show} Only a pushed commit at the tip of main is deployed.` };
    const live = chainHead();
    if (r.commit === live) return { why: `Nothing to do: ${r.commit.slice(0, 12)} is already live.` };
    if (!sh(["git", "merge-base", "--is-ancestor", live, r.commit], d.deployCfg.repoDir).ok) return { why: `Refused: ${r.commit.slice(0, 12)} does not contain ${live.slice(0, 12)}, the commit live now. Deploying it would drop live work.` };
    const msgs = sh(["git", "log", "--format=%an%n%ae%n%B", `${live}..${r.commit}`], d.deployCfg.repoDir).out;
    if (/co-authored-by|generated with/i.test(msgs)) return { why: `Refused: a commit between ${live.slice(0, 12)} and ${r.commit.slice(0, 12)} carries a co-author or "generated with" line.` }; // words-lint: allow (the check that refuses attribution lines)
    return { commit: r.commit, subject };
  }

  /// The team bot runs inside the mainnet service, so every mainnet deploy restarts it: it must write a fresh heartbeat.
  async function teambotCheck(t: Target, restartedAt: number): Promise<string | null> {
    if (!d.teambotHeartbeat || t.name !== d.teambotTarget) return null;
    const until = restartedAt + (d.heartbeatWaitMs ?? 150_000);
    for (;;) {
      if (beatAge(d.teambotHeartbeat, now()) <= now() - restartedAt) return null; // written since the restart
      if (now() >= until) return `${t.name}: the team bot did not start again after the restart (no fresh heartbeat).`;
      await sleep(5_000);
    }
  }

  function checksUpTo(n: number): LiveCheck[] {
    const out: LiveCheck[] = [];
    for (let m = 1; m <= n; m++) {
      if (m < n && !ON_LIVE.includes(st.u[m]?.state as UState)) continue;
      const { m: meta } = readMeta(folder(d.queueDir, m), m);
      for (const c of meta?.checks ?? []) out.push({ ...c, name: `${pad(m)} ${c.name}` });
    }
    return out;
  }

  /// The public push and the GitHub release (retried every 2 minutes while it fails).
  async function tryPublish(n: number): Promise<void> {
    const s = us(n);
    const k = kit(n);
    try {
      if (!k) throw new PublishError("github", "the kit's updates.json could not be read");
      s.url = await d.publish(n, s.commit!, k);
    } catch (e) {
      const step = e instanceof PublishError ? e.step : "github";
      const reason = (e as Error).message.replace(/\.$/, "");
      const first = !s.retryAt || s.publishStep !== step;
      Object.assign(s, { why: reason, publishStep: step, retryAt: now() + RETRY_MS });
      save();
      if (first)
        openAlarm(n, step === "push" ? ALARM.push : ALARM.github, `Update ${pad(n)} is live on testnet and mainnet, but ${step === "push" ? "the public push" : "the GitHub release"} failed: ${reason}. Retrying every 2 minutes.`, step === "push" ? "Dev checks GitHub (the deploy key, and that nobody else pushed to main)." : "Dev checks GitHub (the release token and its expiry).");
      else log(`publish still failing for ${tag(n)}: ${reason}`);
      return;
    }
    const wasDelayed = s.state === "delayed";
    Object.assign(s, { why: undefined, retryAt: undefined, publishStep: undefined });
    if (wasDelayed) {
      s.state = "released";
      save();
      clearAlarm(n, `Update ${pad(n)} is published`);
      released(n);
    } else {
      s.state = "ready";
      save();
      clearAlarm(n, `Update ${pad(n)} is ready for its posting time`);
    }
  }

  function released(n: number): void {
    const s = us(n);
    const where = (s.releases ?? []).map((r) => r.split(":")[0]).join(" and ");
    const what = `Live on ${where || "no target"}; live checks pass; public commit and GitHub release published.`;
    s.at = new Date(now()).toISOString();
    st.lastPostAt = now();
    save();
    logLine("released", n, what, nextText(n), s.url);
    notice(`released-${pad(n)}`, { type: "released", n, what, next: nextText(n), link: s.url });
  }

  // ---------------- at the minute ----------------
  async function minuteTick(): Promise<void> {
    for (let n = 1; n <= total; n++) {
      const s = st.u[n] ?? {};
      if (DONE.includes(s.state as UState)) continue;
      if (now() < due(n)) return; // not its minute yet (and nothing after it is due either)
      if (now() - st.lastPostAt < catchupMs) return; // overdue ones go 2 minutes apart
      if (s.state === "ready") {
        s.state = "released";
        save();
        released(n);
        return;
      }
      if (s.state === "live") {
        s.state = "delayed";
        st.lastPostAt = now();
        save();
        const what = `Live and its checks pass; ${s.publishStep === "push" ? "the public push" : "the GitHub release"} failed (${s.why}); retrying every 2 minutes.`;
        logLine("delayed", n, what, "SHIPPED AND RELEASED follows when it goes through.");
        notice(`delayed-${pad(n)}`, { type: "delayed", n, what, next: "SHIPPED AND RELEASED follows when it goes through." });
        return;
      }
      if (s.state === "failed") {
        const kind = s.failKind ?? "held";
        const next = `Fix it, then on the server: tourbillon-release release ${n}. ${nextText(n).replace(/\.$/, "")} keeps its time.`;
        Object.assign(s, { state: kind, at: new Date(now()).toISOString() });
        st.lastPostAt = now();
        save();
        logLine(kind, n, s.why!, next);
        notice(`${kind}-${pad(n)}`, { type: kind, n, what: `${s.why} It was not ready at its posting time.`, next });
        if (s.alarm) notice(`alarm-${s.alarm}-late`, { type: "alarm", alarm: { name: s.alarm, what: `${s.why} Update ${pad(n)} was not ready at its posting time and is ${kind === "held" ? "held" : "rolled back"}; ${nextText(n).replace(/\.$/, "")} keeps its time.`, who: `Dev fixes it, then on the server: tourbillon-release release ${n}.`, n, postAt: postAt(n) } });
        else openAlarm(n, ALARM.notReady, `Update ${pad(n)} was not ready at its posting time and is held.`);
        return;
      }
      return; // its work has not run yet (just resumed, or still waiting for the one before): it runs, then goes out
    }
  }

  // ---------------- the next update's work ----------------
  async function workTick(): Promise<void> {
    for (let n = 1; n <= total; n++) {
      const s = st.u[n]?.state;
      if (s === undefined) {
        if (now() < due(n) - leadMs) return;
        for (let m = 1; m < n; m++) if (st.u[m]?.state === undefined || st.u[m]?.state === "failed") return; // in order
        return work(n);
      }
    }
  }

  async function retryTick(): Promise<void> {
    for (let n = 1; n <= total; n++) {
      const s = st.u[n];
      if ((s?.state === "live" || s?.state === "delayed") && now() >= (s.retryAt ?? 0)) await tryPublish(n);
    }
  }

  // ---------------- heartbeats and the outside check ----------------
  async function watchTeambot(): Promise<void> {
    if (!d.teambotHeartbeat || !d.alarm || !d.alertChat) return;
    const age = beatAge(d.teambotHeartbeat, now());
    const label = d.alarmLabel ? `${d.alarmLabel}\n` : "";
    const a = st.teambotAlarm;
    try {
      if (age > HEARTBEAT_STALE_MS) {
        if (a && now() - a.lastSentAt < ALARM_REPEAT_MS) return;
        const open = a ? Math.floor((now() - a.openedAt) / 60_000) : 0;
        await d.alarm.send(
          d.alertChat,
          `${label}🔴 ALERT · ${ALARM.teambot}\n\nWhat happened: The team bot has stopped: its heartbeat is ${Number.isFinite(age) ? `${Math.floor(age / 60_000)} minutes old` : "missing"}. Nothing can be posted, and its own alarms cannot be sent, until it runs again.\nWho acts: Dev: on the server, check the team bot (systemctl status tourbillon-teambot and its log) and start it again.\n${open ? `Still open after ${open}m. ` : ""}This one repeats every 2 minutes until the team bot is back (/ack cannot reach it while the team bot is down).`,
        );
        st.teambotAlarm = { openedAt: a?.openedAt ?? now(), lastSentAt: now() };
        save();
      } else if (a) {
        await d.alarm.send(d.alertChat, `${label}🟢 CLEARED · ${ALARM.teambot} (the team bot is running again)`);
        st.teambotAlarm = null;
        save();
      }
    } catch (e) {
      log(`could not send the team bot alarm: ${(e as Error).message}`);
    }
  }

  async function pingTick(): Promise<void> {
    if (!d.ping || now() - st.lastPingAt < PING_EVERY_MS) return;
    st.lastPingAt = now();
    save();
    await d.ping().catch((e) => log(`outside check ping failed: ${(e as Error).message}`));
  }

  // ---------------- server commands ----------------
  const overdue = () => {
    let c = 0;
    for (let n = 1; n <= total; n++) if (!DONE.includes(st.u[n]?.state as UState) && st.launchAt && due(n) <= now()) c++;
    return c;
  };

  async function applyControl(c: { id?: string; cmd: string; arg?: string; rest?: string }): Promise<string> {
    const n = parseInt(c.arg ?? "", 10);
    const anyOut = Object.values(st.u).some((x) => x.state && DONE.includes(x.state));
    switch (c.cmd) {
      case "arm": {
        const raw = (c.arg ?? "").trim();
        const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
        const t = m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!) : /Z$/.test(raw) ? Date.parse(raw) : NaN;
        if (!Number.isFinite(t)) return 'Could not read that time. Use: tourbillon-release arm "2026-12-01 14:00" (UTC).';
        if (anyOut) return "Updates have already gone out: the launch time can no longer change.";
        if (t <= now()) return "That time has already passed.";
        const off = d.deployCfg.targets.filter((x) => !x.enabled).map((x) => x.name);
        if (off.length) return `Not armed: ${off.join(", ")} is off. Every update must go live on testnet and then mainnet before it is posted, so every target must be on before arming (mainnet only after the owner's approval).`;
        const changed = !!st.launchAt;
        st.launchAt = new Date(t).toISOString();
        save();
        notice("armed", { type: "armed", at: st.launchAt, changed });
        return `Armed: the launch announcement at ${st.launchAt}; Update 01 at ${new Date(due(1)).toISOString()} (its work starts 30 minutes before), then one every ${slotMs >= 3_600_000 ? `${slotMs / 3_600_000} hour(s)` : `${slotMs / 60_000} minute(s)`}; Update ${pad(total)} at ${new Date(due(total)).toISOString()}. The schedule was posted in the staff group. From now on, nobody else may push to main until the last update is out.`;
      }
      case "disarm":
        if (!st.launchAt) return "Not armed. Nothing changed.";
        if (anyOut || Object.values(st.u).some((x) => x.state)) return "Work has already started: use pause instead.";
        st.launchAt = null;
        st.u = {};
        save();
        notice("disarmed", { type: "disarmed" });
        return "Disarmed. Nothing will run or post until it is armed again.";
      case "pause":
        if (st.paused) return `Already paused (${st.paused.reason}). Nothing changed.`;
        st.paused = { reason: c.arg || "planned pause", at: new Date(now()).toISOString() };
        save();
        notice("paused", { type: "paused", reason: st.paused.reason });
        return "Paused: no new work and no posts. A delayed one still retries its public half (it is already live).";
      case "resume":
        if (!st.paused) return "Not paused. Nothing changed.";
        st.paused = null;
        save();
        notice("resumed", { type: "resumed", overdue: overdue() });
        return "Resumed: overdue updates run and go out one at a time, 2 minutes apart, then the normal times.";
      case "hold": {
        if (!(n >= 1 && n <= total)) return 'Usage: tourbillon-release hold 15 "reason"';
        const s = st.u[n]?.state;
        if (s && s !== "failed") return `Update ${pad(n)} is ${s.replace("_", " ")}: nothing to hold.`;
        const why = `Held from the server: ${c.rest || "no reason given"}.`;
        Object.assign(us(n), { state: "held", why, at: new Date(now()).toISOString() });
        save();
        clearAlarm(n, "held from the server");
        logLine("held", n, why, nextText(n));
        notice(`held-${pad(n)}`, { type: "held", n, what: why, next: `${nextText(n).replace(/\.$/, "")} keeps its time.` });
        return `Update ${pad(n)} is held. The next one keeps its time.`;
      }
      case "release": {
        if (!(n >= 1 && n <= total)) return "Usage: tourbillon-release release 15";
        const s = st.u[n];
        if (!s || !["held", "rolled_back", "failed"].includes(s.state ?? "")) return `Update ${pad(n)} is not held, failed or rolled back. Nothing changed.`;
        const alarm = s.alarm;
        st.u[n] = { alarm }; // its work runs again; the open alarm clears when it is ready
        save();
        const late = st.launchAt && due(n) <= now();
        return `Update ${pad(n)} is back in the queue: its work runs again now${late ? ", and it goes out as soon as it is ready (its minute has passed)" : `, then it goes out at ${utc(due(n))} UTC`}.`;
      }
      case "verify":
        return "Not needed: the release system checks each update live on testnet and mainnet before it is posted.";
      case "test": {
        if (!(n >= 1 && n <= total)) return "Usage: tourbillon-release test 14";
        if (!kit(n)) return `Update ${pad(n)} is not in the kit.`;
        notice(`test-${pad(n)}`, { type: "test", n, what: "A test of the full set. Nothing was deployed or released.", next: "Nothing: this was a test." });
        return `Asked the team bot to send update ${pad(n)}'s full set to Alert Test, marked TEST.`;
      }
      case "preflight": {
        const bad: [number, string[]][] = [];
        for (let m = 1; m <= total; m++) {
          const g = gateFolder(d.queueDir, d.kitDir, m, d.repo, total);
          if (g.why.length) bad.push([m, g.why]);
        }
        if ((c.arg ?? "").includes("--post")) notice("preflight", { type: "preflight", bad, total });
        return [...bad.map(([m, w]) => `${pad(m)}  ${w.join(" | ")}`), `${total - bad.length} of ${total} ready${bad.length ? "" : ": all clear"} (the gate only; the full preflight with tests is src/preflight.ts)`].join("\n");
      }
      case "deploy-main": {
        const r = mainRefusal(c.arg);
        if ("why" in r) return r.why;
        st.main = { id: c.id ?? "", commit: r.commit, subject: r.subject, from: chainHead(), phase: "queued", lines: [], startedAt: now() };
        save();
        return `Deploying main ${r.commit.slice(0, 12)} (${r.subject}), live now: ${chainHead().slice(0, 12)}. It builds and runs the full tests, then goes to testnet, then mainnet, each checked live; any failure rolls back every target it switched. Nothing is posted.`;
      }
      case "status":
        return statusText();
      default:
        return `Unknown command: ${c.cmd}`;
    }
  }

  function statusText(): string {
    const count = (s: UState) => Object.values(st.u).filter((x) => x.state === s).length;
    let nx: number | undefined;
    for (let n = 1; n <= total && st.launchAt; n++)
      if (!DONE.includes(st.u[n]?.state as UState)) {
        nx = n;
        break;
      }
    const targets = d.deployCfg.targets.map((t) => `${t.name} ${t.enabled ? "on" : "off"}`).join(", ");
    const lines = [
      `Launch:   ${st.launchAt ?? "not armed (nothing runs or posts)"}`,
      `Queue:    ${st.paused ? `paused (${st.paused.reason})` : st.launchAt ? "running" : "not armed"}`,
      `Released: ${count("released")} / ${total}   ready ${count("ready")}   live ${count("live")}   delayed ${count("delayed")}   held ${count("held")}   rolled back ${count("rolled_back")}   failing ${count("failed")}`,
      `Next:     ${nx ? `Update ${pad(nx)} · ${title(nx)} · posts ${new Date(due(nx)).toISOString()}, work from ${new Date(due(nx) - leadMs).toISOString()}` : "none"}`,
      `Targets:  ${targets}`,
      `Posts:    by the team bot only (notices)`,
      `Live:     ${chainHead().slice(0, 12)}${st.main ? `   last deploy-main ${st.main.commit.slice(0, 12)} ${st.main.phase.replace("_", " ")}${st.main.endedAt ? ` at ${new Date(st.main.endedAt).toISOString()}` : ""}` : ""}`,
    ];
    for (const [k, v] of Object.entries(st.u)) if (v.state && ["held", "rolled_back", "delayed", "failed"].includes(v.state)) lines.push(`  ${pad(+k)} ${v.state.replace("_", " ")}: ${v.why}`);
    for (const [k, v] of Object.entries(st.u)) if (v.workMs) lines.push(`  ${pad(+k)} full cycle ${Math.round(v.workMs / 1000)} s`);
    return lines.join("\n");
  }

  async function inboxTick(): Promise<void> {
    const dir = join(d.dataDir, "inbox");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
      const p = join(dir, f);
      let c: { id: string; cmd: string; arg?: string; rest?: string };
      try {
        c = JSON.parse(readFileSync(p, "utf8"));
        if (typeof c.id !== "string" || !/^[\w-]{1,64}$/.test(c.id) || typeof c.cmd !== "string") throw new Error("bad");
      } catch {
        rmSync(p, { force: true });
        continue;
      }
      let text: string;
      try {
        text = await applyControl(c);
      } catch (e) {
        text = `Failed: ${(e as Error).message}`;
      }
      st.lastControl = { id: c.id, text };
      save();
      rmSync(p, { force: true });
      log(`control ${c.cmd} ${c.arg ?? ""} -> ${text.split("\n")[0]}`);
    }
  }

  async function tick(): Promise<void> {
    try {
      beat(join(d.dataDir, "heartbeat"), now());
      await inboxTick();
      if (!st.launchAt) return; // not armed: nothing runs or posts
      await watchTeambot();
      await pingTick();
      await retryTick();
      await mainTick();
      if (!st.launchPosted && now() >= Date.parse(st.launchAt)) {
        st.launchPosted = true;
        save();
        notice("launch", { type: "launch" });
      }
      if (st.paused) return;
      await minuteTick();
      await workTick();
      await minuteTick(); // an update that just became ready after its minute goes at once
    } catch (e) {
      log(`tick error: ${(e as Error).message}`);
    }
  }

  return { st, tick, applyControl, statusText };
}
