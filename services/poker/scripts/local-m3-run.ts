import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicClient, createWalletClient, decodeErrorResult, decodeEventLog, formatUnits, http, parseEther, stringToHex, type Address, type Hex, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { revertName } from "@tourbillon/common/tx.ts";
import { SimVenue } from "../../hedger/src/simvenue.ts";

/// M3 step 11: the whole M3 system for about an hour on anvil. Prices come from the simulated venue's scripted path
/// (signers read them there; vol fixed at 50%), and the chain clock is moved forward an hour at set points so hourly
/// epochs, EQUITY rounds and the drawdown check happen inside the run. The venue outage is in real minutes.
/// No key: anvil's unlocked accounts. Raw logs and the report go to a temporary folder outside the repo.
///
///   bun scripts/local-m3-run.ts [--scale 1]   (--scale 0.2 shortens every phase except the 15-minute outage rule)

const scale = Number(process.argv[process.argv.indexOf("--scale") + 1] ?? 1) || 1;
const OUTAGE_MIN = Number(process.argv[process.argv.indexOf("--outage-minutes") + 1] ?? 18) || 18;
const SERVICES = resolve(import.meta.dir, "../..");
const CONTRACTS = resolve(SERVICES, "../contracts");
const PORT = 30545;
const RPC = `http://127.0.0.1:${PORT}`;
const MARKETS = ["BTC", "ETH", "HYPE"];
const STEP: Record<string, number> = { BTC: 100, ETH: 5, HYPE: 0.1 };
const SZ: Record<string, number> = { BTC: 5, ETH: 4, HYPE: 2 };
const POOL_HL = "0x00000000000000000000000000000000000000E1" as Address;
const USDC = 10n ** 6n;
const out = mkdtempSync(join(tmpdir(), "tourbillon-m3-run-"));
const T0 = Date.now();
const mins = () => ((Date.now() - T0) / 60_000).toFixed(1);
const say = (msg: string) => {
  const line = `${new Date().toISOString()} [${mins()} min] ${msg}`;
  console.log(line);
  appendFileSync(join(out, "runner.log"), line + "\n");
};
const sleep = (ms: number) => Bun.sleep(ms);
const b32 = (m: string) => stringToHex(m, { size: 32 });
const usd = (v: bigint) => Number(formatUnits(v, 6));

const part = { type: "tuple[]", components: [{ type: "uint256", name: "tempo" }, { type: "uint256", name: "weight" }] } as const;
const abi = [
  { type: "function", name: "applyRoute", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] },
  { type: "function", name: "markWad", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "requestWithdraw", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "claimShares", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "depositOf", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "withdrawOf", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "round", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "rounds",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "bool" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint64" }],
  },
  { type: "function", name: "navNow", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "available", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "stressedLiability", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "freeForWithdrawals", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "equityTerm", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "sentOut", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "receivedBack", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "equityReady", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "opensPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "marketPaused", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "seriesRaw", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "setTreasury", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
  { type: "function", name: "setTreasuryDailyCap", stateMutability: "nonpayable", inputs: [{ type: "uint16" }], outputs: [] },
  { type: "function", name: "sendToTreasury", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "receiveFromTreasury", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "unpauseMarket", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] },
  { type: "function", name: "resumeOpens", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "setCaps", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "setHedgerDeltaCap", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "buy", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "bool" }, { type: "uint128" }, part, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "sell", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "error", name: "CoverageBreached", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "MarketIsPaused", inputs: [{ type: "bytes32" }] },
  { type: "error", name: "OpensArePaused", inputs: [] },
  { type: "error", name: "Insolvent", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "StrikeOutOfBand", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "StrikeOffStep", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "NotCaughtUp", inputs: [{ type: "uint256" }] },
  { type: "error", name: "NotionalCapExceeded", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "DirectionalCapExceeded", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "Stale", inputs: [{ type: "bytes32" }, { type: "address" }] },
  { type: "error", name: "Stale", inputs: [{ type: "bytes32" }, { type: "uint256" }] },
  { type: "error", name: "NoData", inputs: [{ type: "bytes32" }] },
  { type: "error", name: "NothingToSell", inputs: [{ type: "uint256" }] },
  // every other project error a buy or sell can meet, so the run can name it
  { type: "error", name: "Expired", inputs: [{ type: "uint256" }] },
  { type: "error", name: "NotListed", inputs: [{ type: "bytes32" }] },
  { type: "error", name: "CostAboveMax", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "ZeroRaw", inputs: [] },
  { type: "error", name: "ZeroUnits", inputs: [] },
  { type: "error", name: "BuysArePaused", inputs: [] },
  { type: "error", name: "NetBelowMin", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "TooManySeries", inputs: [{ type: "bytes32" }] },
  { type: "error", name: "WrongMarket", inputs: [{ type: "uint256" }, { type: "bytes32" }] },
  { type: "error", name: "TempoOutOfRange", inputs: [{ type: "uint256" }] },
  { type: "error", name: "SigmaOutOfBounds", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "PriceTooLarge", inputs: [{ type: "uint256" }] },
  { type: "error", name: "NoHistory", inputs: [] },
  { type: "error", name: "OpenBeforeLastSample", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "HistoryGone", inputs: [{ type: "uint256" }] },
  { type: "error", name: "Unknown", inputs: [{ type: "uint256" }] },
  { type: "error", name: "NoRoute", inputs: [{ type: "bytes32" }] },
  { type: "error", name: "Disagree", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "SpreadOutOfRange", inputs: [{ type: "uint256" }] },
] as const;
const engineEvents = [
  {
    type: "event",
    name: "Bought",
    inputs: [
      { type: "address", name: "buyer", indexed: true }, { type: "uint256", name: "id", indexed: true }, { type: "bytes32", name: "market", indexed: true },
      { type: "uint256", name: "units" }, { type: "uint256", name: "raw" }, { type: "uint256", name: "sWad" }, { type: "uint256", name: "sigmaBps" },
      { type: "uint256", name: "unitValueWad" }, { type: "uint256", name: "premium" }, { type: "uint256", name: "fee" },
    ],
  },
  {
    type: "event",
    name: "Sold",
    inputs: [
      { type: "address", name: "seller", indexed: true }, { type: "uint256", name: "id", indexed: true }, { type: "bytes32", name: "market", indexed: true },
      { type: "uint256", name: "units" }, { type: "uint256", name: "raw" }, { type: "uint256", name: "sWad" }, { type: "uint256", name: "sigmaBps" },
      { type: "uint256", name: "unitValueWad" }, { type: "uint256", name: "gross" }, { type: "uint256", name: "fee" }, { type: "uint256", name: "net" },
      { type: "bool", name: "markFromSample" }, { type: "bool", name: "volFromSample" },
    ],
  },
] as const;

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return ((await res.json()) as { result: unknown }).result;
}

