import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addsMigration, currentRelease, setupTarget, type DeployConfig, type Target } from "../src/deploy.ts";
import { sh } from "../src/gate.ts";
import { publicMain, type PublishConfig } from "../src/publish.ts";
import { createRunner, saveState, loadState } from "../src/runner.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `project-dm-${p}-`));
const git = (cwd: string, ...a: string[]) => {
  const r = sh(["git", "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...a], cwd);
  if (!r.ok) throw new Error(`git ${a.join(" ")}: ${r.err}`);
  return r.out.trim();
};
function commit(dir: string, file: string, text: string, msg: string): string {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), text);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
}
const journal = (tags: string[]) => JSON.stringify({ entries: tags.map((tag) => ({ tag })) });

/// The release clone, a bare "public" repo, someone who merges to main, two targets, and a job whose 2 updates are out.
function world(o: { released?: number; at?: string } = {}) {
  const work = tmp("work");
  git(work, "init", "-q", "-b", "main");
  commit(work, "services/drizzle/meta/_journal.json", journal(["0000_a"]), "base");
  const live = git(work, "rev-parse", "HEAD");
  const pub = join(tmp("pub"), "public.git");
  sh(["git", "clone", "-q", "--bare", work, pub], tmpdir());
  const dev = tmp("dev");
  sh(["git", "clone", "-q", pub, dev], tmpdir());
  const root = tmp("targets");
  const ran: string[] = [];
  const target = (name: string): Target => ({
    name, chainId: 46630, root: join(root, name), baseUrl: `http://${name}.local`, enabled: true,
    restart: { api: [["true", `restart-${name}`]], keeper: [["true", `restart-${name}`]] },
    migrate: [["true", `migrate-${name}`]], checks: [{ name: "health", path: "/healthz", expect: '"ok":true' }],
  });
  const targets = [target("testnet"), target("mainnet-standin")];
  const cfg: DeployConfig = { repoDir: work, buildsDir: join(root, "builds"), install: [], tests: [], targets, checkTimeoutMs: 1_000, keepReleases: 8 };
  const base = join(root, "base");
  sh(["git", "worktree", "add", "-q", "--detach", base, live], work);
  for (const t of targets) setupTarget(t, base, Date.UTC(2026, 10, 21, 5, 0));
  const queueDir = tmp("queue");
  for (const n of [1, 2]) {
    mkdirSync(join(queueDir, `0${n}`));
    writeFileSync(join(queueDir, `0${n}`, "meta.json"), JSON.stringify({ number: n, group: "DOCS", title: `U${n}`, new: "x", verify: { what: "x", how: "x" }, files: ["docs"], tests: ["t"], deploy: "none", migration: false, checks: [{ name: `page ${n}`, path: `/u${n}`, expect: "here" }] }));
  }
  const dataDir = tmp("data");
  const st = loadState(dataDir, live);
  const released = o.released ?? 2;
  Object.assign(st, { launchAt: "2026-11-21T03:00:00.000Z", launchPosted: true, head: live, u: Object.fromEntries(Array.from({ length: released }, (_, i) => [String(i + 1), { state: "released" }])) });
  saveState(dataDir, st);
  let clock = Date.parse(o.at ?? "2026-11-21T13:06:00Z");
  const notices: { id: string; body: Record<string, unknown> }[] = [];
  // a live check fails on any target whose live release carries services/BREAK
  const fetchFn = (async (url: string | URL | Request) => {
    const u = new URL(String(url));
    const t = targets.find((x) => x.baseUrl === `${u.protocol}//${u.host}`)!;
    const broken = existsSync(join(t.root, "current", "services", "BREAK"));
    if (u.pathname === "/healthz") return new Response(broken ? `{"ok":false}` : `{"ok":true}`, { status: broken ? 503 : 200 });
    return new Response("here", { status: 200 });
  }) as unknown as typeof fetch;
  const pubCfg: PublishConfig = { repoDir: work, repo: "x/y", remote: pub, token: "T" };
  const runner = createRunner({
    dataDir, queueDir, kitDir: tmp("kit"), repo: "x/y", deployCfg: cfg, publish: async () => "", releasesLog: join(dataDir, "releases.log"), base: live,
    notify: (id, body) => notices.push({ id, body }), readMain: () => publicMain(pubCfg), total: 2,
    run: (cmd, cwd) => (ran.push(cmd.slice(1).join(" ")), sh(cmd, cwd)), fetch: fetchFn, sleep: async (ms) => void (clock += ms), now: () => clock, log: () => {},
  });
  const push = (file: string, text: string, msg: string) => {
    const c = commit(dev, file, text, msg);
    git(dev, "push", "-q", "origin", "HEAD:main");
    return c;
  };
  const deployMain = async (arg?: string) => {
    const text = await runner.applyControl({ id: "c1", cmd: "deploy-main", arg });
    await runner.tick();
    return text;
  };
  return { work, pub, dev, live, targets, runner, notices, ran, push, deployMain, dataDir, setClock: (iso: string) => (clock = Date.parse(iso)) };
}

