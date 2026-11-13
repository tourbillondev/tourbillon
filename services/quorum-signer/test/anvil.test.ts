import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicClient, http, parseEther, type Address } from "viem";
import { foundry } from "viem/chains";
import { boardAbi, boardErrorName, marketBytes32, RACE_ERRORS } from "../src/board.ts";
import { loadDeployment, type Deployment } from "../src/deployment.ts";

// End to end on a local anvil: deploy with contracts/script/DeployM1.s.sol (unlocked accounts, no key), then run
// the signer once per account. Skipped when anvil or forge is not installed.
const haveTools = Bun.which("anvil") !== null && Bun.which("forge") !== null;
const CONTRACTS = resolve(import.meta.dir, "../../../contracts");
const PORT = 18545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const MARKS = "BTC=100000,ETH=3000,HYPE=40";

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

beforeAll(async () => {
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
}, 180_000);

/// Runs DeployM1 on the anvil (unlocked accounts) and returns a private copy of the deployment file.
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

afterAll(() => {
  anvil?.kill();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test.skipIf(!haveTools)("refuses an address that is not a board signer", async () => {
  const r = await signer("--watch", acc[6]!, "--dry-run", "--test-marks", MARKS, "--test-vol", "0.5");
  expect(r.code).toBe(1);
  expect(String(r.lines.at(-1)?.error)).toContain("is not a signer");
}, 60_000);

test.skipIf(!haveTools)("dry run decides every key and sends nothing", async () => {
  const r = await signer("--watch", acc[2]!, "--dry-run", "--test-marks", MARKS, "--test-vol", "0.5");
  expect(r.code).toBe(0);
  const would = r.lines.filter((l) => l.msg === "would vote");
  expect(would.length).toBe(6); // MARK and VOL for BTC, ETH, HYPE
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
  expect((await read("markKey", "HYPE"))[1]).toBe(40n * 10n ** 8n);
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
  expect(fin.map((l) => l.market).sort()).toEqual(["BTC", "ETH", "HYPE"]);
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

// Opt-in (network): HL_LIVE=1. Live Hyperliquid marks and vol (started from candles), dry run: all 6 keys would vote.
test.skipIf(!haveTools || process.env.HL_LIVE !== "1")("dry run with live Hyperliquid marks and vol", async () => {
  const fresh = deploy("live"); // a board with no rounds yet
  const r = await signerOn(fresh, "--watch", acc[3]!, "--dry-run");
  expect(r.code).toBe(0);
  const would = r.lines.filter((l) => l.msg === "would vote");
  expect(would.map((l) => `${l.kind} ${l.market}`).sort()).toEqual([
    "MARK BTC",
    "MARK ETH",
    "MARK HYPE",
    "VOL BTC",
    "VOL ETH",
    "VOL HYPE",
  ]);
  expect(would.every((l) => l.reason === "first" && l.round === "1")).toBe(true);
  for (const l of would) console.log(`dry run ${l.kind} ${l.market}: would vote ${l.value}`);
}, 90_000);
