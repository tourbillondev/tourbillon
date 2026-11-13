import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BaseError,
  concat,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  decodeEventLog,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  parseEther,
  stringToHex,
  toFunctionSelector,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { foundry } from "viem/chains";
import { blendDelta, blendValue } from "@tourbillon/common/tempo.ts";
import { writerWorstPerUnit } from "../../maker-gateway/src/quote.ts";
import { SimVenue } from "../../hedger/src/simvenue.ts";
import { loadM7Deployment } from "../../receipts/src/collect.ts";
import { Collector } from "../../receipts/src/epochs.ts";
import { buildTree, leafOf, proofOf } from "../../receipts/src/tree.ts";

/// M7 step 11: the whole M7 system on anvil. DeployM7, then every service as a real process (three signers, two
/// pokers, the hedger on the simulated venue, the risk-monitor with the automated key E1, the maker-gateway with two
/// maker bots, the receipts service, and the MCP server driven over stdio). Governance runs through real Safe
/// transactions signed by anvil's unlocked owners (EIP-712 SafeTx): no key anywhere. Automining anvil plus an empty
/// block every second, so routed buys can be re-priced at their exact parent state. Logs and report in a temp folder.
///
///   bun scripts/local-m7-run.ts [--scale 1]

const scale = Number(process.argv[process.argv.indexOf("--scale") + 1] ?? 1) || 1;
const SERVICES = resolve(import.meta.dir, "../..");
const CONTRACTS = resolve(SERVICES, "../contracts");
const PORT = 33545;
const RPC = `http://127.0.0.1:${PORT}`;
const MARKETS = ["BTC", "ETH", "HYPE"];
const STEP: Record<string, number> = { BTC: 100, ETH: 5, HYPE: 0.1 };
const SZ: Record<string, number> = { BTC: 5, ETH: 4, HYPE: 2 };
const POOL_HL = "0x00000000000000000000000000000000000000E1" as Address;
const USDC = 10n ** 6n;
const WAD = 10n ** 18n;
const MAX = 2n ** 256n - 1n;
const DAY = 86_400;
const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const KIND_POOL = 1;
const KIND_QUOTE = 2;
const out = mkdtempSync(join(tmpdir(), "tourbillon-m7-run-"));
const T0 = Date.now();
const say = (msg: string) => {
  const line = `${new Date().toISOString()} [${((Date.now() - T0) / 60_000).toFixed(1)} min] ${msg}`;
  console.log(line);
  appendFileSync(join(out, "runner.log"), line + "\n");
};
const sleep = (ms: number) => Bun.sleep(ms);
const b32 = (m: string) => stringToHex(m, { size: 32 });
const usd = (v: bigint) => Number(formatUnits(v, 6));
const wadStr = (x: number) => parseEther(x.toFixed(8));

// ---------------------------------------------------------------- ABI

const abi = parseAbi([
  "struct Leg { bool isCall; uint128 kWad; int128 qty; }",
  "struct Part { uint256 tempo; uint256 weight; }",
  "struct Quote { address maker; bytes32 name; uint8 sides; uint128 kLoWad; uint128 kHiWad; uint32 tauLo; uint32 tauHi; uint64 sigmaBps; uint128 maxUnits; uint64 validUntil; uint64 nonce; }",
  "struct Route { address primary; address secondary; uint32 maxAge; uint16 maxDevBps; }",
  "function applyRoute(bytes32)",
  "function pending(bytes32) view returns (Route, uint64)",
  "function route(bytes32) view returns (Route)",
  "function markWad(bytes32) view returns (uint256)",
  "function volBps(bytes32) view returns (uint256)",
  "function isSigner(address) view returns (bool)",
  "function setSigner(address, bool)",
  "function mint(address, uint256)",
  "function approve(address, uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function deposit(uint256)",
  "function requestWithdraw(uint256)",
  "function claimShares(uint256)",
  "function withdraw(uint256)",
  "function depositOf(uint256, address) view returns (uint256)",
  "function withdrawOf(uint256, address) view returns (uint256)",
  "function round() view returns (uint256)",
  "function navNow() view returns (uint256)",
  "function equityReady() view returns (bool)",
  "function notionalCap(bytes32) view returns (uint256)",
  "function setCaps(bytes32, uint256, uint256)",
  "function setProtocolFee(uint16, address)",
  "function setTreasury(address)",
  "function treasury() view returns (address)",
  "function sendToTreasury(uint256)",
  "function treasuryDailyCapBps() view returns (uint16)",
  "function freeForWithdrawals() view returns (uint256)",
  "function pauseBuys()",
  "function unpauseBuys()",
  "function buysPaused() view returns (bool)",
  "function pauseMarket(bytes32)",
  "function unpauseMarket(bytes32)",
  "function marketPaused(bytes32) view returns (bool)",
  "function pauseDeposits()",
  "function unpauseDeposits()",
  "function depositsPaused() view returns (bool)",
  "function grantRole(bytes32, address)",
  "function hasRole(bytes32, address) view returns (bool)",
  "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt) payable",
  "function cancel(bytes32 id)",
  "function hashOperation(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt) view returns (bytes32)",
  "function isOperation(bytes32) view returns (bool)",
  "function queueRoute(bytes32 market, Route r)",
  "function nonce() view returns (uint256)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
  "function balanceOf(uint256, address) view returns (uint256)",
  "function accrue(uint256, uint256) returns (uint256, bool)",
  "function buy(bytes32 market, Leg[] legs, Part[] movement, uint256 units, uint256 maxCost, uint256 deadline, Quote[] quotes, bytes[] sigs, uint256[] offerIds) returns (uint256, uint256, uint8)",
  "function sell(uint256, uint256, uint256, uint256) returns (uint256, uint256)",
  "function required(bytes32, uint256) view returns (uint256, uint256)",
  "function entries(bytes32, uint256) view returns (uint256 raw, uint256 usdcPerUnit, uint256 coverPerUnit, uint256 usdcLocked, uint256 whypeLocked, bool flagged)",
  "function seriesSources(uint256) view returns (bytes32[])",
  "function matchedRaw(uint256) view returns (uint256)",
  "function matchedRawOf(uint256) view returns (uint256)",
  "function uncoveredRaw(uint256) view returns (uint256)",
  "function heldUsdc() view returns (uint256)",
  "function freeOf(address, address) view returns (uint256)",
  "function lockedOf(address, address) view returns (uint256)",
  "function openSeries(bytes32) view returns (uint256[])",
  "function rawOf(address, uint256) view returns (uint256)",
  "function totalRaw(uint256) view returns (uint256)",
  "function deltaUsed(bytes32) view returns (uint256)",
  "function vegaUsed(bytes32) view returns (uint256)",
  "function premiumUsed(bytes32) view returns (uint256)",
  "function revoke(uint64)",
  "function ownerSell(uint256 id, uint256 units, uint256 minOut, uint256 deadline) returns (uint256, uint256)",
  "function rootOf(uint256) view returns (bytes32, uint256, uint256)",
  "function verify(uint256 epoch, bytes32 leaf, bytes32[] proof) view returns (bool)",
  // errors
  "error Stale(bytes32 market, address source)",
  "error Stale(bytes32 key, uint256 updatedAt)",
  "error NoSource()",
  "error BuysArePaused()",
  "error DepositsArePaused()",
  "error MarketIsPaused(bytes32 market)",
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
  "error TimelockUnexpectedOperationState(bytes32 operationId, bytes32 expectedStates)",
  "error TimelockInsufficientDelay(uint256 delay, uint256 minDelay)",
  "error AboveDailyCap(uint256 amount, uint256 room)",
  "error AboveFree(uint256 amount, uint256 free)",
  "error EquityNotReady()",
  "error NotAgent()",
  "error BadMandateSignature()",
  "error MandateRevoked()",
  "error MandateExpired(uint64 expiry)",
  "error CloseOnly()",
  "error MarketNotAllowed(bytes32 market)",
  "error ShapeNotAllowed(uint256 family)",
  "error OverTotalCap(uint256 used, uint256 cap)",
  "error NothingHeld(uint256 id)",
  "error GreeksUnavailable(bytes32 market)",
  "error OverDeltaBudget(uint256 wouldBe, uint256 budget)",
  "error OverVegaBudget(uint256 wouldBe, uint256 budget)",
  "error CostAboveMax(uint256 cost, uint256 maxCost)",
  "error NothingToSell(uint256 id)",
  "error NotCaughtUp(uint256 id)",
]);
const events = parseAbi([
  "event Routed(address indexed buyer, uint256 indexed id, uint8 kind, uint256 sigmaBps, uint256 cost, address source)",
  "event Sold(address indexed seller, uint256 indexed id, bytes32 indexed market, uint256 units, uint256 raw, uint256 sWad, uint256 sigmaBps, uint256 unitValueWad, uint256 gross, uint256 fee, uint256 net, bool markFromSample, bool volFromSample)",
  "event BoughtBack(bytes32 indexed key, uint256 indexed seriesId, uint256 raw, uint256 paidUsdc, uint256 paidWhype, uint256 shortfall)",
  "event AgentBought(bytes32 indexed mandate, address indexed owner, uint256 indexed id, uint256 raw, uint256 cost, uint8 kind)",
  "event PositionSold(address indexed owner, uint256 indexed id, uint256 raw, uint256 units, uint256 net, bytes32 mandate)",
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  "event Posted(uint256 indexed epoch, bytes32 root, uint256 count, address indexed poster)",
]);

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return ((await res.json()) as { result: unknown }).result;
}

