import { existsSync, readFileSync, statSync } from "node:fs";
import { sh } from "./gate.ts";
import { pad, releaseUrl, tag, type KitUpdate } from "./queue.ts";

/// The public half (owner's decision, 2026-11-18: the release system publishes each update itself):
///   1. push the update's commit to the public repo's main with the deploy key (limited by GitHub to that one repo),
///      never forced: a push that is not a fast-forward is refused and reported;
///   2. make the GitHub release update-NN at that commit, or publish the draft for it if there is one, so there is
///      never a second release. The release token (fine-grained, that repo only, Contents read and write) goes in a
///      header only: never in a URL, a command line, a log or a post.
/// A second run after a crash checks what is already pushed and released and never does it twice.

export const releaseName = (n: number, k: KitUpdate) => `Update ${pad(n)}: ${k.title}`;
export const releaseBody = (k: KitUpdate) => `${k.telegram}\n\n${k.changelog_line}`;

export type PublishConfig = {
  repoDir: string; // the release system's clone of the public repo (update commits are made here)
  repo: string; // tourbillondev/tourbillon
  remote: string; // the push address: git@github-tourbillon-release:tourbillondev/tourbillon.git (a dry run: a local bare repo)
  deployKeyFile?: string; // the deploy key's private half (mode 600); none for a local dry-run remote
  token: string; // the release token
  api?: string; // https://api.github.com (a dry run: a local stand-in)
  fetch?: typeof fetch;
};

export class PublishError extends Error {
  constructor(
    public step: "push" | "github",
    message: string,
  ) {
    super(message);
  }
}

/// A file that holds a secret must be readable by its owner only.
export function readPrivate(path: string, what: string): string {
  if (!existsSync(path)) throw new Error(`${what}: ${path} is missing`);
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`${what}: ${path} must be readable by its owner only (chmod 600)`);
  const v = readFileSync(path, "utf8").trim();
  if (!v) throw new Error(`${what}: ${path} is empty`);
  return v;
}

const gitEnv = (c: PublishConfig): Record<string, string> =>
  c.deployKeyFile ? { GIT_SSH_COMMAND: `ssh -i ${c.deployKeyFile} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes` } : {};
const scrub = (s: string, c: PublishConfig) => (c.token ? s.split(c.token).join("[token]") : s).split("\n")[0]!.slice(0, 300);

/// Step 1: the commit on the public main (skipped when it is already there).
export function pushCommit(c: PublishConfig, commit: string): void {
  const env = gitEnv(c);
  const f = sh(["git", "fetch", "-q", c.remote, "main"], c.repoDir, undefined, env);
  if (!f.ok) throw new PublishError("push", `the public repo could not be read (${scrub(f.err, c)})`);
  if (sh(["git", "merge-base", "--is-ancestor", commit, "FETCH_HEAD"], c.repoDir).ok) return; // already pushed
  if (!sh(["git", "merge-base", "--is-ancestor", "FETCH_HEAD", commit], c.repoDir).ok)
    throw new PublishError("push", "main on GitHub has commits the release system does not have (someone else pushed to main), so the push would not be a fast-forward. Nothing was pushed");
  const p = sh(["git", "push", "-q", c.remote, `${commit}:refs/heads/main`], c.repoDir, undefined, env);
  if (!p.ok) throw new PublishError("push", `the push was refused (${scrub(p.err, c)})`);
}

/// The base for the next build: the public main, read with the deploy key. Used only if it contains the commit live
/// now, so an update can never drop an earlier one. If main cannot be read or does not contain it, the build goes onto
/// the commit live now, exactly as before this change (and the push is then refused and reported as before).
export function latestMain(c: PublishConfig, liveHead: string): { commit: string; note: string } {
  const f = sh(["git", "fetch", "-q", c.remote, "main"], c.repoDir, undefined, gitEnv(c));
  if (!f.ok) return { commit: liveHead, note: `the update live now: the public main could not be read (${scrub(f.err, c)})` };
  const main = sh(["git", "rev-parse", "FETCH_HEAD"], c.repoDir).out.trim();
  if (!/^[0-9a-f]{40}$/.test(main)) return { commit: liveHead, note: "the update live now: the public main could not be read" };
  if (main === liveHead) return { commit: main, note: "the public main, which is the update live now" };
  if (!sh(["git", "merge-base", "--is-ancestor", liveHead, main], c.repoDir).ok)
    return { commit: liveHead, note: "the update live now: the public main does not contain it" };
  return { commit: main, note: "the public main, which has moved on from the update live now" };
}

/// deploy-main: the public main's tip now, fetched into the repo (so its tree can be built).
export function publicMain(c: PublishConfig): { ok: true; commit: string } | { ok: false; why: string } {
  const f = sh(["git", "fetch", "-q", c.remote, "main"], c.repoDir, undefined, gitEnv(c));
  if (!f.ok) return { ok: false, why: scrub(f.err, c).split("\n")[0] ?? "fetch failed" };
  const main = sh(["git", "rev-parse", "FETCH_HEAD"], c.repoDir).out.trim();
  return /^[0-9a-f]{40}$/.test(main) ? { ok: true, commit: main } : { ok: false, why: "no commit at main" };
}

type GhRelease = { id: number; tag_name: string; draft: boolean; html_url?: string };

/// Step 2: the GitHub release at that commit. Gives back its address.
export async function makeRelease(c: PublishConfig, n: number, commit: string, k: KitUpdate): Promise<string> {
  const api = c.api ?? "https://api.github.com";
  const f = c.fetch ?? fetch;
  const headers = { Authorization: `Bearer ${c.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" };
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> => {
    let r: Response;
    try {
      r = await f(`${api}/repos/${c.repo}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new PublishError("github", "GitHub could not be reached");
    }
    let json: unknown = null;
    try {
      json = await r.json();
    } catch {
      /* no body */
    }
    return { status: r.status, json };
  };
  const want = { tag_name: tag(n), target_commitish: commit, name: releaseName(n, k), body: releaseBody(k), draft: false };
  const one = await call("GET", `/releases/tags/${tag(n)}`);
  if (one.status === 200) return (one.json as GhRelease).html_url ?? releaseUrl(c.repo, n); // already published
  if (one.status !== 404) throw new PublishError("github", `GitHub answered ${one.status} when reading the release ${tag(n)}`);
  const list = await call("GET", "/releases?per_page=100");
  if (list.status !== 200) throw new PublishError("github", `GitHub answered ${list.status} when listing the releases`);
  const draft = (list.json as GhRelease[]).find((r) => r.tag_name === tag(n));
  const made = draft ? await call("PATCH", `/releases/${draft.id}`, want) : await call("POST", "/releases", want);
  if (made.status !== 200 && made.status !== 201) throw new PublishError("github", `GitHub answered ${made.status} when ${draft ? "publishing the draft" : "making the release"} ${tag(n)}`);
  return (made.json as GhRelease).html_url ?? releaseUrl(c.repo, n);
}
