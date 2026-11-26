import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configProblems, type ReleaseConfig } from "../src/config.ts";
import { currentRelease, deploy, liveChecks, setupTarget, switchTo, type DeployConfig, type Target } from "../src/deploy.ts";
import { gateFolder, patchProblems, preflight, preflightText, sh, withChangelogLine } from "../src/gate.ts";
import { PublishError } from "../src/publish.ts";
import { forbiddenPaths, patchPaths, pngSize, readMeta, tag, telegramCaption, type KitUpdate } from "../src/queue.ts";
import { createRunner } from "../src/runner.ts";
import { inboxNotifier } from "../src/notify.ts";
import { loadBook } from "../../teambot/src/data.ts";
import { createTeambot, inboxDir } from "../../teambot/src/runner.ts";
import type { Tg } from "../../teambot/src/telegram.ts";
import { readSecrets, scrub } from "../src/telegram.ts";
import { wordHits } from "../src/words.ts";
import { takeLock } from "../src/lock.ts";

// ---------- fixtures ----------
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `project-rel-${p}-`));

/// A PNG header of the given size (enough for the size check).
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, w);
  v.setUint32(20, h);
  return b;
}

const kitU = (n: number, over: Partial<KitUpdate> = {}): KitUpdate => ({ n, type: "NEW", title: `Title ${n}`, status: "PLANNED", changelog: "add", changelog_line: `Title ${n}: a new thing.`, telegram: `Telegram text ${n}. example.com`, x: `X text ${n}. example.com`, group: "API", ...over });

/// A small git repo with a CHANGELOG, a queue of `count` updates (each adds docs/NN.md) and a kit.
function world(count: number, o: { badPatch?: number[] } = {}) {
  const root = tmp("world");
  const repo = join(root, "repo");
  mkdirSync(repo);
  sh(["git", "init", "-q", "-b", "main"], repo);
  writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\nSome text.\n\n### Contracts\n- old line\n");
  writeFileSync(join(repo, "README.md"), "hello\n");
  sh(["git", "add", "-A"], repo);
  sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base"], repo);
  const base = sh(["git", "rev-parse", "HEAD"], repo).out.trim();
  const queue = join(root, "queue");
  const kit = join(root, "kit");
  mkdirSync(join(kit, "posters", "square"), { recursive: true });
  mkdirSync(join(kit, "posters", "wide"), { recursive: true });
  const list: KitUpdate[] = [];
  for (let n = 1; n <= count; n++) {
    const NN = String(n).padStart(2, "0");
    const dir = join(queue, NN);
    mkdirSync(dir, { recursive: true });
    const file = o.badPatch?.includes(n) ? "contracts/src/ProjectVault.sol" : `docs/u${NN}.md`;
    writeFileSync(join(dir, "patch.diff"), `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+Update ${n} notes.\n`);
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ number: n, group: "API", title: `Title ${n}`, new: "A thing.", verify: { what: "it answers", how: "curl it" }, files: [file], tests: ["t"], deploy: "api", migration: false, checks: [{ name: "page", path: `/u${n}` }] }));
    writeFileSync(join(kit, "posters", "square", `update-${NN}-square.png`), png(1080, 1080));
    writeFileSync(join(kit, "posters", "wide", `update-${NN}-wide.png`), png(1200, 675));
    list.push(kitU(n));
  }
  writeFileSync(join(kit, "updates.json"), JSON.stringify(list, null, 1));
  return { root, repo, base, queue, kit };
}

function target(root: string, name = "testnet", chainId = 46630): Target {
  return { name, chainId, root: join(root, name), baseUrl: "http://live.test", enabled: true, restart: { api: [["true"]], keeper: [["true"]] }, migrate: [["true"]], checks: [{ name: "health", path: "/healthz" }] };
}

/// A fetch that answers 200 except for paths listed in `down`.
const fetchFor = (down: Set<string>) => (async (url: string | URL | Request) => {
  const p = new URL(String(url)).pathname;
  return new Response(down.has(p) ? "no" : `{"ok":true,"path":"${p}"}`, { status: down.has(p) ? 500 : 200 });
}) as unknown as typeof fetch;