// ---------------------------------------------------------------- chain and contracts

say(`logs in ${out}; scale ${scale}; outage ${OUTAGE_MIN} min`);
const anvil = Bun.spawn(["anvil", "--port", String(PORT), "--block-time", "1", "--accounts", "20", "--silent"], { stdout: "ignore", stderr: "ignore" });
const client = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: 300 }) as PublicClient;
for (let i = 0; i < 50; i++) {
  try {
    await client.getChainId();
    break;
  } catch {
    await sleep(100);
  }
}
const acc = (await rpc("eth_accounts")) as Address[];
const [, ADMIN, S1, S2, S3, ANYONE, POKER1, POKER2, RISK, TREASURY, L1, L2, L3, T1, T2, T3, PROTO, BIG] = acc as Address[] as [Address, ...Address[]] as Address[];
const LPS = [L1!, L2!, L3!];
const TRADERS = [T1!, T2!, T3!];
const env = { ...process.env, ADMIN: ADMIN!, SIGNERS: `${S1},${S2},${S3}`, RISK_PAUSER: RISK!, PROTOCOL_RECIPIENT: PROTO! };
for (const [script, sender] of [["DeployM1.s.sol:DeployM1", acc[0]!], ["DeployM3.s.sol:DeployM3", acc[0]!], ["ListEquityFeed.s.sol:ListEquityFeed", ADMIN!]] as const) {
  const r = Bun.spawnSync(["forge", "script", `script/${script}`, "--rpc-url", RPC, "--unlocked", "--sender", sender, "--broadcast"], { cwd: CONTRACTS, env });
  if (r.exitCode !== 0) throw new Error(`${script} failed: ${r.stderr.toString()}`);
}
const m1File = join(out, "31337.json");
const m3File = join(out, "31337-m3.json");
copyFileSync(join(CONTRACTS, "deployments", "31337.json"), m1File);
copyFileSync(join(CONTRACTS, "deployments", "31337-m3.json"), m3File);
const m1 = JSON.parse(readFileSync(m1File, "utf8")) as Record<string, Address>;
const m3 = JSON.parse(readFileSync(m3File, "utf8")) as Record<string, Address>;
const POOL = m3.MainspringPool!;
const ENGINE = m3.Engine!;
const BOOK = m3.PathFundingBook!;
const MUSDC = m3.MockUSDC!;
await rpc("evm_increaseTime", [3600]);
await rpc("evm_mine");

