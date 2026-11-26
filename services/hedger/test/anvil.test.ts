import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicClient, createWalletClient, decodeEventLog, formatEther, http, parseEther, stringToHex, type Address, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { bookAbi, poolHeldCoins, readPositions, walkedNorm } from "../src/book.ts";
import { targetHedge } from "../src/delta.ts";
import { blendValue } from "../src/tempo.ts";
import { SimExchange } from "../src/simexchange.ts";
import { TEARDOWN_MS, hookLimit, within } from "@tourbillon/common/hooks.ts";

// On a local anvil: DeployM1 + DeployM4 (the M3 system plus the WriterBook), routes applied, signers' votes sent by the test, an LP round, trades of varied
// terms. Then: the TS value equals the on-chain value in every Bought event; the simulated walk equals a real walk;
// hedger-cex hedges BTC and ETH at the simulated exchange (dry runs, fills, partials, outages); hedger-onchain hedges
// STK1 through the pool's hedgeSwap and a mock router (no router listed = an outage). Skipped without anvil/forge.
const haveTools = Bun.which("anvil") !== null && Bun.which("forge") !== null;
const CONTRACTS = resolve(import.meta.dir, "../../../contracts");
const PORT = 21545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const PX: Record<string, string> = { BTC: "100000", ETH: "3000", STK1: "40" }; // the signers' marks (mutable)
const SZ: Record<string, number> = { BTC: 5, ETH: 4 };

const boardAbi = [
  { type: "function", name: "markKey", stateMutability: "pure", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "volKey", stateMutability: "pure", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32" }] },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }],
  },
  { type: "function", name: "vote", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint80" }, { type: "uint256" }], outputs: [] },
] as const;
const part = { type: "tuple[]", components: [{ type: "uint256", name: "tempo" }, { type: "uint256", name: "weight" }] } as const;
const engineAbi = [
  {
    type: "function",
    name: "buy",
    stateMutability: "nonpayable",
    inputs: [{ type: "bytes32" }, { type: "bool" }, { type: "uint128" }, part, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    outputs: [{ type: "uint256" }, { type: "uint256" }],
  },
  {
    type: "event",
    name: "Bought",
    inputs: [
      { type: "address", name: "buyer", indexed: true },
      { type: "uint256", name: "id", indexed: true },
      { type: "bytes32", name: "market", indexed: true },
      { type: "uint256", name: "units", indexed: false },
      { type: "uint256", name: "raw", indexed: false },
      { type: "uint256", name: "sWad", indexed: false },
      { type: "uint256", name: "sigmaBps", indexed: false },
      { type: "uint256", name: "unitValueWad", indexed: false },
      { type: "uint256", name: "premium", indexed: false },
      { type: "uint256", name: "fee", indexed: false },
    ],
  },
] as const;
const poolAbi = [
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "startEpoch", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "markChunk", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "settle", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;
const usdcAbi = [
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;
const pokeAbi = [{ type: "function", name: "poke", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }, { type: "bool" }, { type: "bool" }] }] as const;
const routeAbi = [{ type: "function", name: "applyRoute", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] }] as const;

let anvil: ReturnType<typeof Bun.spawn> | undefined;
let sim: SimExchange | undefined;
let tmp = "";
let m3File = "";
let m1: Record<string, Address>;
let m3: Record<string, Address>;
let acc: Address[] = [];
const client = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: 100 }) as PublicClient;
const wallet = (a: Address) => createWalletClient({ chain: foundry, transport: http(RPC), account: a });
const b32 = (m: string) => stringToHex(m, { size: 32 });

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return ((await res.json()) as { result: unknown }).result;
}

/// Sends with 2× gas headroom (the estimate is made against the latest block; a walk in a later block can need a
/// little more) and fails loudly if the transaction reverts.
async function send(from: Address, address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) {
  const gas = await client.estimateContractGas({ address, abi, functionName, args, account: from } as never);
  const hash = await wallet(from).writeContract({ address, abi, functionName, args, gas: gas * 2n } as never);
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return r;
}

