import { appendFileSync, copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  parseEther,
  stringToHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { foundry } from "viem/chains";
import { revertName } from "@tourbillon/common/tx.ts";
import { bookAbi, engineAbi as engineEvents } from "../src/abi.ts";
import { windowsDueIn, windowStart } from "../src/poke.ts";

/// M2 step 9: the whole local system for about 45 minutes of real time. anvil (1 s blocks), DeployM1 + DeployM2,
/// three signers on live Hyperliquid data, a primary and a backup poker, three traders trading at random every
/// minute, and a sleeper holder the walker must keep walkable. No key: anvil's unlocked accounts. Raw logs go to a
/// temporary folder outside the repo.
///
///   bun scripts/local-m2-run.ts [--scale 1]   (--scale 0.15 runs the same schedule in about 6 minutes)

const scale = Number(process.argv[process.argv.indexOf("--scale") + 1] ?? 1) || 1;
const PHASES = [
  { name: "A: both pokers", minutes: 30, primary: true },
  { name: "B: backup only", minutes: 10, primary: false },
  { name: "C: both pokers again", minutes: 5, primary: true },
];
const TRADE_EVERY_MS = 60_000 * scale;
const POLL_MS = 15_000;
const SERVICES = resolve(import.meta.dir, "../..");
const CONTRACTS = resolve(SERVICES, "../contracts");
const PORT = 29545;
const RPC = `http://127.0.0.1:${PORT}`;
const MARKETS = ["BTC", "ETH", "HYPE"];
const STEP: Record<string, bigint> = { BTC: parseEther("100"), ETH: parseEther("5"), HYPE: parseEther("0.1") };
const out = mkdtempSync(join(tmpdir(), "tourbillon-m2-run-"));
const say = (msg: string) => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  appendFileSync(join(out, "runner.log"), line + "\n");
};
const b32 = (m: string) => stringToHex(m, { size: 32 });
const WAD = 10n ** 18n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