type Receipt = Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>>;
async function tx(from: Address, address: Address, functionName: string, args: readonly unknown[] = []): Promise<{ ok: true; receipt: Receipt } | { ok: false; reason: string }> {
  const call = { address, abi, functionName, args, account: from } as const;
  let gas: bigint;
  try {
    gas = await client.estimateContractGas(call as never);
  } catch (e) {
    const name = revertName(e);
    if (name) return { ok: false, reason: name };
    const sel = /0x[0-9a-fA-F]{8}/.exec((e as Error).message)?.[0];
    return { ok: false, reason: sel ? `unknown error ${sel}` : (e as Error).message.split("\n")[0]! };
  }
  const hash = await createWalletClient({ chain: foundry, transport: http(RPC), account: from }).writeContract({ ...(call as object), gas: gas * 2n } as never);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") return { ok: false, reason: `reverted on chain: ${await revertedWith(hash)}` };
  return { ok: true, receipt };
}
/// Simulated fine but reverted when mined (state changed in between): name the error from the trace.
async function revertedWith(hash: `0x${string}`): Promise<string> {
  try {
    const t = (await rpc("debug_traceTransaction", [hash, { tracer: "callTracer" }])) as { output?: `0x${string}` };
    if (!t.output || t.output === "0x") return "no data";
    try {
      return decodeErrorResult({ abi, data: t.output }).errorName;
    } catch {
      return `unknown error ${t.output.slice(0, 10)}`;
    }
  } catch (e) {
    return `trace failed: ${(e as Error).message.split("\n")[0]}`;
  }
}
async function must(from: Address, address: Address, fn: string, args: readonly unknown[] = []): Promise<Receipt> {
  const r = await tx(from, address, fn, args);
  if (!r.ok) throw new Error(`${fn} failed: ${r.reason}`);
  return r.receipt;
}
const read = <T>(address: Address, functionName: string, args: readonly unknown[] = []) => client.readContract({ address, abi, functionName, args } as never) as Promise<T>;

for (const m of MARKETS) await must(ANYONE!, m1.MarkRouter!, "applyRoute", [b32(m)]);
for (const w of [...LPS, ...TRADERS, BIG!]) {
  await must(w, MUSDC, "mint", [w, 20_000_000n * USDC]);
  await must(w, MUSDC, "approve", [POOL, 20_000_000n * USDC]);
  await must(w, MUSDC, "approve", [ENGINE, 20_000_000n * USDC]);
}
await must(TREASURY!, MUSDC, "approve", [POOL, 10n ** 18n]);
await must(ADMIN!, POOL, "setTreasury", [TREASURY!]);
say(`deployed; pool ${POOL}`);

// ---------------------------------------------------------------- the simulated venue and the price path

const PRICE: Record<string, number> = { BTC: 100_000, ETH: 3_000, HYPE: 40 };
const sim = new SimVenue(MARKETS.map((n) => ({ name: n, szDecimals: SZ[n]!, mid: PRICE[n]! })));
sim.deposit(1_000_000); // the pool's Hyperliquid account starts with margin of its own (a deposit, so P&L-only EQUITY is 0)
let walking = true;
let shockTarget: number | null = null;
const pricer = (async () => {
  let k = 1;
  while (walking) {
    for (const m of MARKETS) {
      let p = PRICE[m]!;
      if (m === "BTC" && shockTarget !== null) p = Math.min(shockTarget, p * 1.015); // the shock: +1.5% per step
      else p = p * (1 + (Math.sin(k * 1.7 + m.length) * 0.0015)); // a gentle wander, ±0.15%
      PRICE[m] = p;
      sim.setMid(m, Number(p.toPrecision(5)));
    }
    k++;
    await sleep(30_000);
  }
})();

// ---------------------------------------------------------------- services

