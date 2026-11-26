import { loadConfig } from "./config.ts";
import { preflight, preflightText } from "./gate.ts";

/// Checks the whole queue (or some updates) against the gate, in order, in a fresh copy of the repo at the base commit.
/// Changes nothing.
///   bun src/preflight.ts [--config <file>] [--only 3,4] [--up-to 6] [--test]
/// --test also installs and runs the full test commands after each update (as the build step will).
/// Exit code 0 when every checked update is ready, 1 otherwise.

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let config: string | undefined;
  let only: number[] | undefined;
  let upTo: number | undefined;
  let test = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") config = argv[++i];
    else if (a === "--only") only = (argv[++i] ?? "").split(",").map(Number);
    else if (a === "--up-to") upTo = Number(argv[++i]);
    else if (a === "--test") test = true;
    else throw new Error(`unknown flag ${a}`);
  }
  const cfg = loadConfig(config);
  const p = preflight({
    repoDir: cfg.deploy.repoDir,
    base: cfg.base,
    queueDir: cfg.queueDir,
    kitDir: cfg.kitDir,
    repo: cfg.repo,
    only,
    upTo,
    install: test ? cfg.deploy.install : undefined,
    test: test ? cfg.deploy.tests : undefined,
    log: (s) => console.log(s),
  });
  console.log(preflightText(p));
  process.exitCode = p.ready === p.total ? 0 : 1;
}
