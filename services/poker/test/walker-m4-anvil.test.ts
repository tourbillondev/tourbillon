import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicClient, createWalletClient, http, parseEther, parseEventLogs, stringToHex, type Address, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { revertName } from "@tourbillon/common/tx.ts";
import { windowStart } from "../src/poke.ts";
import { writerBookAbi } from "../src/abi.ts";

// M4 on a local anvil: DeployM1 + DeployM4, signer votes sent by the test, the real poker process. A shape series held
// only by a write (no buyer) falls behind; the walker finds it from the WriterBook's events and walks it, so the next
// write on it is not refused. Skipped without anvil and forge.
const haveTools = Bun.which("anvil") !== null && Bun.which("forge") !== null;
const CONTRACTS = resolve(import.meta.dir, "../../../contracts");
const PORT = 23545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const MARKS: Record<string, bigint> = { BTC: parseEther("100000"), ETH: parseEther("3000"), HYPE: parseEther("40") };

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
const routerAbi = [{ type: "function", name: "applyRoute", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] }] as const;
const usdcAbi = [
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;
const poolAbi = [
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "startEpoch", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "markChunk", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "settle", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;
const part = { type: "tuple[]", components: [{ type: "uint256", name: "tempo" }, { type: "uint256", name: "weight" }] } as const;
const leg = { type: "tuple[]", components: [{ type: "bool", name: "isCall" }, { type: "uint128", name: "kWad" }, { type: "int128", name: "qty" }] } as const;
const wbAbi = [
  {
    type: "function",
    name: "write",
    stateMutability: "nonpayable",
    inputs: [{ type: "bytes32" }, leg, part, { type: "uint256" }, { type: "bool" }, { type: "int256" }, { type: "uint256" }],
    outputs: [{ type: "uint256" }, { type: "int256" }],
  },
  { type: "error", name: "NotCaughtUp", inputs: [{ type: "uint256" }] },
] as const;
const bookPokeAbi = [{ type: "function", name: "poke", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }, { type: "bool" }, { type: "bool" }] }] as const;

let anvil: ReturnType<typeof Bun.spawn> | undefined;
let tmp = "";
let m1: Record<string, string>;
let m4: Record<string, string>;
let m4File = "";
let acc: Address[] = [];
const client = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: 100 }) as PublicClient;
const wallet = (a: Address) => createWalletClient({ chain: foundry, transport: http(RPC), account: a });
const b32 = (m: string) => stringToHex(m, { size: 32 });

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return ((await res.json()) as { result: unknown }).result;
}

async function now(): Promise<number> {
  return Number((await client.getBlock()).timestamp);
}

async function setTime(t: number): Promise<void> {
  await rpc("evm_setNextBlockTimestamp", [t]);
  await rpc("evm_mine");
}

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
      const key = await client.readContract({ address: m1.QuorumBoard as Address, abi: boardAbi, functionName: fn, args: [b32(m)] });
      let round = 0n;
      try {
        [round] = await client.readContract({ address: m1.QuorumBoard as Address, abi: boardAbi, functionName: "latestRoundData", args: [key] });
      } catch {
        round = 0n;
      }
      const value = fn === "markKey" ? MARKS[m]! : parseEther("0.5");
      for (const s of [acc[2]!, acc[3]!, acc[4]!]) await send(s, m1.QuorumBoard as Address, boardAbi, "vote", [key, round + 1n, value]);
    }
  }
}

