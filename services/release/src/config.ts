import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { DeployConfig } from "./deploy.ts";
import { setTagPrefix } from "./queue.ts";

/// The release job's settings (paths and commands only; no secret). Secrets live in their own file (secretsFile).

export type ReleaseConfig = {
  dryRun: boolean; // a dry run may use a short slot; it may never have a mainnet target
  repo: string; // tourbillondev/tourbillon
  tagPrefix: string; // update-
  base: string; // the commit the first update applies onto (the public repo's main at launch)
  queueDir: string;
  kitDir: string; // tourbillon-teambot-data: updates.json and posters/
  dataDir: string; // state.json, inbox/, zips/
  releasesLog: string;
  teambotInbox: string; // the team bot's inbox: the notices it posts (tourbillon-teambot-data/inbox)
  teambotHeartbeat: string; // the team bot's heartbeat file (tourbillon-teambot-data/heartbeat)
  teambotTarget: string; // the target whose restart restarts the team bot ("mainnet"; a dry run: its stand-in)
  secretsFile: string; // ALERT_BOT_TOKEN and TEST_CHAT_ID (Alert Test), mode 600: only for the team bot's own heartbeat alarm
  pushRemote: string; // git@github-tourbillon-release:tourbillondev/tourbillon.git (a dry run: a local bare repo or the throwaway repo)
  deployKeyFile?: string; // the deploy key's private half, mode 600 (none for a local dry-run remote)
  githubTokenFile: string; // the release token, mode 600
  githubApi?: string; // only for a dry run against a local stand-in
  pingUrlFile?: string; // the outside check's ping address, mode 600 (optional)
  telegramApi?: string; // only for a dry run against a local fake
  total: number; // 62 (a dry run may use fewer)
  slotMinutes: number; // 60 (a dry run may use less)
  leadMinutes: number; // 30: the work starts this long before each post (a dry run may use less)
  mainnetAllowed: boolean; // false until the testnet proof has passed and the owner says so
  testnetProof: string; // written by a passing testnet dry run
  deploy: DeployConfig;
};

export const DEFAULT_CONFIG = join(homedir(), ".tourbillon-release", "release.json");
const home = (p: string) => resolve(p.replace(/^~(?=\/|$)/, homedir()));

export function loadConfig(path = DEFAULT_CONFIG): ReleaseConfig {
  let j: ReleaseConfig;
  try {
    j = JSON.parse(readFileSync(home(path), "utf8"));
  } catch {
    throw new Error(`release config: cannot read ${path}`);
  }
  for (const k of ["repo", "tagPrefix", "base", "queueDir", "kitDir", "dataDir", "releasesLog", "teambotInbox", "teambotHeartbeat", "teambotTarget", "secretsFile", "pushRemote", "githubTokenFile", "testnetProof", "deploy"] as const) if (!j[k]) throw new Error(`release config: "${k}" is missing`);
  setTagPrefix(j.tagPrefix);
  const cfg: ReleaseConfig = {
    ...j,
    dryRun: j.dryRun === true,
    mainnetAllowed: j.mainnetAllowed === true,
    total: j.total ?? 62,
    slotMinutes: j.slotMinutes ?? 60,
    leadMinutes: j.leadMinutes ?? 30,
    queueDir: home(j.queueDir),
    kitDir: home(j.kitDir),
    dataDir: home(j.dataDir),
    releasesLog: home(j.releasesLog),
    teambotInbox: home(j.teambotInbox),
    teambotHeartbeat: home(j.teambotHeartbeat),
    secretsFile: home(j.secretsFile),
    deployKeyFile: j.deployKeyFile ? home(j.deployKeyFile) : undefined,
    githubTokenFile: home(j.githubTokenFile),
    pingUrlFile: j.pingUrlFile ? home(j.pingUrlFile) : undefined,
    testnetProof: home(j.testnetProof),
    deploy: { ...j.deploy, repoDir: home(j.deploy.repoDir), buildsDir: home(j.deploy.buildsDir), targets: j.deploy.targets.map((t) => ({ ...t, root: home(t.root) })) },
  };
  for (const why of configProblems(cfg)) throw new Error(`release config: ${why}`);
  return cfg;
}

/// What makes a config unsafe to run, as plain sentences.
export function configProblems(c: ReleaseConfig): string[] {
  const why: string[] = [];
  const mainnet = c.deploy.targets.filter((t) => t.chainId === 4663);
  const testnet = c.deploy.targets.filter((t) => t.chainId === 46630);
  if (c.deploy.targets.some((t) => t.chainId !== 4663 && t.chainId !== 46630)) why.push("every target must be testnet (46630) or mainnet (4663).");
  if (!testnet.length || !testnet[0]!.enabled) why.push("the testnet target must be there and on: every update goes to testnet first.");
  const iT = c.deploy.targets.findIndex((t) => t.chainId === 46630);
  const iM = c.deploy.targets.findIndex((t) => t.chainId === 4663);
  if (iM >= 0 && iM < iT) why.push("the testnet target must come before the mainnet target.");
  if (c.dryRun && mainnet.length) why.push("a dry run may not have a mainnet target.");
  if (c.dryRun && c.deploy.targets.length < 2) why.push("a dry run needs two targets: testnet, then a second test target standing in for mainnet.");
  if (!c.dryRun && !(iT === 0 && iM === 1 && c.deploy.targets.length === 2)) why.push("the real run has exactly two targets: testnet first, then mainnet.");
  if (!c.dryRun && (c.slotMinutes !== 60 || c.leadMinutes !== 30)) why.push("the real schedule is one update every 60 minutes, its work starting 30 minutes before (only a dry run may change it).");
  if (!c.deploy.targets.some((t) => t.name === c.teambotTarget)) why.push(`teambotTarget "${c.teambotTarget}" is not one of the targets.`);
  if (!c.dryRun && c.teambotTarget !== "mainnet") why.push("the real run checks the team bot's heartbeat after the mainnet deploy (teambotTarget: mainnet).");
  if (!c.dryRun && !/^git@[\w.-]+:tourbillondev\/tourbillon\.git$/.test(c.pushRemote)) why.push("the real run pushes only to tourbillondev/tourbillon over ssh (pushRemote).");
  if (!c.dryRun && !c.deployKeyFile) why.push("the real run needs deployKeyFile (the deploy key limited to tourbillondev/tourbillon).");
  if (c.dryRun && /tourbillondev\/tourbillon(\.git)?$/.test(c.pushRemote)) why.push("a dry run may never push to tourbillondev/tourbillon (use the throwaway repo or a local one).");
  if (c.githubApi && !c.dryRun) why.push("githubApi (a local stand-in) is only for a dry run.");
  if (mainnet.some((t) => t.enabled)) {
    if (!c.mainnetAllowed) why.push("a mainnet target is on but mainnetAllowed is false.");
    if (!existsSync(c.testnetProof)) why.push(`a mainnet target is on but there is no passing testnet proof at ${c.testnetProof}.`);
    else {
      try {
        const p = JSON.parse(readFileSync(c.testnetProof, "utf8")) as { passed?: boolean };
        if (p.passed !== true) why.push("the testnet proof did not pass.");
      } catch {
        why.push("the testnet proof cannot be read.");
      }
    }
  }
  if (!c.dryRun && c.total !== 62) why.push("the real run has 62 updates (only a dry run may use fewer).");
  if (c.telegramApi && !c.dryRun) why.push("telegramApi (a local fake) is only for a dry run.");
  return why;
}
