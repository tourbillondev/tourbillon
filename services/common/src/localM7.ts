import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { concat, createPublicClient, createWalletClient, getAddress, http, parseAbi, parseEther, stringToHex, type Address, type Hex, type PublicClient } from "viem";
import { foundry } from "viem/chains";

/// LOCAL ONLY: a fresh anvil with the M7 system (DeployM7), routes applied, marks and vols voted by the test signers
/// and an LP round settled. For service tests and runs; anvil's unlocked accounts, no key anywhere.
/// Accounts: 0 deployer; 1–5 Safe owners; 6–8 guardian owners; 9 risk key (E1); 10 receipts poster; 11 protocol
/// recipient; 12–14 signers; 15 LP; 16 trader; 17 maker; 18 agent; 19 an agent's owner.

export const haveFoundry = () => Bun.which("anvil") !== null && Bun.which("forge") !== null;
export const CONTRACTS = resolve(import.meta.dir, "../../../contracts");
export const b32 = (m: string) => stringToHex(m, { size: 32 });

const abi = parseAbi([
  "function markKey(bytes32) pure returns (bytes32)",
  "function volKey(bytes32) pure returns (bytes32)",
  "function latestRoundData(bytes32) view returns (uint80, int256, uint256, uint256, uint80)",
  "function vote(bytes32, uint80, uint256)",
  "function applyRoute(bytes32)",
  "function poke(bytes32) returns (bool, bool, bool)",
  "function mint(address, uint256)",
  "function approve(address, uint256) returns (bool)",
  "function deposit(uint256)",
  "function startEpoch()",
  "function markChunk(uint256) returns (bool)",
  "function settle()",
  "function claimShares(uint256)",
]);

export type LocalM7 = {
  rpc: string;
  client: PublicClient;
  acc: Address[];
  m7: Record<string, Address> & { deployBlock?: unknown; timelockDelay?: unknown };
  m7File: string;
  rpcCall(method: string, params?: unknown[]): Promise<unknown>;
  send(from: Address, address: Address, abi: readonly unknown[], functionName: string, args?: readonly unknown[]): Promise<Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>>>;
  vote(prices: Record<string, string>, vol?: string): Promise<void>;
  warp(seconds: number): Promise<void>;
  /// A Safe transaction (a call from the Safe), signed by `owners` through anvil (EIP-712 SafeTx), sent by owners[0].
  safeExec(safe: Address, owners: Address[], to: Address, data: Hex): Promise<Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>>>;
  stop(): void;
};

const safeAbi = parseAbi([
  "function nonce() view returns (uint256)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
]);

