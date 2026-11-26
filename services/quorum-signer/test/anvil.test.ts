import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicClient, createWalletClient, http, keccak256, parseEther, toHex, type Address, type Hex } from "viem";
import { standInFeeds, startStandIn } from "./standin.ts";
import { CALENDAR, isClosedDay, isRegularSession } from "@tourbillon/common/session.ts";
import { foundry } from "viem/chains";
import { boardAbi, boardErrorName, marketBytes32, RACE_ERRORS } from "../src/board.ts";
import { loadDeployment, type Deployment } from "../src/deployment.ts";
import { TEARDOWN_MS, hookLimit, within } from "@tourbillon/common/hooks.ts";

// End to end on a local anvil: deploy with contracts/script/DeployM1.s.sol (unlocked accounts, no key), then run
// the signer once per account. Skipped when anvil or forge is not installed.
const haveTools = Bun.which("anvil") !== null && Bun.which("forge") !== null;
const CONTRACTS = resolve(import.meta.dir, "../../../contracts");
const PORT = 18545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const MARKS = "BTC=100000,ETH=3000,STK1=40";

let anvil: ReturnType<typeof Bun.spawn> | undefined;
let tmp = "";
let depFile = "";
let dep: Deployment;
let acc: Address[] = [];
const client = createPublicClient({ chain: foundry, transport: http(RPC) });

async function signer(...args: string[]): Promise<{ code: number; lines: Record<string, unknown>[] }> {
  return signerOn(depFile, ...args);
}

async function signerOn(file: string, ...args: string[]): Promise<{ code: number; lines: Record<string, unknown>[] }> {
  const p = Bun.spawn(["bun", "src/main.ts", "--deployment", file, "--rpc", RPC, "--once", ...args], {
    cwd: resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  return { code, lines: out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}

beforeAll(within(import.meta.path, "setup", 180_000, async () => {
  if (!haveTools) return;
  tmp = mkdtempSync(join(tmpdir(), "signer-anvil-"));
  anvil = Bun.spawn(["anvil", "--port", String(PORT), "--silent"], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      await client.getChainId();
      break;
    } catch {
      await Bun.sleep(100);
    }
  }
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_accounts", params: [] }),
  });
  acc = ((await res.json()) as { result: Address[] }).result;
  depFile = deploy("first");
  dep = loadDeployment(depFile);
}), hookLimit(180_000));

/// Runs DeployM1 on the anvil (unlocked accounts) and gives a private copy of the deployment file.
function deploy(tag: string): string {
  const r = Bun.spawnSync(
    ["forge", "script", "script/DeployM1.s.sol:DeployM1", "--rpc-url", RPC, "--unlocked", "--sender", acc[0]!, "--broadcast"],
    { cwd: CONTRACTS, env: { ...process.env, ADMIN: acc[1]!, SIGNERS: `${acc[2]},${acc[3]},${acc[4]}` } },
  );
  if (r.exitCode !== 0) throw new Error(`deploy failed: ${r.stderr.toString()}`);
  const file = join(tmp, `31337-${tag}.json`);
  copyFileSync(join(CONTRACTS, "deployments", "31337.json"), file);
  return file;
}

afterAll(within(import.meta.path, "teardown", TEARDOWN_MS, () => {
  anvil?.kill();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}), hookLimit(TEARDOWN_MS));

test.skipIf(!haveTools)("refuses an address that is not a board signer", async () => {
  const r = await signer("--watch", acc[6]!, "--dry-run", "--test-marks", MARKS, "--test-vol", "0.5");
  expect(r.code).toBe(1);
  expect(String(r.lines.at(-1)?.error)).toContain("is not a signer");
}, 60_000);