type Sent = { id: string; type: string; n?: number; what?: string; next?: string; link?: string; alarm?: { name: string; what: string; who: string; n?: number }; name?: string; reason?: string; at?: string; overdue?: number };
function setup(count: number, o: { badPatch?: number[]; tests?: string[]; down?: Set<string>; second?: { down?: Set<string>; enabled?: boolean }; publishFails?: { step: "push" | "github"; times: number }; teambotBeat?: string; notify?: (id: string, body: Record<string, unknown>) => void } = {}) {
  const w = world(count, o);
  const t = target(w.root);
  const t2: Target | null = o.second ? { ...target(w.root, "mainnet-standin"), baseUrl: "http://second.test", enabled: o.second.enabled ?? true } : null;
  const deployCfg: DeployConfig = { repoDir: w.repo, buildsDir: join(w.root, "builds"), install: [], tests: [{ cmd: o.tests ?? ["true"] }], targets: t2 ? [t, t2] : [t], checkTimeoutMs: 0, keepReleases: 5 };
  mkdirSync(join(w.root, "core"), { recursive: true });
  writeFileSync(join(w.root, "core", "x"), "core");
  setupTarget(t, join(w.root, "core"), Date.UTC(2026, 0, 1));
  if (t2) setupTarget(t2, join(w.root, "core"), Date.UTC(2026, 0, 1));
  const notices: Sent[] = [];
  const launches: Sent[] = [];
  const alarms: string[] = [];
  const published: number[] = [];
  let fails = o.publishFails?.times ?? 0;
  let clock = Date.UTC(2026, 11, 1, 9, 0, 0);
  const data = join(w.root, "data");
  const down = o.down ?? new Set<string>();
  const make = () => createRunner({
    dataDir: data,
    queueDir: w.queue,
    kitDir: w.kit,
    repo: "tourbillondev/tourbillon",
    deployCfg,
    publish: async (n) => {
      if (fails > 0) {
        fails--;
        throw new PublishError(o.publishFails!.step, o.publishFails!.step === "push" ? "the push was refused (main moved)" : "GitHub answered 502 when making the release update-01");
      }
      published.push(n);
      return `https://github.com/tourbillondev/tourbillon/releases/tag/${tag(n)}`;
    },
    notify: (id, body) => {
      o.notify?.(id, body);
      ((body as { type: string }).type === "launch" ? launches : notices).push({ id, ...(body as object) } as Sent);
    },
    teambotHeartbeat: o.teambotBeat,
    teambotTarget: "mainnet-standin",
    alarm: { send: async (_chat, text) => (alarms.push(text), 1) },
    alertChat: "-100",
    releasesLog: join(w.root, "releases.log"),
    base: w.base,
    fetch: (async (url: string | URL | Request) => {
      const u = new URL(String(url));
      const off = u.host === "second.test" ? (o.second?.down ?? new Set<string>()) : down;
      return new Response(off.has(u.pathname) ? "no" : `{"ok":true}`, { status: off.has(u.pathname) ? 500 : 200 });
    }) as unknown as typeof fetch,
    sleep: async () => {
      clock += 5_000;
    },
    now: () => clock,
    total: count,
    heartbeatWaitMs: 30_000,
    log: () => {},
  });
  const runner = make();
  return { ...w, t, t2, runner, make, notices, launches, alarms, published, down, data, advance: (ms: number) => (clock += ms), at: () => clock };
}

const H = 3_600_000;

// ---------- queue, words, gate ----------
describe("queue and gate", () => {
  test("png size and patch paths", () => {
    expect(pngSize(png(1080, 1080))).toEqual({ w: 1080, h: 1080 });
    expect(pngSize(new Uint8Array(10))).toBeNull();
    expect(patchPaths("diff --git a/x/y.ts b/x/y.ts\n--- a/x/y.ts\n+++ b/x/y.ts\n")).toEqual(["x/y.ts"]);
  });

  test("core contracts and private paths are refused", () => {
    expect(forbiddenPaths(["contracts/src/ProjectVault.sol", "contracts/lib/x", "services/.env", "docs/a.md", "contracts/test/T.t.sol"])).toEqual(["contracts/src/ProjectVault.sol", "contracts/lib/x", "services/.env"]);
  });

  test("the words check catches banned words and tool names, and not normal code", () => {
    expect(wordHits("A steady yield for the group")).toEqual(["yield"]); // words-lint: allow (test data)
    // the one shared list names its rules (services/common/src/words.ts)
    expect(wordHits(["Gener", "ated with some tool"].join(""))).toContain("attribution");
    expect(wordHits(["an A", "I helper"].join(""))).toContain("tool-name-ai");
    expect(wordHits("const ok = Number.isSafeInteger(x); return ok;")).toEqual([]);
    expect(wordHits("llms.txt for software agents")).toEqual([]);
  });

  test("patchProblems names the file with a banned word", () => {
    const p = "diff --git a/docs/a.md b/docs/a.md\n--- /dev/null\n+++ b/docs/a.md\n@@ -0,0 +1 @@\n+Members earn more.\n"; // words-lint: allow (test data)
    expect(patchProblems(p)).toEqual(['patch.diff adds "earn" in docs/a.md.']); // words-lint: allow (test data)
  });

  test("meta.json must be complete and in step with the kit", () => {
    const w = world(1);
    expect(readMeta(join(w.queue, "01"), 1).why).toEqual([]);
    expect(gateFolder(w.queue, w.kit, 1, "tourbillondev/tourbillon").why).toEqual([]);
    writeFileSync(join(w.kit, "updates.json"), JSON.stringify([kitU(1, { title: "Other" })]));
    expect(gateFolder(w.queue, w.kit, 1, "tourbillondev/tourbillon").why.join(" ")).toContain("differs from the kit");
  });

  test("a wrong poster size is held", () => {
    const w = world(1);
    writeFileSync(join(w.kit, "posters", "wide", "update-01-wide.png"), png(1600, 900));
    expect(gateFolder(w.queue, w.kit, 1, "tourbillondev/tourbillon").why).toContain("The wide poster is 1600x900; it must be 1200x675.");
  });

  test("the changelog line goes under Unreleased in a Tech updates section, once", () => {
    const c = "# Changelog\n\n## [Unreleased]\n\nText.\n\n### Contracts\n- a\n";
    const t = Date.UTC(2026, 11, 1, 14, 0);
    const one = withChangelogLine(c, 1, "First: one.", t);
    expect(one).toContain("Text.\n\n### Tech updates\n- Update 01 · 2026-12-01 14:00 UTC: First: one.\n\n### Contracts");
    const two = withChangelogLine(one, 2, "Second: two.", t + 3_600_000);
    expect(two).toContain("- Update 01 · 2026-12-01 14:00 UTC: First: one.\n- Update 02 · 2026-12-01 15:00 UTC: Second: two.\n");
    expect(withChangelogLine(two, 2, "Second: two.", t)).toBe(two);
  });

  test("the caption carries the heading and the release link", () => {
    expect(telegramCaption("tourbillondev/tourbillon", 3, kitU(3), 55)).toBe("Update 03 of 55\n\nTelegram text 3. example.com\n\nGitHub: https://github.com/tourbillondev/tourbillon/releases/tag/update-03");
  });
});