async function poker(...args: string[]): Promise<Record<string, unknown>[]> {
  const p = Bun.spawn(["bun", "src/main.ts", "--deployment", m4File, "--rpc", RPC, "--once", ...args], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

beforeAll(async () => {
  if (!haveTools) return;
  tmp = mkdtempSync(join(tmpdir(), "poker-m4-anvil-"));
  anvil = Bun.spawn(["anvil", "--port", String(PORT), "--silent"], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      await client.getChainId();
      break;
    } catch {
      await Bun.sleep(100);
    }
  }
  acc = (await rpc("eth_accounts")) as Address[];
  const env = { ...process.env, ADMIN: acc[1]!, SIGNERS: `${acc[2]},${acc[3]},${acc[4]}` };
  for (const script of ["DeployM1.s.sol:DeployM1", "DeployM4.s.sol:DeployM4"]) {
    const r = Bun.spawnSync(["forge", "script", `script/${script}`, "--rpc-url", RPC, "--unlocked", "--sender", acc[0]!, "--broadcast"], { cwd: CONTRACTS, env });
    if (r.exitCode !== 0) throw new Error(`${script} failed: ${r.stderr.toString()}`);
  }
  copyFileSync(join(CONTRACTS, "deployments", "31337.json"), join(tmp, "31337.json"));
  m4File = join(tmp, "31337-m4.json");
  copyFileSync(join(CONTRACTS, "deployments", "31337-m4.json"), m4File);
  m1 = await Bun.file(join(tmp, "31337.json")).json();
  m4 = await Bun.file(m4File).json();
  await rpc("evm_increaseTime", [3600]);
  await rpc("evm_mine");
  for (const m of ["BTC", "ETH", "HYPE"]) await send(acc[5]!, m1.MarkRouter as Address, routerAbi, "applyRoute", [b32(m)]);
}, 180_000);

afterAll(() => {
  anvil?.kill();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test.skipIf(!haveTools)("M4: the walker walks a shape series held only by a write, so the next write is not refused", async () => {
  let w = windowStart(await now()) + 300;
  await setTime(w + 10);
  await vote(["BTC", "ETH", "HYPE"]);
  for (const m of ["BTC", "ETH", "HYPE"]) await send(acc[9]!, m4.PathFundingBook as Address, bookPokeAbi, "poke", [b32(m)]);
  // the pool needs capital to pay a write's credit
  const LP = acc[7]!;
  await send(LP, m4.MockUSDC as Address, usdcAbi, "mint", [LP, 1_000_000n * 10n ** 6n]);
  await send(LP, m4.MockUSDC as Address, usdcAbi, "approve", [m4.MainspringPool as Address, 1_000_000n * 10n ** 6n]);
  await send(LP, m4.MainspringPool as Address, poolAbi, "deposit", [1_000_000n * 10n ** 6n]);
  await send(acc[9]!, m4.MainspringPool as Address, poolAbi, "startEpoch");
  await send(acc[9]!, m4.MainspringPool as Address, poolAbi, "markChunk", [100n]);
  await send(acc[9]!, m4.MainspringPool as Address, poolAbi, "settle");

  // a writer writes a BTC put spread: a shape series nobody buys
  const W = acc[8]!;
  await send(W, m4.MockUSDC as Address, usdcAbi, "mint", [W, 10n ** 12n]);
  await send(W, m4.MockUSDC as Address, usdcAbi, "approve", [m4.WriterBook as Address, 10n ** 12n]);
  const writeArgs = [
    b32("BTC"),
    [{ isCall: false, kWad: parseEther("98000"), qty: parseEther("1") }, { isCall: false, kWad: parseEther("100000"), qty: -parseEther("1") }],
    [{ tempo: 86_400n, weight: parseEther("1") }],
    parseEther("0.1"),
    false,
    -(2n ** 200n),
    99_999_999_999n,
  ] as const;
  const r = await send(W, m4.WriterBook as Address, wbAbi, "write", writeArgs);
  const [written] = parseEventLogs({ abi: writerBookAbi, logs: r.logs, eventName: "Written" });
  const seriesId = written!.args.seriesId;

  // 20 more windows, each sampled: the series falls 20 intervals behind and a new write on it is refused
  for (let i = 0; i < 20; i++) {
    w += 300;
    await setTime(w + 10);
    await vote(["BTC"]);
    await send(acc[9]!, m4.PathFundingBook as Address, bookPokeAbi, "poke", [b32("BTC")]);
  }
  const refused = await client.estimateContractGas({ address: m4.WriterBook as Address, abi: wbAbi, functionName: "write", args: writeArgs, account: W }).then(
    () => "none",
    (e) => revertName(e),
  );
  expect(refused).toBe("NotCaughtUp");

  // the poker's walker finds the series from the WriterBook's events and walks it
  w += 300;
  await setTime(w + 10);
  await vote(["BTC"]);
  const run = await poker("--local-unlocked", acc[6]!);
  const walked = run.filter((l) => l.msg === "walked" && BigInt(String(l.id)) === seriesId);
  expect(walked.length).toBe(1);
  expect(walked[0]!.status).toBe("success");
  expect(walked[0]!.caughtUp).toBe(true);
  expect(Number(walked[0]!.behindS)).toBeGreaterThanOrEqual(8 * 300);
  const gas = await client.estimateContractGas({ address: m4.WriterBook as Address, abi: wbAbi, functionName: "write", args: writeArgs, account: W });
  expect(gas > 0n).toBe(true);
}, 240_000);
