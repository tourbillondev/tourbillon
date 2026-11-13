import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicClient, createWalletClient, http, parseEther, stringToHex, type Address, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { SimVenue } from "../../hedger/src/simvenue.ts";

// On a local anvil: DeployM1 + DeployM3 (risk pauser = its own account) + ListEquityFeed, votes sent by the test, an LP
// round and two trades, a simulated Hyperliquid venue, and the real risk-monitor process with a 3-second outage window.
const haveTools = Bun.which("anvil") !== null && Bun.which("forge") !== null;
const CONTRACTS = resolve(import.meta.dir, "../../../contracts");
const PORT = 22545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const PX: Record<string, string> = { BTC: "100000", ETH: "3000", HYPE: "40" };
const HL_USER = "0x00000000000000000000000000000000000000E1";
const OFFSET = 10n ** 30n;
const part = { type: "tuple[]", components: [{ type: "uint256", name: "tempo" }, { type: "uint256", name: "weight" }] } as const;
const abi = [
  { type: "function", name: "markKey", stateMutability: "pure", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "volKey", stateMutability: "pure", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "latestRoundData", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] },
  { type: "function", name: "vote", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint80" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "applyRoute", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] },
  { type: "function", name: "poke", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }, { type: "bool" }, { type: "bool" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "startEpoch", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "markChunk", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "settle", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "equityKey", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "setTreasury", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
  { type: "function", name: "sendToTreasury", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "setCaps", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "setHedgerDeltaCap", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "marketPaused", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "unpauseMarket", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] },
  { type: "function", name: "buy", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "bool" }, { type: "uint128" }, part, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "sell", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "idOf", stateMutability: "pure", inputs: [{ type: "bytes32" }, { type: "bool" }, { type: "uint128" }, part], outputs: [{ type: "uint256" }] },
] as const;

let anvil: ReturnType<typeof Bun.spawn> | undefined;
let sim: SimVenue | undefined;
let tmp = "";
let m3File = "";
let statusFile = "";
let m1: Record<string, Address>;
let m3: Record<string, Address>;
let acc: Address[] = [];
let equityRound = 0n;
const client = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: 100 }) as PublicClient;
const b32 = (m: string) => stringToHex(m, { size: 32 });

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return ((await res.json()) as { result: unknown }).result;
}

async function send(from: Address, address: Address, functionName: string, args: readonly unknown[] = []) {
  const gas = await client.estimateContractGas({ address, abi, functionName, args, account: from } as never);
  const hash = await createWalletClient({ chain: foundry, transport: http(RPC), account: from }).writeContract({ address, abi, functionName, args, gas: gas * 2n } as never);
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return r;
}

async function vote(markets: string[]): Promise<void> {
  for (const m of markets) {
    for (const fn of ["markKey", "volKey"] as const) {
      const key = await client.readContract({ address: m1.QuorumBoard!, abi, functionName: fn, args: [b32(m)] });
      let round = 0n;
      try {
        [round] = await client.readContract({ address: m1.QuorumBoard!, abi, functionName: "latestRoundData", args: [key] });
      } catch {}
      for (const s of [acc[2]!, acc[3]!, acc[4]!]) await send(s, m1.QuorumBoard!, "vote", [key, round + 1n, fn === "markKey" ? parseEther(PX[m]!) : parseEther("0.5")]);
    }
  }
}

async function postEquity(pnlUsd: bigint): Promise<void> {
  const key = await client.readContract({ address: m3.MainspringPool!, abi, functionName: "equityKey" });
  ++equityRound;
  for (const s of [acc[2]!, acc[3]!, acc[4]!]) await send(s, m1.QuorumBoard!, "vote", [key, equityRound, OFFSET + pnlUsd * 10n ** 18n]);
}

function writeHedgerStatus(failing: string[]): void {
  const markets = Object.fromEntries(["BTC", "ETH", "HYPE"].map((m) => [m, { ok: !failing.includes(m), lastOkAt: null }]));
  writeFileSync(statusFile, JSON.stringify({ updatedAt: new Date().toISOString(), markets }));
}

const monitorArgs = () => ["src/main.ts", "--deployment", m3File, "--rpc", RPC, "--local-unlocked", acc[6]!, "--hl-api", sim!.url, "--hl-user", HL_USER, "--hedger-status", statusFile, "--equity-every-seconds", "0"];