// ---------- deploy and rollback ----------
describe("release folders", () => {
  test("files not in git (the .env) are linked into every release folder; a missing one stops the deploy", () => {
    const root = tmp("links");
    const env = join(root, "live.env");
    writeFileSync(env, "X=1\n");
    const built = join(root, "built");
    mkdirSync(join(built, "services"), { recursive: true });
    const t: Target = { ...target(root), links: [["services/.env", env]] };
    const rel = setupTarget(t, built, Date.UTC(2026, 0, 1));
    expect(readlinkSync(join(t.root, "releases", rel, "services", ".env"))).toBe(env);
    expect(() => setupTarget({ ...t, links: [["services/.env", join(root, "missing.env")]] }, built, Date.UTC(2026, 0, 2))).toThrow("which is missing");
  });
  test("switching current is atomic and points at the folder", () => {
    const root = tmp("sw");
    const t = target(root);
    mkdirSync(join(root, "c"));
    const rel = setupTarget(t, join(root, "c"), Date.UTC(2026, 0, 1));
    expect(rel).toBe("20260101T000000Z-base");
    expect(currentRelease(t.root)).toBe(rel);
    expect(() => switchTo(t.root, "nope")).toThrow("does not exist");
  });

  test("a failed live check rolls back to the previous folder and checks it again", async () => {
    const root = tmp("rb");
    const t = target(root);
    mkdirSync(join(root, "c"));
    mkdirSync(join(root, "b1"));
    const base = setupTarget(t, join(root, "c"), Date.UTC(2026, 0, 1));
    const cfg: DeployConfig = { repoDir: root, buildsDir: root, install: [], tests: [], targets: [t], checkTimeoutMs: 0, keepReleases: 5 };
    const restarts: string[] = [];
    const run = (cmd: string[]) => {
      restarts.push(cmd.join(" "));
      return { ok: true, out: "", err: "" };
    };
    const out = await deploy(cfg, 1, join(root, "b1"), "api", false, [{ name: "new", path: "/v1/status" }], { run, fetch: fetchFor(new Set(["/v1/status"])), sleep: async () => {} });
    expect(out.status).toBe("rolled_back");
    if (out.status === "rolled_back") {
      expect(out.why).toEqual(["testnet: new: /v1/status answered 500."]);
      expect(out.back).toEqual([{ target: "testnet", to: base, healthy: true }]);
    }
    expect(currentRelease(t.root)).toBe(base);
    expect(restarts).toEqual(["true", "true"]); // restarted on the deploy and again on the rollback
  });

  test("a later target failing rolls the earlier one back too", async () => {
    const root = tmp("rb2");
    const a = target(root, "testnet");
    const b = { ...target(root, "mainnet", 4663), baseUrl: "http://main.test" };
    mkdirSync(join(root, "c"));
    mkdirSync(join(root, "b1"));
    const baseA = setupTarget(a, join(root, "c"));
    setupTarget(b, join(root, "c"));
    const f = (async (url: string | URL | Request) => new Response("x", { status: String(url).startsWith("http://main.test/v1") ? 500 : 200 })) as unknown as typeof fetch;
    const out = await deploy({ repoDir: root, buildsDir: root, install: [], tests: [], targets: [a, b], checkTimeoutMs: 0, keepReleases: 5 }, 2, join(root, "b1"), "api", false, [{ name: "s", path: "/v1/status" }], { fetch: f, sleep: async () => {}, run: () => ({ ok: true, out: "", err: "" }) });
    expect(out.status).toBe("rolled_back");
    expect(currentRelease(a.root)).toBe(baseA);
  });

  test("live checks: an expected status other than 200", async () => {
    const t = target(tmp("lc2"));
    expect(await liveChecks(t, [{ name: "nf", path: "/u1", status: 500 }], 0, fetchFor(new Set(["/u1"])), async () => {})).toEqual([]);
    expect(await liveChecks(t, [{ name: "nf", path: "/u2", status: 404 }], 0, fetchFor(new Set()), async () => {})).toEqual(["nf: /u2 answered 200 (expected 404)."]);
  });

  test("live checks: a missing expected text fails", async () => {
    const t = target(tmp("lc"));
    expect(await liveChecks(t, [{ name: "s", path: "/v1/status", expect: "chainId" }], 0, fetchFor(new Set()), async () => {})).toEqual(['s: /v1/status answered without "chainId".']);
  });
});