const part = { type: "tuple[]", components: [{ type: "uint256", name: "tempo" }, { type: "uint256", name: "weight" }] } as const;
const engineAbi = [
  ...engineEvents,
  {
    type: "function",
    name: "buy",
    stateMutability: "nonpayable",
    inputs: [{ type: "bytes32" }, { type: "bool" }, { type: "uint128" }, part, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    outputs: [{ type: "uint256" }, { type: "uint256" }],
  },
  {
    type: "function",
    name: "sell",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    outputs: [{ type: "uint256" }, { type: "uint256" }],
  },
  {
    type: "function",
    name: "markets",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "bool" }, { type: "uint16" }, { type: "uint128" }],
  },
  { type: "error", name: "NotCaughtUp", inputs: [{ type: "uint256" }] },
  { type: "error", name: "CapExceeded", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "StrikeOutOfBand", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "StrikeOffStep", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "BuysArePaused", inputs: [] },
  { type: "error", name: "NothingToSell", inputs: [{ type: "uint256" }] },
  { type: "error", name: "Insolvent", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "TempoOutOfRange", inputs: [{ type: "uint256" }] },
  ...bookAbi.filter((x) => x.type === "error"),
] as const;
const viewAbi = [
  { type: "function", name: "markWad", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "volBps", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "applyRoute", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "seriesRaw", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const recordedEvent = {
  type: "event",
  name: "Recorded",
  inputs: [
    { type: "bytes32", name: "name", indexed: true },
    { type: "uint256", name: "t", indexed: false },
    { type: "uint256", name: "sWad", indexed: false },
    { type: "uint256", name: "sigmaBps", indexed: false },
    { type: "bool", name: "l0", indexed: false },
    { type: "bool", name: "l1", indexed: false },
    { type: "bool", name: "l2", indexed: false },
  ],
} as const;
const accruedEvent = {
  type: "event",
  name: "Accrued",
  inputs: [
    { type: "uint256", name: "id", indexed: true },
    { type: "uint256", name: "x", indexed: false },
    { type: "uint256", name: "at", indexed: false },
    { type: "uint256", name: "steps", indexed: false },
  ],
} as const;

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return ((await res.json()) as { result: unknown }).result;
}

// ---------------------------------------------------------------- setup

say(`logs in ${out}; scale ${scale}`);
const anvil = Bun.spawn(["anvil", "--port", String(PORT), "--block-time", "1", "--accounts", "12", "--silent"], { stdout: "ignore", stderr: "ignore" });
const client = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: 300 }) as PublicClient;
const wallet = (a: Address) => createWalletClient({ chain: foundry, transport: http(RPC), account: a });
for (let i = 0; i < 50; i++) {
  try {
    await client.getChainId();
    break;
  } catch {
    await Bun.sleep(100);
  }
}
const acc = (await rpc("eth_accounts")) as Address[];
const [, ADMIN, S1, S2, S3, ANYONE, PRIMARY, BACKUP, T1, T2, T3] = acc as [Address, Address, Address, Address, Address, Address, Address, Address, Address, Address, Address];
const SLEEPER = ANYONE;
const traders = [T1, T2, T3];
const env = { ...process.env, ADMIN, SIGNERS: `${S1},${S2},${S3}` };
for (const script of ["DeployM1.s.sol:DeployM1", "DeployM2.s.sol:DeployM2"]) {
  const r = Bun.spawnSync(["forge", "script", `script/${script}`, "--rpc-url", RPC, "--unlocked", "--sender", acc[0]!, "--broadcast"], { cwd: CONTRACTS, env });
  if (r.exitCode !== 0) throw new Error(`${script} failed: ${r.stderr.toString()}`);
}
const m1File = join(out, "31337.json");
const m2File = join(out, "31337-m2.json");
copyFileSync(join(CONTRACTS, "deployments", "31337.json"), m1File);
copyFileSync(join(CONTRACTS, "deployments", "31337-m2.json"), m2File);
const m1 = (await Bun.file(m1File).json()) as Record<string, Address>;
const m2 = (await Bun.file(m2File).json()) as Record<string, Address>;
await rpc("evm_increaseTime", [3600]);
await rpc("evm_mine");
for (const m of MARKETS) {
  await client.waitForTransactionReceipt({ hash: await wallet(ANYONE).writeContract({ address: m1.MarkRouter!, abi: viewAbi, functionName: "applyRoute", args: [b32(m)] }) });
}
const START_USDC = 1_000_000n * 10n ** 6n;
for (const t of [...traders, SLEEPER]) {
  await client.waitForTransactionReceipt({ hash: await wallet(t).writeContract({ address: m2.MockUSDC!, abi: viewAbi, functionName: "mint", args: [t, START_USDC] }) });
  await client.waitForTransactionReceipt({ hash: await wallet(t).writeContract({ address: m2.MockUSDC!, abi: viewAbi, functionName: "approve", args: [m2.Engine!, START_USDC] }) });
}
say(`deployed; routes applied; traders funded. board ${m1.QuorumBoard} book ${m2.PathFundingBook} engine ${m2.Engine}`);

// ---------------------------------------------------------------- services

