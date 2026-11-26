/// The quick server check before launch (instead of the full stage 2): update 01's real cycle on TESTNET ONLY through
/// the release system: gate, build, tests, testnet deploy and live checks. Nothing is pushed, nothing is released on
/// GitHub, nothing is posted to the staff group, mainnet is never touched. Then one test emergency to Alert Test through
/// the Tourbillon dry-run bot (send-only), to prove the release system's alarm path.
///   bun server/quick-check.ts --config /home/tourbillon/.tourbillon-release/release.json --alarm /home/tourbillon/.tourbillon-release/dryrun-bot.env
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { inboxNotifier } from "../src/notify.ts";
import { createRunner } from "../src/runner.ts";
import { readSecrets, scrub, telegramClient } from "../src/telegram.ts";

const arg = (k: string) => process.argv[process.argv.indexOf(k) + 1]!;
const cfg = loadConfig(arg("--config"));
const testnet = cfg.deploy.targets.filter((t) => t.chainId === 46630 && t.enabled);
if (testnet.length !== 1 || cfg.deploy.targets.some((t) => t.chainId === 4663 && t.enabled)) throw new Error("STOP: the check needs exactly the testnet target on and mainnet off");
const alarm = readSecrets(arg("--alarm"));
const work = mkdtempSync(join(tmpdir(), "project-quick-"));
const inbox = join(work, "inbox"); // notices go here, never to the team bot
const runner = createRunner({
  dataDir: work,
  queueDir: cfg.queueDir,
  kitDir: cfg.kitDir,
  repo: cfg.repo,
  deployCfg: { ...cfg.deploy, buildsDir: join(work, "builds"), targets: testnet },
  publish: async (n) => `https://github.com/${cfg.repo}/releases/tag/update-${String(n).padStart(2, "0")} (not made: check only)`,
  notify: inboxNotifier(inbox),
  releasesLog: join(work, "releases.log"),
  base: cfg.base,
  total: cfg.total,
  log: (m) => console.log(`  release: ${scrub(m, alarm.token)}`),
});
runner.st.launchAt = new Date(Date.now() - 35 * 60_000).toISOString(); // update 01's window is open now (no real arming)
runner.st.launchPosted = true; // no launch announcement
const t0 = Date.now();
await runner.tick();
const u = runner.st.u[1] ?? {};
const ok = u.state === "ready";
console.log(ok ? `CYCLE OK: update 01 built, tested, deployed on testnet and its live checks pass (${Math.round((Date.now() - t0) / 1000)} s)` : `CYCLE FAILED: ${u.state ?? "did not run"}: ${u.why ?? ""}`);
for (const [k, ms] of Object.entries(u.steps ?? {})) console.log(`  ${k}: ${Math.round(ms / 1000)} s`);
console.log(`  testnet release folder now: ${(u.releases ?? []).join(", ") || "(unchanged)"}`);
console.log(`  notices kept back (never posted): ${readdirSync(inbox).length}`);
const id = await telegramClient(alarm.token).send(
  alarm.testChat,
  `🧪 DRY RUN · EMERGENCY\n🔴 ALERT · release-check-test-01\n\nWhat happened: A test of the release system's alarm path before launch. Nothing is wrong.\nWho acts: nobody.`,
);
console.log(`ALARM OK: one test emergency sent to Alert Test (message ${id})`);
process.exit(ok ? 0 : 1);
