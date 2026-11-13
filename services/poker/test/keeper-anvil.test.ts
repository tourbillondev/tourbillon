import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicClient, createWalletClient, http, parseEther, stringToHex, type Address, type PublicClient } from "viem";
import { foundry } from "viem/chains";

// On a local anvil: DeployM1 + DeployM3, signers' votes sent by the test, an LP deposit, and the real poker process
// keeping the pool's hourly cycle (start → mark → settle). Skipped without anvil and forge.
const haveTools = Bun.which("anvil") !== null && Bun.which("forge") !== null;
const CONTRACTS = resolve(import.meta.dir, "../../../contracts");
const PORT = 23545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const PX: Record<string, string> = { BTC: "100000", ETH: "3000", HYPE: "40" };
const abi = [
  { type: "function", name: "markKey", stateMutability: "pure", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "volKey", stateMutability: "pure", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "latestRoundData", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] },
  { type: "function", name: "vote", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint80" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "applyRoute", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "claimShares", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "round", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

let anvil: ReturnType<typeof Bun.spawn> | undefined;
let tmp = "";
let m3File = "";
let m1: Record<string, Address>;
let m3: Record<string, Address>;
let acc: Address[] = [];
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
}
async function vote(): Promise<void> {
  for (const m of ["BTC", "ETH", "HYPE"]) {
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
async function poker(role: string): Promise<Record<string, unknown>[]> {
  const p = Bun.spawn(["bun", "src/main.ts", "--deployment", m3File, "--rpc", RPC, "--once", "--local-unlocked", role === "primary" ? acc[6]! : acc[7]!, "--role", role], {
    cwd: resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const has = (lines: Record<string, unknown>[], msg: string) => lines.some((l) => l.msg === msg);
const round = () => client.readContract({ address: m3.MainspringPool!, abi, functionName: "round" });
async function advance(s: number) {
  await rpc("evm_increaseTime", [s]);
  await rpc("evm_mine");
}

beforeAll(async () => {
  if (!haveTools) return;
  tmp = mkdtempSync(join(tmpdir(), "keeper-anvil-"));
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
  for (const script of ["DeployM1.s.sol:DeployM1", "DeployM3.s.sol:DeployM3"]) {
    const r = Bun.spawnSync(["forge", "script", `script/${script}`, "--rpc-url", RPC, "--unlocked", "--sender", acc[0]!, "--broadcast"], { cwd: CONTRACTS, env });
    if (r.exitCode !== 0) throw new Error(`${script} failed: ${r.stderr.toString()}`);
  }
  copyFileSync(join(CONTRACTS, "deployments", "31337.json"), join(tmp, "31337.json"));
  m3File = join(tmp, "31337-m3.json");
  copyFileSync(join(CONTRACTS, "deployments", "31337-m3.json"), m3File);
  m1 = await Bun.file(join(tmp, "31337.json")).json();
  m3 = await Bun.file(m3File).json();
  await advance(3600);
  for (const m of ["BTC", "ETH", "HYPE"]) await send(acc[5]!, m1.MarkRouter!, "applyRoute", [b32(m)]);
  const LP = acc[8]!;
  await send(LP, m3.MockUSDC!, "mint", [LP, 1_000_000n * 10n ** 6n]);
  await send(LP, m3.MockUSDC!, "approve", [m3.MainspringPool!, 1_000_000n * 10n ** 6n]);
  await send(LP, m3.MainspringPool!, "deposit", [1_000_000n * 10n ** 6n]);
}, 300_000);

afterAll(() => {
  anvil?.kill();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test.skipIf(!haveTools)("one pass runs the whole cycle; the LP can claim; the next pass waits", async () => {
  await vote();
  const a = await poker("primary");
  expect(has(a, "keeper: epoch started")).toBe(true);
  expect(has(a, "keeper: marked")).toBe(true);
  expect(has(a, "keeper: settled")).toBe(true);
  expect(await round()).toBe(1n);
  await send(acc[8]!, m3.MainspringPool!, "claimShares", [0n]);
  expect(await client.readContract({ address: m3.MainspringPool!, abi, functionName: "balanceOf", args: [acc[8]!] })).toBe(1_000_000n * 10n ** 18n);
  const b = await poker("primary");
  expect(has(b, "keeper: wait")).toBe(true);
  expect(await round()).toBe(1n);
}, 120_000);

test.skipIf(!haveTools)("after the hour: the backup waits for the primary; the primary acts; the backup covers when it is late", async () => {
  await advance(3600 + 70);
  await vote();
  expect(has(await poker("backup"), "keeper: wait")).toBe(true); // 70 s past: the backup's 10 min not reached
  const p = await poker("primary");
  expect(has(p, "keeper: settled")).toBe(true);
  expect(await round()).toBe(2n);

  await advance(3600 + 700); // the primary is absent this hour
  await vote();
  const bk = await poker("backup");
  expect(has(bk, "keeper: settled")).toBe(true);
  expect(await round()).toBe(3n);
}, 120_000);

test.skipIf(!haveTools)("stale marks: the keeper cannot start an epoch (law 2) and says why", async () => {
  await advance(3600 + 700); // no votes: the router is stale
  const lines = await poker("primary");
  const w = lines.find((l) => l.msg === "keeper: cannot act");
  expect(w).toBeDefined();
  expect(w!.action).toBe("start");
  expect(w!.error).toBe("Stale");
  expect(await round()).toBe(3n);
}, 120_000);