type Proc = ReturnType<typeof Bun.spawn>;
async function pipe(stream: ReadableStream<Uint8Array>, file: string) {
  for await (const c of stream) appendFileSync(file, c);
}
function service(name: string, cwd: string, args: string[]): Proc {
  const p = Bun.spawn(["bun", "src/main.ts", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  void pipe(p.stdout, join(out, `${name}.log`));
  void pipe(p.stderr, join(out, `${name}.err`));
  say(`${name} started`);
  return p;
}
const statusFile = join(out, "hedger-status.json");
const procs: Proc[] = [];
for (const [i, s] of [S1!, S2!, S3!].entries()) {
  procs.push(service(`signer-${i + 1}`, join(SERVICES, "quorum-signer"), ["--deployment", m1File, "--rpc", RPC, "--local-unlocked", s, "--hl-api", sim.url, "--test-vol", "0.5", "--equity-pool", POOL, "--equity-hl-user", POOL_HL]));
}
procs.push(service("poker-primary", join(SERVICES, "poker"), ["--deployment", m3File, "--rpc", RPC, "--local-unlocked", POKER1!, "--role", "primary"]));
procs.push(service("poker-backup", join(SERVICES, "poker"), ["--deployment", m3File, "--rpc", RPC, "--local-unlocked", POKER2!, "--role", "backup"]));
procs.push(service("hedger", join(SERVICES, "hedger"), ["--deployment", m3File, "--rpc", RPC, "--hl-user", POOL_HL, "--venue", "sim", "--venue-url", sim.url, "--status-file", statusFile]));
procs.push(service("risk-monitor", join(SERVICES, "risk-monitor"), ["--deployment", m3File, "--rpc", RPC, "--local-unlocked", RISK!, "--hl-api", sim.url, "--hl-user", POOL_HL, "--hedger-status", statusFile, "--equity-every-seconds", "300"]));

// ---------------------------------------------------------------- actors

type Attempt = { kind: "buy" | "sell"; who: string; ok: boolean; reason?: string; gas?: bigint; phase: string };
const attempts: Attempt[] = [];
let phase = "warm-up";
const held = new Map<Address, Set<string>>();
let rng = 0x7462;
const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;

async function routerMark(m: string): Promise<number | null> {
  try {
    return Number(formatUnits(await read<bigint>(m1.MarkRouter!, "markWad", [b32(m)]), 18));
  } catch {
    return null;
  }
}

async function buy(who: Address, m: string, isCall: boolean, stepsOff: number, units: number, tempo: bigint): Promise<Attempt> {
  const mark = (await routerMark(m)) ?? PRICE[m]!;
  const k = Math.round(mark / STEP[m]! + stepsOff) * STEP[m]!;
  const r = await tx(who, ENGINE, "buy", [b32(m), isCall, parseEther(k.toFixed(2)), [{ tempo, weight: parseEther("1") }], parseEther(units.toFixed(6)), 10n ** 13n, 99_999_999_999n]);
  const a: Attempt = { kind: "buy", who, ok: r.ok, reason: r.ok ? undefined : r.reason, gas: r.ok ? r.receipt.gasUsed : undefined, phase };
  if (r.ok) {
    for (const l of r.receipt.logs) {
      try {
        const ev = decodeEventLog({ abi: engineEvents, data: l.data, topics: l.topics });
        if (ev.eventName === "Bought") {
          const set = held.get(who) ?? new Set();
          set.add((ev.args as { id: bigint }).id.toString());
          held.set(who, set);
        }
      } catch {}
    }
  }
  attempts.push(a);
  return a;
}

async function sellAll(who: Address): Promise<void> {
  for (const id of [...(held.get(who) ?? [])]) {
    if ((await read<bigint>(BOOK, "balanceOf", [BigInt(id), who])) === 0n) {
      held.get(who)!.delete(id);
      continue;
    }
    const r = await tx(who, ENGINE, "sell", [BigInt(id), 2n ** 256n - 1n, 0n, 99_999_999_999n]);
    attempts.push({ kind: "sell", who, ok: r.ok, reason: r.ok ? undefined : r.reason, gas: r.ok ? r.receipt.gasUsed : undefined, phase });
    if (r.ok) held.get(who)!.delete(id);
  }
}

async function randomTrade(): Promise<void> {
  const t = pick(TRADERS);
  if (rand() < 0.35 && (held.get(t)?.size ?? 0) > 0) {
    const id = pick([...held.get(t)!]);
    if ((await read<bigint>(BOOK, "balanceOf", [BigInt(id), t])) === 0n) return;
    const r = await tx(t, ENGINE, "sell", [BigInt(id), rand() < 0.5 ? 2n ** 256n - 1n : parseEther("0.0001"), 0n, 99_999_999_999n]);
    attempts.push({ kind: "sell", who: t, ok: r.ok, reason: r.ok ? undefined : r.reason, gas: r.ok ? r.receipt.gasUsed : undefined, phase });
    return;
  }
  const m = pick(MARKETS);
  const units = (2_000 + rand() * 18_000) / PRICE[m]!;
  await buy(t, m, rand() < 0.5, Math.floor(rand() * 5) - 2, units, pick([3600n, 86_400n, 604_800n]));
}

let trading = true;
const traderLoop = (async () => {
  while (trading) {
    try {
      await randomTrade();
    } catch (e) {
      say(`trade threw: ${(e as Error).message.split("\n")[0]}`);
    }
    await sleep(30_000 * scale);
  }
})();

const warps: number[] = [];
async function warp(label: string) {
  await rpc("evm_increaseTime", [3600]);
  await rpc("evm_mine");
  warps.push(Date.now());
  say(`chain clock +1 h (${label})`);
}
/// Raised or event lines of one risk-monitor alarm so far (tolerates a line still being written).
function alarmCount(name: string, state: string): number {
  const f = join(out, "risk-monitor.log");
  if (!existsSync(f)) return 0;
  let n = 0;
  for (const t of readFileSync(f, "utf8").split("\n")) {
    try {
      const l = JSON.parse(t) as Record<string, unknown>;
      if (l.msg === "alarm" && l.name === name && l.state === state) n++;
    } catch {
      // a line still being written
    }
  }
  return n;
}

/// The risk-monitor checks once a minute. A real drawdown pause lasts until the admin acts, so the run waits for the
/// alarm before resuming (staff would have been told); likewise for treasury events before the run stops.
async function alarmSeen(name: string, state: string, before: number): Promise<void> {
  if (await waitFor(`the risk-monitor's ${name}`, async () => alarmCount(name, state) > before, 150_000)) say(`risk-monitor announced ${name}`);
}

async function waitFor(label: string, check: () => Promise<boolean>, maxMs: number): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < maxMs) {
    if (await check()) return true;
    await sleep(5_000);
  }
  say(`timeout waiting for ${label}`);
  return false;
}
const settledRound = async (r: bigint) => (await read<bigint>(POOL, "round")) > r;
/// Waits for the next settlement after now and returns the round that settled.
async function nextSettlement(label: string, maxMs = 300_000): Promise<bigint> {
  const r = await read<bigint>(POOL, "round");
  await waitFor(label, () => settledRound(r), maxMs);
  return r;
}
const lpNotes: string[] = [];
async function claimAll(r: bigint) {
  for (const lp of LPS) {
    if ((await read<bigint>(POOL, "depositOf", [r, lp])) > 0n) await must(lp, POOL, "claimShares", [r]);
    if ((await read<bigint>(POOL, "withdrawOf", [r, lp])) > 0n) await must(lp, POOL, "withdraw", [r]);
  }
}
const navSnap: { label: string; nav: number; equityTerm: number; available: number }[] = [];
async function snapNav(label: string) {
  const [nav, eq, av] = await Promise.all([read<bigint>(POOL, "navNow"), read<bigint>(POOL, "equityTerm"), read<bigint>(POOL, "available")]);
  navSnap.push({ label, nav: usd(nav), equityTerm: usd(eq), available: usd(av) });
  say(`NAV ${usd(nav).toFixed(2)} (equity term ${usd(eq).toFixed(2)}, available ${usd(av).toFixed(2)}) at ${label}`);
}