// ---------------------------------------------------------------- chain and DeployM7

say(`logs in ${out}; scale ${scale}`);
const anvil = Bun.spawn(["anvil", "--port", String(PORT), "--accounts", "24", "--silent"], { stdout: "ignore", stderr: "ignore" });
const client = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: 200 }) as PublicClient;
for (let i = 0; i < 80; i++) {
  try {
    await client.getChainId();
    break;
  } catch {
    await sleep(100);
  }
}
const acc = ((await rpc("eth_accounts")) as Address[]).map((a) => getAddress(a));
const DEPLOYER = acc[0]!;
const OWNERS = acc.slice(1, 6);
const GUARDIANS = acc.slice(6, 9);
const E1 = acc[9]!;
const POSTER = acc[10]!;
const PROTO = acc[11]!;
const SIGNERS = acc.slice(12, 15);
const LP = acc[15]!;
const TRADERS = [acc[16]!, acc[17]!];
const MK1 = acc[18]!;
const MK2 = acc[19]!;
const AGENT = acc[20]!;
const OA = acc[21]!;
const OB_ = acc[22]!;
const TREASURY = acc[23]!;
const ANYONE = "0x000000000000000000000000000000000000a11a" as Address;
const env = {
  ...process.env,
  SAFE_OWNERS: OWNERS.join(","),
  GUARDIAN_OWNERS: GUARDIANS.join(","),
  RISK_PAUSER: E1,
  RECEIPTS_POSTER: POSTER,
  PROTOCOL_RECIPIENT: PROTO,
  SIGNERS: SIGNERS.join(","),
};
{
  const r = Bun.spawnSync(["forge", "script", "script/DeployM7.s.sol:DeployM7", "--rpc-url", RPC, "--unlocked", "--sender", DEPLOYER, "--broadcast"], { cwd: CONTRACTS, env });
  if (r.exitCode !== 0) throw new Error(`DeployM7 failed: ${r.stderr.toString()}`);
}
const m7File = join(out, "31337-m7.json");
copyFileSync(join(CONTRACTS, "deployments", "31337-m7.json"), m7File);
const m7 = JSON.parse(readFileSync(m7File, "utf8")) as Record<string, Address> & { deployBlock: number };
const POOL = m7.MainspringPool!;
const ENGINE = m7.Engine!;
const BOOK = m7.PathFundingBook!;
const MUSDC = m7.MockUSDC!;
const VAULT = m7.MakerVault!;
const MB = m7.MatchBook!;
const OBK = m7.OpenBook!;
const AR = m7.AgentRouter!;
const RA = m7.RiskAuction!;
const RR = m7.ReceiptRoots!;
const TL = m7.Timelock!;
const SAFE = m7.Safe!;
const GUARD = m7.Guardian!;
const ROUTER = m7.MarkRouter!;
const BOARD = m7.QuorumBoard!;
const ticker = setInterval(() => void rpc("evm_mine").catch(() => {}), 1_000);

type Receipt = Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>>;
type TxResult = { ok: true; receipt: Receipt } | { ok: false; reason: string };
/// Error names by selector, for reverts that arrive as a bare 4-byte selector (a raw estimateGas).
const errorBySelector = new Map<string, string>(
  (abi.filter((x) => x.type === "error") as unknown as { name: string; inputs: { type: string }[] }[]).map((x) => [toFunctionSelector(`${x.name}(${x.inputs.map((i) => i.type).join(",")})`).toLowerCase(), x.name]),
);
function decodeErr(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName === "Error" ? String(r.data.args?.[0]) : (r.data?.errorName ?? r.reason ?? "reverted");
  }
  const data = /(0x[0-9a-fA-F]{8,})/.exec((e as Error).message)?.[1] as Hex | undefined;
  if (data) {
    try {
      return decodeErrorResult({ abi, data }).errorName;
    } catch {
      return errorBySelector.get(data.slice(0, 10).toLowerCase()) ?? `unknown error ${data.slice(0, 10)}`;
    }
  }
  const m = /reverted with reason string '([^']+)'|reason: ([A-Z0-9]+)/.exec((e as Error).message);
  return m ? (m[1] ?? m[2]!) : (e as Error).message.split("\n")[0]!;
}
async function tx(from: Address, address: Address, functionName: string, args: readonly unknown[] = []): Promise<TxResult> {
  const call = { address, abi, functionName, args, account: from } as const;
  let gas: bigint;
  try {
    gas = await client.estimateContractGas(call as never);
  } catch (e) {
    return { ok: false, reason: decodeErr(e) };
  }
  const hash = await createWalletClient({ chain: foundry, transport: http(RPC), account: from }).writeContract({ ...(call as object), gas: gas * 2n } as never);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") return { ok: false, reason: "reverted on chain" };
  return { ok: true, receipt };
}
async function must(from: Address, address: Address, fn: string, args: readonly unknown[] = []): Promise<Receipt> {
  const r = await tx(from, address, fn, args);
  if (!r.ok) throw new Error(`${fn} failed: ${r.reason}`);
  return r.receipt;
}
const read = <T>(address: Address, functionName: string, args: readonly unknown[] = [], blockNumber?: bigint) =>
  client.readContract({ address, abi, functionName, args, blockNumber } as never) as Promise<T>;
type Ev = { eventName: string; args: Record<string, unknown>; address: Address };
function decoded(receipt: Receipt): Ev[] {
  const o: Ev[] = [];
  for (const l of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: events, data: l.data, topics: l.topics });
      o.push({ eventName: ev.eventName, args: ev.args as Record<string, unknown>, address: getAddress(l.address) });
    } catch {}
  }
  return o;
}
const chainNow = async () => (await client.getBlock()).timestamp;

/// A Safe transaction from `safe`, signed by `owners` through anvil (EIP-712 SafeTx), sent by owners[0].
async function safeTx(safe: Address, owners: Address[], to: Address, data: Hex): Promise<TxResult> {
  const n = await read<bigint>(safe, "nonce");
  const zero = "0x0000000000000000000000000000000000000000" as Address;
  const message = { to, value: 0n, data, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: zero, refundReceiver: zero, nonce: n };
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
  const sigs: Hex[] = [];
  for (const o of [...owners].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1))) {
    sigs.push(await createWalletClient({ chain: foundry, transport: http(RPC), account: o }).signTypedData({ domain: { chainId: 31337, verifyingContract: safe }, types, primaryType: "SafeTx", message }));
  }
  return tx(owners[0]!, safe, "execTransaction", [to, 0n, data, 0, 0n, 0n, 0n, zero, zero, concat(sigs)]);
}
const enc = (functionName: string, args: readonly unknown[] = []) => encodeFunctionData({ abi, functionName, args } as never);

// funds and allowances
const START_USDC = new Map<Address, bigint>();
for (const w of [LP, ...TRADERS, OA, OB_]) {
  await must(w, MUSDC, "mint", [w, 10_000_000n * USDC]);
  for (const sp of [POOL, ENGINE, AR]) await must(w, MUSDC, "approve", [sp, 10n ** 30n]);
  START_USDC.set(w, 10_000_000n * USDC);
}
say(`deployed; Safe ${SAFE}; guardian ${GUARD}; timelock ${TL}; AgentRouter ${AR}; ReceiptRoots ${RR}`);

// ---------------------------------------------------------------- the simulated venue and services

