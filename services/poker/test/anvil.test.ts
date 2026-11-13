import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicClient, createWalletClient, http, parseEther, stringToHex, type Address, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { revertName } from "@tourbillon/common/tx.ts";
import { windowStart } from "../src/poke.ts";

// End to end on a local anvil: DeployM1 + DeployM2 (unlocked accounts, no key), signer votes sent directly by the
// test (so chain time can be set window by window), and the real poker process. Skipped without anvil and forge.
const haveTools = Bun.which("anvil") !== null && Bun.which("forge") !== null;
const CONTRACTS = resolve(import.meta.dir, "../../../contracts");
const PORT = 19545 + Math.floor(Math.random() * 1000);
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
  { type: "error", name: "NoData", inputs: [{ type: "bytes32" }] },
] as const;
const routerAbi = [{ type: "function", name: "applyRoute", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] }] as const;
const usdcAbi = [
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
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
  { type: "error", name: "NotCaughtUp", inputs: [{ type: "uint256" }] },
] as const;
const bookPokeAbi = [{ type: "function", name: "poke", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }, { type: "bool" }, { type: "bool" }] }] as const;

let anvil: ReturnType<typeof Bun.spawn> | undefined;
let tmp = "";
let m1: Record<string, string>;
let m2: Record<string, string>;
let m2File = "";
let acc: Address[] = [];
const client = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: 100 }) as PublicClient;
const wallet = (a: Address) => createWalletClient({ chain: foundry, transport: http(RPC), account: a });
const b32 = (m: string) => stringToHex(m, { size: 32 });

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return ((await res.json()) as { result: unknown }).result;
}

async function now(): Promise<number> {
  return Number((await client.getBlock()).timestamp);
}

async function setTime(t: number): Promise<void> {
  await rpc("evm_setNextBlockTimestamp", [t]);
  await rpc("evm_mine");
}

/// The three signers vote MARK and VOL for `markets` (fixed values), finalising a round on each key.
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
      for (const s of [acc[2]!, acc[3]!, acc[4]!]) {
        const hash = await wallet(s).writeContract({ address: m1.QuorumBoard as Address, abi: boardAbi, functionName: "vote", args: [key, round + 1n, value] });
        await client.waitForTransactionReceipt({ hash });
      }
    }
  }
}