// ---------- the job ----------
const types = (ns: Sent[]) => ns.filter((x) => x.type !== "launch").map((x) => (x.type === "alarm" ? `alarm:${x.alarm!.name}` : x.type === "cleared" ? `cleared:${x.name}` : `${x.type}${x.n ? `:${x.n}` : ""}`));
const ARM = "2026-12-01 10:00"; // the clock starts at 09:00 UTC; the launch announcement at 10:00, update 1 at 11:00
const at = (s: ReturnType<typeof setup>, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  const t = Date.UTC(2026, 11, 1, h!, m!, 0);
  s.advance(t - s.at());
};

describe("the release system", () => {
  test("the launch announcement at the launch minute, once; update 1 an hour later", async () => {
    const s = setup(1);
    await s.runner.applyControl({ cmd: "arm", arg: ARM });
    at(s, "09:59");
    await s.runner.tick();
    expect(s.launches).toHaveLength(0);
    at(s, "10:00");
    await s.runner.tick();
    await s.runner.tick();
    expect(s.launches).toHaveLength(1);
    expect(s.runner.st.u[1]).toBeUndefined(); // its work starts at 10:30
  });

  test("nothing runs or is reported until armed", async () => {
    const s = setup(2);
    for (let i = 0; i < 5; i++) {
      await s.runner.tick();
      s.advance(H);
    }
    expect(s.notices).toEqual([]);
    expect(s.runner.statusText()).toContain("not armed");
  });

  test("arm reads the UTC time, refuses one that has passed, and tells the team bot", async () => {
    const s = setup(2);
    expect(await s.runner.applyControl({ cmd: "arm", arg: "tomorrow" })).toContain("Could not read");
    expect(await s.runner.applyControl({ cmd: "arm", arg: "2026-12-01 08:59" })).toBe("That time has already passed.");
    expect(await s.runner.applyControl({ cmd: "arm", arg: ARM })).toStartWith("Armed: the launch announcement at 2026-12-01T10:00:00.000Z; Update 01 at 2026-12-01T11:00:00.000Z (its work starts 30 minutes before)");
    expect(types(s.notices)).toEqual(["armed"]);
    expect(s.notices[0]!.at).toBe("2026-12-01T10:00:00.000Z");
    expect(await s.runner.applyControl({ cmd: "disarm" })).toContain("Disarmed");
    expect(types(s.notices)).toEqual(["armed", "disarmed"]);
  });

  test("the work starts 30 minutes before, finishes, waits ready; at the minute exactly, the team bot is told", async () => {
    const s = setup(1);
    await s.runner.applyControl({ cmd: "arm", arg: ARM });
    at(s, "10:29");
    await s.runner.tick();
    expect(s.runner.st.u[1]).toBeUndefined();
    at(s, "10:30");
    await s.runner.tick();
    expect(s.runner.st.u[1]?.state).toBe("ready");
    expect(s.published).toEqual([1]); // pushed and released inside the window
    expect(readlinkSync(join(s.t.root, "current"))).toContain("-update-01");
    expect(types(s.notices)).toEqual(["armed"]); // nothing posted before its minute
    at(s, "10:59");
    await s.runner.tick();
    expect(types(s.notices)).toEqual(["armed"]);
    at(s, "11:00");
    await s.runner.tick();
    await s.runner.tick();
    expect(types(s.notices)).toEqual(["armed", "released:1"]);
    expect(s.notices[1]).toMatchObject({ what: "Live on testnet; live checks pass; public commit and GitHub release published.", link: "https://github.com/tourbillondev/tourbillon/releases/tag/update-01" });
    expect(s.runner.st.u[1]!.workMs).toBeGreaterThanOrEqual(0);
    const msg = sh(["git", "log", "-1", "--format=%an|%B", s.runner.st.u[1]!.commit!], s.repo).out.trim();
    expect(msg).toBe("tourbillondev|Update 01: Title 1"); // the commit author (AUTHOR in publish.ts)
    expect(sh(["git", "show", `${s.runner.st.u[1]!.commit!}:CHANGELOG.md`], s.repo).out).toContain("- Update 01 · 2026-12-01 11:00 UTC: Title 1: a new thing.");
  });

  test("a failing test in the window: an emergency at once; fixed in time with release N, it clears and posts at its minute", async () => {
    const flag = join(tmp("flag"), "fail");
    writeFileSync(flag, "1");
    const s = setup(1, { tests: ["sh", "-c", `test ! -f ${flag}`] });
    await s.runner.applyControl({ cmd: "arm", arg: ARM });
    at(s, "10:30");
    await s.runner.tick();
    expect(s.runner.st.u[1]?.state).toBe("failed");
    expect(types(s.notices)).toEqual(["armed", "alarm:release-tests-failed-01"]);
    expect(s.notices[1]!.alarm!.what).toContain("the tests failed");
    expect(s.notices[1]!.alarm!.who).toBe("Dev fixes it, then on the server: tourbillon-release release 1.");
    rmSync(flag);
    expect(await s.runner.applyControl({ cmd: "release", arg: "1" })).toContain("then it goes out at 11:00 UTC");
    at(s, "10:40");
    await s.runner.tick();
    expect(types(s.notices).slice(2)).toEqual(["cleared:release-tests-failed-01"]);
    expect(s.notices[2]!.reason).toBe("Update 01 is ready for its posting time");
    at(s, "11:00");
    await s.runner.tick();
    expect(types(s.notices).at(-1)).toBe("released:1");
  });

  test("still failing at the minute: HELD (the alarm says so), and the next update keeps its own time", async () => {
    const s = setup(2, { badPatch: [1] });
    await s.runner.applyControl({ cmd: "arm", arg: ARM });
    at(s, "10:30");
    await s.runner.tick();
    expect(types(s.notices)).toEqual(["armed", "alarm:release-gate-failed-01"]);
    at(s, "11:00");
    await s.runner.tick();
    expect(types(s.notices).slice(2)).toEqual(["held:1", "alarm:release-gate-failed-01"]);
    expect(s.notices[2]!.what).toContain("It was not ready at its posting time.");
    expect(s.notices[2]!.next).toBe("Fix it, then on the server: tourbillon-release release 1. Update 02 at 12:00 UTC keeps its time.");
    expect(s.notices[3]!.alarm!.what).toContain("was not ready at its posting time and is held");
    at(s, "11:30");
    await s.runner.tick();
    expect(s.runner.st.u[2]?.state).toBe("ready");
    at(s, "12:00");
    await s.runner.tick();
    expect(types(s.notices).at(-1)).toBe("released:2");
  });

  test("a failed live check rolls back in the window; still failing at the minute it is ROLLED BACK", async () => {
    const s = setup(1, { down: new Set(["/u1"]) });
    await s.runner.applyControl({ cmd: "arm", arg: ARM });
    at(s, "10:30");
    await s.runner.tick();
    expect(types(s.notices)).toEqual(["armed", "alarm:release-live-check-failed-01"]);
    expect(readlinkSync(join(s.t.root, "current"))).toContain("-base");
    at(s, "11:00");
    await s.runner.tick();
    expect(types(s.notices)).toEqual(["armed", "alarm:release-live-check-failed-01", "rolled_back:1", "alarm:release-live-check-failed-01"]);
  });

  test("testnet then the second target: both live and checked before it is ready; the second failing rolls both back", async () => {
    const s = setup(1, { second: { down: new Set(["/u1"]) } });
    await s.runner.applyControl({ cmd: "arm", arg: ARM });
    at(s, "10:30");
    await s.runner.tick();
    expect(s.runner.st.u[1]?.state).toBe("failed");
    expect(readlinkSync(join(s.t.root, "current"))).toContain("-base");
    expect(readlinkSync(join(s.t2!.root, "current"))).toContain("-base");
    expect(s.published).toEqual([]);
  });

  test("publish fails: an emergency and retries every 2 minutes; at the minute RELEASE DELAYED; then released once", async () => {
    const s = setup(1, { publishFails: { step: "github", times: 16 } });
    await s.runner.applyControl({ cmd: "arm", arg: ARM });
    at(s, "10:30");
    await s.runner.tick();
    expect(s.runner.st.u[1]?.state).toBe("live");
    expect(types(s.notices)).toEqual(["armed", "alarm:release-github-failed-01"]);
    for (let i = 0; i < 15; i++) {
      s.advance(2 * 60_000);
      await s.runner.tick();
    }
    expect(types(s.notices)).toEqual(["armed", "alarm:release-github-failed-01", "delayed:1"]); // one alarm, retried quietly
    s.advance(12 * 60_000);
    await s.runner.tick();
    expect(types(s.notices)).toEqual(["armed", "alarm:release-github-failed-01", "delayed:1", "cleared:release-github-failed-01", "released:1"]);
  });

  test("a restart in the middle neither repeats nor skips: the same state goes on", async () => {
    const s = setup(2);
    await s.runner.applyControl({ cmd: "arm", arg: ARM });
    at(s, "10:30");
    await s.runner.tick();
    const again = s.make(); // a restart
    expect(again.st.u[1]!.state).toBe("ready");
    await again.tick();
    expect(s.published).toEqual([1]); // not published again
    at(s, "11:00");
    await again.tick();
    const fresh = s.make();
    await fresh.tick();
    expect(types(s.notices).filter((x) => x === "released:1")).toHaveLength(1);
  });

  test("pause stops new work and posts; resume tells the overdue count; overdue go 2 minutes apart", async () => {
    const s = setup(3);
    await s.runner.applyControl({ cmd: "arm", arg: ARM });
    await s.runner.applyControl({ cmd: "pause", arg: "check" });
    at(s, "13:10");
    await s.runner.tick();
    expect(s.runner.st.u[1]).toBeUndefined();
    await s.runner.applyControl({ cmd: "resume" });
    expect(s.notices.find((x) => x.type === "resumed")!.overdue).toBe(3);
    await s.runner.tick();
    expect(types(s.notices).filter((x) => x.startsWith("released"))).toEqual(["released:1"]);
    s.advance(60_000);
    await s.runner.tick();
    expect(types(s.notices).filter((x) => x.startsWith("released"))).toEqual(["released:1"]);
    s.advance(60_000);
    await s.runner.tick();
    expect(types(s.notices).filter((x) => x.startsWith("released"))).toEqual(["released:1", "released:2"]);
  });

  test("hold from the server: HELD at once, its alarm cleared; release puts it back", async () => {
    const s = setup(2);
    await s.runner.applyControl({ cmd: "arm", arg: ARM });
    expect(await s.runner.applyControl({ cmd: "hold", arg: "1", rest: "a check" })).toBe("Update 01 is held. The next one keeps its time.");
    expect(types(s.notices)).toEqual(["armed", "held:1"]);
    expect(s.notices[1]!.what).toBe("Held from the server: a check.");
    expect(await s.runner.applyControl({ cmd: "release", arg: "1" })).toContain("back in the queue");
    expect(await s.runner.applyControl({ cmd: "release", arg: "2" })).toContain("Nothing changed");
  });

  test("resume only after a pause, pause only once; disarm only before any work; an update already out cannot be held", async () => {
    const s = setup(2);
    await s.runner.applyControl({ cmd: "arm", arg: ARM });
    expect(await s.runner.applyControl({ cmd: "resume" })).toBe("Not paused. Nothing changed.");
    await s.runner.applyControl({ cmd: "pause", arg: "x" });
    expect(await s.runner.applyControl({ cmd: "pause", arg: "y" })).toBe("Already paused (x). Nothing changed.");
    await s.runner.applyControl({ cmd: "resume" });
    expect(types(s.notices)).toEqual(["armed", "paused", "resumed"]); // never a RESUMED without a PAUSED
    at(s, "11:00");
    await s.runner.tick();
    await s.runner.tick();
    expect(await s.runner.applyControl({ cmd: "disarm" })).toBe("Work has already started: use pause instead.");
    expect(await s.runner.applyControl({ cmd: "hold", arg: "1" })).toBe("Update 01 is released: nothing to hold.");
  });

  test("test N and preflight go to the team bot as notices", async () => {
    const s = setup(2, { badPatch: [2] });
    expect(await s.runner.applyControl({ cmd: "test", arg: "1" })).toContain("Alert Test, marked TEST");
    const out = await s.runner.applyControl({ cmd: "preflight", arg: "--post" });
    expect(out).toContain("1 of 2 ready");
    expect(types(s.notices)).toEqual(["test:1", "preflight"]);
  });

  test("every notice id is unique", async () => {
    const s = setup(2, { badPatch: [1] });
    await s.runner.applyControl({ cmd: "arm", arg: ARM });
    at(s, "12:00");
    for (let i = 0; i < 5; i++) {
      await s.runner.tick();
      s.advance(60_000);
    }
    expect(new Set(s.notices.map((x) => x.id)).size).toBe(s.notices.length);
  });

  test("the team bot's heartbeat: a fresh one after the restart is a live check; missing while armed, an alarm every 2 minutes, then cleared", async () => {
    const beat = join(tmp("tb"), "heartbeat");
    const s = setup(1, { second: {}, teambotBeat: beat });
    await s.runner.applyControl({ cmd: "arm", arg: ARM });
    at(s, "10:30");
    await s.runner.tick(); // no fresh heartbeat after the second target's restart: rolled back
    expect(types(s.notices)).toContain("alarm:release-live-check-failed-01");
    expect(s.alarms[0]).toStartWith("🔴 ALERT · teambot-heartbeat-missing");
    s.advance(60_000);
    await s.runner.tick();
    expect(s.alarms).toHaveLength(1);
    s.advance(60_000);
    await s.runner.tick();
    expect(s.alarms).toHaveLength(2);
    expect(s.alarms[1]).toContain("Still open after");
    writeFileSync(beat, "x");
    const t = new Date(s.at());
    Bun.spawnSync(["touch", "-d", t.toISOString(), beat]);
    utimesSync(beat, t, t);
    await s.runner.tick();
    expect(s.alarms.at(-1)).toBe("🟢 CLEARED · teambot-heartbeat-missing (the team bot is running again)");
  });

  test("its own heartbeat every tick", async () => {
    const s = setup(1);
    await s.runner.tick();
    expect(existsSync(join(s.data, "heartbeat"))).toBe(true);
  });
});