const PRICE: Record<string, number> = { BTC: 74_000, ETH: 2_000, HYPE: 40 };
const sim = new SimVenue(MARKETS.map((n) => ({ name: n, szDecimals: SZ[n]!, mid: PRICE[n]! })));
sim.deposit(1_000_000);
let walking = true;
const pricer = (async () => {
  let k = 1;
  while (walking) {
    for (const m of MARKETS) {
      PRICE[m] = PRICE[m]! * (1 + Math.sin(k * 1.7 + m.length) * 0.001);
      sim.setMid(m, Number(PRICE[m]!.toPrecision(5)));
    }
    k++;
    await sleep(30_000);
  }
})();
type Proc = ReturnType<typeof Bun.spawn>;
async function pipe(stream: ReadableStream<Uint8Array>, file: string) {
  for await (const c of stream) appendFileSync(file, c);
}
const procs: Proc[] = [];
process.on("exit", () => {
  for (const p of procs) p.kill("SIGKILL");
  anvil.kill("SIGKILL");
});
function service(name: string, cwd: string, entry: string, args: string[]): Proc {
  const p = Bun.spawn(["bun", entry, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  void pipe(p.stdout, join(out, `${name}.log`));
  void pipe(p.stderr, join(out, `${name}.err`));
  procs.push(p);
  say(`${name} started`);
  return p;
}
const statusFile = join(out, "hedger-status.json");
const GATEWAY = "http://127.0.0.1:33600";
for (const [i, s] of SIGNERS.entries()) service(`signer-${i + 1}`, join(SERVICES, "quorum-signer"), "src/main.ts", ["--deployment", m7File, "--rpc", RPC, "--local-unlocked", s, "--hl-api", sim.url, "--test-vol", "0.45", "--equity-pool", POOL, "--equity-hl-user", POOL_HL]);
service("poker-primary", join(SERVICES, "poker"), "src/main.ts", ["--deployment", m7File, "--rpc", RPC, "--local-unlocked", acc[1]!, "--role", "primary"]);
service("poker-backup", join(SERVICES, "poker"), "src/main.ts", ["--deployment", m7File, "--rpc", RPC, "--local-unlocked", acc[2]!, "--role", "backup"]);
service("hedger", join(SERVICES, "hedger"), "src/main.ts", ["--deployment", m7File, "--rpc", RPC, "--hl-user", POOL_HL, "--venue", "sim", "--venue-url", sim.url, "--status-file", statusFile, "--tick-seconds", "15"]);
service("risk-monitor", join(SERVICES, "risk-monitor"), "src/main.ts", ["--deployment", m7File, "--rpc", RPC, "--local-unlocked", E1, "--hl-api", sim.url, "--hl-user", POOL_HL, "--hedger-status", statusFile, "--equity-every-seconds", "300", "--tick-seconds", "15"]);
service("maker-gateway", join(SERVICES, "maker-gateway"), "src/main.ts", ["--deployment", m7File, "--rpc", RPC, "--port", "33600"]);
service("receipts", join(SERVICES, "receipts"), "src/main.ts", ["--deployment", m7File, "--rpc", RPC, "--local-unlocked", POSTER, "--port", "33601", "--margin-seconds", "30", "--tick-seconds", "15"]);

// the MCP server, driven over stdio
const mcp = Bun.spawn(["bun", "src/main.ts", "--deployment", m7File, "--rpc", RPC, "--gateway", GATEWAY], { cwd: join(SERVICES, "mcp"), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
procs.push(mcp);
void pipe(mcp.stderr, join(out, "mcp.err"));
let mcpId = 1;
const mcpWait = new Map<number, (v: Record<string, unknown>) => void>();
(async () => {
  let buf = "";
  for await (const c of mcp.stdout as ReadableStream<Uint8Array>) {
    buf += new TextDecoder().decode(c);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      appendFileSync(join(out, "mcp.log"), line + "\n");
      const msg = JSON.parse(line);
      mcpWait.get(msg.id)?.(msg);
    }
  }
})();
const mcpRpc = (method: string, params: unknown = {}) => {
  const id = mcpId++;
  const p = new Promise<Record<string, unknown>>((r) => mcpWait.set(id, r));
  (mcp.stdin as import("bun").FileSink).write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return p;
};
const mcpUsed = new Map<string, { ok: number; err: number }>();
async function tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = (await mcpRpc("tools/call", { name, arguments: args })).result as { isError: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] };
  const u = mcpUsed.get(name) ?? { ok: 0, err: 0 };
  if (r.isError) {
    u.err++;
    mcpUsed.set(name, u);
    throw new Error(`${name}: ${r.content[0]!.text}`);
  }
  u.ok++;
  mcpUsed.set(name, u);
  return r.structuredContent!;
}
/// Sends an unsigned transaction an MCP builder returned, from `from`.
async function sendBuilt(from: Address, t: Record<string, unknown>): Promise<TxResult> {
  try {
    const gas = await client.estimateGas({ account: from, to: t.to as Address, data: t.data as Hex });
    const hash = await createWalletClient({ chain: foundry, transport: http(RPC), account: from }).sendTransaction({ to: t.to as Address, data: t.data as Hex, gas: gas * 2n, chain: foundry });
    const receipt = await client.waitForTransactionReceipt({ hash });
    return receipt.status === "success" ? { ok: true, receipt } : { ok: false, reason: "reverted on chain" };
  } catch (e) {
    return { ok: false, reason: decodeErr(e) };
  }
}

// ---------------------------------------------------------------- helpers

const lines = (name: string) =>
  existsSync(join(out, `${name}.log`))
    ? readFileSync(join(out, `${name}.log`), "utf8").trim().split("\n").filter(Boolean).flatMap((l) => {
        try {
          return [JSON.parse(l) as Record<string, unknown>];
        } catch {
          return [];
        }
      })
    : [];
async function waitFor(label: string, check: () => Promise<boolean>, maxMs: number): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < maxMs) {
    try {
      if (await check()) return true;
    } catch {}
    await sleep(3_000);
  }
  say(`timeout waiting for ${label}`);
  return false;
}
async function routerMark(m: string): Promise<number | null> {
  try {
    return Number(formatUnits(await read<bigint>(ROUTER, "markWad", [b32(m)]), 18));
  } catch {
    return null;
  }
}
async function boardFresh(m: string): Promise<boolean> {
  try {
    await read<bigint>(BOARD, "volBps", [b32(m)]);
    return true;
  } catch {
    return false;
  }
}
const marksFresh = () => waitFor("marks and vols fresh", async () => (await Promise.all(MARKETS.map(async (m) => (await routerMark(m)) !== null && (await boardFresh(m))))).every(Boolean), 240_000);
const warps: number[] = [];
async function warp(seconds: number, label: string) {
  await rpc("evm_increaseTime", [seconds]);
  await rpc("evm_mine");
  warps.push(Date.now());
  say(`chain clock +${seconds / 60} min (${label})`);
}
const settledRound = async (r: bigint) => (await read<bigint>(POOL, "round")) > r;
async function nextSettlement(label: string): Promise<bigint> {
  const r = await read<bigint>(POOL, "round");
  await waitFor(label, () => settledRound(r), 300_000);
  return r;
}
async function walkedNorm(id: bigint): Promise<bigint> {
  const { result } = await client.simulateContract({ address: BOOK, abi, functionName: "accrue", args: [id, MAX], account: ANYONE } as never);
  return (result as readonly [bigint, boolean])[0];
}
const kAt = (m: string, x: number) => Math.round(x / STEP[m]!) * STEP[m]!;
type Leg = { isCall: boolean; k: number; qty: number };
const legArgs = (legs: Leg[]) => legs.map((l) => ({ isCall: l.isCall, kWad: wadStr(l.k), qty: wadStr(l.qty) }));
const tempoArg = (t: number) => [{ tempo: BigInt(t), weight: WAD }];
const spreadAt = (m: string, mark: number): Leg[] => {
  const K = kAt(m, mark);
  const w = Math.max(STEP[m]!, kAt(m, mark * 0.02));
  return [{ isCall: true, k: K, qty: 1 }, { isCall: true, k: K + w, qty: -1 }];
};
const gas: Record<string, bigint[]> = {};
const legsById = new Map<string, Leg[]>(); // every series bought in the run, for the independent law-4 check
const noteGas = (k: string, r: TxResult) => {
  if (r.ok) (gas[k] ??= []).push(r.receipt.gasUsed);
};

// ---------------------------------------------------------------- A. warm-up