// ---------------------------------------------------------------- the run

const phaseAt: Record<string, number> = {};
const mark = (p: string) => {
  phase = p;
  phaseAt[p] = Date.now();
  say(`phase: ${p}`);
};

// warm-up: marks fresh, samples recorded
await waitFor("router marks", async () => (await Promise.all(MARKETS.map(routerMark))).every((x) => x !== null), 180_000);
mark("A normal");
await waitFor("the keeper's first settlement", () => settledRound(0n), 240_000);
for (const [i, lp] of LPS.entries()) await must(lp, POOL, "deposit", [BigInt([3_000_000, 2_000_000, 1_000_000][i]!) * USDC]);
await sleep(150_000 * scale);
await warp("EQUITY's second round; hour 1");
const lpRound = await nextSettlement("the LP round settled");
await claimAll(lpRound);
await waitFor("EQUITY ready", () => read<boolean>(POOL, "equityReady"), 180_000);
await snapNav("after the LP round");

mark("B treasury");
await snapNav("before send");
await must(ADMIN!, POOL, "setTreasuryDailyCap", [3000]);
const sendAmt = ((await read<bigint>(POOL, "navNow")) * 25n) / 100n;
await must(ADMIN!, POOL, "sendToTreasury", [sendAmt]);
await snapNav("after send");
await sleep(90_000 * scale);
sim.deposit(usd(sendAmt)); // the bridge delivers to the pool's Hyperliquid account
say(`landing: ${usd(sendAmt)} credited on the venue`);
await sleep(60_000);
await snapNav("after landing");

mark("C shock");
// a big buyer fills the pool up to its coverage limit (the admin lifts BTC's caps so coverage is what binds)
await must(ADMIN!, POOL, "setHedgerDeltaCap", [b32("BTC"), 10n ** 16n]); // the pool refuses a directional cap the hedger cannot carry
await must(ADMIN!, POOL, "setCaps", [b32("BTC"), 10n ** 15n, 10n ** 15n]);
let big = 0;
for (let i = 0; i < 200; i++) {
  const a = await buy(BIG!, "BTC", true, 0, 2, 86_400n);
  if (!a.ok) {
    say(`big buyer stopped after ${big} buys: ${a.reason}`);
    break;
  }
  big++;
}
await snapNav("pool near its coverage limit");
shockTarget = PRICE.BTC! * 1.17;
say(`shock: BTC to ${shockTarget.toFixed(0)} (+17%) in 1.5% steps`);
await waitFor("router at the shock price", async () => ((await routerMark("BTC")) ?? 0) >= shockTarget! * 0.995, 600_000);
const shockSellsStart = attempts.length;
await sellAll(BIG!);
for (const t of TRADERS) await sellAll(t);
const shockSells = attempts.slice(shockSellsStart).filter((a) => a.kind === "sell");
say(`shock sells: ${shockSells.filter((a) => a.ok).length}/${shockSells.length} ok`);
shockTarget = null;

mark("D outage");
await warp("hour 2");
await nextSettlement("hour 2 settled");
const drawdowns: string[] = [];
if (await read<boolean>(POOL, "opensPaused")) {
  drawdowns.push("hour 2: the shock's loss (unhedged calls beyond the hedger's hard limit)");
  say("drawdown pause after the shock's loss; the admin resumes once staff are alerted (the 30-day window restarts)");
  await alarmSeen("DRAWDOWN_PAUSED", "raised", 0);
  await must(ADMIN!, POOL, "resumeOpens");
}
await waitFor("router marks fresh", async () => (await Promise.all(MARKETS.map(routerMark))).every((x) => x !== null), 180_000);
for (const t of TRADERS) await buy(t, "ETH", true, 0, 5, 86_400n); // positions to sell during the outage
sim.outage = "http500";
const outageStart = Date.now();
say(`venue outage begins (${OUTAGE_MIN} min)`);
await sleep(5 * 60_000);
const outageSellsStart = attempts.length;
for (const t of TRADERS) await sellAll(t); // stale marks: priced from the last sample
const outageSells = attempts.slice(outageSellsStart).filter((a) => a.kind === "sell");
await sleep(Math.max(0, OUTAGE_MIN * 60_000 - (Date.now() - outageStart)));
const pausedAtEnd = await Promise.all(MARKETS.map((m) => read<boolean>(POOL, "marketPaused", [b32(m)])));
sim.outage = "none";
const outageEnd = Date.now();
say(`venue back; paused at the end of the outage: ${MARKETS.map((m, i) => `${m}=${pausedAtEnd[i]}`).join(", ")}`);
await sleep(120_000);
for (const m of MARKETS) await must(ADMIN!, POOL, "unpauseMarket", [b32(m)]);
say("admin unpaused every market");

