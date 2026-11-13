import { appendFileSync, copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicClient, createWalletClient, http, type Address, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { marketBytes32 } from "../src/board.ts";
import { loadDeployment } from "../src/deployment.ts";
import { formatReport, Monitor, type Phase, type PhaseReport } from "../src/monitor.ts";

/// Three signers on live Hyperliquid data against a local anvil, with outages on a schedule (M1 step 7).
/// No key: anvil's unlocked accounts. Raw logs go to a temporary folder outside the repo.
///
///   bun scripts/local-soak.ts [--scale 1]      (--scale 0.1 runs the same schedule in a tenth of the time)

const scale = Number(process.argv[process.argv.indexOf("--scale") + 1] ?? 1) || 1;
const PHASES = [
  { name: "1: 3 of 3", minutes: 20, up: [0, 1, 2] },
  { name: "2: 2 of 3", minutes: 10, up: [0, 1] },
  { name: "3: 1 of 3", minutes: 5, up: [0] },
  { name: "4: 3 of 3 again", minutes: 5, up: [0, 1, 2] },
];
const POLL_MS = 5_000;
const ROOT = resolve(import.meta.dir, "..");
const CONTRACTS = resolve(ROOT, "../../contracts");
const PORT = 28545;
const RPC = `http://127.0.0.1:${PORT}`;
const out = mkdtempSync(join(tmpdir(), "tourbillon-soak-"));
const say = (msg: string) => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  appendFileSync(join(out, "runner.log"), line + "\n");
};

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return ((await res.json()) as { result: unknown }).result;
}

say(`logs in ${out}; scale ${scale}`);
const anvil = Bun.spawn(["anvil", "--port", String(PORT), "--block-time", "1", "--silent"], { stdout: "ignore", stderr: "ignore" });
const client = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: 500 }) as PublicClient;
for (let i = 0; i < 50; i++) {
  try {
    await client.getChainId();
    break;
  } catch {
    await Bun.sleep(100);
  }
}
const acc = (await rpc("eth_accounts")) as Address[];
const signerAddrs = [acc[2]!, acc[3]!, acc[4]!];

// Deploy, then move the chain clock past the 1 h router delay and apply the routes from a non-admin account
const dep0 = Bun.spawnSync(
  ["forge", "script", "script/DeployM1.s.sol:DeployM1", "--rpc-url", RPC, "--unlocked", "--sender", acc[0]!, "--broadcast"],
  { cwd: CONTRACTS, env: { ...process.env, ADMIN: acc[1]!, SIGNERS: signerAddrs.join(",") } },
);
if (dep0.exitCode !== 0) throw new Error(`deploy failed: ${dep0.stderr.toString()}`);
const depFile = join(out, "31337.json");
copyFileSync(join(CONTRACTS, "deployments", "31337.json"), depFile);
const dep = loadDeployment(depFile);
await rpc("evm_increaseTime", [3600]);
await rpc("evm_mine");
const anyone = createWalletClient({ chain: foundry, transport: http(RPC), account: acc[5]! });
const applyAbi = [{ type: "function", name: "applyRoute", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] }] as const;
for (const m of dep.markets) {
  const hash = await anyone.writeContract({ address: dep.router, abi: applyAbi, functionName: "applyRoute", args: [marketBytes32(m)] });
  await client.waitForTransactionReceipt({ hash });
}
say(`deployed: board ${dep.board}, router ${dep.router}; routes applied`);