await warp(3600, "the router's own delay for the first routes");
for (const m of MARKETS) await must(DEPLOYER, ROUTER, "applyRoute", [b32(m)]);
await marksFresh();
await waitFor("the keeper's first settlement", () => settledRound(0n), 240_000);
await must(LP, POOL, "deposit", [5_000_000n * USDC]);
await warp(3600, "the LP round");
const lpRound = await nextSettlement("the LP round settled");
await must(LP, POOL, "claimShares", [lpRound]);
await marksFresh();
for (const [name, mk, off] of [["maker-1", MK1, "-300"], ["maker-2", MK2, "-500"]] as const) {
  service(name, join(SERVICES, "maker-gateway"), "src/bot.ts", ["--deployment", m7File, "--rpc", RPC, "--gateway", GATEWAY, "--maker", mk, "--market", "BTC", "--sigma-offset-bps", off, "--max-units", "40", "--every-seconds", "30", "--fund", "300000"]);
  await waitFor(`${name} funded`, async () => (await read<bigint>(VAULT, "freeOf", [mk, MUSDC])) > 0n, 60_000);
}
await waitFor("quotes at the gateway", async () => ((await (await fetch(new URL("/health", GATEWAY))).json()) as { quotes: number }).quotes >= 2, 90_000);
say(`NAV ${usd(await read<bigint>(POOL, "navNow")).toFixed(2)} after the LP round`);

// ---------------------------------------------------------------- B. law 6 at runtime: the role sweep and timelocked actions

const crit: Record<number, { ok: boolean; detail: string }> = {};
const report: string[] = [];
{
  // every holder of every role, rebuilt from the chain's own events
  const logs = await client.getLogs({ fromBlock: 0n, toBlock: "latest", events: [events[5]!, events[6]!] } as never);
  const holders = new Map<string, Set<string>>();
  for (const l of logs as unknown as { address: Address; eventName: string; args: { role: Hex; account: Address } }[]) {
    const key = `${getAddress(l.address)}:${l.args.role}`;
    const s = holders.get(key) ?? new Set<string>();
    if (l.eventName === "RoleGranted") s.add(getAddress(l.args.account));
    else s.delete(getAddress(l.args.account));
    holders.set(key, s);
  }
  const eoaAdmins: string[] = [];
  const keyHolders: string[] = [];
  for (const [key, set] of holders) {
    for (const a of set) {
      if (a === "0x0000000000000000000000000000000000000000") continue; // the timelock's open executor
      const code = await client.getCode({ address: a as Address });
      if (code && code !== "0x") continue;
      if (key.endsWith(ZERO32)) eoaAdmins.push(`${key.slice(0, 10)}… → ${a}`);
      else keyHolders.push(`${key.slice(0, 10)}…:${key.slice(-8)} → ${a === E1 ? "E1" : a === POSTER ? "receipts poster" : a}`);
    }
  }
  const unexpectedKeys = keyHolders.filter((k) => !k.endsWith("E1") && !k.endsWith("receipts poster"));
  report.push(`role sweep: ${holders.size} (contract, role) pairs from the chain's events; key holders: ${keyHolders.join("; ")}`);
  crit[1] = { ok: eoaAdmins.length === 0 && unexpectedKeys.length === 0, detail: `no externally owned account holds an admin role (${eoaAdmins.length}); keys hold only E1's market pause and the receipts poster (${unexpectedKeys.length} other)` };
}
const govResults: { what: string; ok: boolean; detail: string }[] = [];
const timelockOps: { what: string; target: Address; data: Hex; salt: Hex }[] = [
  { what: "caps: BTC notional to $4.5M", target: POOL, data: enc("setCaps", [b32("BTC"), 4_500_000n * USDC, 1_000_000n * USDC]), salt: b32("op-caps") },
  { what: "fees: protocol share and recipient", target: POOL, data: enc("setProtocolFee", [1000, PROTO]), salt: b32("op-fee") },
  { what: "signer set: a fourth signer", target: BOARD, data: enc("setSigner", ["0x0000000000000000000000000000000000005454", true]), salt: b32("op-signer") },
  { what: "routes: BTC route with a 150 s max age", target: ROUTER, data: enc("queueRoute", [b32("BTC"), { primary: m7.QuorumMarkSource!, secondary: "0x0000000000000000000000000000000000000000", maxAge: 150, maxDevBps: 0 }]), salt: b32("op-route") },
  { what: "treasury address", target: POOL, data: enc("setTreasury", [TREASURY]), salt: b32("op-treasury") },
];
{
  // refused on every path but the timelock: the Safe directly, an owner alone, the guardian, the deployer
  let refusals = 0;
  let tried = 0;
  for (const op of timelockOps) {
    const viaSafe = await safeTx(SAFE, OWNERS.slice(0, 3), op.target, op.data);
    const viaGuardian = await safeTx(GUARD, GUARDIANS.slice(0, 2), op.target, op.data);
    tried += 2;
    if (!viaSafe.ok) refusals++;
    if (!viaGuardian.ok) refusals++;
    for (const who of [OWNERS[0]!, DEPLOYER]) {
      tried++;
      try {
        await client.estimateGas({ account: who, to: op.target, data: op.data });
      } catch {
        refusals++;
      }
    }
  }
  govResults.push({ what: "every listed admin call refused from the Safe directly, the guardian, an owner alone and the deployer", ok: refusals === tried, detail: `${refusals}/${tried} refused` });
  // scheduled by the Safe; refused before the delay; executed by anyone after it
  for (const op of timelockOps) {
    const r = await safeTx(SAFE, OWNERS.slice(0, 3), TL, enc("schedule", [op.target, 0n, op.data, ZERO32, op.salt, 3600n]));
    noteGas("Safe schedule (3-of-5)", r);
    if (!r.ok) govResults.push({ what: `schedule ${op.what}`, ok: false, detail: r.reason });
  }
  // one more, cancelled by the Safe
  const cancelData = enc("setCaps", [b32("ETH"), 1n, 1n]);
  await safeTx(SAFE, OWNERS.slice(0, 3), TL, enc("schedule", [POOL, 0n, cancelData, ZERO32, b32("op-cancel"), 3600n]));
  const cancelId = await read<Hex>(TL, "hashOperation", [POOL, 0n, cancelData, ZERO32, b32("op-cancel")]);
  const c = await safeTx(SAFE, OWNERS.slice(0, 3), TL, enc("cancel", [cancelId]));
  govResults.push({ what: "a queued call cancelled by the Safe is gone", ok: c.ok && !(await read<boolean>(TL, "isOperation", [cancelId])), detail: c.ok ? "cancelled" : c.reason });
  const early = await tx(TRADERS[0]!, TL, "execute", [timelockOps[0]!.target, 0n, timelockOps[0]!.data, ZERO32, timelockOps[0]!.salt]);
  govResults.push({ what: "nothing executes before the delay", ok: !early.ok, detail: early.ok ? "executed early" : early.reason });
}

// ---------------------------------------------------------------- C. guardian pauses (during the delay), E1, Safe unpauses

const guardianResults: { what: string; ok: boolean; detail: string }[] = [];
let preId = 0n;
{
  // a position to sell while paused, and a withdrawal to settle while deposits are paused
  const legs = spreadAt("BTC", (await routerMark("BTC"))!);
  const r = await must(TRADERS[0]!, OBK, "buy", [b32("BTC"), legArgs(legs), tempoArg(DAY), wadStr(1), 10n ** 13n, (await chainNow()) + 3600n, [], [], []]);
  preId = decoded(r).find((e) => e.eventName === "Routed")!.args.id as bigint;
  for (const [what, to, data] of [["pause buys", ENGINE, enc("pauseBuys")], ["pause ETH", POOL, enc("pauseMarket", [b32("ETH")])], ["pause deposits", POOL, enc("pauseDeposits")]] as const) {
    const g = await safeTx(GUARD, GUARDIANS.slice(0, 2), to, data);
    noteGas("guardian pause (2-of-3)", g);
    guardianResults.push({ what: `guardian: ${what}`, ok: g.ok, detail: g.ok ? "done" : g.reason });
  }
  const buy = await tx(TRADERS[1]!, OBK, "buy", [b32("BTC"), legArgs(legs), tempoArg(DAY), wadStr(1), 10n ** 13n, (await chainNow()) + 3600n, [], [], []]);
  guardianResults.push({ what: "opens refused while paused", ok: !buy.ok && buy.reason === "BuysArePaused", detail: buy.ok ? "filled" : buy.reason });
  const dep = await tx(TRADERS[1]!, POOL, "deposit", [1_000n * USDC]);
  guardianResults.push({ what: "new deposits refused while paused", ok: !dep.ok && dep.reason === "DepositsArePaused", detail: dep.ok ? "accepted" : dep.reason });
  const sell = await tx(TRADERS[0]!, ENGINE, "sell", [preId, MAX, 0n, (await chainNow()) + 3600n]);
  guardianResults.push({ what: "sells work while paused", ok: sell.ok, detail: sell.ok ? "paid" : sell.reason });
  const wr = await tx(LP, POOL, "requestWithdraw", [1_000n * WAD]);
  guardianResults.push({ what: "withdrawal requests work while paused", ok: wr.ok, detail: wr.ok ? "queued" : wr.reason });
  // the guardian cannot unpause or set anything; E1 pauses a market and nothing else
  const gu = await safeTx(GUARD, GUARDIANS.slice(0, 2), ENGINE, enc("unpauseBuys"));
  const gs = await safeTx(GUARD, GUARDIANS.slice(0, 2), POOL, enc("setCaps", [b32("BTC"), 1n, 1n]));
  guardianResults.push({ what: "the guardian cannot unpause or change a setting", ok: !gu.ok && !gs.ok, detail: `${gu.ok ? "unpaused" : gu.reason}; ${gs.ok ? "set" : gs.reason}` });
  const e1a = await tx(E1, POOL, "pauseMarket", [b32("HYPE")]);
  const e1b = await tx(E1, POOL, "pauseDeposits");
  const e1c = await tx(E1, POOL, "unpauseMarket", [b32("HYPE")]);
  guardianResults.push({ what: "E1 pauses a market only (not deposits, never unpauses)", ok: e1a.ok && !e1b.ok && !e1c.ok, detail: `${e1a.ok}/${e1b.ok}/${e1c.ok}` });
}