mark("E drawdown");
await waitFor("router marks fresh", async () => (await Promise.all(MARKETS.map(routerMark))).every((x) => x !== null), 180_000);
await snapNav("before the loss");
const nav0 = usd(await read<bigint>(POOL, "navNow"));
// The pool counts the lower of the latest and previous EQUITY, so a venue gain not yet confirmed by two rounds is
// not in NAV. The loss is sized against what NAV counts: wipe the uncounted gain, then 18% of NAV on top.
const venuePnl = sim.accountValue() - sim.ledger.reduce((a, e) => a + (e.type === "deposit" ? e.usdc : -(e.usdc + e.fee)), 0);
const outside = usd(await read<bigint>(POOL, "sentOut")) - usd(await read<bigint>(POOL, "receivedBack"));
const countedTerm = usd(await read<bigint>(POOL, "equityTerm")) - outside;
const countedPnl = countedTerm > 0 ? countedTerm / 0.95 : countedTerm;
const uncounted = Math.max(0, venuePnl - countedPnl);
const loss = nav0 * 0.18 + uncounted;
sim.cash -= loss; // a loss on the pool's Hyperliquid account
say(`loss of ${loss.toFixed(0)} on the venue (18% of NAV ${(nav0 * 0.18).toFixed(0)} + uncounted gain ${uncounted.toFixed(0)}; venue P&L ${venuePnl.toFixed(0)}, counted ${countedPnl.toFixed(0)})`);
await warp("hour 3: EQUITY round with the loss, then settlement");
await nextSettlement("hour 3 settled");
await snapNav("after the loss");
const drawdownPaused = await read<boolean>(POOL, "opensPaused");
if (drawdownPaused) drawdowns.push("hour 3: the 18% loss on the venue");
const pausedBuy = await buy(T1!, "BTC", true, 0, 0.1, 86_400n);
say(`drawdown pause: ${drawdownPaused}; a buy now: ${pausedBuy.ok ? "accepted" : pausedBuy.reason}`);
if (drawdownPaused) await alarmSeen("DRAWDOWN_PAUSED", "raised", drawdowns.length - 1); // the hour 3 entry is already listed
await must(ADMIN!, POOL, "resumeOpens");
say("admin resumed opens");

mark("F wind-down");
trading = false;
await traderLoop;
for (const t of TRADERS) await sellAll(t);
// part of the capital comes back from the venue
const back = usd(sendAmt) / 2;
sim.withdraw(back, 1);
await must(TREASURY!, POOL, "receiveFromTreasury", [BigInt(Math.round((back - 1) * 1e6))]);
say(`return: ${back - 1} received back (fee 1)`);
await alarmSeen("TREASURY_RETURNED", "event", 0);
for (const lp of LPS) {
  const sh = await read<bigint>(POOL, "balanceOf", [lp]);
  if (sh > 0n) await must(lp, POOL, "requestWithdraw", [sh / 2n]);
}
await warp("hour 4: wind-down settlement");
const windDown = await nextSettlement("wind-down round settled");
await claimAll(windDown);
await snapNav("end");
const endTime = Date.now();

walking = false;
await pricer;
for (const p of procs) p.kill("SIGTERM");
await Promise.all(procs.map((p) => p.exited));
sim.stop();

// ---------------------------------------------------------------- report

