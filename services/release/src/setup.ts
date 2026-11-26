import { loadConfig } from "./config.ts";
import { buildCore, currentRelease, setupTarget } from "./deploy.ts";

/// One-time set-up before arming: builds the base commit (install and tests), then makes it the first release folder
/// of each enabled target and points `current` at it. A target that already has a `current` is left alone.
///   bun src/setup.ts [--config <file>]

if (import.meta.main) {
  const ci = process.argv.indexOf("--config");
  const cfg = loadConfig(ci >= 0 ? process.argv[ci + 1] : undefined);
  console.log(`building the base ${cfg.base.slice(0, 12)} (install and tests)...`);
  const b = buildCore(cfg.deploy, cfg.base);
  if (!b.ok) {
    console.log(`The base build failed: ${b.why}`);
    process.exit(1);
  }
  for (const t of cfg.deploy.targets.filter((x) => x.enabled)) {
    const cur = currentRelease(t.root);
    if (cur) console.log(`${t.name}: already set up (current -> ${cur}); left alone.`);
    else console.log(`${t.name}: current -> ${setupTarget(t, b.dir)}`);
  }
}