describe("deploy-main: refusals", () => {
  test("only after every update is out", async () => {
    const w = world({ released: 1 });
    w.push("docs/a.md", "a\n", "docs");
    expect(await w.deployMain("abcdef0")).toContain("update 02 not released yet");
  });

  test("only between :05 and :25 UTC", async () => {
    const w = world({ at: "2026-11-21T13:30:00Z" });
    const c = w.push("docs/a.md", "a\n", "docs");
    expect(await w.deployMain(c.slice(0, 7))).toBe("Refused: it is 13:30 UTC. deploy-main starts only between :05 and :25 past the hour.");
    w.setClock("2026-11-21T13:25:00Z");
    expect(await w.deployMain(c.slice(0, 7))).toContain("Refused: it is 13:25 UTC");
  });

  test("the commit must be named, and be the public main's tip; it says which commit main is", async () => {
    const w = world();
    const c = w.push("docs/a.md", "a\n", "docs: a page");
    expect(await w.deployMain()).toBe(`Refused: name the commit to deploy. The public main is ${c.slice(0, 12)} (docs: a page). To deploy it: tourbillon-release deploy-main ${c.slice(0, 7)}`);
    expect(await w.deployMain(w.live.slice(0, 7))).toContain(`is not the public main's tip. The public main is ${c.slice(0, 12)}`);
  });

  test("main already live: nothing to do; main not containing the live commit: refused", async () => {
    const w = world();
    expect(await w.deployMain(w.live.slice(0, 7))).toBe(`Nothing to do: ${w.live.slice(0, 12)} is already live.`);
    git(w.dev, "checkout", "-q", "--orphan", "x");
    const stranger = commit(w.dev, "z.txt", "z\n", "unrelated");
    git(w.dev, "push", "-q", "--force", "origin", `${stranger}:refs/heads/main`);
    expect(await w.deployMain(stranger.slice(0, 7))).toContain("does not contain");
  });

  test("a co-author or generated-with line anywhere since the live commit: refused", async () => {
    const w = world();
    const c = w.push("docs/a.md", "a\n", "docs\n\nCo-Authored-By: someone <x@example.invalid>"); // words-lint: allow (test data: the line the check refuses)
    expect(await w.deployMain(c.slice(0, 7))).toContain("co-author");
  });

  test("not while paused, and not while another deploy-main runs", async () => {
    const w = world();
    const c = w.push("docs/a.md", "a\n", "docs");
    await w.runner.applyControl({ cmd: "pause", arg: "maintenance" });
    expect(await w.runner.applyControl({ id: "x", cmd: "deploy-main", arg: c.slice(0, 7) })).toContain("paused");
    await w.runner.applyControl({ cmd: "resume" });
    expect(await w.runner.applyControl({ id: "x", cmd: "deploy-main", arg: c.slice(0, 7) })).toStartWith("Deploying main");
    expect(await w.runner.applyControl({ id: "y", cmd: "deploy-main", arg: c.slice(0, 7) })).toContain("is still queued");
  });
});