async function vote(markets: string[]): Promise<void> {
  for (const m of markets) {
    for (const fn of ["markKey", "volKey"] as const) {
      const key = await client.readContract({ address: m1.QuorumBoard!, abi: boardAbi, functionName: fn, args: [b32(m)] });
      let round = 0n;
      try {
        [round] = await client.readContract({ address: m1.QuorumBoard!, abi: boardAbi, functionName: "latestRoundData", args: [key] });
      } catch {
        round = 0n;
      }
      const v = fn === "markKey" ? parseEther(PX[m]!) : parseEther("0.5");
      for (const s of [acc[2]!, acc[3]!, acc[4]!]) await send(s, m1.QuorumBoard!, boardAbi, "vote", [key, round + 1n, v]);
    }
  }
}

/// The board clamps each MARK round to a 2% step, so a bigger move takes several rounds: vote until the router's mark
/// for `market` equals the signers' price.
async function voteUntil(market: string): Promise<void> {
  const routerAbi = [{ type: "function", name: "markWad", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] }] as const;
  for (let i = 0; i < 20; i++) {
    await vote([market]);
    const mark = await client.readContract({ address: m1.MarkRouter!, abi: routerAbi, functionName: "markWad", args: [b32(market)] });
    if (mark === parseEther(PX[market]!)) return;
  }
  throw new Error(`router mark for ${market} did not reach ${PX[market]}`);
}

async function hedger(...args: string[]): Promise<Record<string, unknown>[]> {
  return run("src/cex.ts", ...args);
}

async function onchain(...args: string[]): Promise<Record<string, unknown>[]> {
  return run("src/onchain.ts", ...args);
}