describe("job lock", () => {
  test("a second job on the same folder is refused; a stale lock is taken over", () => {
    const dir = tmp("lock");
    const free = takeLock(dir, 111, () => true);
    expect(() => takeLock(dir, 222, () => true)).toThrow("another release job (process 111) is already running");
    expect(() => takeLock(dir, 222, (p) => p !== 111)).not.toThrow(); // 111 has stopped: its lock is taken over
    free();
  });
});

// ---------- config and secrets ----------
describe("config and secrets", () => {
  const cfg = (over: Partial<ReleaseConfig> = {}, targets?: Target[]): ReleaseConfig => {
    const root = tmp("cfg");
    return {
      dryRun: false, repo: "tourbillondev/tourbillon", tagPrefix: "update-", base: "x", queueDir: root, kitDir: root, dataDir: root, releasesLog: join(root, "l"), secretsFile: join(root, "s"),
      teambotInbox: join(root, "inbox"), teambotHeartbeat: join(root, "hb"), teambotTarget: "mainnet", pushRemote: "git@github-tourbillon-release:tourbillondev/tourbillon.git", deployKeyFile: join(root, "key"), githubTokenFile: join(root, "tok"),
      total: 62, slotMinutes: 60, leadMinutes: 30, mainnetAllowed: false, testnetProof: join(root, "proof.json"),
      deploy: { repoDir: root, buildsDir: root, install: [], tests: [], targets: targets ?? [target(root)], checkTimeoutMs: 1, keepReleases: 3 },
      ...over,
    };
  };
  test("mainnet stays off without the owner's flag and a passing testnet proof", () => {
    const root = tmp("m");
    const t = [target(root), target(root, "mainnet", 4663)];
    expect(configProblems(cfg({}, t))).toEqual(["a mainnet target is on but mainnetAllowed is false.", expect.stringContaining("no passing testnet proof")]);
    const c = cfg({ mainnetAllowed: true }, t);
    writeFileSync(c.testnetProof, JSON.stringify({ passed: true }));
    expect(configProblems(c)).toEqual([]);
    expect(configProblems(cfg({}, [{ ...t[1]!, enabled: false }, t[0]!]))).toContain("the testnet target must come before the mainnet target.");
  });
  test("the real run pushes only to tourbillondev/tourbillon over ssh with the deploy key, and checks the team bot on mainnet", () => {
    const root = tmp("pk");
    const two = [target(root), { ...target(root, "mainnet", 4663), enabled: false }];
    expect(configProblems(cfg({ pushRemote: "git@github.com:someone/else.git" }, two))).toContain("the real run pushes only to tourbillondev/tourbillon over ssh (pushRemote).");
    expect(configProblems(cfg({ deployKeyFile: undefined }, two))).toContain("the real run needs deployKeyFile (the deploy key limited to tourbillondev/tourbillon).");
    expect(configProblems(cfg({ teambotTarget: "testnet" }, two))).toContain("the real run checks the team bot's heartbeat after the mainnet deploy (teambotTarget: mainnet).");
  });
  test("the real run has testnet then mainnet", () => {
    const root = tmp("rr");
    expect(configProblems(cfg({}, [target(root)]))).toContain("the real run has exactly two targets: testnet first, then mainnet.");
    expect(configProblems(cfg({}, [target(root), { ...target(root, "mainnet", 4663), enabled: false }]))).toEqual([]);
  });
  test("only a dry run may change the hourly slot or use a fake Telegram, and never with mainnet", () => {
    expect(configProblems(cfg({ slotMinutes: 3 }, [target(tmp("s3")), { ...target(tmp("s4"), "mainnet", 4663), enabled: false }]))).toContain("the real schedule is one update every 60 minutes, its work starting 30 minutes before (only a dry run may change it).");
    expect(configProblems(cfg({ leadMinutes: 45 }, [target(tmp("s5")), { ...target(tmp("s6"), "mainnet", 4663), enabled: false }]))).toContain("the real schedule is one update every 60 minutes, its work starting 30 minutes before (only a dry run may change it).");
    const r2 = tmp("d2");
    const dry = { dryRun: true, slotMinutes: 3, leadMinutes: 1, telegramApi: "http://127.0.0.1:1", teambotTarget: "mainnet-standin", pushRemote: "git@github-tourbillon-release:tourbillondev/tourbillon-dryrun.git" };
    expect(configProblems(cfg(dry, [target(r2), target(r2, "mainnet-standin")]))).toEqual([]);
    expect(configProblems(cfg({ ...dry, pushRemote: "git@github-tourbillon-release:tourbillondev/tourbillon.git" }, [target(r2), target(r2, "mainnet-standin")]))).toContain("a dry run may never push to tourbillondev/tourbillon (use the throwaway repo or a local one).");
    expect(configProblems(cfg({ dryRun: true }, [target(r2)]))).toContain("a dry run needs two targets: testnet, then a second test target standing in for mainnet.");
    const root = tmp("d");
    expect(configProblems(cfg({ dryRun: true }, [target(root), { ...target(root, "mainnet", 4663), enabled: false }]))).toContain("a dry run may not have a mainnet target.");
  });
  test("the secrets file must be private and complete; the token is scrubbed", () => {
    const root = tmp("sec");
    const p = join(root, "alerts.env");
    writeFileSync(p, "ALERT_BOT_TOKEN=123456:abcdefghijklmnopqrstuvwxyz\nTEST_CHAT_ID=-1001\n", { mode: 0o644 });
    expect(() => readSecrets(p)).toThrow("readable by others");
    Bun.spawnSync(["chmod", "600", p]);
    expect(readSecrets(p)).toEqual({ token: "123456:abcdefghijklmnopqrstuvwxyz", testChat: "-1001" });
    expect(scrub("x bot123456:abcdefghijklmnopqrstuvwxyz/y", "123456:abcdefghijklmnopqrstuvwxyz")).toBe("x bot[token]/y");
  });
});