// ---------------------------------------------------------------- D. the delay passes: executions, settlements, the Safe unpauses

await warp(3600 + 30, "the timelock delay");
for (const op of timelockOps) {
  const r = await tx(TRADERS[1]!, TL, "execute", [op.target, 0n, op.data, ZERO32, op.salt]);
  noteGas("timelock execute (anyone)", r);
  govResults.push({ what: `executed after the delay by anyone: ${op.what}`, ok: r.ok, detail: r.ok ? "done" : r.reason });
}
const wround = await nextSettlement("the hour's settlement (deposits paused)");
{
  const w = await tx(LP, POOL, "withdraw", [wround]);
  guardianResults.push({ what: "a withdrawal settles and pays while deposits are paused", ok: w.ok, detail: w.ok ? "paid" : w.reason });
  for (const [to, data] of [[ENGINE, enc("unpauseBuys")], [POOL, enc("unpauseMarket", [b32("ETH")])], [POOL, enc("unpauseMarket", [b32("HYPE")])], [POOL, enc("unpauseDeposits")]] as const) {
    const s = await safeTx(SAFE, OWNERS.slice(0, 3), to, data);
    noteGas("Safe unpause (3-of-5, no delay)", s);
    if (!s.ok) guardianResults.push({ what: "Safe unpause", ok: false, detail: s.reason });
  }
  const cleared = !(await read<boolean>(ENGINE, "buysPaused")) && !(await read<boolean>(POOL, "marketPaused", [b32("ETH")])) && !(await read<boolean>(POOL, "depositsPaused"));
  guardianResults.push({ what: "the Safe unpauses directly, with no delay", ok: cleared, detail: cleared ? "all clear" : "still paused" });
}
await warp(3600 + 30, "the router's own delay for the new BTC route");
{
  const ap = await tx(TRADERS[1]!, ROUTER, "applyRoute", [b32("BTC")]);
  const route = await read<{ maxAge: number }>(ROUTER, "route", [b32("BTC")]);
  govResults.push({ what: "the queued route also waited out the router's own delay, then applied", ok: ap.ok && route.maxAge === 150, detail: `maxAge ${route.maxAge}` });
  const caps = await read<bigint>(POOL, "notionalCap", [b32("BTC")]);
  const signerOn = await read<boolean>(BOARD, "isSigner", ["0x0000000000000000000000000000000000005454"]);
  govResults.push({ what: "the executed settings are live", ok: caps === 4_500_000n * USDC && signerOn && (await read<Address>(POOL, "treasury")) === TREASURY, detail: `cap ${usd(caps)}, fourth signer ${signerOn}` });
}
crit[2] = { ok: govResults.every((g) => g.ok), detail: govResults.map((g) => `${g.ok ? "" : "FAILED "}${g.what} [${g.detail}]`).join("; ") };
crit[3] = { ok: guardianResults.every((g) => g.ok), detail: guardianResults.map((g) => `${g.ok ? "" : "FAILED "}${g.what} [${g.detail}]`).join("; ") };
await marksFresh();

// ---------------------------------------------------------------- E. treasury

{
  const t: { what: string; ok: boolean; detail: string }[] = [];
  const ready = await waitFor("EQUITY ready (two fresh finals)", async () => read<boolean>(POOL, "equityReady"), 240_000);
  if (!ready) {
    await warp(3600, "EQUITY cadence");
    await waitFor("EQUITY ready", async () => read<boolean>(POOL, "equityReady"), 240_000);
  }
  const nav = await read<bigint>(POOL, "navNow");
  const cap = (nav * BigInt(await read<number>(POOL, "treasuryDailyCapBps"))) / 10_000n;
  const small = 50_000n * USDC;
  const before = await read<bigint>(MUSDC, "balanceOf", [TREASURY]);
  const s1 = await safeTx(SAFE, OWNERS.slice(0, 3), POOL, enc("sendToTreasury", [small]));
  noteGas("Safe treasury move", s1);
  t.push({ what: "the Safe moves funds directly within the daily cap", ok: s1.ok && (await read<bigint>(MUSDC, "balanceOf", [TREASURY])) - before === small, detail: s1.ok ? `${usd(small)} sent` : s1.reason });
  const s2 = await safeTx(SAFE, OWNERS.slice(0, 3), POOL, enc("sendToTreasury", [cap]));
  t.push({ what: "a move over the day's cap is refused", ok: !s2.ok, detail: s2.ok ? "sent" : s2.reason });
  const s3 = await tx(TRADERS[0]!, POOL, "sendToTreasury", [1n]);
  const s4 = await tx(OWNERS[0]!, POOL, "sendToTreasury", [1n]);
  t.push({ what: "no one else moves treasury funds (a trader, a Safe owner alone)", ok: !s3.ok && !s4.ok, detail: `${s3.ok ? "sent" : s3.reason}; ${s4.ok ? "sent" : s4.reason}` });
  crit[4] = { ok: t.every((x) => x.ok), detail: t.map((x) => `${x.ok ? "" : "FAILED "}${x.what} [${x.detail}]`).join("; ") + "; the address was set through the timelock (criterion 2)" };
}

// ---------------------------------------------------------------- F. agents through MCP, budgets, law 1 and law 3 for owners