describe("deploy-main: the deploy", () => {
  test("goes live on testnet, then mainnet, with every update's checks; nothing is posted; the releases log has one line", async () => {
    const w = world();
    const c = w.push("docs/a.md", "a\n", "docs: a page");
    expect(await w.deployMain(c.slice(0, 7))).toStartWith(`Deploying main ${c.slice(0, 12)} (docs: a page), live now: ${w.live.slice(0, 12)}`);
    const st = w.runner.st;
    expect(st.main?.phase).toBe("live");
    expect(st.head).toBe(c);
    for (const t of w.targets) expect(currentRelease(t.root)).toMatch(new RegExp(`-main-${c.slice(0, 7)}$`));
    expect(w.ran.filter((r) => r.startsWith("restart-") || r.startsWith("migrate-"))).toEqual(["restart-testnet", "restart-testnet", "restart-mainnet-standin", "restart-mainnet-standin"]);
    expect(w.notices).toEqual([]); // no post
    const lines = readFileSync(join(w.dataDir, "releases.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "deploy-main", status: "live", commit: c, from: w.live });
    expect(w.runner.statusText()).toContain(`Live:     ${c.slice(0, 12)}   last deploy-main ${c.slice(0, 12)} live`);
  });

  test("a commit that adds a database migration runs the database step on each target before its restart", async () => {
    const w = world();
    const c = w.push("services/drizzle/meta/_journal.json", journal(["0000_a", "0001_b"]), "db: a new table");
    await w.deployMain(c.slice(0, 7));
    expect(w.runner.st.main?.phase).toBe("live");
    expect(w.ran.filter((r) => r.startsWith("restart-") || r.startsWith("migrate-"))).toEqual(["migrate-testnet", "restart-testnet", "restart-testnet", "migrate-mainnet-standin", "restart-mainnet-standin", "restart-mainnet-standin"]);
  });

  test("a live check that fails rolls back, mainnet is never touched, and Alert Test gets the emergency until a later deploy goes live", async () => {
    const w = world();
    const bad = w.push("services/BREAK", "x\n", "a change that breaks health");
    await w.deployMain(bad.slice(0, 7));
    const st = w.runner.st;
    expect(st.main?.phase).toBe("rolled_back");
    expect(st.head).toBe(w.live);
    expect(currentRelease(w.targets[0]!.root)).toMatch(/-base$/);
    expect(currentRelease(w.targets[1]!.root)).toMatch(/-base$/);
    expect(w.ran).not.toContain("restart-mainnet-standin");
    expect(w.notices).toHaveLength(1);
    const a = w.notices[0]!.body as { type: string; alarm: { name: string; what: string; who: string } };
    expect(a.type).toBe("alarm");
    expect(a.alarm.name).toBe(`release-main-live-check-failed-${bad.slice(0, 7)}`);
    expect(a.alarm.what).toContain("testnet: health: /healthz answered 503");
    expect(a.alarm.what).toContain("Rolled back automatically: testnet is back on");
    // fixed on main, deployed again: live, and the emergency clears
    git(w.dev, "rm", "-q", "services/BREAK");
    git(w.dev, "commit", "-q", "-m", "fix: health again");
    git(w.dev, "push", "-q", "origin", "HEAD:main");
    const good = git(w.dev, "rev-parse", "HEAD");
    await w.deployMain(good.slice(0, 7));
    expect(w.runner.st.main?.phase).toBe("live");
    expect(w.notices.at(-1)!.body).toMatchObject({ type: "cleared", name: `release-main-live-check-failed-${bad.slice(0, 7)}` });
    expect(readlinkSync(join(w.targets[1]!.root, "current"))).toMatch(new RegExp(`-main-${good.slice(0, 7)}$`));
  });

  test("failing tests: nothing deployed, the tests emergency", async () => {
    const w = world();
    const c = w.push("docs/a.md", "a\n", "docs");
    // the job's tests are a command that fails on this tree
    const r = createRunnerWithFailingTests(w);
    await r.applyControl({ id: "t", cmd: "deploy-main", arg: c.slice(0, 7) });
    await r.tick();
    expect(r.st.main?.phase).toBe("failed");
    expect(r.st.main?.why).toContain("the tests failed");
    for (const t of w.targets) expect(currentRelease(t.root)).toMatch(/-base$/);
  });

  test("addsMigration compares the built tree's journal with the live release's", () => {
    const w = world();
    const d = tmp("built");
    mkdirSync(join(d, "services", "drizzle", "meta"), { recursive: true });
    writeFileSync(join(d, "services", "drizzle", "meta", "_journal.json"), journal(["0000_a"]));
    expect(addsMigration(w.targets[0]!, d)).toBe(false);
    writeFileSync(join(d, "services", "drizzle", "meta", "_journal.json"), journal(["0000_a", "0001_b"]));
    expect(addsMigration(w.targets[0]!, d)).toBe(true);
  });
});

function createRunnerWithFailingTests(w: ReturnType<typeof world>) {
  const dataDir = w.dataDir;
  const pubCfg: PublishConfig = { repoDir: w.work, repo: "x/y", remote: w.pub, token: "T" };
  return createRunner({
    dataDir, queueDir: tmp("q2"), kitDir: tmp("k2"), repo: "x/y",
    deployCfg: { repoDir: w.work, buildsDir: tmp("b2"), install: [], tests: [{ cmd: ["sh", "-c", "echo '(fail) something > broke'; exit 1"] }], targets: w.targets, checkTimeoutMs: 1_000, keepReleases: 8 },
    publish: async () => "", releasesLog: join(dataDir, "releases.log"), base: w.live, notify: (id, body) => w.notices.push({ id, body }),
    readMain: () => publicMain(pubCfg), total: 2, now: () => Date.parse("2026-11-21T13:06:00Z"), log: () => {},
  });
}