export async function startLocalM7(port: number, prices: Record<string, string> = { BTC: "74000", ETH: "2000", HYPE: "40" }): Promise<LocalM7> {
  const rpc = `http://127.0.0.1:${port}`;
  const tmp = mkdtempSync(join(tmpdir(), "local-m7-"));
  const anvil = Bun.spawn(["anvil", "--port", String(port), "--accounts", "20", "--silent"], { stdout: "ignore", stderr: "ignore" });
  const client = createPublicClient({ chain: foundry, transport: http(rpc), pollingInterval: 100 }) as PublicClient;
  for (let i = 0; i < 80; i++) {
    try {
      await client.getChainId();
      break;
    } catch {
      await Bun.sleep(100);
    }
  }
  const rpcCall = async (method: string, params: unknown[] = []) => {
    const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return ((await res.json()) as { result: unknown }).result;
  };
  const acc = ((await rpcCall("eth_accounts")) as Address[]).map((a) => getAddress(a));
  const env = {
    ...process.env,
    SAFE_OWNERS: acc.slice(1, 6).join(","),
    GUARDIAN_OWNERS: acc.slice(6, 9).join(","),
    RISK_PAUSER: acc[9]!,
    RECEIPTS_POSTER: acc[10]!,
    PROTOCOL_RECIPIENT: acc[11]!,
    SIGNERS: acc.slice(12, 15).join(","),
  };
  const r = Bun.spawnSync(["forge", "script", "script/DeployM7.s.sol:DeployM7", "--rpc-url", rpc, "--unlocked", "--sender", acc[0]!, "--broadcast"], { cwd: CONTRACTS, env });
  if (r.exitCode !== 0) throw new Error(`DeployM7 failed: ${r.stderr.toString()}`);
  const m7File = join(tmp, "31337-m7.json");
  copyFileSync(join(CONTRACTS, "deployments", "31337-m7.json"), m7File);
  const m7 = (await Bun.file(m7File).json()) as LocalM7["m7"];

  const send: LocalM7["send"] = async (from, address, a, functionName, args = []) => {
    const gas = await client.estimateContractGas({ address, abi: a, functionName, args, account: from } as never);
    const hash = await createWalletClient({ chain: foundry, transport: http(rpc), account: from }).writeContract({ address, abi: a, functionName, args, gas: gas * 2n } as never);
    const rc = await client.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`${functionName} reverted`);
    return rc;
  };
  const vote: LocalM7["vote"] = async (px, vol = "0.45") => {
    for (const m of Object.keys(px)) {
      for (const fn of ["markKey", "volKey"] as const) {
        const key = await client.readContract({ address: m7.QuorumBoard!, abi, functionName: fn, args: [b32(m)] });
        let round = 0n;
        try {
          [round] = await client.readContract({ address: m7.QuorumBoard!, abi, functionName: "latestRoundData", args: [key] });
        } catch {
          round = 0n;
        }
        const v = fn === "markKey" ? parseEther(px[m]!) : parseEther(vol);
        for (const s of acc.slice(12, 15)) await send(s, m7.QuorumBoard!, abi, "vote", [key, round + 1n, v]);
      }
    }
  };
  const warp = async (s: number) => {
    await rpcCall("evm_increaseTime", [s]);
    await rpcCall("evm_mine");
  };

  // live: the router's own delay for the first routes, then marks, vols, samples, an LP round
  await warp(3600);
  for (const m of Object.keys(prices)) await send(acc[0]!, m7.MarkRouter!, abi, "applyRoute", [b32(m)]);
  await vote(prices);
  for (const m of Object.keys(prices)) await send(acc[0]!, m7.PathFundingBook!, abi, "poke", [b32(m)]);
  const LP = acc[15]!;
  await send(LP, m7.MockUSDC!, abi, "mint", [LP, 5_000_000n * 10n ** 6n]);
  await send(LP, m7.MockUSDC!, abi, "approve", [m7.MainspringPool!, 5_000_000n * 10n ** 6n]);
  await send(LP, m7.MainspringPool!, abi, "deposit", [5_000_000n * 10n ** 6n]);
  await send(acc[0]!, m7.MainspringPool!, abi, "startEpoch");
  await send(acc[0]!, m7.MainspringPool!, abi, "markChunk", [100n]);
  await send(acc[0]!, m7.MainspringPool!, abi, "settle");
  await send(LP, m7.MainspringPool!, abi, "claimShares", [0n]);

  const safeExec: LocalM7["safeExec"] = async (safe, owners, to, data) => {
    const nonce = await client.readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
    const message = { to, value: 0n, data, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: "0x0000000000000000000000000000000000000000" as Address, refundReceiver: "0x0000000000000000000000000000000000000000" as Address, nonce };
    const types = {
      SafeTx: [
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
        { name: "operation", type: "uint8" },
        { name: "safeTxGas", type: "uint256" },
        { name: "baseGas", type: "uint256" },
        { name: "gasPrice", type: "uint256" },
        { name: "gasToken", type: "address" },
        { name: "refundReceiver", type: "address" },
        { name: "nonce", type: "uint256" },
      ],
    } as const;
    const sorted = [...owners].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1));
    const sigs: Hex[] = [];
    for (const o of sorted) {
      const w = createWalletClient({ chain: foundry, transport: http(rpc), account: o });
      sigs.push(await w.signTypedData({ domain: { chainId: 31337, verifyingContract: safe }, types, primaryType: "SafeTx", message }));
    }
    return send(owners[0]!, safe, safeAbi, "execTransaction", [to, 0n, data, 0, 0n, 0n, 0n, message.gasToken, message.refundReceiver, concat(sigs)]);
  };

  return {
    rpc,
    client,
    safeExec,
    acc,
    m7,
    m7File,
    rpcCall,
    send,
    vote,
    warp,
    stop: () => {
      anvil.kill();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
