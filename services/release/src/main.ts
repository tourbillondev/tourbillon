import { existsSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { inboxNotifier } from "./notify.ts";
import { latestMain, makeRelease, publicMain, pushCommit, readPrivate } from "./publish.ts";
import { createRunner, TICK_MS } from "./runner.ts";
import { readSecrets, scrub, telegramClient } from "./telegram.ts";
import { takeLock } from "./lock.ts";

/// The release system (on the server: systemd unit tourbillon-ship, user tourbillon):
///   bun src/main.ts [--config ~/.tourbillon-release/release.json]
/// It runs all the time; nothing is built, deployed or posted until it is armed (tourbillon-release arm "<time>"). It
/// posts nothing itself: the team bot posts from its notices.

if (import.meta.main) {
  const ci = process.argv.indexOf("--config");
  const cfg = loadConfig(ci >= 0 ? process.argv[ci + 1] : undefined);
  const release = takeLock(cfg.dataDir);
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (release(), process.exit(0)));
  const secrets = readSecrets(cfg.secretsFile);
  const token = readPrivate(cfg.githubTokenFile, "the release token");
  if (cfg.deployKeyFile) readPrivate(cfg.deployKeyFile, "the deploy key");
  const pingUrl = cfg.pingUrlFile && existsSync(cfg.pingUrlFile) ? readPrivate(cfg.pingUrlFile, "the outside check address") : undefined;
  if (!pingUrl) console.log("[release] the outside check is not set up yet (no ping address file): no pings");
  const hide = (m: string) => scrub(scrub(scrub(m, secrets.token), token), pingUrl ?? "");
  const pub = { repoDir: cfg.deploy.repoDir, repo: cfg.repo, remote: cfg.pushRemote, deployKeyFile: cfg.deployKeyFile, token, api: cfg.githubApi };
  const job = createRunner({
    dataDir: cfg.dataDir,
    queueDir: cfg.queueDir,
    kitDir: cfg.kitDir,
    repo: cfg.repo,
    deployCfg: cfg.deploy,
    publish: async (n, commit, k) => {
      pushCommit(pub, commit);
      return makeRelease(pub, n, commit, k);
    },
    buildBase: (liveHead) => latestMain(pub, liveHead),
    readMain: () => publicMain(pub),
    mainWindow: !cfg.dryRun,
    notify: inboxNotifier(cfg.teambotInbox),
    teambotHeartbeat: cfg.teambotHeartbeat,
    teambotTarget: cfg.teambotTarget,
    alarm: telegramClient(secrets.token, { api: cfg.telegramApi }),
    alertChat: secrets.testChat,
    alarmLabel: cfg.dryRun ? "🧪 DRY RUN · EMERGENCY" : undefined,
    ping: pingUrl ? async () => void (await fetch(pingUrl, { signal: AbortSignal.timeout(10_000) })) : undefined,
    releasesLog: cfg.releasesLog,
    base: cfg.base,
    total: cfg.total,
    slotMs: cfg.slotMinutes * 60_000,
    leadMs: cfg.leadMinutes * 60_000,
    catchupMs: cfg.dryRun ? 20_000 : undefined,
    log: (m) => console.log(`[release ${new Date().toISOString().slice(11, 19)}] ${hide(m)}`),
  });
  console.log(`[release] up${cfg.dryRun ? " (DRY RUN)" : ""}: ${job.statusText().split("\n")[0]}`);
  for (;;) {
    await job.tick();
    await Bun.sleep(cfg.dryRun ? 2_000 : TICK_MS);
  }
}
