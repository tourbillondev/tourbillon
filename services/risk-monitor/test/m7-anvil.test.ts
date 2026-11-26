import { afterAll, beforeAll, expect, test } from "bun:test";
import { TEARDOWN_MS, hookLimit, within } from "@tourbillon/common/hooks.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { encodeFunctionData, parseAbi } from "viem";
import { b32, haveFoundry, startLocalM7, type LocalM7 } from "@tourbillon/common/localM7.ts";

// On a local anvil with DeployM7: the Safe queues a cap change in the timelock and the guardian pauses buys (both real
// Safe transactions signed through anvil); the risk-monitor (--once, watch mode) announces the queued call by name and
// the pause by who, and does not mistake the deploy's handover for role changes. Skipped without anvil/forge.
const PORT = 27545 + Math.floor(Math.random() * 1000);
let L: LocalM7 | undefined;

const abi = parseAbi([
  "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function setCaps(bytes32 market, uint256 notionalCap, uint256 directionalCap)",
  "function pauseBuys()",
]);

beforeAll(within(import.meta.path, "setup", 240_000, async () => {
  if (haveFoundry()) L = await startLocalM7(PORT);
}), hookLimit(240_000));
afterAll(within(import.meta.path, "teardown", TEARDOWN_MS, () => L?.stop()), hookLimit(TEARDOWN_MS));

test.skipIf(!haveFoundry())(
  "a queued timelock call and a guardian pause are announced; the handover is not a role change; a dry key is raised",
  async () => {
    const { acc, m7, safeExec } = L!;
    const caps = encodeFunctionData({ abi, functionName: "setCaps", args: [b32("BTC"), 4_000_000n * 10n ** 6n, 1_000_000n * 10n ** 6n] });
    const schedule = encodeFunctionData({ abi, functionName: "schedule", args: [m7.MainspringPool!, 0n, caps, `0x${"0".repeat(64)}`, `0x${"1".repeat(64)}`, 3600n] });
    await safeExec(m7.Safe!, acc.slice(1, 4), m7.Timelock!, schedule);
    await safeExec(m7.Guardian!, acc.slice(6, 8), m7.Engine!, encodeFunctionData({ abi, functionName: "pauseBuys" }));
    // the key watcher: E1 (given ETH by anvil) and an empty key
    const kdir = mkdtempSync(join(tmpdir(), "keys-"));
    const keysFile = join(kdir, "keys.json");
    writeFileSync(keysFile, JSON.stringify([{ name: "E1", address: acc[9] }, { name: "receipts-poster", address: "0x000000000000000000000000000000000000dEaD", min: "0.1" }]));
    const p = Bun.spawn(["bun", "src/main.ts", "--deployment", L!.m7File, "--rpc", L!.rpc, "--watch", acc[9]!, "--once", "--keys", keysFile], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const lines = (await new Response(p.stdout).text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    await p.exited;
    const queued = lines.find((l) => l.name === "timelock-queued");
    expect((queued?.values as Record<string, unknown>).call).toBe("setCaps(BTC, 4000000000000, 1000000000000)");
    expect((queued?.values as Record<string, unknown>).contract).toBe("MainspringPool");
    const paused = lines.find((l) => l.name === "paused");
    expect((paused?.values as Record<string, unknown>).by).toBe("the guardian");
    expect(lines.some((l) => l.name === "role-changed")).toBe(false);
    expect(lines.some((l) => l.name === "monitor-error")).toBe(false);
    expect(lines.some((l) => l.name === "receipts-stale")).toBe(false);
    const low = lines.filter((l) => l.name === "key-balance-low");
    expect(low.map((l) => l.market)).toEqual(["receipts-poster"]); // the key with gas is fine, the empty one is raised
    rmSync(kdir, { recursive: true, force: true });
  },
  240_000,
);

const rhAbi = parseAbi([
  "function marketPaused(bytes32) view returns (bool)",
  "function onCoverStuck(bytes32 market)",
]);

test.skipIf(!haveFoundry())(
  "RH7: a split ratio pauses STK1 at once; a hedge holding off target and a stuck covering token are announced",
  async () => {
    const { acc, m7, client, rpcCall } = L!;
    // the signers see STK1 at 20 after a 2-for-1 split; the board's step clamp publishes about 39.2
    await L!.vote({ BTC: "74000", ETH: "2000", STK1: "20" });
    // hedger-onchain says the pool holds nothing against a target of 300 shares (band 50)
    const dir = mkdtempSync(join(tmpdir(), "rh7-"));
    const status = join(dir, "onchain.json");
    writeFileSync(status, JSON.stringify({ updatedAt: new Date().toISOString(), venue: "onchain", markets: { STK1: { ok: true, lastOkAt: null, held: 0, target: 300, band: 50 } } }));
    // the WriterBook reports a stuck covering token on ETH (as after a frozen transfer)
    await rpcCall("anvil_impersonateAccount", [m7.WriterBook!]);
    await rpcCall("anvil_setBalance", [m7.WriterBook!, "0x56BC75E2D63100000"]);
    const hash = (await rpcCall("eth_sendTransaction", [{ from: m7.WriterBook!, to: m7.MainspringPool!, data: encodeFunctionData({ abi: rhAbi, functionName: "onCoverStuck", args: [b32("ETH")] }) }])) as `0x${string}`;
    await client.waitForTransactionReceipt({ hash });
    await rpcCall("anvil_stopImpersonatingAccount", [m7.WriterBook!]);

    const p = Bun.spawn(["bun", "src/main.ts", "--deployment", L!.m7File, "--rpc", L!.rpc, "--local-unlocked", acc[9]!, "--once", "--hedger-status", status], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const lines = (await new Response(p.stdout).text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    await p.exited;
    const split = lines.find((l) => l.name === "split-mismatch");
    expect(split?.market).toBe("STK1");
    expect((split?.values as Record<string, unknown>).ratio).toBe(0.5);
    expect(typeof (split?.values as Record<string, unknown>).tx).toBe("string"); // the pause transaction
    expect(await client.readContract({ address: m7.MainspringPool!, abi: rhAbi, functionName: "marketPaused", args: [b32("STK1")] })).toBe(true);
    expect(await client.readContract({ address: m7.MainspringPool!, abi: rhAbi, functionName: "marketPaused", args: [b32("BTC")] })).toBe(false);
    const inv = lines.find((l) => l.name === "inventory-mismatch" && l.state === "raised");
    expect(inv?.market).toBe("STK1");
    const stuck = lines.find((l) => l.name === "transfer-stuck");
    expect(stuck?.market).toBe("ETH");
    expect(lines.some((l) => l.name === "monitor-error" || l.name === "pause-failed")).toBe(false);
    expect(lines.filter((l) => l.msg === "alarm").every((l) => /^[a-z]+(-[a-z]+)*$/.test(String(l.name)))).toBe(true); // playbook names
    rmSync(dir, { recursive: true, force: true });
  },
  240_000,
);