async function poker(...args: string[]): Promise<Record<string, unknown>[]> {
  const p = Bun.spawn(["bun", "src/main.ts", "--deployment", m2File, "--rpc", RPC, "--once", ...args], {
    cwd: resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const count = (lines: Record<string, unknown>[], msg: string, extra: Record<string, unknown> = {}) =>
  lines.filter((l) => l.msg === msg && Object.entries(extra).every(([k, v]) => l[k] === v)).length;

beforeAll(async () => {
  if (!haveTools) return;
  tmp = mkdtempSync(join(tmpdir(), "poker-anvil-"));
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
  for (const script of ["DeployM1.s.sol:DeployM1", "DeployM2.s.sol:DeployM2"]) {
    const r = Bun.spawnSync(["forge", "script", `script/${script}`, "--rpc-url", RPC, "--unlocked", "--sender", acc[0]!, "--broadcast"], { cwd: CONTRACTS, env });
    if (r.exitCode !== 0) throw new Error(`${script} failed: ${r.stderr.toString()}`);
  }
  copyFileSync(join(CONTRACTS, "deployments", "31337.json"), join(tmp, "31337.json"));
  m2File = join(tmp, "31337-m2.json");
  copyFileSync(join(CONTRACTS, "deployments", "31337-m2.json"), m2File);
  m1 = await Bun.file(join(tmp, "31337.json")).json();
  m2 = await Bun.file(m2File).json();
  await rpc("evm_increaseTime", [3600]);
  await rpc("evm_mine");
  for (const m of ["BTC", "ETH", "HYPE"]) {
    const hash = await wallet(acc[5]!).writeContract({ address: m1.MarkRouter as Address, abi: routerAbi, functionName: "applyRoute", args: [b32(m)] });
    await client.waitForTransactionReceipt({ hash });
  }
}, 180_000);

afterAll(() => {
  anvil?.kill();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test.skipIf(!haveTools)("the primary pokes every market once per window; a second pass skips", async () => {
  await setTime(windowStart(await now()) + 300 + 10);
  await vote(["BTC", "ETH", "HYPE"]);
  const first = await poker("--local-unlocked", acc[6]!);
  expect(count(first, "poked", { status: "success" })).toBe(3);
  const again = await poker("--local-unlocked", acc[6]!);
  expect(count(again, "skip", { reason: "sampled" })).toBe(3);
  expect(count(again, "poked")).toBe(0);
}, 120_000);

test.skipIf(!haveTools)("the backup waits until +35 s and pokes only an unsampled window", async () => {
  const w = windowStart(await now()) + 300;
  await setTime(w + 10);
  await vote(["BTC", "ETH", "HYPE"]);
  const early = await poker("--local-unlocked", acc[7]!, "--role", "backup");
  expect(count(early, "skip", { reason: "wait" })).toBe(3);
  await setTime(w + 40);
  const late = await poker("--local-unlocked", acc[7]!, "--role", "backup");
  expect(count(late, "poked", { status: "success" })).toBe(3);
  const primary = await poker("--local-unlocked", acc[6]!);
  expect(count(primary, "skip", { reason: "sampled" })).toBe(3);
}, 120_000);

test.skipIf(!haveTools)("stale sources: no poke, a warning; 3 whole windows missed raise an alarm", async () => {
  const w = windowStart(await now()) + 300;
  await setTime(w + 10); // the last votes are about 300 s old: past the router's 120 s maxAge
  const stale = await poker("--local-unlocked", acc[6]!);
  expect(count(stale, "cannot poke")).toBe(3);
  expect(stale.filter((l) => l.msg === "cannot poke").every((l) => l.error === "Stale")).toBe(true);
  expect(count(stale, "poked")).toBe(0);
  await setTime(w + 3 * 300 + 10);
  const later = await poker("--local-unlocked", acc[6]!);
  expect(later.filter((l) => l.level === "alarm" && l.msg === "no sample for whole windows").length).toBe(3);
}, 120_000);

test.skipIf(!haveTools)("the walker brings a held series back within the trade limit, so a new buy works", async () => {
  let w = windowStart(await now()) + 300;
  await setTime(w + 10);
  await vote(["BTC"]);
  const poked = await poker("--local-unlocked", acc[6]!);
  expect(count(poked, "poked", { market: "BTC" })).toBe(1);

  // a buyer opens a position
  const buyer = acc[8]!;
  const buyArgs = [b32("BTC"), true, parseEther("100000"), [{ tempo: 86_400n, weight: parseEther("1") }], parseEther("0.1"), 10n ** 12n, 99_999_999_999n] as const;
  for (const [fn, args] of [
    ["mint", [buyer, 10n ** 12n]],
    ["approve", [m2.Engine, 10n ** 12n]],
  ] as const) {
    const hash = await wallet(buyer).writeContract({ address: m2.MockUSDC as Address, abi: usdcAbi, functionName: fn, args: args as never });
    await client.waitForTransactionReceipt({ hash });
  }
  let hash = await wallet(buyer).writeContract({ address: m2.Engine as Address, abi: engineAbi, functionName: "buy", args: buyArgs });
  expect((await client.waitForTransactionReceipt({ hash })).status).toBe("success");

  // 20 more windows, each sampled (votes + a direct poke): the series falls 20 intervals behind
  for (let i = 0; i < 20; i++) {
    w += 300;
    await setTime(w + 10);
    await vote(["BTC"]);
    hash = await wallet(acc[9]!).writeContract({ address: m2.PathFundingBook as Address, abi: bookPokeAbi, functionName: "poke", args: [b32("BTC")] });
    await client.waitForTransactionReceipt({ hash });
  }
  const refused = await client.estimateContractGas({ address: m2.Engine as Address, abi: engineAbi, functionName: "buy", args: buyArgs, account: buyer }).then(
    () => "none",
    (e) => revertName(e),
  );
  expect(refused).toBe("NotCaughtUp");

  w += 300;
  await setTime(w + 10);
  await vote(["BTC"]);
  const run = await poker("--local-unlocked", acc[6]!);
  const walked = run.filter((l) => l.msg === "walked");
  expect(walked.length).toBe(1);
  expect(walked[0]!.status).toBe("success");
  expect(walked[0]!.caughtUp).toBe(true);
  expect(Number(walked[0]!.behindS)).toBeGreaterThanOrEqual(8 * 300);

  const gas = await client.estimateContractGas({ address: m2.Engine as Address, abi: engineAbi, functionName: "buy", args: buyArgs, account: buyer });
  expect(gas > 0n).toBe(true);
}, 240_000);
