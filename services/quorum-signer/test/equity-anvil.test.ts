import { afterAll, beforeAll, expect, test } from "bun:test";
import { TEARDOWN_MS, hookLimit, within } from "@tourbillon/common/hooks.ts";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicClient, createWalletClient, http, type Address, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { equityKey } from "../src/equity.ts";
import { SimExchange } from "../../hedger/src/simexchange.ts";

// End to end on a local anvil: DeployM1 (the board), a MainspringPool created with forge, the EQUITY feed listed,
// the simulated crypto hedge exchange (read-only keys), and the three real signer processes voting EQUITY twice. The
// pool's equity term then equals 95% of the P&L the exchange account shows. Skipped without anvil and forge.
const haveTools = Bun.which("anvil") !== null && Bun.which("forge") !== null;
const CONTRACTS = resolve(import.meta.dir, "../../../contracts");
const PORT = 20545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const MARKS = "BTC=100000,ETH=3000,STK1=40";

const poolAbi = [
  { type: "function", name: "equityKey", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "equityTerm", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
const boardAbi = [
  { type: "function", name: "setFeed", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint16" }, { type: "uint32" }], outputs: [] },
] as const;

let anvil: ReturnType<typeof Bun.spawn> | undefined;
let ex: SimExchange | undefined;
let tmp = "";
let depFile = "";
let pool: Address;
let acc: Address[] = [];
const client = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: 100 }) as PublicClient;

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return ((await res.json()) as { result: unknown }).result;
}

function forgeCreate(contract: string, args: string[], libraries: string[] = []): Address {
  const libs = libraries.flatMap((l) => ["--libraries", l]);
  const r = Bun.spawnSync(["forge", "create", contract, "--rpc-url", RPC, "--unlocked", "--from", acc[0]!, "--broadcast", ...libs, ...(args.length ? ["--constructor-args", ...args] : [])], { cwd: CONTRACTS });
  const m = /Deployed to: (0x[0-9a-fA-F]{40})/.exec(r.stdout.toString());
  if (!m) throw new Error(`forge create ${contract} failed: ${r.stderr.toString()}`);
  return m[1] as Address;
}

async function signer(a: Address): Promise<Record<string, unknown>[]> {
  const p = Bun.spawn(
    ["bun", "src/main.ts", "--deployment", depFile, "--rpc", RPC, "--once", "--local-unlocked", a, "--test-marks", MARKS, "--test-vol", "0.5", "--equity-pool", pool, "--exchange", "sim", "--exchange-url", ex!.url],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

beforeAll(within(import.meta.path, "setup", 240_000, async () => {
  if (!haveTools) return;
  tmp = mkdtempSync(join(tmpdir(), "equity-anvil-"));
  ex = new SimExchange([{ name: "BTC", szDecimals: 5, mid: 100_000 }]);
  ex.deposit(1_000_000);
  ex.cash += 50_000; // P&L 50,000
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
  const r = Bun.spawnSync(["forge", "script", "script/DeployM1.s.sol:DeployM1", "--rpc-url", RPC, "--unlocked", "--sender", acc[0]!, "--broadcast"], {
    cwd: CONTRACTS,
    env: { ...process.env, ADMIN: acc[1]!, SIGNERS: `${acc[2]},${acc[3]},${acc[4]}` },
  });
  if (r.exitCode !== 0) throw new Error(`DeployM1 failed: ${r.stderr.toString()}`);
  depFile = join(tmp, "31337.json");
  copyFileSync(join(CONTRACTS, "deployments", "31337.json"), depFile);
  const m1 = (await Bun.file(depFile).json()) as Record<string, Address>;
  const usdc = forgeCreate("test/mocks/MockSettlementToken.sol:MockSettlementToken", ["Mock Global Dollar", "USDG", "6"]);
  // (admin, usdc, book, marks, vols, equityFeed, protocolRecipient): the book is not used in this test
  // the pool's liability code is an external library (M4 D4): deploy it, then link it
  const liability = forgeCreate("src/PoolLiability.sol:PoolLiability", []);
  const hedge = forgeCreate("src/HedgeSwap.sol:HedgeSwap", []);
  pool = forgeCreate("src/MainspringPool.sol:MainspringPool", [acc[1]!, usdc, acc[9]!, m1.MarkRouter!, m1.QuorumBoard!, m1.QuorumBoard!, acc[1]!], [`src/PoolLiability.sol:PoolLiability:${liability}`, `src/HedgeSwap.sol:HedgeSwap:${hedge}`]);
  const key = await client.readContract({ address: pool, abi: poolAbi, functionName: "equityKey" });
  const hash = await createWalletClient({ chain: foundry, transport: http(RPC), account: acc[1]! }).writeContract({
    address: m1.QuorumBoard!,
    abi: boardAbi,
    functionName: "setFeed",
    args: [key, 5000, 7200],
  });
  await client.waitForTransactionReceipt({ hash });
}), hookLimit(240_000));

afterAll(within(import.meta.path, "teardown", TEARDOWN_MS, () => {
  anvil?.kill();
  ex?.stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}), hookLimit(TEARDOWN_MS));

test.skipIf(!haveTools)("three signers vote EQUITY twice; the pool counts 95% of the lower P&L", async () => {
  expect(await client.readContract({ address: pool, abi: poolAbi, functionName: "equityKey" })).toBe(equityKey(pool));

  for (const s of [acc[2]!, acc[3]!, acc[4]!]) {
    const lines = await signer(s);
    expect(lines.some((l) => l.msg === "voted" && l.kind === "EQUITY" && l.status === "success")).toBe(true);
  }
  expect(await client.readContract({ address: pool, abi: poolAbi, functionName: "equityTerm" })).toBe(0n); // one final

  await rpc("evm_increaseTime", [3601]);
  await rpc("evm_mine");
  for (const s of [acc[2]!, acc[3]!, acc[4]!]) await signer(s);
  expect(await client.readContract({ address: pool, abi: poolAbi, functionName: "equityTerm" })).toBe(47_500_000_000n); // 95% of 50,000

  // a 40% P&L drop shows after one round
  ex!.cash -= 20_000; // P&L 30,000
  expect(ex!.rejected).toEqual([]); // the signers' read-only keys only ever read
  await rpc("evm_increaseTime", [3601]);
  await rpc("evm_mine");
  for (const s of [acc[2]!, acc[3]!, acc[4]!]) await signer(s);
  expect(await client.readContract({ address: pool, abi: poolAbi, functionName: "equityTerm" })).toBe(28_500_000_000n);
}, 240_000);