type Fill = { owner: Address; mandate: Hex; id: bigint; cost: bigint; kind: number; d: number; v: number; block: bigint };
const fills: Fill[] = [];
const ownerNet = new Map<Address, bigint>();
const refusals: { what: string; ok: boolean; detail: string }[] = [];
const budgetSeen: { h: Hex; d: bigint; v: bigint; dB: bigint; vB: bigint }[] = [];
const mcpTools: string[] = [];
let budgetMismatch: string[] = [];
{
  const init = (await mcpRpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "local-m7-run", version: "1" } })).result as Record<string, unknown>;
  mcpTools.push(...(((await mcpRpc("tools/list")).result as { tools: { name: string }[] }).tools.map((t) => t.name)));
  say(`MCP: ${String((init.serverInfo as Record<string, unknown>).name)} with ${mcpTools.length} tools`);
  await tool("chains_by_tempo", { market: "BTC", strikes: 2 });
  await tool("vol_feed", { market: "BTC" });
  const now = Number(await chainNow());
  const mandateFor = async (owner: Address, o: Record<string, unknown>) => {
    const built = await tool("build_mandate", { owner, agent: AGENT, markets: ["BTC"], families: ["callSpread", "putSpread"], maxPremiumPerTrade: "15000", maxPremiumTotal: "40000", deltaBudgetUsd: "250000", vegaBudgetUsd: "1000", expiry: now + DAY, nonce: 1, ...o });
    const msg = built.message as Record<string, unknown>;
    const big = (k: string) => BigInt(String(msg[k]));
    const typed = { ...(built.typedData as object), message: { ...msg, shapes: big("shapes"), maxPremiumPerTrade: big("maxPremiumPerTrade"), maxPremiumTotal: big("maxPremiumTotal"), deltaBudgetUsd: big("deltaBudgetUsd"), vegaBudgetUsd: big("vegaBudgetUsd"), expiry: big("expiry"), nonce: big("nonce") } };
    const signature = await createWalletClient({ chain: foundry, transport: http(RPC), account: owner }).signTypedData(typed as never);
    const hash = (await tool("mandates", { mandate: msg })).hash as Hex;
    return { msg, signature, hash, dB: big("deltaBudgetUsd"), vB: big("vegaBudgetUsd") };
  };
  const mA = await mandateFor(OA, {});
  const mB = await mandateFor(OB_, { deltaBudgetUsd: "unlimited", vegaBudgetUsd: "unlimited", maxPremiumTotal: "12000" });
  const tsGreeks = async (legs: Leg[], units: number, block: bigint) => {
    const s = Number(formatUnits(await read<bigint>(ROUTER, "markWad", [b32("BTC")], block), 18));
    const sig = Number(await read<bigint>(BOARD, "volBps", [b32("BTC")], block));
    const parts = [{ tempo: DAY, weight: 1 }];
    const d = legs.reduce((a, l) => a + l.qty * blendDelta(l.isCall, s, l.k, sig, parts), 0);
    const V = (x: number) => legs.reduce((a, l) => a + l.qty * blendValue(l.isCall, s, l.k, x, parts), 0);
    const v = ((V(sig + 1) - V(sig - 1)) / 2) * 100;
    return { d: Math.abs(d) * s * units, v: Math.abs(v) * units };
  };
  const agentBuy = async (m: Awaited<ReturnType<typeof mandateFor>>, legs: Leg[], units: number, maxCost: string, market = "BTC") => {
    const b = await tool("build_buy", { market, legs: legs.map((l) => ({ isCall: l.isCall, strike: l.k, qty: l.qty })), tempo: DAY, units: String(units), maxCost, mandate: m.msg, signature: m.signature });
    const r = await sendBuilt(AGENT, b);
    noteGas("agent buy (AgentRouter)", r);
    if (r.ok) {
      const ev = decoded(r.receipt).find((e) => e.eventName === "AgentBought")!;
      const g = await tsGreeks(legs, units, r.receipt.blockNumber - 1n);
      legsById.set(String(ev.args.id), legs);
      fills.push({ owner: ev.args.owner as Address, mandate: m.hash, id: ev.args.id as bigint, cost: ev.args.cost as bigint, kind: Number(ev.args.kind), d: g.d, v: g.v, block: r.receipt.blockNumber });
    }
    budgetSeen.push({ h: m.hash, d: await read<bigint>(AR, "deltaUsed", [m.hash]), v: await read<bigint>(AR, "vegaUsed", [m.hash]), dB: m.dB, vB: m.vB });
    return r;
  };
  const mark = (await routerMark("BTC"))!;
  const legs = spreadAt("BTC", mark);
  // fills within the mandates (maker quotes from the gateway where cheaper)
  for (const u of [1, 1.5]) await agentBuy(mA, legs, u, "15000");
  await agentBuy(mB, legs, 2, "15000");
  // the on-chain budgets against an independent recompute (TypeScript Greeks at each fill's parent block)
  for (const m of [mA]) {
    const want = fills.filter((f) => f.mandate === m.hash).reduce((a, f) => a + f.d, 0);
    const got = usd(await read<bigint>(AR, "deltaUsed", [m.hash]));
    const wantV = fills.filter((f) => f.mandate === m.hash).reduce((a, f) => a + f.v, 0);
    const gotV = usd(await read<bigint>(AR, "vegaUsed", [m.hash]));
    if (Math.abs(got - want) > want * 0.005 || Math.abs(gotV - wantV) > wantV * 0.01) budgetMismatch.push(`delta ${got} vs ${want.toFixed(2)}, vega ${gotV} vs ${wantV.toFixed(2)}`);
    report.push(`mandate A budgets: delta in use ${got} vs recomputed ${want.toFixed(2)}; vega ${gotV} vs ${wantV.toFixed(2)}`);
  }
  // a refusal at every boundary
  const expectRefused = async (what: string, want: string, run: () => Promise<TxResult>) => {
    const r = await run();
    const reasons = want.split("|");
    refusals.push({ what, ok: !r.ok && reasons.some((w) => r.reason.includes(w)), detail: r.ok ? "accepted" : r.reason });
  };
  await expectRefused("delta budget", "OverDeltaBudget", () => agentBuy(mA, legs, 10, "15000")); // about 0.34 × $74k per unit: 10 more units cross $250k
  const mV = await mandateFor(OA, { nonce: 2, vegaBudgetUsd: "1" });
  await expectRefused("vega budget", "OverVegaBudget", () => agentBuy(mV, legs, 1, "15000"));
  await expectRefused("per-trade cap", "CostAboveMax", () => agentBuy(mB, legs, 30, "100000"));
  // the total cap binds as the next buy's maxCost (what is left), or as OverTotalCap once it is all spent
  await expectRefused("total premium cap", "CostAboveMax|OverTotalCap", async () => {
    let last: TxResult = { ok: true } as TxResult;
    for (let i = 0; i < 16 && last.ok; i++) last = await agentBuy(mB, legs, 2, "15000");
    return last;
  });
  const ethMark = (await routerMark("ETH"))!;
  await expectRefused("market not in the mandate", "MarketNotAllowed", () => agentBuy(mA, spreadAt("ETH", ethMark), 1, "15000", "ETH"));
  await expectRefused("family not in the mandate", "ShapeNotAllowed", () => agentBuy(mA, [{ isCall: true, k: kAt("BTC", mark), qty: 1 }], 0.5, "15000"));
  const mC = await mandateFor(OA, { nonce: 3, closeOnly: true });
  await expectRefused("close-only", "CloseOnly", () => agentBuy(mC, legs, 1, "15000"));
  const mE = await mandateFor(OA, { nonce: 4, expiry: Number(await chainNow()) + 120 });
  await warp(300, "a short mandate expires");
  await marksFresh();
  await expectRefused("expired", "MandateExpired", () => agentBuy(mE, legs, 1, "15000"));
  await must(OA, AR, "revoke", [1n]);
  await expectRefused("revoked", "MandateRevoked", () => agentBuy(mA, legs, 1, "15000"));
  for (const rf of refusals) say(`agent refusal: ${rf.what}: ${rf.ok ? "ok" : "FAIL"} (${rf.detail})`);
  // positions through MCP; owners exit: A after revocation, B while buys are paused (law 3)
  const posA = (await tool("positions", { owner: OA })).positions as { id: string }[];
  const posB = (await tool("positions", { owner: OB_ })).positions as { id: string }[];
  report.push(`MCP positions: owner A ${posA.length} series, owner B ${posB.length} series`);
  await safeTx(GUARD, GUARDIANS.slice(0, 2), ENGINE, enc("pauseBuys"));
  for (const [o, ps] of [[OA, posA], [OB_, posB]] as const) {
    for (const p of ps) {
      const s = await tool("build_sell", { id: p.id, via: "owner" });
      const r = await sendBuilt(o, s);
      noteGas("owner sell (AgentRouter)", r);
      refusals.push({ what: `owner ${o === OA ? "A (revoked)" : "B (buys paused)"} sells`, ok: r.ok, detail: r.ok ? "paid" : r.reason });
      if (r.ok) for (const e of decoded(r.receipt)) if (e.eventName === "PositionSold") ownerNet.set(o, (ownerNet.get(o) ?? 0n) + (e.args.net as bigint));
    }
  }
  await safeTx(SAFE, OWNERS.slice(0, 3), ENGINE, enc("unpauseBuys"));
  for (const m of [mA, mB]) if ((await read<bigint>(AR, "deltaUsed", [m.hash])) !== 0n || (await read<bigint>(AR, "vegaUsed", [m.hash])) !== 0n) budgetMismatch.push("budget not released to 0 after every sale");
}
const law1Owners: string[] = [];
for (const o of [OA, OB_]) {
  const paid = fills.filter((f) => f.owner === o).reduce((a, f) => a + f.cost, 0n);
  const bal = await read<bigint>(MUSDC, "balanceOf", [o]);
  const want = START_USDC.get(o)! - paid + (ownerNet.get(o) ?? 0n);
  if (bal !== want || bal + paid < START_USDC.get(o)!) law1Owners.push(`${o.slice(0, 6)}: ${usd(bal)} vs ${usd(want)}`);
  report.push(`owner ${o.slice(0, 6)}: paid ${usd(paid).toFixed(2)}, got ${usd(ownerNet.get(o) ?? 0n).toFixed(2)}`);
}
const routerHolds = await read<bigint>(MUSDC, "balanceOf", [AR]);
crit[6] = { ok: refusals.every((r) => r.ok) && law1Owners.length === 0 && fills.length >= 3 && routerHolds === 0n, detail: `${fills.length} agent fills (${fills.filter((f) => f.kind === KIND_QUOTE).length} from makers); refusals: ${refusals.map((r) => `${r.ok ? "" : "FAILED "}${r.what} [${r.detail}]`).join("; ")}; law 1 for owners (${law1Owners.length} mismatches); the router keeps ${usd(routerHolds)} USDC` };
const exceeded = budgetSeen.filter((b) => b.d > b.dB || b.v > b.vB);
crit[7] = { ok: budgetMismatch.length === 0 && exceeded.length === 0, detail: `delta and vega in use = an independent recompute from each fill (TypeScript Greeks at its parent block); released to 0 after every sale; never exceeded across ${budgetSeen.length} checks (${budgetMismatch.length + exceeded.length} issues${budgetMismatch.length ? ": " + budgetMismatch.join(" | ") : ""})` };