type Proc = ReturnType<typeof Bun.spawn>;
async function pipeTo(stream: ReadableStream<Uint8Array>, file: string) {
  for await (const chunk of stream) appendFileSync(file, chunk);
}
function spawnService(name: string, cwd: string, args: string[]): Proc {
  const p = Bun.spawn(["bun", "src/main.ts", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  void pipeTo(p.stdout, join(out, `${name}.log`));
  void pipeTo(p.stderr, join(out, `${name}.err`));
  say(`${name} started`);
  return p;
}
const signers = [S1, S2, S3].map((s, i) =>
  spawnService(`signer-${i + 1}`, join(SERVICES, "quorum-signer"), ["--deployment", m1File, "--rpc", RPC, "--local-unlocked", s]),
);
const pokerArgs = (who: Address, role: string) => ["--deployment", m2File, "--rpc", RPC, "--local-unlocked", who, "--role", role];
let primary: Proc | null = spawnService("poker-primary", join(SERVICES, "poker"), pokerArgs(PRIMARY, "primary"));
const backup = spawnService("poker-backup", join(SERVICES, "poker"), pokerArgs(BACKUP, "backup"));

// ---------------------------------------------------------------- polling

type Poll = { t: number; latest: Record<string, number>; maxBehind: number; behindId: string };
const polls: Poll[] = [];
const held = new Map<string, { id: bigint; market: Hex }>(); // series with trades, from Engine events
async function latestSampleT(m: string): Promise<number> {
  try {
    const [t] = await client.readContract({ address: m2.PathFundingBook!, abi: bookAbi, functionName: "latestSample", args: [b32(m)] });
    return Number(t);
  } catch {
    return 0;
  }
}
async function poll(): Promise<void> {
  const t = Number((await client.getBlock()).timestamp);
  const latest: Record<string, number> = {};
  for (const m of MARKETS) latest[m] = await latestSampleT(m);
  let maxBehind = 0;
  let behindId = "";
  for (const s of held.values()) {
    const raw = await client.readContract({ address: m2.HousePool!, abi: viewAbi, functionName: "seriesRaw", args: [s.id] });
    if (raw === 0n) continue;
    const c = await client.readContract({ address: m2.PathFundingBook!, abi: bookAbi, functionName: "cursor", args: [s.id] });
    const m = MARKETS.find((x) => b32(x) === s.market)!;
    const behind = Math.floor((latest[m]! - Number(c.at)) / 300);
    if (behind > maxBehind) {
      maxBehind = behind;
      behindId = s.id.toString().slice(0, 10);
    }
  }
  polls.push({ t, latest, maxBehind, behindId });
}
let polling = true;
const poller = (async () => {
  while (polling) {
    try {
      await poll();
    } catch (e) {
      say(`poll failed: ${(e as Error).message.split("\n")[0]}`);
    }
    await Bun.sleep(POLL_MS);
  }
})();

// ---------------------------------------------------------------- trading

type Attempt = { kind: "buy" | "sell"; ok: boolean; reason?: string; gas?: bigint; tx?: Hex; id?: bigint };
const attempts: Attempt[] = [];
const EXPECTED_BUY_REFUSALS = new Set(["Stale", "NoData", "StrikeOutOfBand", "CapExceeded"]);
let rng = 0x7462;
const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
const tempos = [
  [{ tempo: 3600n, weight: WAD }],
  [{ tempo: 86_400n, weight: WAD }],
  [{ tempo: 604_800n, weight: WAD }],
  [
    { tempo: 3600n, weight: (WAD * 2n) / 10n },
    { tempo: 86_400n, weight: (WAD * 5n) / 10n },
    { tempo: 604_800n, weight: (WAD * 3n) / 10n },
  ],
];
const positions = new Map<Address, Set<string>>(); // trader -> series ids held

async function send(from: Address, fn: "buy" | "sell", args: readonly unknown[]): Promise<Attempt> {
  const call = { address: m2.Engine!, abi: engineAbi, functionName: fn, args: args as never, account: from } as const;
  let gas: bigint;
  try {
    gas = await client.estimateContractGas(call);
  } catch (e) {
    return { kind: fn, ok: false, reason: revertName(e) ?? (e as Error).message.split("\n")[0] };
  }
  const hash = await wallet(from).writeContract({ ...call, gas: gas * 2n > 500_000n ? gas * 2n : 500_000n } as never);
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") return { kind: fn, ok: false, reason: "reverted on chain", tx: hash };
  let id: bigint | undefined;
  for (const l of r.logs) {
    try {
      const ev = decodeEventLog({ abi: engineEvents, data: l.data, topics: l.topics });
      const a = ev.args as unknown as { id: bigint; market: Hex };
      held.set(a.id.toString(), { id: a.id, market: a.market });
      id = a.id;
    } catch {
      // other contracts' events
    }
  }
  return { kind: fn, ok: true, gas: r.gasUsed, tx: hash, id };
}

async function buyRandom(trader: Address, sleeper = false): Promise<void> {
  const m = sleeper ? "BTC" : pick(MARKETS);
  let mark: bigint;
  try {
    mark = await client.readContract({ address: m1.MarkRouter!, abi: viewAbi, functionName: "markWad", args: [b32(m)] });
  } catch (e) {
    attempts.push({ kind: "buy", ok: false, reason: revertName(e) ?? "mark read failed" });
    return;
  }
  const step = STEP[m]!;
  // traders use strikes within ±2 steps of the mark; the sleeper uses +8 steps and a 30-day tempo, a series no
  // trader touches, so only the walker keeps it walkable
  const offset = sleeper ? 8n : BigInt(Math.floor(rand() * 5) - 2);
  const k = ((mark + step / 2n) / step + offset) * step;
  const notional = BigInt(500 + Math.floor(rand() * 4500)) * WAD; // $500 to $5,000
  const units = (notional * WAD) / mark;
  const mv = sleeper ? [{ tempo: 2_592_000n, weight: WAD }] : pick(tempos);
  const a = await send(trader, "buy", [b32(m), rand() < 0.5, k, mv, units, 10n ** 12n, 99_999_999_999n]);
  attempts.push(a);
  if (a.ok) {
    const ids = positions.get(trader) ?? new Set<string>();
    if (a.id !== undefined) ids.add(a.id.toString());
    positions.set(trader, ids);
  }
}

async function sellRandom(trader: Address): Promise<boolean> {
  const ids = [...(positions.get(trader) ?? [])];
  if (ids.length === 0) return false;
  const id = BigInt(pick(ids));
  const all = rand() < 0.5;
  const a = await send(trader, "sell", [id, all ? 2n ** 256n - 1n : parseEther("0.0001") + BigInt(Math.floor(rand() * 1e6)) * 10n ** 9n, 0n, 99_999_999_999n]);
  attempts.push(a);
  if (a.ok && all) positions.get(trader)!.delete(id.toString());
  return true;
}

// warm-up: every market sampled (signers start vol from candles, then votes, then a poke)
const warmStart = Date.now();
while (Date.now() - warmStart < 8 * 60_000) {
  const ts = await Promise.all(MARKETS.map(latestSampleT));
  if (ts.every((t) => t > 0)) break;
  await Bun.sleep(5_000);
}
say(`warm-up done in ${Math.round((Date.now() - warmStart) / 1000)} s`);
await buyRandom(SLEEPER, true); // the sleeper never trades again
say(`sleeper bought: ${attempts.at(-1)?.ok ? "ok" : attempts.at(-1)?.reason}`);

const phaseBounds: { name: string; start: number; end: number }[] = [];
for (const ph of PHASES) {
  if (!ph.primary && primary) {
    primary.kill("SIGTERM");
    await primary.exited;
    primary = null;
    say("poker-primary stopped");
  }
  if (ph.primary && !primary) primary = spawnService("poker-primary", join(SERVICES, "poker"), pokerArgs(PRIMARY, "primary"));
  const start = Number((await client.getBlock()).timestamp);
  say(`phase ${ph.name} begins (chain time ${start})`);
  const until = Date.now() + ph.minutes * 60_000 * scale;
  while (Date.now() < until) {
    const trader = pick(traders);
    try {
      if (!(rand() < 0.4 && (await sellRandom(trader)))) await buyRandom(trader);
    } catch (e) {
      say(`trade threw: ${(e as Error).message.split("\n")[0]}`);
      attempts.push({ kind: "buy", ok: false, reason: "threw" });
    }
    await Bun.sleep(Math.min(TRADE_EVERY_MS, Math.max(0, until - Date.now())));
  }
  phaseBounds.push({ name: ph.name, start, end: Number((await client.getBlock()).timestamp) });
}

polling = false;
await poller;
await poll();
for (const p of [...signers, backup, primary]) {
  if (!p) continue;
  p.kill("SIGTERM");
  await p.exited;
}

// ---------------------------------------------------------------- report

const report: string[] = [];
const crit: string[] = ["== criteria"];
const check = (ok: boolean, what: string) => crit.push(`${ok ? "PASS" : "FAIL"}  ${what}`);
const median = (xs: bigint[]) => (xs.length ? [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[Math.floor(xs.length / 2)]! : 0n);

// 1: samples per window, and who poked
const recorded = await client.getLogs({ address: m2.PathFundingBook!, event: recordedEvent, fromBlock: 0n });
const pokesBy = new Map<string, { role: string; t: number; gas: bigint }[]>();
const txCache = new Map<string, { from: Address; gas: bigint }>();
async function txInfo(hash: Hex) {
  let v = txCache.get(hash);
  if (!v) {
    const [tx, r] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
    v = { from: tx.from, gas: r.gasUsed };
    txCache.set(hash, v);
  }
  return v;
}
for (const l of recorded) {
  if (!l.args.l0) continue;
  const info = await txInfo(l.transactionHash!);
  const role = info.from.toLowerCase() === PRIMARY.toLowerCase() ? "primary" : info.from.toLowerCase() === BACKUP.toLowerCase() ? "backup" : "other";
  const m = MARKETS.find((x) => b32(x) === l.args.name)!;
  const list = pokesBy.get(m) ?? [];
  list.push({ role, t: Number(l.args.t), gas: info.gas });
  pokesBy.set(m, list);
}
// A window counts for a phase when its +40 s point falls inside the phase: by then the primary (+5 s) or the backup
// (+35 s) must have sampled it. (A 5-minute phase rarely contains a whole window, so whole windows are not used.)
for (const ph of phaseBounds) {
  const windows = windowsDueIn(ph.start, ph.end);
  let worst = 100;
  const parts: string[] = [];
  for (const m of MARKETS) {
    const inPhase = (pokesBy.get(m) ?? []).filter((p) => windows.includes(windowStart(p.t)));
    const sampled = new Set(inPhase.map((p) => windowStart(p.t)));
    const pct = windows.length ? (100 * sampled.size) / windows.length : 0;
    worst = Math.min(worst, pct);
    parts.push(`${m} ${sampled.size}/${windows.length} (primary ${inPhase.filter((r) => r.role === "primary").length}, backup ${inPhase.filter((r) => r.role === "backup").length})`);
  }
  report.push(`${ph.name}: windows sampled: ${parts.join("; ")}`);
  check(windows.length > 0 && worst >= 95, `${ph.name}: every market sampled in >= 95% of its windows (worst ${worst.toFixed(1)}% of ${windows.length})`);
}

// 2, 3: trades
const buys = attempts.filter((a) => a.kind === "buy");
const sells = attempts.filter((a) => a.kind === "sell");
const refusals = new Map<string, number>();
for (const a of buys.filter((x) => !x.ok)) refusals.set(a.reason ?? "?", (refusals.get(a.reason ?? "?") ?? 0) + 1);
report.push(`buys: ${buys.filter((a) => a.ok).length} ok, refused: ${[...refusals].map(([r, n]) => `${r} ×${n}`).join(", ") || "none"}`);
report.push(`sells: ${sells.filter((a) => a.ok).length} ok, ${sells.filter((a) => !a.ok).length} failed ${sells.filter((a) => !a.ok).map((a) => a.reason).join(", ")}`);
check(sells.length > 0 && sells.every((a) => a.ok), `law 3: every sell succeeded (${sells.filter((a) => a.ok).length}/${sells.length})`);
const unexpected = buys.filter((a) => !a.ok && !EXPECTED_BUY_REFUSALS.has(a.reason ?? ""));
check(buys.some((a) => a.ok) && unexpected.length === 0, `buys refused only for expected reasons (${unexpected.length} unexpected: ${unexpected.map((a) => a.reason).join(", ")})`);

// 4: law 5 — every trade's inputs equal the sources at that block; amounts recomputed from the event
const engineLogs = await client.getLogs({ address: m2.Engine!, fromBlock: 0n });
let checked = 0;
const law5: string[] = [];
let feeSum = 0n;
const [, spreadBps] = await client.readContract({ address: m2.Engine!, abi: engineAbi, functionName: "markets", args: [b32("BTC")] });
const spread = BigInt(spreadBps);
const fee = (price: bigint, units: bigint, s: bigint) => {
  let sp = ceilDiv(price * spread, 10_000n);
  if (sp < 10n ** 16n) sp = 10n ** 16n;
  return ceilDiv(sp + ceilDiv(ceilDiv(units * s, WAD) * 3n, 10_000n), 10n ** 12n);
};
async function sourceAt(fn: "markWad" | "volBps", m: Hex, block: bigint): Promise<bigint[]> {
  const res: bigint[] = [];
  for (const b of [block - 1n, block]) {
    try {
      res.push(await client.readContract({ address: (fn === "markWad" ? m1.MarkRouter : m1.QuorumBoard)!, abi: viewAbi, functionName: fn, args: [m], blockNumber: b }));
    } catch {
      // stale at that block
    }
  }
  return res;
}
for (const l of engineLogs) {
  let ev;
  try {
    ev = decodeEventLog({ abi: engineEvents, data: l.data, topics: l.topics });
  } catch {
    continue;
  }
  const a = ev.args as Record<string, unknown>;
  const units = a.units as bigint;
  const s = a.sWad as bigint;
  const sigma = a.sigmaBps as bigint;
  const v = a.unitValueWad as bigint;
  const m = a.market as Hex;
  const fromSampleMark = ev.eventName === "Sold" && (a.markFromSample as boolean);
  const fromSampleVol = ev.eventName === "Sold" && (a.volFromSample as boolean);
  if (!fromSampleMark && !(await sourceAt("markWad", m, l.blockNumber!)).includes(s)) law5.push(`${ev.eventName} block ${l.blockNumber}: S not the router mark`);
  if (!fromSampleVol && !(await sourceAt("volBps", m, l.blockNumber!)).includes(sigma)) law5.push(`${ev.eventName} block ${l.blockNumber}: σ not the board vol`);
  if (ev.eventName === "Bought") {
    const p = ceilDiv(units * v, WAD);
    if (a.premium !== ceilDiv(p, 10n ** 12n) || a.fee !== fee(p, units, s)) law5.push(`Bought block ${l.blockNumber}: amounts`);
    feeSum += a.fee as bigint;
  } else {
    const g = (units * v) / WAD;
    const gross = g / 10n ** 12n;
    let f = fee(g, units, s);
    if (f > gross) f = gross;
    if (a.gross !== gross || a.fee !== f || a.net !== gross - f) law5.push(`Sold block ${l.blockNumber}: amounts`);
    feeSum += a.fee as bigint;
  }
  checked++;
}
check(checked > 0 && law5.length === 0, `law 5: ${checked} trades priced from the sources at their block, amounts recomputed exactly (${law5.length} mismatches${law5.length ? ": " + law5.slice(0, 3).join("; ") : ""})`);

// 5: walker
const maxBehind = Math.max(0, ...polls.map((p) => p.maxBehind));
const accrued = await client.getLogs({ address: m2.PathFundingBook!, event: accruedEvent, fromBlock: 0n });
const walks: { gas: bigint; steps: bigint }[] = [];
for (const l of accrued) {
  const info = await txInfo(l.transactionHash!);
  const fromPoker = [PRIMARY, BACKUP].some((p) => p.toLowerCase() === info.from.toLowerCase());
  const isWalkTx = (await client.getTransaction({ hash: l.transactionHash! })).to?.toLowerCase() === m2.PathFundingBook!.toLowerCase();
  if (fromPoker && isWalkTx) walks.push({ gas: info.gas, steps: l.args.steps! });
}
report.push(`walker: ${walks.length} walks by the pokers (steps ${walks.map((w) => w.steps).join(", ") || "-"}); worst held series behind at any poll: ${maxBehind} intervals`);
check(maxBehind <= 16, `walker: no held series more than 16 intervals behind at any poll (worst ${maxBehind})`);
check(walks.length > 0, `walker: the sleeper's (or another held) series was walked (${walks.length} walks)`);

// 6: accounting
const usdcBal = (a: Address) => client.readContract({ address: m2.MockUSDC!, abi: viewAbi, functionName: "balanceOf", args: [a] });
const engineUsdc = await usdcBal(m2.Engine!);
let sum = (await usdcBal(m2.HousePool!)) + (await usdcBal(ADMIN)) + (await usdcBal(acc[0]!));
for (const t of [...traders, SLEEPER]) sum += await usdcBal(t);
const supply = await client.readContract({ address: m2.MockUSDC!, abi: viewAbi, functionName: "totalSupply" });
let rawMismatch = 0;
for (const s of held.values()) {
  let h = 0n;
  for (const t of [...traders, SLEEPER]) h += await client.readContract({ address: m2.PathFundingBook!, abi: viewAbi, functionName: "balanceOf", args: [s.id, t] });
  if (h !== (await client.readContract({ address: m2.HousePool!, abi: viewAbi, functionName: "seriesRaw", args: [s.id] }))) rawMismatch++;
}
const adminFees = await usdcBal(ADMIN);
check(engineUsdc === 0n && sum === supply && rawMismatch === 0 && adminFees === feeSum, `accounting: engine holds ${engineUsdc}; USDC conserved (${sum === supply}); pool raw = holders on ${held.size - rawMismatch}/${held.size} series; fees ${adminFees} = Σ events ${feeSum}`);

// 7: service logs
let errorLines = 0;
const errorSamples: string[] = [];
for (const f of ["signer-1", "signer-2", "signer-3", "poker-primary", "poker-backup"]) {
  const text = await Bun.file(join(out, `${f}.log`)).text();
  for (const line of text.split("\n").filter(Boolean)) {
    if (JSON.parse(line).level === "error") {
      errorLines++;
      if (errorSamples.length < 3) errorSamples.push(`${f}: ${line.slice(0, 200)}`);
    }
  }
}
check(errorLines === 0, `no error lines in signer and poker logs (${errorLines}${errorSamples.length ? ": " + errorSamples.join(" | ") : ""})`);

// 8: gas
const buyGas = buys.filter((a) => a.ok).map((a) => a.gas!);
const sellGas = sells.filter((a) => a.ok).map((a) => a.gas!);
const pokeGas = [...pokesBy.values()].flat().map((p) => p.gas);
const pokeMed = median(pokeGas);
report.push(
  `gas medians: buy ${median(buyGas)}, sell ${median(sellGas)}, poke ${pokeMed}, walk ${median(walks.map((w) => w.gas))}`,
);
const pokesPerDay = 288n * BigInt(MARKETS.length);
report.push(`poker cost: ${pokesPerDay} pokes a day × ${pokeMed} gas × 0.1 gwei ≈ ${Number(pokesPerDay * pokeMed) * 1e-10} test HYPE a day (plus walks; execution only)`);

const text = [...report, "", ...crit].join("\n") + "\n";
writeFileSync(join(out, "report.txt"), text);
console.log("\n" + text);
anvil.kill();
say(`done; logs in ${out}`);
