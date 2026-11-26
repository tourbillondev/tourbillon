import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sh } from "../src/gate.ts";
import { latestMain, pushCommit, PublishError, type PublishConfig } from "../src/publish.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `project-main-${p}-`));
const git = (cwd: string, ...a: string[]) => {
  const r = sh(["git", "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...a], cwd);
  if (!r.ok) throw new Error(`git ${a.join(" ")}: ${r.err}`);
  return r.out.trim();
};
function commitFile(dir: string, file: string, text: string, msg: string): string {
  writeFileSync(join(dir, file), text);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
}

/// A work repo (the release system's clone) and a bare "public" repo whose main starts at the first commit.
function world() {
  const work = tmp("work");
  git(work, "init", "-q", "-b", "main");
  const live = commitFile(work, "a.txt", "1\n", "base");
  const pub = join(tmp("pub"), "public.git");
  sh(["git", "clone", "-q", "--bare", work, pub], tmpdir());
  const other = tmp("other");
  sh(["git", "clone", "-q", pub, other], tmpdir());
  const c: PublishConfig = { repoDir: work, repo: "x/y", remote: pub, token: "T" };
  return { work, pub, other, live, c };
}

describe("build base: the latest public main", () => {
  test("main is the update live now: build onto it", () => {
    const w = world();
    expect(latestMain(w.c, w.live)).toEqual({ commit: w.live, note: "the public main, which is the update live now" });
  });

  test("main moved on (a merge after the update): build onto main, and the push is a fast-forward", () => {
    const w = world();
    const merged = commitFile(w.other, "v2.txt", "v2\n", "merge v2");
    git(w.other, "push", "-q", "origin", "HEAD:main");
    const b = latestMain(w.c, w.live);
    expect(b.commit).toBe(merged);
    expect(b.note).toContain("moved on");
    // the next update is committed onto main's tip in the release clone, then pushed
    git(w.work, "checkout", "-q", "--detach", merged);
    const next = commitFile(w.work, "u.txt", "update\n", "Update 16");
    pushCommit(w.c, next);
    expect(sh(["git", "rev-parse", "main"], w.pub).out.trim()).toBe(next);
  });

  test("main does not contain the update live now: build onto the live update, as before (the push is then refused)", () => {
    const w = world();
    git(w.other, "checkout", "-q", "--orphan", "x");
    const stranger = commitFile(w.other, "z.txt", "z\n", "unrelated");
    git(w.other, "push", "-q", "--force", "origin", `${stranger}:refs/heads/main`);
    const b = latestMain(w.c, w.live);
    expect(b.commit).toBe(w.live);
    expect(b.note).toContain("does not contain");
    const next = commitFile(w.work, "u.txt", "update\n", "Update 16");
    expect(() => pushCommit(w.c, next)).toThrow(PublishError);
  });

  test("main cannot be read: build onto the live update, as before", () => {
    const w = world();
    const b = latestMain({ ...w.c, remote: join(tmpdir(), "no-such-repo.git") }, w.live);
    expect(b.commit).toBe(w.live);
    expect(b.note).toContain("could not be read");
  });
});
