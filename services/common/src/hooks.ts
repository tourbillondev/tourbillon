import { relative, resolve } from "node:path";

/// Time limits for the local-stack test hooks (anvil, Postgres). A hook that runs past its limit fails at once with
/// its test file and step named, instead of holding the whole suite (RH14: one setup hook once hung for 81 minutes).
/// The helpers' own blocking calls (initdb, pg_ctl, forge script) carry their own limits too, because a blocked thread
/// would stop this timer from firing.
export const SETUP_MS = 300_000;
export const TEARDOWN_MS = 60_000;
const ROOT = resolve(import.meta.dir, "../../..");

/// Wraps a hook body: rejects with "<file>: <step> did not finish in N s" when it runs past `ms`. Pass the hook's own
/// bun time limit a little above `ms` (see `hookLimit`) so this message is the one reported.
export function within(file: string, step: string, ms: number, fn: () => unknown): () => Promise<unknown> {
  return () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${relative(ROOT, file)}: ${step} did not finish in ${ms / 1000} s`)), ms);
    });
    return Promise.race([Promise.resolve().then(fn), limit]).finally(() => clearTimeout(timer));
  };
}
export const hookLimit = (ms: number) => ms + 5_000;