test.skipIf(!haveTools)("dry run decides every key and sends nothing", async () => {
  const r = await signer("--watch", acc[2]!, "--dry-run", "--test-marks", MARKS, "--test-vol", "0.5");
  expect(r.code).toBe(0);
  const would = r.lines.filter((l) => l.msg === "would vote");
  expect(would.length).toBe(6); // MARK and VOL for BTC, ETH, STK1
  expect(would.every((l) => l.reason === "first" && l.round === "1")).toBe(true);
  expect(r.lines.some((l) => l.msg === "voted")).toBe(false);
  const key = await client.readContract({ address: dep.board, abi: boardAbi, functionName: "markKey", args: [marketBytes32("BTC")] });
  expect(await client.readContract({ address: dep.board, abi: boardAbi, functionName: "openVotes", args: [key] })).toBe(0n);
}, 60_000);

test.skipIf(!haveTools)("three signers vote once each: every key finalises round 1", async () => {
  const reasons: string[][] = [];
  for (const a of [acc[2]!, acc[3]!, acc[4]!]) {
    const r = await signer("--local-unlocked", a, "--test-marks", MARKS, "--test-vol", "0.5");
    expect(r.code).toBe(0);
    const voted = r.lines.filter((l) => l.msg === "voted");
    expect(voted.length).toBe(6);
    expect(voted.every((l) => l.status === "success")).toBe(true);
    reasons.push(voted.map((l) => String(l.reason)));
  }
  expect(reasons[0]!.every((x) => x === "first")).toBe(true);
  expect(reasons[1]!.every((x) => x === "join")).toBe(true);

  const read = async (fn: "markKey" | "volKey", m: string) => {
    const key = await client.readContract({ address: dep.board, abi: boardAbi, functionName: fn, args: [marketBytes32(m)] });
    return client.readContract({ address: dep.board, abi: boardAbi, functionName: "latestRoundData", args: [key] });
  };
  expect((await read("markKey", "BTC"))[0]).toBe(1n);
  expect((await read("markKey", "BTC"))[1]).toBe(parseEther("100000") / 10n ** 10n); // 8 decimals
  expect((await read("markKey", "STK1"))[1]).toBe(40n * 10n ** 8n);
  expect((await read("volKey", "ETH"))[1]).toBe(parseEther("0.5") / 10n ** 10n);

  // A fourth pass right away: the VOL keys (5 min cadence) are fresh, so nothing is sent for them
  const again = await signer("--local-unlocked", acc[2]!, "--test-marks", MARKS, "--test-vol", "0.5");
  const volSkips = again.lines.filter((l) => l.kind === "VOL" && l.msg === "skip" && l.reason === "fresh");
  expect(volSkips.length).toBe(3);
}, 120_000);

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return ((await res.json()) as { result: unknown }).result;
}

test.skipIf(!haveTools)("with one signer down, two votes finalise through finalize after the window", async () => {
  // Round 1 of every key was finalised by the previous test. Move past the 20 s MARK cadence.
  await rpc("evm_increaseTime", [25]);
  await rpc("evm_mine");
  for (const a of [acc[2]!, acc[3]!]) {
    const r = await signer("--local-unlocked", a, "--test-marks", MARKS, "--test-vol", "0.5");
    expect(r.lines.filter((l) => l.msg === "voted" && l.kind === "MARK").length).toBe(3);
  }
  // Inside the 30 s window the board refuses: the signer skips without sending
  const early = await signer("--local-unlocked", acc[2]!, "--test-marks", MARKS, "--test-vol", "0.5");
  expect(early.lines.filter((l) => l.kind === "MARK" && l.reason === "not-ready").length).toBe(3);
  expect(early.lines.some((l) => l.msg === "finalized")).toBe(false);

  await rpc("evm_increaseTime", [31]);
  await rpc("evm_mine");
  const r = await signer("--local-unlocked", acc[2]!, "--test-marks", MARKS, "--test-vol", "0.5");
  const fin = r.lines.filter((l) => l.msg === "finalized");
  expect(fin.map((l) => l.market).sort()).toEqual(["BTC", "ETH", "STK1"]);
  expect(fin.every((l) => l.status === "success" && l.kind === "MARK")).toBe(true);
  const key = await client.readContract({ address: dep.board, abi: boardAbi, functionName: "markKey", args: [marketBytes32("ETH")] });
  const [round, answer] = await client.readContract({ address: dep.board, abi: boardAbi, functionName: "latestRoundData", args: [key] });
  expect(round).toBe(2n);
  expect(answer).toBe(3000n * 10n ** 8n);
}, 120_000);