describe("server commands", () => {
  test("every command the control script sends is one the job answers", async () => {
    const { COMMANDS } = await import("../src/ctl.ts");
    const runner = readFileSync(join(import.meta.dir, "../src/runner.ts"), "utf8");
    for (const c of COMMANDS) expect(runner.includes(`case "${c}":`) || runner.includes(`case "${c}": {`)).toBe(true);
    expect(COMMANDS).toContain("release");
  });
});

// ---------- the release system and the real team bot together (playbook 07 §8, 06 §2) ----------
describe("release system to team bot", () => {
  test("released, held at the gate, failed tests then fixed: every post once, in order, in the right group", async () => {
    const STAFF = -1001;
    const TEST = -1002;
    let s!: ReturnType<typeof setup>;
    const flag = join(tmp("flag"), "fail");
    let kitDir = "";
    s = setup(3, { badPatch: [2], tests: ["sh", "-c", `test ! -f ${flag}`], notify: (id, body) => inboxNotifier(inboxDir(kitDir), () => s.at())(id, body) });
    kitDir = s.kit;
    writeFileSync(join(s.kit, "config.json"), JSON.stringify({ repo: "tourbillondev/tourbillon", explorer: "https://explorer.test", settlementSymbol: "USDG", contracts: [], socials: [], videos: [], health: [] }));
    const posts: { chat: number; kind: string; text: string; file?: string }[] = [];
    let id = 0;
    const rec = (chat: number, kind: string, text: string, file?: string) => (posts.push({ chat, kind, text, file }), ++id);
    const tg: Tg = {
      send: async (c, t) => rec(c, "message", t),
      photo: async (c, f, t) => rec(c, "photo", t, f.split("/").pop()),
      document: async (c, name, data, t) => rec(c, "zip", t, `${name}:${data.length}`),
      edit: async () => {},
      pin: async () => {},
      me: async () => "bot",
      setCommands: async () => {},
      updates: async () => [],
      copy: async () => {},
    };
    const bot = createTeambot({ book: loadBook(s.kit), tg, chat: STAFF, testChat: TEST, now: () => s.at(), log: () => {}, sleep: async () => {} });
    const both = async () => {
      await s.runner.tick();
      await bot.inboxTick();
      await bot.alarmTick();
    };
    await s.runner.applyControl({ cmd: "arm", arg: ARM });
    for (const hhmm of ["10:00", "10:30", "11:00", "11:30", "12:00", "12:30"]) {
      if (hhmm === "12:30") writeFileSync(flag, "1"); // update 3's tests fail in its window
      at(s, hhmm);
      await both();
    }
    rmSync(flag); // update 3's tests were failing in its window; fixed
    await s.runner.applyControl({ cmd: "release", arg: "3" });
    for (const hhmm of ["12:31", "12:40", "13:00", "13:01"]) {
      at(s, hhmm);
      await both();
    }
    const staff = posts.filter((p) => p.chat === STAFF).map((p) => `${p.kind}:${p.text.split("\n")[0]}`);
    expect(staff).toEqual([
      "message:🟢 <b>SCHEDULE ARMED</b>",
      "message:<b>Day 1 · from Tue, 1 Dec</b>",
      "photo:🟢 <b>TOURBILLON IS LIVE</b>".replace("photo", "message"), // no launch poster in this kit: the text alone
      "message:<b>Tech Updates: Update 01 Released</b>",
      "photo:Update 01 of 3",
      "zip:Update 01 · square poster, full quality (1080x1080 PNG)",
      "photo:For X · 32 characters",
      "zip:Update 01 · wide poster, full quality (1200x675 PNG)",
      "message:✅ SHIPPED AND RELEASED · Update 01 · release update-01",
      "message:🟡 HELD · Update 02 · release update-02",
      "message:<b>Tech Updates: Update 03 Released</b>",
      "photo:Update 03 of 3",
      "zip:Update 03 · square poster, full quality (1080x1080 PNG)",
      "photo:For X · 32 characters",
      "zip:Update 03 · wide poster, full quality (1200x675 PNG)",
      "message:✅ SHIPPED AND RELEASED · Update 03 · release update-03",
    ]);
    const alerts = posts.filter((p) => p.chat === TEST).map((p) => p.text.split("\n")[0]);
    expect(alerts[0]).toBe("🔴 ALERT · release-gate-failed-02");
    expect(alerts).toContain("🔴 ALERT · release-tests-failed-03");
    expect(alerts).toContain("🟢 CLEARED · release-tests-failed-03 (Update 03 is ready for its posting time)");
    expect(alerts.filter((a) => a === "🟢 CLEARED · release-tests-failed-03 (Update 03 is ready for its posting time)")).toHaveLength(1);
    expect(posts.every((p) => p.chat === STAFF || p.chat === TEST)).toBe(true);
    expect(readdirSync(inboxDir(s.kit)).filter((f) => f.endsWith(".json"))).toEqual([]); // every notice handled
  });
});