async function monitorOnce(): Promise<Record<string, unknown>[]> {
  const p = Bun.spawn(["bun", ...monitorArgs(), "--once"], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function monitorFor(ms: number, during?: () => void): Promise<Record<string, unknown>[]> {
  const p = Bun.spawn(["bun", ...monitorArgs(), "--outage-minutes", "0.05", "--tick-seconds", "1"], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const start = Date.now();
  while (Date.now() - start < ms) {
    during?.();
    await Bun.sleep(500);
  }
  p.kill("SIGTERM");
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const alarms = (lines: Record<string, unknown>[], name: string, state?: string) => lines.filter((l) => l.msg === "alarm" && l.name === name && (!state || l.state === state));

beforeAll(async () => {
  if (!haveTools) return;
  tmp = mkdtempSync(join(tmpdir(), "risk-anvil-"));
  statusFile = join(tmp, "hedger-status.json");
  sim = new SimVenue(["BTC", "ETH", "HYPE"].map((n) => ({ name: n, szDecimals: { BTC: 5, ETH: 4, HYPE: 2 }[n]!, mid: Number(PX[n]) })));
  sim.deposit(1_000_000); // the pool's Hyperliquid account: 1,000,000 deposited, no P&L yet
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
  const env = { ...process.env, ADMIN: acc[1]!, SIGNERS: `${acc[2]},${acc[3]},${acc[4]}`, RISK_PAUSER: acc[6]! };
  for (const [script, sender] of [["DeployM1.s.sol:DeployM1", acc[0]!], ["DeployM3.s.sol:DeployM3", acc[0]!], ["ListEquityFeed.s.sol:ListEquityFeed", acc[1]!]] as const) {
    const r = Bun.spawnSync(["forge", "script", `script/${script}`, "--rpc-url", RPC, "--unlocked", "--sender", sender, "--broadcast"], { cwd: CONTRACTS, env });
    if (r.exitCode !== 0) throw new Error(`${script} failed: ${r.stderr.toString()}`);
  }
  copyFileSync(join(CONTRACTS, "deployments", "31337.json"), join(tmp, "31337.json"));
  m3File = join(tmp, "31337-m3.json");
  copyFileSync(join(CONTRACTS, "deployments", "31337-m3.json"), m3File);
  m1 = await Bun.file(join(tmp, "31337.json")).json();
  m3 = await Bun.file(m3File).json();
  await rpc("evm_increaseTime", [3600]);
  await rpc("evm_mine");
  for (const m of ["BTC", "ETH", "HYPE"]) await send(acc[5]!, m1.MarkRouter!, "applyRoute", [b32(m)]);
  await vote(["BTC", "ETH", "HYPE"]);
  for (const m of ["BTC", "ETH", "HYPE"]) await send(acc[9]!, m3.PathFundingBook!, "poke", [b32(m)]);
  const LP = acc[7]!;
  await send(LP, m3.MockUSDC!, "mint", [LP, 5_000_000n * 10n ** 6n]);
  await send(LP, m3.MockUSDC!, "approve", [m3.MainspringPool!, 5_000_000n * 10n ** 6n]);
  await send(LP, m3.MainspringPool!, "deposit", [5_000_000n * 10n ** 6n]);
  await send(acc[9]!, m3.MainspringPool!, "startEpoch");
  await send(acc[9]!, m3.MainspringPool!, "markChunk", [100n]);
  await send(acc[9]!, m3.MainspringPool!, "settle");
  const T = acc[8]!;
  await send(T, m3.MockUSDC!, "mint", [T, 1_000_000n * 10n ** 6n]);
  await send(T, m3.MockUSDC!, "approve", [m3.Engine!, 1_000_000n * 10n ** 6n]);
  await send(T, m3.Engine!, "buy", [b32("BTC"), true, parseEther("100000"), [{ tempo: 86_400n, weight: parseEther("1") }], parseEther("1"), 10n ** 12n, 99_999_999_999n]);
  await send(T, m3.Engine!, "buy", [b32("ETH"), true, parseEther("3000"), [{ tempo: 86_400n, weight: parseEther("1") }], parseEther("10"), 10n ** 12n, 99_999_999_999n]);
  writeHedgerStatus([]);
}, 300_000);

afterAll(() => {
  anvil?.kill();
  sim?.stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test.skipIf(!haveTools)("a healthy system raises no alarm", async () => {
  const lines = await monitorOnce();
  expect(lines.filter((l) => l.msg === "alarm" && l.state === "raised")).toEqual([]);
  expect(lines.some((l) => l.msg === "started")).toBe(true);
}, 60_000);

test.skipIf(!haveTools)("a treasury send is announced; EQUITY that disagrees with Hyperliquid raises EQUITY_MISMATCH", async () => {
  await postEquity(0n);
  await postEquity(0n);
  await send(acc[1]!, m3.MainspringPool!, "setTreasury", [acc[10]!]);
  await send(acc[1]!, m3.MainspringPool!, "sendToTreasury", [100_000n * 10n ** 6n]);
  const a = await monitorOnce();
  const sent = alarms(a, "TREASURY_SENT", "event")[0]!;
  expect(sent).toBeDefined();
  expect(sent.who).toContain("treasury operator");
  expect((sent.values as { amount: number }).amount).toBe(100_000);
  expect(alarms(a, "EQUITY_MISMATCH")).toEqual([]);

  await postEquity(50_000n); // the board says +50,000; Hyperliquid's account shows 0 P&L
  const b = await monitorOnce();
  const mm = alarms(b, "EQUITY_MISMATCH", "raised")[0]!;
  expect(mm).toBeDefined();
  expect(mm.values).toMatchObject({ boardPnl: 50_000, hyperliquidPnl: 0, accountValue: 1_000_000 });
  await postEquity(0n);
}, 120_000);

test.skipIf(!haveTools)("the hedger failing on ETH for the window pauses opens on ETH only; buys there refused, sells work", async () => {
  await vote(["BTC", "ETH", "HYPE"]); // fresh router marks
  const lines = await monitorFor(7_000, () => writeHedgerStatus(["ETH"]));
  expect(alarms(lines, "MONITOR_ERROR")).toEqual([]); // every pass worked, also on a quiet chain with no new blocks
  const paused = alarms(lines, "VENUE_DOWN_PAUSED", "event");
  expect(paused.map((l) => l.market)).toEqual(["ETH"]);
  expect(paused[0]!.who).toContain("automatic pause done");
  expect(await client.readContract({ address: m3.MainspringPool!, abi, functionName: "marketPaused", args: [b32("ETH")] })).toBe(true);
  expect(await client.readContract({ address: m3.MainspringPool!, abi, functionName: "marketPaused", args: [b32("BTC")] })).toBe(false);

  const T = acc[8]!;
  await vote(["ETH"]);
  await expect(send(T, m3.Engine!, "buy", [b32("ETH"), true, parseEther("3000"), [{ tempo: 86_400n, weight: parseEther("1") }], parseEther("1"), 10n ** 12n, 99_999_999_999n])).rejects.toThrow();
  const id = await client.readContract({ address: m3.PathFundingBook!, abi, functionName: "idOf", args: [b32("ETH"), true, parseEther("3000"), [{ tempo: 86_400n, weight: parseEther("1") }]] });
  await send(T, m3.Engine!, "sell", [id, 2n ** 256n - 1n, 0n, 99_999_999_999n]); // sells unaffected
  await expect(send(acc[6]!, m3.MainspringPool!, "unpauseMarket", [b32("ETH")])).rejects.toThrow(); // the risk key cannot unpause
  writeHedgerStatus([]);
}, 120_000);

test.skipIf(!haveTools)("a venue outage pauses the other markets; recovery is announced", async () => {
  await vote(["BTC", "ETH", "HYPE"]);
  sim!.outage = "http500";
  const down = await monitorFor(7_000, () => writeHedgerStatus([]));
  expect(alarms(down, "VENUE_DOWN_PAUSED", "event").map((l) => l.market).sort()).toEqual(["BTC", "HYPE"]); // ETH was already paused
  sim!.outage = "none";
  const p = Bun.spawn(["bun", ...monitorArgs(), "--outage-minutes", "0.01", "--tick-seconds", "1"], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  // a fresh process starts with no trip, so trip it again on the outage, then recover
  sim!.outage = "http500";
  await Bun.sleep(3_500);
  sim!.outage = "none";
  await Bun.sleep(3_000);
  p.kill("SIGTERM");
  const lines = (await new Response(p.stdout).text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  expect(alarms(lines, "VENUE_RECOVERED", "event").length).toBeGreaterThanOrEqual(1);
  expect(alarms(lines, "VENUE_RECOVERED", "event")[0]!.who).toContain("admin");
}, 120_000);

test.skipIf(!haveTools)("caps near their limit, then two hours without signers, poker or keeper: every liveness alarm", async () => {
  await send(acc[1]!, m3.MainspringPool!, "setHedgerDeltaCap", [b32("BTC"), 10n ** 16n]); // the pool refuses a directional cap the hedger cannot carry
  await send(acc[1]!, m3.MainspringPool!, "setCaps", [b32("BTC"), 105_000n * 10n ** 6n, 10n ** 15n]); // 100,000 open of 105,000
  const caps = await monitorOnce();
  expect(alarms(caps, "CAP_HIGH", "raised").map((l) => l.market)).toEqual(["BTC"]);

  await rpc("evm_increaseTime", [2 * 3600 + 60]);
  await rpc("evm_mine");
  const late = await monitorOnce();
  expect(alarms(late, "MARK_STALE", "raised").map((l) => l.market).sort()).toEqual(["BTC", "ETH", "HYPE"]);
  expect(alarms(late, "SAMPLE_STALE", "raised").length).toBe(3);
  expect(alarms(late, "SETTLEMENT_STALE", "raised").length).toBe(1);
  const nr = alarms(late, "EQUITY_NOT_READY", "raised")[0]!;
  expect(nr.values).toMatchObject({ sentOut: 100_000, receivedBack: 0 });
  for (const l of late.filter((x) => x.msg === "alarm")) {
    expect(typeof l.name).toBe("string");
    expect(typeof l.what).toBe("string");
    expect(typeof l.who).toBe("string");
    expect(l).toHaveProperty("market");
    expect(l).toHaveProperty("values");
  }
}, 120_000);