// ---------------------------------------------------------------- G. trader activity for the laws 1–5 checks (routing, buybacks, collateral)

type RouteCheck = { ok: boolean; cost: bigint; expected: bigint };
const routeChecks: RouteCheck[] = [];
const tradersPaid = new Map<Address, bigint>();
const tradersGot = new Map<Address, bigint>();
const held: { who: Address; id: bigint }[] = [];
let shortfall = 0;
{
  for (let i = 0; i < 6; i++) {
    const who = TRADERS[i % 2]!;
    const mark = (await routerMark("BTC"))!;
    const legs = spreadAt("BTC", mark);
    const units = wadStr(1 + (i % 3));
    const best = (await (await fetch(new URL("/best", GATEWAY), { method: "POST", body: JSON.stringify({ name: b32("BTC"), legs: legArgs(legs), movement: tempoArg(DAY), units }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) })).json()) as { quotes?: { quote: Record<string, string>; sig: Hex }[] };
    const quotes = (best.quotes ?? []).map((x) => ({ maker: getAddress(x.quote.maker!), name: x.quote.name as Hex, sides: Number(x.quote.sides), kLoWad: BigInt(x.quote.kLoWad!), kHiWad: BigInt(x.quote.kHiWad!), tauLo: Number(x.quote.tauLo), tauHi: Number(x.quote.tauHi), sigmaBps: BigInt(x.quote.sigmaBps!), maxUnits: BigInt(x.quote.maxUnits!), validUntil: BigInt(x.quote.validUntil!), nonce: BigInt(x.quote.nonce!) }));
    const sigs = (best.quotes ?? []).map((x) => x.sig);
    const deadline = (await chainNow()) + 3600n;
    const args = [b32("BTC"), legArgs(legs), tempoArg(DAY), units, 10n ** 13n, deadline, quotes, sigs, []] as const;
    const r = await tx(who, OBK, "buy", args);
    noteGas("routed buy (OpenBook)", r);
    if (!r.ok) continue;
    const routed = decoded(r.receipt).find((e) => e.eventName === "Routed")!;
    const cost = routed.args.cost as bigint;
    tradersPaid.set(who, (tradersPaid.get(who) ?? 0n) + cost);
    held.push({ who, id: routed.args.id as bigint });
    legsById.set(String(routed.args.id), legs);
    // independent re-pricing, candidate by candidate, at the parent block
    let bestCost = MAX;
    const sim1 = async (qs: unknown[], ss: Hex[]) => {
      try {
        const { result } = await client.simulateContract({ address: OBK, abi, functionName: "buy", args: [args[0], args[1], args[2], args[3], args[4], args[5], qs, ss, []], account: who, blockNumber: r.receipt.blockNumber - 1n } as never);
        return result as readonly [bigint, bigint, number];
      } catch {
        return null;
      }
    };
    const p = await sim1([], []);
    if (p && p[2] === KIND_POOL) bestCost = p[1];
    for (let q = 0; q < quotes.length; q++) {
      const s = await sim1([quotes[q]], [sigs[q]!]);
      if (s && s[2] === KIND_QUOTE && s[1] < bestCost) bestCost = s[1];
    }
    routeChecks.push({ ok: bestCost === cost, cost, expected: bestCost });
  }
}
// law 4 on every matched entry, the pool mirror, then every trader sells (buybacks)
const law4: string[] = [];
const mirror: string[] = [];
async function checkMatched(label: string) {
  for (const id of await read<readonly bigint[]>(POOL, "openSeries", [b32("BTC")])) {
    const keys = await read<readonly Hex[]>(MB, "seriesSources", [id]);
    let sum = 0n;
    for (const k of keys) {
      const e = await read<readonly [bigint, bigint, bigint, bigint, bigint, boolean]>(MB, "entries", [k, id]);
      if (e[0] === 0n) continue;
      sum += e[0];
      const [req] = await read<readonly [bigint, bigint]>(MB, "required", [k, id]);
      if (e[3] < req) law4.push(`${label}: locked ${e[3]} < required ${req}`);
      const legs = legsById.get(String(id));
      if (!legs) continue;
      const w = writerWorstPerUnit(legArgs(legs));
      const norm = await walkedNorm(id);
      const unitsNow = (e[0] * norm + WAD - 1n) / WAD;
      const need = w === null ? MAX : ((w * unitsNow) / WAD + 10n ** 12n - 1n) / 10n ** 12n;
      if (e[3] + 1n < need) law4.push(`${label}: locked ${e[3]} < the exact worst case ${need}`);
    }
    const [mbRaw, poolM, unc] = await Promise.all([read<bigint>(MB, "matchedRaw", [id]), read<bigint>(POOL, "matchedRawOf", [id]), read<bigint>(MB, "uncoveredRaw", [id])]);
    if (mbRaw !== sum || poolM !== mbRaw || unc !== 0n) mirror.push(`${label}: series ${String(id).slice(0, 8)} MB ${mbRaw} Σ ${sum} pool ${poolM} uncovered ${unc}`);
  }
}
await checkMatched("after routing");
let sellsOk = 0;
for (const h of held) {
  const r = await tx(h.who, ENGINE, "sell", [h.id, MAX, 0n, (await chainNow()) + 3600n]);
  noteGas("sell with buyback", r);
  if (!r.ok) {
    if (r.reason !== "NothingToSell") mirror.push(`sell failed: ${r.reason}`);
    continue;
  }
  sellsOk++;
  for (const e of decoded(r.receipt)) {
    if (e.eventName === "Sold") tradersGot.set(h.who, (tradersGot.get(h.who) ?? 0n) + (e.args.net as bigint));
    if (e.eventName === "BoughtBack" && (e.args.shortfall as bigint) > 1n) shortfall++;
  }
}
await checkMatched("after the exits");

// ---------------------------------------------------------------- H. receipts

await warp(2 * 3600, "two hours: every phase's hour is over");
await waitFor("the receipts service to post through the last finished hour", async () => {
  const now = Number(await chainNow());
  const last = lines("receipts").filter((l) => l.msg === "posted").map((l) => Number(l.epoch));
  return last.length > 0 && Math.max(...last) >= Math.floor(now / 3600) - 2;
}, 300_000);
const receiptResults: string[] = [];
let receiptsOk = true;
{
  const d = loadM7Deployment(m7File);
  const col = new Collector(client, d, BigInt(m7.deployBlock));
  await col.scan();
  const posted = (await client.getLogs({ address: RR, event: events[7]!, fromBlock: 0n } as never)) as unknown as { args: { epoch: bigint; root: Hex; count: bigint } }[];
  const seenEpochs = new Set<string>();
  const kinds = new Set<number>();
  for (const p of posted) {
    const e = Number(p.args.epoch);
    if (seenEpochs.has(String(e))) receiptsOk = false;
    seenEpochs.add(String(e));
    const list = col.byEpoch.get(e) ?? [];
    for (const x of list) kinds.add(x.kind);
    const root = buildTree(list.map((x) => leafOf(x.encoded))).root;
    if (root !== p.args.root || BigInt(list.length) !== p.args.count) {
      receiptsOk = false;
      receiptResults.push(`epoch ${e}: on-chain root differs from the rebuild`);
    }
  }
  // finished hours with receipts but no root (before the last posted hour)
  const lastPosted = Math.max(...posted.map((p) => Number(p.args.epoch)));
  const missing = [...col.byEpoch.keys()].filter((e) => e < lastPosted && col.byEpoch.get(e)!.length > 0 && !seenEpochs.has(String(e)));
  // one receipt of each kind verified on-chain
  let verified = 0;
  for (const k of [1, 2, 3]) {
    for (const p of posted) {
      const e = Number(p.args.epoch);
      const x = (col.byEpoch.get(e) ?? []).find((r) => r.kind === k);
      if (!x) continue;
      const tree = buildTree(col.byEpoch.get(e)!.map((r) => leafOf(r.encoded)));
      const leaf = leafOf(x.encoded);
      if (await read<boolean>(RR, "verify", [BigInt(e), leaf, proofOf(tree, leaf)])) verified++;
      break;
    }
  }
  receiptResults.push(`${posted.length} roots posted, ${missing.length} finished hours with receipts missing, kinds ${[...kinds].sort().join(",")}, ${verified}/3 kinds verified on-chain`);
  receiptsOk = receiptsOk && missing.length === 0 && kinds.size === 3 && verified === 3 && posted.length > 0;
  (gas["receipts post"] ??= []).push(...lines("receipts").filter((l) => l.msg === "posted").map((l) => BigInt(String(l.gasUsed))));
}
crit[5] = { ok: receiptsOk, detail: `every finished hour with receipts has a root equal to an independent rebuild; trades, vol finals and NAV snapshots; one of each kind verified through ReceiptRoots.verify; nothing replaced (${receiptResults.join("; ")})` };