test.skipIf(!haveTools)("the board's race reverts are named, so they are skipped quietly", async () => {
  const key = await client.readContract({ address: dep.board, abi: boardAbi, functionName: "markKey", args: [marketBytes32("BTC")] });
  const name = async (call: () => Promise<unknown>) => {
    try {
      await call();
      return "none";
    } catch (e) {
      return boardErrorName(e);
    }
  };
  // finalize with no open votes
  expect(await name(() => client.estimateContractGas({ address: dep.board, abi: boardAbi, functionName: "finalize", args: [key], account: acc[2]! }))).toBe("NotReady");
  // a vote for a round that was already finalised
  expect(
    await name(() =>
      client.estimateContractGas({ address: dep.board, abi: boardAbi, functionName: "vote", args: [key, 1n, 1n], account: acc[2]! }),
    ),
  ).toBe("WrongRound");
  expect(RACE_ERRORS.has("NotReady") && RACE_ERRORS.has("WrongRound") && RACE_ERRORS.has("AlreadyVoted")).toBe(true);
  expect(RACE_ERRORS.has("NotSigner")).toBe(false);
}, 60_000);

// RH4: the on-chain SessionCalendar (deployed by DeployM1 from the data file) and the signers' calendar answer alike.
test.skipIf(!haveTools)("the on-chain session calendar equals the signers' calendar", async () => {
  const cal = JSON.parse(readFileSync(depFile, "utf8")).SessionCalendar as Address;
  expect(cal).toMatch(/^0x[0-9a-fA-F]{40}$/);
  const abi = [
    { type: "function", name: "isRegularSession", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bool" }] },
    { type: "function", name: "isClosedDay", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bool" }] },
  ] as const;
  let seed = 5;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed / 2 ** 31);
  const from = Date.parse("2025-12-25T00:00:00Z") / 1000;
  const to = Date.parse("2028-01-05T00:00:00Z") / 1000;
  const times: number[] = [];
  for (let i = 0; i < 1_500; i++) times.push(Math.floor(from + rnd() * (to - from)));
  for (const y of CALENDAR.years) {
    for (const t of [y.dstStart, y.dstEnd]) for (const d of [-3600, -1, 0, 1, 3600]) times.push(t + d);
    for (const day of [...y.holidays, ...y.earlyCloses]) {
      for (const min of [570, 779, 780, 959, 960]) for (const off of [4, 5]) times.push(day * 86_400 + min * 60 + off * 3600);
    }
  }
  const onchain = await Promise.all(
    times.map(async (t) => [
      await client.readContract({ address: cal, abi, functionName: "isRegularSession", args: [BigInt(t)] }),
      await client.readContract({ address: cal, abi, functionName: "isClosedDay", args: [BigInt(t)] }),
    ]),
  );
  const off = times.filter((t, i) => onchain[i]![0] !== isRegularSession(t * 1000) || onchain[i]![1] !== isClosedDay(t * 1000));
  expect(off.map((t) => new Date(t * 1000).toISOString())).toEqual([]);
  expect(times.length).toBeGreaterThan(1_700);
}, 120_000);

// End to end with the real feeds path: a stock market read from an on-chain price adapter (the local mock) and an
// equity reference, and a crypto market read from three exchanges and Pyth, all from a local stand-in. Offline.
test.skipIf(!haveTools)("with its feeds file, a signer votes checked marks and refuses when a cross-check fails", async () => {
  const fresh = deployWith("feeds", "STK1,BTC");
  const adapter = await deployMockAdapter();
  const assetId = keccak256(toHex("standin:STK1"));
  await setAdapterPrice(adapter, assetId, "412.30");
  const si = startStandIn();
  try {
    si.set("BTC", "97120");
    si.set("STK1", "412.30");
    const feedsFile = join(tmp, "feeds.json");
    writeFileSync(feedsFile, JSON.stringify(standInFeeds(si.url, [{ name: "STK1", kind: "stock", adapter, assetId }, { name: "BTC", kind: "crypto" }])));
    // earlier tests in this file move anvil's clock ahead of this machine's: the on-chain price's age is measured in
    // chain time, so it still counts as fresh
    const run = () => signerOn(fresh, "--watch", acc[3]!, "--dry-run", "--feeds", feedsFile);

    // everything agrees: both marks would be voted; no vol yet (a day of warm-up first)
    let r = await run();
    expect(r.code).toBe(0);
    const would = (x: typeof r) => x.lines.filter((l) => l.msg === "would vote").map((l) => `${l.kind} ${l.market}`).sort();
    expect(would(r)).toEqual(["MARK BTC", "MARK STK1"]);
    expect(r.lines.find((l) => l.msg === "would vote" && l.market === "BTC")!.value).toBe(parseEther("97120").toString());

    // Pyth more than 1% away: no BTC vote; Pyth down: no BTC vote either
    si.set("BTC", "97120", { pythPx: "95000" });
    r = await run();
    expect(would(r)).toEqual(["MARK STK1"]);
    expect(r.lines.some((l) => l.msg === "mark: refused, no vote" && l.market === "BTC" && l.reason === "disagree")).toBe(true);
    si.set("BTC", "97120");
    si.down("pyth", true);
    r = await run();
    expect(would(r)).toEqual(["MARK STK1"]);
    si.down("pyth", false);

    // two exchanges down: fewer than two left, no BTC vote
    si.down("kraken", true);
    si.down("okx", true);
    r = await run();
    expect(would(r)).toEqual(["MARK STK1"]);
    expect(r.lines.some((l) => l.reason === "too-few-exchanges")).toBe(true);
  } finally {
    si.stop();
  }
}, 120_000);

/// DeployM1 with chosen markets.
function deployWith(tag: string, markets: string): string {
  const r = Bun.spawnSync(
    ["forge", "script", "script/DeployM1.s.sol:DeployM1", "--rpc-url", RPC, "--unlocked", "--sender", acc[0]!, "--broadcast"],
    { cwd: CONTRACTS, env: { ...process.env, ADMIN: acc[1]!, SIGNERS: `${acc[2]},${acc[3]},${acc[4]}`, MARKETS: markets } },
  );
  if (r.exitCode !== 0) throw new Error(`deploy failed: ${r.stderr.toString()}`);
  const file = join(tmp, `31337-${tag}.json`);
  copyFileSync(join(CONTRACTS, "deployments", "31337.json"), file);
  return file;
}

const adapterAbi = [
  { type: "function", name: "set", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint256" }], outputs: [] },
] as const;

async function deployMockAdapter(): Promise<Address> {
  const art = JSON.parse(readFileSync(join(CONTRACTS, "out/MockPriceAdapter.sol/MockPriceAdapter.json"), "utf8")) as { bytecode: { object: Hex } };
  const w = createWalletClient({ chain: foundry, transport: http(RPC), account: acc[5]! });
  const hash = await w.deployContract({ abi: [], bytecode: art.bytecode.object });
  return (await client.waitForTransactionReceipt({ hash })).contractAddress!;
}

async function setAdapterPrice(adapter: Address, assetId: Hex, px: string): Promise<void> {
  const w = createWalletClient({ chain: foundry, transport: http(RPC), account: acc[5]! });
  const hash = await w.writeContract({ address: adapter, abi: adapterAbi, functionName: "set", args: [assetId, parseEther(px)] });
  await client.waitForTransactionReceipt({ hash });
}