// Signers
const procs: (ReturnType<typeof Bun.spawn> | null)[] = [null, null, null];
async function pipeTo(stream: ReadableStream<Uint8Array>, file: string) {
  for await (const chunk of stream) appendFileSync(file, chunk);
}
function startSigner(i: number) {
  const p = Bun.spawn(["bun", "src/main.ts", "--deployment", depFile, "--rpc", RPC, "--local-unlocked", signerAddrs[i]!], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  void pipeTo(p.stdout, join(out, `signer-${i + 1}.log`));
  void pipeTo(p.stderr, join(out, `signer-${i + 1}.err`));
  procs[i] = p;
  say(`signer ${i + 1} started`);
}
async function stopSigner(i: number) {
  const p = procs[i];
  if (!p) return;
  p.kill("SIGTERM");
  await p.exited;
  procs[i] = null;
  say(`signer ${i + 1} stopped`);
}

const mon = new Monitor(client, dep, signerAddrs);
await mon.init();
const phases: Phase[] = [];
let polling = true;
const poller = (async () => {
  while (polling) {
    try {
      await mon.poll();
    } catch (e) {
      say(`poll failed: ${(e as Error).message.split("\n")[0]}`);
    }
    await Bun.sleep(POLL_MS);
  }
})();

for (const ph of PHASES) {
  for (let i = 0; i < 3; i++) {
    if (ph.up.includes(i) && !procs[i]) startSigner(i);
    if (!ph.up.includes(i) && procs[i]) await stopSigner(i);
  }
  const start = await mon.now();
  say(`phase ${ph.name} begins (chain time ${start})`);
  await Bun.sleep(ph.minutes * 60_000 * scale);
  phases.push({ name: ph.name, start, end: await mon.now() });
}

polling = false;
await poller;
await mon.poll();
for (let i = 0; i < 3; i++) await stopSigner(i);
anvil.kill();

const reports = mon.report(phases);
const text = formatReport(reports, (a) => `${signerAddrs.indexOf(a as Address) + 1}`);
writeFileSync(join(out, "report.txt"), text);
writeFileSync(join(out, "report.json"), JSON.stringify(reports, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

// Signer log counts
for (let i = 0; i < 3; i++) {
  const lines = (await Bun.file(join(out, `signer-${i + 1}.log`)).text()).trim().split("\n").filter(Boolean);
  const count = (pred: (l: Record<string, unknown>) => boolean) => lines.map((l) => JSON.parse(l)).filter(pred).length;
  say(
    `signer ${i + 1} log: ${count((l) => l.level === "error")} errors, ${count((l) => l.level === "alarm")} alarms, ` +
      `${count((l) => l.msg === "voted" && l.status !== "success")} reverted votes, ${count((l) => l.msg === "vol started from candles")} vol start-ups`,
  );
}
console.log("\n" + text);
console.log(criteria(reports));
writeFileSync(join(out, "criteria.txt"), criteria(reports));
say(`done; logs in ${out}`);

/// Pass criteria agreed for step 7.
function criteria(r: PhaseReport[]): string {
  const [p1, p2, p3, p4] = r as [PhaseReport, PhaseReport, PhaseReport, PhaseReport];
  const lines: string[] = ["== criteria"];
  const check = (ok: boolean, what: string) => lines.push(`${ok ? "PASS" : "FAIL"}  ${what}`);
  const mk = Object.keys(p1.markets);
  const failed = (p: PhaseReport) => Object.values(p.signers).reduce((a, s) => a + s.failedTxs, 0);
  const markKeys = (p: PhaseReport) => Object.entries(p.keys).filter(([k]) => k.startsWith("MARK"));
  const volKeys = (p: PhaseReport) => Object.entries(p.keys).filter(([k]) => k.startsWith("VOL"));

  const fresh1 = Math.min(...mk.map((m) => p1.markets[m]!.freshPct));
  check(fresh1 >= 99, `phase 1: router fresh >= 99% on every market (lowest ${fresh1.toFixed(1)}%)`);
  const mark50 = Math.max(...markKeys(p1).map(([, s]) => s.p50 ?? Infinity));
  check(markKeys(p1).length === 3 && mark50 <= 40, `phase 1: median MARK final interval <= 40 s (worst ${mark50} s)`);
  const volMax = Math.max(...volKeys(p1).map(([, s]) => s.max ?? Infinity));
  check(volKeys(p1).length === 3 && volMax <= 360, `phase 1: VOL finals every <= 6 min (longest ${volMax} s)`);
  check(failed(p1) === 0, `phase 1: no failed vote transaction (${failed(p1)})`);

  const two = markKeys(p2).reduce((a, [, s]) => a + s.twoVoteFinals, 0);
  check(markKeys(p2).length === 3 && markKeys(p2).every(([, s]) => s.twoVoteFinals > 0), `phase 2: rounds finalise with 2 votes via finalize (${two} MARK finals with 2 votes)`);
  const fresh2 = Math.min(...mk.map((m) => p2.markets[m]!.freshPct));
  check(fresh2 >= 95, `phase 2: router fresh >= 95% (lowest ${fresh2.toFixed(1)}%)`);

  // A round's start is its first vote. Rounds that already held votes before the stop may still finalise.
  const firstVote = new Map<string, number>();
  for (const e of mon.events) {
    if (e.type !== "Voted") continue;
    const id = `${e.key}:${e.round}`;
    if (!firstVote.has(id)) firstVote.set(id, e.t);
  }
  const startedAfterStop = mon.events.filter(
    (e) => e.type === "Finalised" && e.t >= phases[2]!.start && e.t < phases[2]!.end && (firstVote.get(`${e.key}:${e.round}`) ?? 0) >= phases[2]!.start,
  ).length;
  check(startedAfterStop === 0, `phase 3: no round started after the stop finalises (${startedAfterStop})`);
  const stale3 = mk.map((m) => p3.markets[m]!.firstNotFresh);
  check(stale3.every((x) => x !== null && x <= 130), `phase 3: router not fresh on every market within 130 s (${stale3.map((x) => x ?? "never").join(", ")} s)`);

  check(p4.allFreshAfter !== null && p4.allFreshAfter <= 120, `phase 4: all markets fresh again within 2 min (${p4.allFreshAfter ?? "never"} s)`);
  // Information, not pass rules
  const p1All = (() => {
    const firstFinal = Math.min(...mon.events.filter((e) => e.type === "Finalised").map((e) => e.t));
    const xs = mon.samples.filter((x) => x.t >= Math.max(phases[0]!.start, firstFinal) && x.t < phases[0]!.end);
    return Math.min(...mk.map((m) => (100 * xs.filter((x) => x.router[m] === "fresh").length) / Math.max(1, xs.length)));
  })();
  lines.push(`info  phase 1 after the first final (warm-up excluded): lowest fresh ${p1All.toFixed(1)}%`);
  const p3Finals = mon.events.filter((e) => e.type === "Finalised" && e.t >= phases[2]!.start && e.t < phases[2]!.end);
  for (const m of mk) {
    const lastFinal = Math.max(
      ...mon.events.filter((e) => e.type === "Finalised" && e.t < phases[2]!.end && mon.keyName(e.key) === `MARK ${m}`).map((e) => e.t),
    );
    const bad = mon.samples.find((x) => x.t >= phases[2]!.start && x.t < phases[2]!.end && x.router[m] !== "fresh");
    lines.push(`info  phase 3 ${m}: last MARK final ${lastFinal - phases[2]!.start} s after phase start; not fresh ${bad ? bad.t - lastFinal : "never"} s after it`);
  }
  lines.push(`info  phase 3 finals: ${p3Finals.map((e) => `${mon.keyName(e.key)} at +${e.t - phases[2]!.start} s with ${e.type === "Finalised" ? e.votes : "?"} votes`).join("; ") || "none"}`);
  return lines.join("\n") + "\n";
}
