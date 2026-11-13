import { afterAll, beforeAll, expect, test } from "bun:test";
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

beforeAll(async () => {
  if (haveFoundry()) L = await startLocalM7(PORT);
}, 240_000);
afterAll(() => L?.stop());

test.skipIf(!haveFoundry())(
  "a queued timelock call and a guardian pause are announced; the handover is not a role change; a dry key is raised",
  async () => {
    const { acc, m7, safeExec } = L!;
    const caps = encodeFunctionData({ abi, functionName: "setCaps", args: [b32("BTC"), 4_000_000n * 10n ** 6n, 1_000_000n * 10n ** 6n] });
    const schedule = encodeFunctionData({ abi, functionName: "schedule", args: [m7.MainspringPool!, 0n, caps, `0x${"0".repeat(64)}`, `0x${"1".repeat(64)}`, 3600n] });
    await safeExec(m7.Safe!, acc.slice(1, 4), m7.Timelock!, schedule);
    await safeExec(m7.Guardian!, acc.slice(6, 8), m7.Engine!, encodeFunctionData({ abi, functionName: "pauseBuys" }));
    // the key watcher: E1 (funded by anvil) and an empty key
    const kdir = mkdtempSync(join(tmpdir(), "keys-"));
    const keysFile = join(kdir, "keys.json");
    writeFileSync(keysFile, JSON.stringify([{ name: "E1", address: acc[9] }, { name: "receipts-poster", address: "0x000000000000000000000000000000000000dEaD", min: "0.1" }]));
    const p = Bun.spawn(["bun", "src/main.ts", "--deployment", L!.m7File, "--rpc", L!.rpc, "--watch", acc[9]!, "--once", "--hl-api", "http://127.0.0.1:9", "--keys", keysFile], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const lines = (await new Response(p.stdout).text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    await p.exited;
    const queued = lines.find((l) => l.name === "TIMELOCK_QUEUED");
    expect((queued?.values as Record<string, unknown>).call).toBe("setCaps(BTC, 4000000000000, 1000000000000)");
    expect((queued?.values as Record<string, unknown>).contract).toBe("MainspringPool");
    const paused = lines.find((l) => l.name === "PAUSED");
    expect((paused?.values as Record<string, unknown>).by).toBe("the guardian");
    expect(lines.some((l) => l.name === "ROLE_CHANGED")).toBe(false);
    expect(lines.some((l) => l.name === "MONITOR_ERROR")).toBe(false);
    expect(lines.some((l) => l.name === "RECEIPTS_STALE")).toBe(false);
    const low = lines.filter((l) => l.name === "KEY_BALANCE_LOW");
    expect(low.map((l) => l.market)).toEqual(["receipts-poster"]); // the funded key is fine, the empty one is raised
    rmSync(kdir, { recursive: true, force: true });
  },
  240_000,
);