// ---------- preflight while the owner has not approved a poster design (RH10) ----------
describe("preflight with posters pending", () => {
  test("every change still applies in order; the summary says only posters wait; a broken patch is still named", () => {
    const w = world(3);
    rmSync(join(w.kit, "posters"), { recursive: true, force: true }); // no design approved yet: no posters drawn
    const p = preflight({ repoDir: w.repo, base: w.base, queueDir: w.queue, kitDir: w.kit, repo: "tourbillondev/tourbillon" });
    expect(p.ready).toBe(0);
    expect(p.onlyPosters).toBe(3);
    expect(preflightText(p)).toStartWith("🟡 PREFLIGHT · 0 of 3 ready · 3 wait only for posters pending owner approval\n\nEvery other check passes: texts checked, every change applies in order.");
    // update 2's patch no longer applies onto update 1: still found, though its posters are pending too
    writeFileSync(join(w.queue, "02", "patch.diff"), "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-not the line there\n+x\n");
    const q = preflight({ repoDir: w.repo, base: w.base, queueDir: w.queue, kitDir: w.kit, repo: "tourbillondev/tourbillon" });
    expect(q.onlyPosters).toBe(2);
    expect(preflightText(q)).toContain("02 (update-02) posters pending owner approval. patch.diff does not apply onto the previous update");
  });
});