async function run(entry: string, ...args: string[]): Promise<Record<string, unknown>[]> {
  const p = Bun.spawn(["bun", entry, "--deployment", m3File, "--rpc", RPC, "--once", ...args], {
    cwd: resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

beforeAll(within(import.meta.path, "setup", 300_000, async () => {
  if (!haveTools) return;
  tmp = mkdtempSync(join(tmpdir(), "hedger-anvil-"));
  anvil = Bun.spawn(["anvil", "--port", String(PORT), "--silent", "--accounts", "12"], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      await client.getChainId();
      break;
    } catch {
      await Bun.sleep(100);
    }
  }
  acc = (await rpc("eth_accounts")) as Address[];
  // ListEquityFeed reads the deployment DeployM4 just wrote (never a file left over from another run)
  const env = { ...process.env, ADMIN: acc[1]!, SIGNERS: `${acc[2]},${acc[3]},${acc[4]}`, M3_DEPLOYMENT: "deployments/31337-m4.json" };
  for (const [script, sender] of [
    ["DeployM1.s.sol:DeployM1", acc[0]!],
    ["DeployM4.s.sol:DeployM4", acc[0]!],
    ["ListEquityFeed.s.sol:ListEquityFeed", acc[1]!],
  ] as const) {
    const r = Bun.spawnSync(["forge", "script", `script/${script}`, "--rpc-url", RPC, "--unlocked", "--sender", sender, "--broadcast"], { cwd: CONTRACTS, env });
    if (r.exitCode !== 0) throw new Error(`${script} failed: ${r.stderr.toString()}`);
  }
  copyFileSync(join(CONTRACTS, "deployments", "31337.json"), join(tmp, "31337.json"));
  m3File = join(tmp, "31337-m4.json"); // every M3 key plus WriterBook and MockStockToken
  copyFileSync(join(CONTRACTS, "deployments", "31337-m4.json"), m3File);
  m1 = await Bun.file(join(tmp, "31337.json")).json();
  m3 = await Bun.file(m3File).json();
  await rpc("evm_increaseTime", [3600]);
  await rpc("evm_mine");
  for (const m of ["BTC", "ETH", "STK1"]) await send(acc[5]!, m1.MarkRouter!, routeAbi, "applyRoute", [b32(m)]);
  await vote(["BTC", "ETH", "STK1"]);
  for (const m of ["BTC", "ETH", "STK1"]) await send(acc[9]!, m3.PathFundingBook!, pokeAbi, "poke", [b32(m)]);
  // an LP round
  const LP = acc[7]!;
  await send(LP, m3.SettlementToken!, usdcAbi, "mint", [LP, 5_000_000n * 10n ** 6n]);
  await send(LP, m3.SettlementToken!, usdcAbi, "approve", [m3.MainspringPool!, 5_000_000n * 10n ** 6n]);
  await send(LP, m3.MainspringPool!, poolAbi, "deposit", [5_000_000n * 10n ** 6n]);
  await send(acc[9]!, m3.MainspringPool!, poolAbi, "startEpoch");
  await send(acc[9]!, m3.MainspringPool!, poolAbi, "markChunk", [100n]);
  await send(acc[9]!, m3.MainspringPool!, poolAbi, "settle");
  // trades of varied terms
  const T = acc[8]!;
  await send(T, m3.SettlementToken!, usdcAbi, "mint", [T, 1_000_000n * 10n ** 6n]);
  await send(T, m3.SettlementToken!, usdcAbi, "approve", [m3.Engine!, 1_000_000n * 10n ** 6n]);
  const day = 86_400n;
  const trades: [string, boolean, string, { tempo: bigint; weight: bigint }[], string][] = [
    ["BTC", true, "100000", [{ tempo: day, weight: parseEther("1") }], "1"],
    ["BTC", false, "98000", [{ tempo: 7n * day, weight: parseEther("1") }], "2"],
    ["BTC", true, "103000", [{ tempo: 3600n, weight: parseEther("1") }], "0.5"],
    ["ETH", true, "3000", [{ tempo: 3600n, weight: parseEther("0.2") }, { tempo: day, weight: parseEther("0.5") }, { tempo: 7n * day, weight: parseEther("0.3") }], "20"],
    ["ETH", false, "3100", [{ tempo: 30n * day, weight: parseEther("1") }], "10"],
    ["STK1", true, "39", [{ tempo: day, weight: parseEther("1") }], "500"],
    ["STK1", false, "41", [{ tempo: 7n * day, weight: parseEther("1") }], "300"],
  ];
  for (const [m, isCall, k, mv, units] of trades) {
    await send(T, m3.Engine!, engineAbi, "buy", [b32(m), isCall, parseEther(k), mv, parseEther(units), 10n ** 12n, 99_999_999_999n]);
  }
}), hookLimit(300_000));

afterAll(within(import.meta.path, "teardown", TEARDOWN_MS, () => {
  anvil?.kill();
  sim?.stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}), hookLimit(TEARDOWN_MS));

test.skipIf(!haveTools)("the TS value equals the on-chain value of every trade (Bought events)", async () => {
  const logs = await client.getLogs({ address: m3.Engine!, fromBlock: 0n });
  let checked = 0;
  for (const l of logs) {
    let ev;
    try {
      ev = decodeEventLog({ abi: engineAbi, data: l.data, topics: l.topics });
    } catch {
      continue;
    }
    if (ev.eventName !== "Bought") continue;
    const a = ev.args;
    const [, isCall, kWad, movement] = await client.readContract({ address: m3.PathFundingBook!, abi: bookAbi, functionName: "seriesOf", args: [a.id] });
    const parts = movement.map((p) => ({ tempo: Number(p.tempo), weight: Number(formatEther(p.weight)) }));
    const ts = blendValue(isCall, Number(formatEther(a.sWad)), Number(formatEther(kWad)), Number(a.sigmaBps), parts);
    const onchain = Number(formatEther(a.unitValueWad));
    expect(Math.abs(ts - onchain) / onchain).toBeLessThan(1e-9);
    checked++;
  }
  expect(checked).toBe(7);
}, 60_000);

test.skipIf(!haveTools)("the simulated walk equals a real walk", async () => {
  // move time on by an hour with a fresh sample each window, so the BTC series fall behind
  for (let i = 0; i < 12; i++) {
    await rpc("evm_increaseTime", [300]);
    await rpc("evm_mine");
    await vote(["BTC"]);
    await send(acc[9]!, m3.PathFundingBook!, pokeAbi, "poke", [b32("BTC")]);
  }
  const before = await readPositions(client, m3.MainspringPool!, m3.PathFundingBook!, "BTC");
  expect(before.length).toBe(3);
  const ids = await client.readContract({
    address: m3.MainspringPool!,
    abi: [{ type: "function", name: "openSeries", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256[]" }] }] as const,
    functionName: "openSeries",
    args: [b32("BTC")],
  });
  for (const id of ids) {
    const simAt = Number((await client.getBlock()).timestamp); // the simulation runs at the latest block's time
    const simulated = await walkedNorm(client, m3.PathFundingBook!, id);
    expect(simulated).toBeLessThan(10n ** 18n); // funding has been charged
    const receipt = await send(acc[9]!, m3.PathFundingBook!, bookAbi, "accrue", [id, 2n ** 256n - 1n]);
    const realAt = Number((await client.getBlock({ blockNumber: receipt.blockNumber })).timestamp);
    const normNow = await client.readContract({
      address: m3.PathFundingBook!,
      abi: [{ type: "function", name: "normNow", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] }] as const,
      functionName: "normNow",
      args: [id],
    });
    // the real walk lands in a later block: the only difference allowed is the funding of the seconds in between,
    // at most 1/3600 per second (the shortest tempo here is 1 hour)
    expect(simulated).toBeGreaterThanOrEqual(normNow);
    const gap = Math.max(0, realAt - simAt);
    expect(Number(simulated - normNow) / Number(simulated)).toBeLessThanOrEqual(gap / 3600 + 1e-9);
  }
}, 180_000);

test.skipIf(!haveTools)("dry run: a plan and intended orders per market, nothing sent; a tight cap raises the alarm", async () => {
  await vote(["BTC", "ETH", "STK1"]); // fresh router marks and board vols
  const lines = await hedger("--positions", "BTC=0,ETH=0");
  const plans = lines.filter((l) => l.msg === "plan");
  expect(plans.map((l) => l.market).sort()).toEqual(["BTC", "ETH"]); // STK1 is a stock market: hedger-onchain's
  expect(plans.every((p) => p.venue === "cex")).toBe(true);
  for (const p of plans) expect(Number(p.series)).toBeGreaterThan(0);
  const btc = plans.find((p) => p.market === "BTC")!;
  expect(Number(btc.target)).not.toBe(0);
  // with the default caps every net delta here is inside its band: correctly, no orders and no alarm
  expect(plans.every((p) => p.reason === "in-band")).toBe(true);
  expect(lines.some((l) => l.msg === "would send")).toBe(false);
  expect(lines.some((l) => l.level === "alarm")).toBe(false);

  // a $50,000 ETH cap (band 1.67 coins at $3,000): the ETH target is outside the band, so an order is planned
  const eth = await hedger("--positions", "BTC=0,ETH=0", "--delta-cap", "ETH=50000");
  const ethPlan = eth.find((l) => l.msg === "plan" && l.market === "ETH")!;
  expect(ethPlan.reason).toBe("rebalance");
  const order = eth.find((l) => l.msg === "would send" && l.market === "ETH")!;
  expect(order.dryRun).toBe(true);
  expect(order.side).toBe(Number(ethPlan.target) > 0 ? "buy" : "sell");
  expect(order.tif).toBe("Ioc");

  // a $1,000 BTC cap: the target is far above the hard limit, so the remainder is reported, not silently clipped
  const tight = await hedger("--positions", "BTC=0,ETH=0", "--delta-cap", "BTC=1000");
  const alarm = tight.find((l) => l.level === "alarm" && l.market === "BTC");
  expect(alarm).toBeDefined();
  expect(Number(alarm!.hardLimit)).toBeCloseTo(0.01, 9); // $1,000 / $100,000
  expect(Number(alarm!.unhedgedCoins)).toBeCloseTo(Math.abs(Number(btc.target)) - 0.01, 6);
  expect(Number(alarm!.unhedgedUsd)).toBeCloseTo(Number(alarm!.unhedgedCoins) * 100_000, 3);
}, 120_000);

// ---------------------------------------------------------------- hedger-cex against the simulated exchange

async function hedgerOnSim(...args: string[]) {
  return hedger("--exchange", "sim", "--exchange-url", sim!.url, ...args);
}

function startSim() {
  sim = new SimExchange(["BTC", "ETH"].map((n) => ({ name: n, szDecimals: SZ[n]!, pxDecimals: 2, mid: Number(PX[n]) })));
}

test.skipIf(!haveTools)("hedger-cex: target → IOC → fill → position; the next pass is in band", async () => {
  await vote(["BTC", "ETH", "STK1"]);
  startSim();
  const first = await hedgerOnSim("--delta-cap", "ETH=50000");
  const row = first.find((l) => l.msg === "hedge" && l.market === "ETH")!;
  expect(row).toBeDefined();
  expect(row.status).toBe("filled");
  expect(row.via).toBe("cex_api");
  const target = Number(first.find((l) => l.msg === "plan" && l.market === "ETH")!.target);
  expect(sim!.positions.get("ETH")!.szi).toBeCloseTo(target, 3);
  expect(Number(row.position_after)).toBeCloseTo(target, 3);
  expect(sim!.rejected).toEqual([]);
  expect(first.some((l) => l.market === "STK1")).toBe(false); // never a stock market at the exchange

  const second = await hedgerOnSim("--delta-cap", "ETH=50000");
  expect(second.find((l) => l.msg === "plan" && l.market === "ETH")!.reason).toBe("in-band");
  expect(second.some((l) => l.msg === "hedge")).toBe(false);
}, 120_000);

test.skipIf(!haveTools)("hedger-cex: partial fills converge over passes; a price move triggers a rebalance", async () => {
  await vote(["BTC", "ETH", "STK1"]); // router marks are fresh for 120 s only
  // BTC with a cap set so the hard limit is twice the target: the band is a fifth of it
  const dry = await hedger("--positions", "BTC=0,ETH=0");
  const t0 = Math.abs(Number(dry.find((l) => l.msg === "plan" && l.market === "BTC")!.target));
  expect(t0).toBeGreaterThan(0.01);
  const cap = `BTC=${Math.round(2 * t0 * 100_000)},ETH=50000`;
  sim!.partialFraction = 0.5;
  const p1 = await hedgerOnSim("--delta-cap", cap);
  const target = Number(p1.find((l) => l.msg === "plan" && l.market === "BTC")!.target);
  const after1 = sim!.positions.get("BTC")!.szi;
  expect(Math.abs(after1)).toBeLessThan(Math.abs(target)); // half filled
  for (let i = 0; i < 4; i++) await hedgerOnSim("--delta-cap", cap);
  await vote(["BTC", "ETH", "STK1"]);
  const last = await hedgerOnSim("--delta-cap", cap);
  expect(last.find((l) => l.msg === "plan" && l.market === "BTC")!.reason).toBe("in-band");
  expect(Math.abs(sim!.positions.get("BTC")!.szi - target)).toBeLessThanOrEqual(0.2 * Math.abs(target) + 1e-9);
  sim!.partialFraction = 1;

  // ETH +10%: router marks and the exchange move together; the calls' deltas rise, so the hedge is rebalanced
  const ethBefore = sim!.positions.get("ETH")!.szi;
  PX.ETH = "3300";
  await voteUntil("ETH"); // five 2% rounds
  sim!.setMid("ETH", 3300);
  const moved = await hedgerOnSim("--delta-cap", cap);
  expect(moved.find((l) => l.msg === "plan" && l.market === "ETH")!.reason).toBe("rebalance");
  expect(moved.some((l) => l.msg === "hedge" && l.market === "ETH" && l.status === "filled")).toBe(true);
  expect(sim!.positions.get("ETH")!.szi).not.toBeCloseTo(ethBefore, 3);
}, 240_000);

test.skipIf(!haveTools)("hedger-cex: an outage of 3 passes raises an alarm; --dry-run never places an order", async () => {
  sim!.outage = "http500";
  // the key is issued before the outage switch takes effect on the passes
  const p = Bun.spawn(
    ["bun", "src/cex.ts", "--deployment", m3File, "--rpc", RPC, "--exchange", "sim", "--exchange-url", sim!.url, "--tick-seconds", "1", "--status-file", join(tmp, "status.json")],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
  );
  await Bun.sleep(6_000);
  p.kill("SIGTERM");
  const lines = (await new Response(p.stdout).text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  expect(lines.some((l) => l.level === "alarm" && l.msg === "hedging failing" && Number(l.failures) >= 3)).toBe(true);
  // the status file the risk-monitor reads: every crypto market failing during the outage
  const st = (await Bun.file(join(tmp, "status.json")).json()) as { updatedAt: string; venue: string; markets: Record<string, { ok: boolean }> };
  expect(Date.now() - Date.parse(st.updatedAt)).toBeLessThan(30_000);
  expect(st.venue).toBe("cex");
  expect(["BTC", "ETH"].every((m) => st.markets[m]?.ok === false)).toBe(true);
  expect(st.markets.STK1).toBeUndefined();
  sim!.outage = "none";

  await vote(["BTC", "ETH", "STK1"]);
  const before = sim!.requests.filter((r) => r.path === "/v1/orders").length;
  const dry = await hedgerOnSim("--delta-cap", "ETH=1000", "--dry-run");
  expect(dry.some((l) => l.msg === "would send")).toBe(true);
  expect(sim!.requests.filter((r) => r.path === "/v1/orders").length).toBe(before);
}, 120_000);

// ---------------------------------------------------------------- M4: shapes, writes and the pool's STK1 stock

const leg = { type: "tuple[]", components: [{ type: "bool", name: "isCall" }, { type: "uint128", name: "kWad" }, { type: "int128", name: "qty" }] } as const;
const shapeAbi = [
  { type: "function", name: "buyShape", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, leg, part, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "write", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, leg, part, { type: "uint256" }, { type: "bool" }, { type: "int256" }, { type: "uint256" }], outputs: [{ type: "uint256" }, { type: "int256" }] },
] as const;

test.skipIf(!haveTools)("M4: the target counts bought shapes, written shapes (the pool long) and the pool's STK1 stock", async () => {
  await vote(["BTC", "ETH", "STK1"]);
  for (const m of ["BTC", "ETH", "STK1"]) await send(acc[9]!, m3.PathFundingBook!, pokeAbi, "poke", [b32(m)]).catch(() => undefined);
  const now = BigInt((await client.getBlock()).timestamp) + 600n;
  const day = [{ tempo: 86_400n, weight: 10n ** 18n }];
  const T = acc[8]!;
  // a bought STK1 call spread 40 / 44
  await send(T, m3.Engine!, shapeAbi, "buyShape", [b32("STK1"), [{ isCall: true, kWad: parseEther("40"), qty: 10n ** 18n }, { isCall: true, kWad: parseEther("44"), qty: -(10n ** 18n) }], day, parseEther("50"), 2n ** 255n, now]);
  // a covered STK1 Rise at 46 written to the pool
  const W = acc[6]!; // free in this test file
  await send(W, m3.MockStockToken!, usdcAbi, "mint", [W, parseEther("100")]);
  await send(W, m3.MockStockToken!, usdcAbi, "approve", [m3.WriterBook!, parseEther("100")]);
  await send(W, m3.SettlementToken!, usdcAbi, "mint", [W, 1_000n * 10n ** 6n]);
  await send(W, m3.SettlementToken!, usdcAbi, "approve", [m3.WriterBook!, 1_000n * 10n ** 6n]);
  await send(W, m3.WriterBook!, shapeAbi, "write", [b32("STK1"), [{ isCall: true, kWad: parseEther("46"), qty: -(10n ** 18n) }], day, parseEther("30"), true, -(2n ** 200n), now]);
  // STK1 stock the pool holds outright, as after a buyback paid in STK1 stock
  await send(acc[0]!, m3.MockStockToken!, usdcAbi, "mint", [m3.MainspringPool!, parseEther("7")]);

  const positions = await readPositions(client, m3.MainspringPool!, m3.PathFundingBook!, "STK1");
  const spread = positions.find((p) => p.legs.length === 2)!;
  expect(spread.legs.map((l) => [l.isCall, l.k, l.qty])).toEqual([[true, 40, 1], [true, 44, -1]]);
  expect(spread.units).toBeGreaterThan(49.9);
  expect(spread.units).toBeLessThanOrEqual(50);
  const written = positions.find((p) => p.legs.length === 1 && p.legs[0]!.k === 46)!;
  expect(written.legs[0]).toEqual({ isCall: true, k: 46, qty: 1 }); // the pool's side: long the Rise
  expect(written.units).toBeLessThan(-29.9); // the pool holds it
  expect(written.units).toBeGreaterThanOrEqual(-30);
  expect(await poolHeldCoins(client, m3.MainspringPool!, "STK1")).toBe(7);
  expect(await poolHeldCoins(client, m3.MainspringPool!, "BTC")).toBe(0);

  // hedger-onchain: the holding that offsets the option delta, against the 7 shares the pool already holds
  const lines = await onchain("--dry-run", "--delta-cap", "STK1=1000000");
  const plan = lines.find((l) => l.msg === "plan" && l.market === "STK1")!;
  expect(plan.venue).toBe("onchain");
  expect(Number(plan.current)).toBe(7);
  expect(Number(plan.wanted)).toBeCloseTo(targetHedge(positions, Number(plan.s), Number(plan.sigmaBps), 0), 1);
}, 120_000);

// ---------------------------------------------------------------- hedger-onchain through the pool (G7)

const hedgeAdminAbi = [
  { type: "function", name: "setHedge", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint16" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "grantRole", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [] },
  { type: "function", name: "HEDGER_ROLE", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
] as const;
const balAbi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;

test.skipIf(!haveTools)("hedger-onchain: no router listed is an outage; then target → hedgeSwap → the pool holds the stock", async () => {
  await vote(["BTC", "ETH", "STK1"]);
  const KEEPER = acc[10]!;
  const status = join(tmp, "status-onchain.json");
  const none = await onchain("--local-unlocked", KEEPER, "--delta-cap", "STK1=20000", "--status-file", status);
  expect(none.some((l) => l.level === "alarm" && l.msg === "no on-chain hedge router listed: stock market not hedged")).toBe(true);
  const st0 = (await Bun.file(status).json()) as { venue: string; markets: Record<string, { ok: boolean; error?: string }> };
  expect(st0.venue).toBe("onchain");
  expect(st0.markets.STK1).toMatchObject({ ok: false, error: "no hedge router listed" });

  // governance lists a router (a mock of Robinhood Chain liquidity at the mark) and the keeper
  const r = Bun.spawnSync(["forge", "create", "test/mocks/MockHedgeRouter.sol:MockHedgeRouter", "--rpc-url", RPC, "--unlocked", "--from", acc[0]!, "--broadcast", "--constructor-args", m3.SettlementToken!, m3.MockStockToken!, "1", parseEther(PX.STK1!).toString()], { cwd: CONTRACTS });
  const router = /Deployed to: (0x[0-9a-fA-F]{40})/.exec(r.stdout.toString())?.[1] as Address;
  expect(router).toBeDefined();
  const ADMIN = acc[1]!;
  await send(ADMIN, m3.MainspringPool!, hedgeAdminAbi, "setHedge", [router, 100, b32("STK1"), parseEther("10000"), 1_000_000n * 10n ** 6n]);
  const role = await client.readContract({ address: m3.MainspringPool!, abi: hedgeAdminAbi, functionName: "HEDGER_ROLE" });
  await send(ADMIN, m3.MainspringPool!, hedgeAdminAbi, "grantRole", [role, KEEPER]);

  // STK1: cap $20,000 at $40 → hard limit 500 shares, band 50
  const first = await onchain("--local-unlocked", KEEPER, "--delta-cap", "STK1=20000", "--status-file", status);
  const plan = first.find((l) => l.msg === "plan" && l.market === "STK1")!;
  const target = Number(plan.target);
  expect(Math.abs(target - Number(plan.current))).toBeGreaterThan(50);
  const row = first.find((l) => l.msg === "hedge" && l.market === "STK1")!;
  expect(row).toBeDefined();
  expect(row.via).toBe("onchain_dex");
  const held = Number(formatEther(await client.readContract({ address: m3.MockStockToken!, abi: balAbi, functionName: "balanceOf", args: [m3.MainspringPool!] })));
  expect(Math.abs(held - target)).toBeLessThan(0.01 * target + 1e-6); // the pool holds the stock, within the slippage
  expect(await client.readContract({ address: m3.MockStockToken!, abi: balAbi, functionName: "balanceOf", args: [KEEPER] })).toBe(0n);
  expect(((await Bun.file(status).json()) as { markets: Record<string, { ok: boolean }> }).markets.STK1!.ok).toBe(true);

  const second = await onchain("--local-unlocked", KEEPER, "--delta-cap", "STK1=20000");
  expect(second.find((l) => l.msg === "plan" && l.market === "STK1")!.reason).toBe("in-band");
  expect(second.some((l) => l.msg === "hedge")).toBe(false);
  expect(second.some((l) => l.market === "BTC" || l.market === "ETH")).toBe(false); // crypto is hedger-cex's
}, 180_000);