// ---------------------------------------------------------------- I. MCP, monitor, laws, errors

const endTime = Date.now();
walking = false;
await pricer;
clearInterval(ticker);
// read the books before stopping
const holders = [POOL, VAULT, MB, ENGINE, OBK, RA, AR, BOOK, TL, SAFE, GUARD, ...acc];
let onchain = 0n;
for (const h of holders) onchain += await read<bigint>(MUSDC, "balanceOf", [h]);
const supply = await read<bigint>(MUSDC, "totalSupply");
const zeroHolders = await Promise.all([ENGINE, OBK, RA, AR].map((h) => read<bigint>(MUSDC, "balanceOf", [h])));
let vaultBooks = 0n;
for (const mk of [MK1, MK2]) vaultBooks += (await read<bigint>(VAULT, "freeOf", [mk, MUSDC])) + (await read<bigint>(VAULT, "lockedOf", [mk, MUSDC]));
const vaultBal = await read<bigint>(MUSDC, "balanceOf", [VAULT]);
const mbOk = (await read<bigint>(MB, "heldUsdc")) === (await read<bigint>(MUSDC, "balanceOf", [MB]));
const law1Traders: string[] = [];
for (const t of TRADERS) {
  const bal = await read<bigint>(MUSDC, "balanceOf", [t]);
  // the pre-pause buy and its sale were by trader 0; count them from the chain's Routed / Sold events
  const routed = await client.getLogs({ address: OBK, event: events[0]!, args: { buyer: t }, fromBlock: 0n } as never) as unknown as { args: { cost: bigint } }[];
  const sold = await client.getLogs({ address: ENGINE, event: events[1]!, args: { seller: t }, fromBlock: 0n } as never) as unknown as { args: { net: bigint } }[];
  const want = START_USDC.get(t)! - routed.reduce((a, r) => a + r.args.cost, 0n) + sold.reduce((a, s) => a + s.args.net, 0n);
  if (bal !== want) law1Traders.push(`${t.slice(0, 6)}: ${usd(bal)} vs ${usd(want)}`);
}
for (const p of procs) p.kill("SIGTERM");
await Promise.all(procs.map((p) => p.exited));
sim.stop();

const expectedTools = ["chains_by_tempo", "vol_feed", "shapes", "quotes", "positions", "mandates", "build_mandate", "build_buy", "build_sell"];
const unusedTools = expectedTools.filter((t) => !mcpUsed.has(t) && t !== "shapes" && t !== "quotes");
crit[8] = { ok: mcpTools.join() === expectedTools.join() && unusedTools.length === 0 && fills.length > 0, detail: `${mcpTools.length} tools listed; used: ${[...mcpUsed].map(([k, v]) => `${k} ${v.ok}`).join(", ")}; every built transaction sent by its signer (agent buys, owner sells) and the mandates the owners signed matched the contract's hash` };

const alarms = lines("risk-monitor").filter((l) => l.msg === "alarm");
const count = (n: string) => alarms.filter((l) => l.name === n).length;
const queuedNamed = alarms.filter((l) => l.name === "TIMELOCK_QUEUED").map((l) => String((l.values as Record<string, unknown>).call));
const pausedBy = alarms.filter((l) => l.name === "PAUSED").map((l) => String((l.values as Record<string, unknown>).by));
const unexpected = alarms.filter((l) => ["ROLE_CHANGED", "MONITOR_ERROR", "BUYBACK_FAILED", "MATCHED_UNCOVERED", "RECEIPTS_STALE"].includes(String(l.name)));
report.push(`risk-monitor: ${[...new Set(alarms.map((l) => String(l.name)))].map((n) => `${n} ${count(n)}`).join(", ")}`);
crit[9] = {
  ok: count("TIMELOCK_QUEUED") >= 6 && count("TIMELOCK_EXECUTED") >= 5 && count("TIMELOCK_CANCELLED") >= 1 && pausedBy.includes("the guardian") && pausedBy.includes("the automated risk key (E1)") && count("UNPAUSED") >= 4 && unexpected.length === 0,
  detail: `queued calls named (${queuedNamed.slice(0, 3).join("; ")}…), executed and cancelled announced; pauses by ${[...new Set(pausedBy)].join(", ")}; unpauses ${count("UNPAUSED")}; unexpected ${unexpected.map((l) => l.name).join(", ") || "none"}`,
};

const badRoutes = routeChecks.filter((r) => !r.ok);
crit[10] = {
  ok: badRoutes.length === 0 && routeChecks.length > 0 && law4.length === 0 && mirror.length === 0 && shortfall === 0 && onchain === supply && zeroHolders.every((z) => z === 0n) && vaultBooks === vaultBal && mbOk && law1Traders.length === 0,
  detail: `routing: ${routeChecks.length - badRoutes.length}/${routeChecks.length} cheapest when re-priced per candidate at the parent block; law 4: ${law4.length} violations; pool mirror and nothing uncovered (${mirror.length}); ${sellsOk} sells paid, buyback shortfall beyond dust ${shortfall}; USDC ${usd(onchain)} of supply ${usd(supply)}; Engine, OpenBook, RiskAuction and AgentRouter hold ${zeroHolders.map(usd).join("/")}; vault and MatchBook books = balances (${vaultBooks === vaultBal && mbOk}); law 1 for traders (${law1Traders.length} mismatches)`,
};

let errorLines = 0;
const samples: string[] = [];
for (const f of ["signer-1", "signer-2", "signer-3", "poker-primary", "poker-backup", "hedger", "risk-monitor", "maker-gateway", "maker-1", "maker-2", "receipts"]) {
  for (const l of lines(f)) {
    if (l.level === "error") {
      errorLines++;
      if (samples.length < 6) samples.push(`${f}: ${JSON.stringify(l).slice(0, 200)}`);
    }
  }
}
const median = (xs: bigint[]) => (xs.length ? [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[Math.floor(xs.length / 2)]! : 0n);
const gasLine = Object.entries(gas).map(([k, v]) => `${k} ${median(v)}`).join(", ");
crit[11] = { ok: errorLines === 0 && Object.keys(gas).length >= 8, detail: `service error lines ${errorLines}${samples.length ? " (" + samples.join(" | ") + ")" : ""}; gas medians: ${gasLine}` };

const names: Record<number, string> = {
  1: "law 6 at runtime (role sweep from the chain's events)",
  2: "timelock flow (caps, fees, signer set, route, treasury address; cancel; delay; router delay)",
  3: "guardian, E1 and the Safe's unpause",
  4: "treasury",
  5: "receipts",
  6: "agents: mandates, refusals, owners' exits, law 1 for owners",
  7: "delta and vega budgets",
  8: "MCP",
  9: "risk-monitor",
  10: "laws 1–5 (routing, law 4, buybacks, conservation)",
  11: "service error lines and gas",
};
const crits = Object.keys(names).map((n) => {
  const c = crit[Number(n)] ?? { ok: false, detail: "not reached" };
  return `${c.ok ? "PASS" : "FAIL"}  ${n}. ${names[Number(n)]}: ${c.detail}`;
});
const text = [`run ${((endTime - T0) / 60_000).toFixed(1)} min; logs in ${out}`, ...report, `gas medians: ${gasLine}`, "", "== criteria", ...crits].join("\n") + "\n";
writeFileSync(join(out, "report.txt"), text);
console.log("\n" + text);
anvil.kill();
say("done");