const report: string[] = [];
const crit: string[] = ["== criteria"];
const check = (ok: boolean, what: string) => crit.push(`${ok ? "PASS" : "FAIL"}  ${what}`);
const median = (xs: bigint[]) => (xs.length ? [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[Math.floor(xs.length / 2)]! : 0n);
const lines = (name: string) => (existsSync(join(out, `${name}.log`)) ? readFileSync(join(out, `${name}.log`), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);

// 1 law 3
const sells = attempts.filter((a) => a.kind === "sell");
const sellFails = sells.filter((a) => !a.ok && a.reason !== "NothingToSell");
report.push(`sells: ${sells.filter((a) => a.ok).length} ok of ${sells.length}; during the shock ${shockSells.filter((a) => a.ok).length}/${shockSells.length}; during the outage ${outageSells.filter((a) => a.ok).length}/${outageSells.length}`);
check(sellFails.length === 0 && shockSells.length > 0 && outageSells.length > 0, `law 3: every sell succeeded, in every phase (${sellFails.length} failed: ${sellFails.map((a) => `${a.phase}/${a.reason}`).join(", ")})`);

// 2 buy refusals
const EXPECTED = new Set(["CoverageBreached", "MarketIsPaused", "OpensArePaused", "StrikeOutOfBand", "NotCaughtUp", "Stale", "NoData", "DirectionalCapExceeded", "NotionalCapExceeded"]);
const buys = attempts.filter((a) => a.kind === "buy");
const refused = new Map<string, number>();
for (const a of buys.filter((x) => !x.ok)) refused.set(`${a.phase}:${a.reason}`, (refused.get(`${a.phase}:${a.reason}`) ?? 0) + 1);
report.push(`buys: ${buys.filter((a) => a.ok).length} ok of ${buys.length}; refused: ${[...refused].map(([k, n]) => `${k} ×${n}`).join(", ") || "none"}`);
// a refusal that simulated fine and reverted when mined (a pause or stale mark landed in between) is named from the trace
const unexpected = buys.filter((a) => !a.ok && !EXPECTED.has((a.reason ?? "").replace(/^reverted on chain: /, "")));
check(unexpected.length === 0 && !pausedBuy.ok && pausedBuy.reason === "OpensArePaused" && drawdowns.some((d) => d.startsWith("hour 3")), `buys refused only for expected reasons, and refused during the drawdown pause (${unexpected.length} unexpected: ${unexpected.map((a) => a.reason).join(", ")})`);

// 3 coverage and reserve
const finalAvail = usd(await read<bigint>(POOL, "available").catch(() => 0n));
report.push(`big buyer filled ${big} buys of 2 BTC calls before the coverage rule stopped it`);
check(big > 0 && attempts.some((a) => a.who === BIG && !a.ok && a.reason === "CoverageBreached"), "coverage: the big buyer was stopped by CoverageBreached (no accepted buy breached it)");

// 4 hedger
const hedger = lines("hedger");
const hedgeRows = hedger.filter((l) => l.msg === "hedge");
const hedgeErrors = hedgeRows.filter((l) => l.status === "error" && Date.parse(String(l.sent_at)) < outageStart);
const plansUp = hedger.filter((l) => l.msg === "plan" && (Date.parse(String(l.t)) < outageStart || Date.parse(String(l.t)) > outageEnd + 120_000));
const inBand = plansUp.filter((l) => l.reason === "in-band").length;
report.push(`hedger: ${hedgeRows.length} hedge rows (${hedgeRows.filter((l) => l.status === "filled").length} filled, ${hedgeRows.filter((l) => l.status === "partial").length} partial), ${plansUp.length} plans with the venue up, ${inBand} in band`);
check(hedgeRows.length > 0 && hedgeErrors.length === 0 && inBand / Math.max(1, plansUp.length) >= 0.8, `hedger: hedges filled with the venue up, no venue errors, ≥80% of passes in band (${((100 * inBand) / Math.max(1, plansUp.length)).toFixed(0)}%)`);

// 5 risk-monitor
const risk = lines("risk-monitor").filter((l) => l.msg === "alarm");
const pausedAlarms = risk.filter((l) => l.name === "VENUE_DOWN_PAUSED");
const pauseDelays = pausedAlarms.map((l) => (Date.parse(String(l.t)) - outageStart) / 60_000);
const recovered = risk.filter((l) => l.name === "VENUE_RECOVERED");
const treasuryAlarms = risk.filter((l) => l.name === "TREASURY_SENT" || l.name === "TREASURY_RETURNED");
const mismatch = risk.filter((l) => l.name === "EQUITY_MISMATCH" && l.state === "raised");
const drawdownAlarm = risk.filter((l) => l.name === "DRAWDOWN_PAUSED" && l.state === "raised");
report.push(`risk-monitor: pauses at ${pauseDelays.map((d) => d.toFixed(1)).join(", ")} min into the outage; ${recovered.length} recoveries; ${treasuryAlarms.length} treasury events; ${mismatch.length} EQUITY mismatches; drawdown alarm ${drawdownAlarm.length}`);
const cleared = risk.filter((l) => l.name === "EQUITY_MISMATCH" && l.state === "cleared");
report.push(`EQUITY_MISMATCH: ${mismatch.map((l) => `${new Date(String(l.t)).toISOString().slice(11, 19)} ${JSON.stringify(l.values)}`).join("; ") || "none"}; cleared ${cleared.length}`);
check(
  pausedAlarms.length === 3 && pauseDelays.every((d) => d >= 15 && d <= 17.5) && recovered.length === 3 && treasuryAlarms.length >= 2 && drawdownAlarm.length === drawdowns.length && drawdowns.length >= 1,
  "risk-monitor: 3 pauses 15–17.5 min into the outage, 3 recoveries, treasury send and return announced, a drawdown alarm for every drawdown pause",
);
check(mismatch.length === cleared.length, `risk-monitor: every EQUITY_MISMATCH cleared once EQUITY caught up (${mismatch.length} raised, ${cleared.length} cleared; see the list above)`);

// 6 keeper and poker
const settles = lines("poker-primary").concat(lines("poker-backup")).filter((l) => l.msg === "keeper: settled");
const settleStale = risk.filter((l) => l.name === "SETTLEMENT_STALE" && l.state === "raised");
const nearWarp = (t: number) => warps.some((w) => t >= w && t <= w + 180_000);
const sampleStaleOutside = risk.filter((l) => {
  const t = Date.parse(String(l.t));
  return l.name === "SAMPLE_STALE" && l.state === "raised" && (t < outageStart || t > outageEnd + 300_000) && !nearWarp(t);
});
report.push(`drawdown pauses: ${drawdowns.join("; ") || "none"}`);
report.push(`keeper: ${settles.length} settlements; SETTLEMENT_STALE ${settleStale.length}; SAMPLE_STALE outside the outage ${sampleStaleOutside.length}`);
check(settles.length >= 5 && settleStale.length === 0 && sampleStaleOutside.length === 0, "keeper and poker: every hour settled, no stale-sample alarm outside the outage");

// 7 accounting
const engineUsdc = await read<bigint>(MUSDC, "balanceOf", [ENGINE]).catch(() => -1n);
let onchain = 0n;
for (const w of [POOL, PROTO!, TREASURY!, BIG!, ...LPS, ...TRADERS, acc[0]!, ADMIN!]) onchain += await read<bigint>(MUSDC, "balanceOf", [w]).catch(() => 0n);
const supply = await read<bigint>(MUSDC, "totalSupply").catch(() => 0n);
const evLogs = await client.getLogs({ address: ENGINE, fromBlock: 0n }).catch(() => []);
let protoExpected = 0n;
for (const l of evLogs) {
  try {
    const ev = decodeEventLog({ abi: engineEvents, data: l.data, topics: l.topics });
    protoExpected += ((ev.args as { fee: bigint }).fee * 1000n) / 10_000n;
  } catch {}
}
const protoGot = await read<bigint>(MUSDC, "balanceOf", [PROTO!]).catch(() => 0n);
let rawMismatch = 0;
for (const w of [BIG!, ...TRADERS]) for (const id of held.get(w) ?? []) if ((await read<bigint>(POOL, "seriesRaw", [BigInt(id)])) !== (await read<bigint>(BOOK, "balanceOf", [BigInt(id), w]))) rawMismatch++;
report.push(`accounting: engine ${usd(engineUsdc)}; USDC on-chain ${usd(onchain)} of supply ${usd(supply)}; protocol ${usd(protoGot)} vs 10% of fees ${usd(protoExpected)}; open series mismatches ${rawMismatch}`);
check(engineUsdc === 0n && onchain === supply && protoGot === protoExpected && rawMismatch === 0, "accounting: engine holds 0, USDC conserved, protocol received exactly 10% of every fee, pool raw = holders");

// 8 logs
let errorLines = 0;
const samples: string[] = [];
for (const f of ["signer-1", "signer-2", "signer-3", "poker-primary", "poker-backup", "hedger", "risk-monitor"]) {
  for (const l of lines(f)) {
    const t = Date.parse(String(l.t));
    const inOutage = t >= outageStart && t <= outageEnd + 180_000;
    if (l.level === "error" && !inOutage) {
      errorLines++;
      if (samples.length < 4) samples.push(`${f}: ${JSON.stringify(l).slice(0, 220)}`);
    }
  }
}
check(errorLines === 0, `no error lines outside the outage window (${errorLines}${samples.length ? ": " + samples.join(" | ") : ""})`);

// 9 gas
const buyGas = buys.filter((a) => a.ok).map((a) => a.gas!);
const sellGas = sells.filter((a) => a.ok).map((a) => a.gas!);
const pokes = lines("poker-primary").concat(lines("poker-backup")).filter((l) => l.msg === "poked").map((l) => BigInt(String(l.gasUsed)));
const marks = lines("poker-primary").concat(lines("poker-backup")).filter((l) => l.msg === "keeper: marked").map((l) => BigInt(String(l.gasUsed)));
const starts = lines("poker-primary").concat(lines("poker-backup")).filter((l) => l.msg === "keeper: epoch started").map((l) => BigInt(String(l.gasUsed)));
const settleGas = settles.map((l) => BigInt(String(l.gasUsed)));
const votes = ["signer-1", "signer-2", "signer-3"].flatMap((f) => lines(f)).filter((l) => l.msg === "voted").map((l) => BigInt(String(l.gasUsed)));
report.push(
  `gas medians: buy ${median(buyGas)}, sell ${median(sellGas)}, poke ${median(pokes)}, startEpoch ${median(starts)}, markChunk ${median(marks)}, settle ${median(settleGas)}, vote ${median(votes)}`,
);
report.push(`NAV snapshots: ${navSnap.map((n) => `${n.label} ${n.nav.toFixed(2)}`).join("; ")}`);
check(buyGas.length > 0 && sellGas.length > 0 && pokes.length > 0 && marks.length > 0 && settleGas.length > 0 && votes.length > 0, "gas measured for buy, sell, poke, startEpoch, markChunk, settle and vote");

const text = [`run ${((endTime - T0) / 60_000).toFixed(1)} min; logs in ${out}`, ...report, "", ...crit].join("\n") + "\n";
writeFileSync(join(out, "report.txt"), text);
writeFileSync(join(out, "attempts.json"), JSON.stringify(attempts, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1));
console.log("\n" + text);
anvil.kill();
say("done");
void finalAvail;
void lpNotes;
