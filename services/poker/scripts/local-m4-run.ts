import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicClient, createWalletClient, decodeErrorResult, decodeEventLog, formatUnits, http, parseEther, stringToHex, type Address, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { revertName } from "@tourbillon/common/tx.ts";
import { SimVenue } from "../../hedger/src/simvenue.ts";
import { blendDelta } from "../../hedger/src/tempo.ts";

/// M4 step 10: the whole M4 system on anvil for about 20 minutes: shapes bought and sold, shapes written against
/// exact collateral (USDC and WHYPE), claims, partial and full unwrites, a shock with writers, pauses, a wind-down.
/// Every service runs as a real process. Prices come from the simulated venue's path (signers read them there; vol
/// fixed at 50%); the chain clock moves forward an hour at set points for epochs and decay. No venue outage (M3
/// step 11 covered it). No key: anvil's unlocked accounts. Raw logs and the report go to a temp folder outside the repo.
///
///   bun scripts/local-m4-run.ts [--scale 1]   (--scale 0.2 shortens the waits)

const scale = Number(process.argv[process.argv.indexOf("--scale") + 1] ?? 1) || 1;
const SERVICES = resolve(import.meta.dir, "../..");
const CONTRACTS = resolve(SERVICES, "../contracts");
const PORT = 31545;
const RPC = `http://127.0.0.1:${PORT}`;
const MARKETS = ["BTC", "ETH", "HYPE"];
const STEP: Record<string, number> = { BTC: 100, ETH: 5, HYPE: 0.1 };
const SZ: Record<string, number> = { BTC: 5, ETH: 4, HYPE: 2 };
const POOL_HL = "0x00000000000000000000000000000000000000E1" as Address;
const USDC = 10n ** 6n;
const WAD = 10n ** 18n;
const MAX = 2n ** 256n - 1n;
const out = mkdtempSync(join(tmpdir(), "tourbillon-m4-run-"));
const T0 = Date.now();
const mins = () => ((Date.now() - T0) / 60_000).toFixed(1);
const say = (msg: string) => {
  const line = `${new Date().toISOString()} [${mins()} min] ${msg}`;
  console.log(line);
  appendFileSync(join(out, "runner.log"), line + "\n");
};
const sleep = (ms: number) => Bun.sleep(ms);
const b32 = (m: string) => stringToHex(m, { size: 32 });
const usd = (v: bigint) => Number(formatUnits(v, 6));
const wadStr = (x: number) => parseEther(x.toFixed(8));

// ---------------------------------------------------------------- ABIs

const part = { type: "tuple[]", components: [{ type: "uint256", name: "tempo" }, { type: "uint256", name: "weight" }] } as const;
const leg = { type: "tuple[]", components: [{ type: "bool", name: "isCall" }, { type: "uint128", name: "kWad" }, { type: "int128", name: "qty" }] } as const;
const abi = [
  { type: "function", name: "applyRoute", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] },
  { type: "function", name: "markWad", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "requestWithdraw", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "claimShares", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "depositOf", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "withdrawOf", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "round", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "epoch", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "navNow", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "available", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "equityTerm", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "whypeTerm", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "protocolFeeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "opensPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "seriesRaw", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "writtenRaw", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "openSeries", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256[]" }] },
  { type: "function", name: "pauseMarket", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] },
  { type: "function", name: "unpauseMarket", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] },
  { type: "function", name: "resumeOpens", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "pauseBuys", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "unpauseBuys", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "buy", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "bool" }, { type: "uint128" }, part, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "buyShape", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, leg, part, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "sell", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "accrue", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }, { type: "bool" }] },
  { type: "function", name: "write", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, leg, part, { type: "uint256" }, { type: "bool" }, { type: "int256" }, { type: "uint256" }], outputs: [{ type: "uint256" }, { type: "int256" }] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "unwrite", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "int256" }, { type: "uint256" }], outputs: [{ type: "uint256" }, { type: "int256" }] },
  { type: "function", name: "required", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "totalUsdcLocked", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalWhypeLocked", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "writes",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "address" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
  },
  // errors a buy, sell, write or unwrite can meet
  ...[
    ["CoverageBreached", 2], ["MarketIsPaused", "b"], ["OpensArePaused", 0], ["Insolvent", 2], ["StrikeOutOfBand", 2], ["StrikeOffStep", 2],
    ["NotCaughtUp", 1], ["NotionalCapExceeded", "b2"], ["DirectionalCapExceeded", "b2"], ["NoData", "b"], ["NothingToSell", 1],
    ["Expired", 1], ["NotListed", "b"], ["ZeroRaw", 0], ["ZeroUnits", 0], ["BuysArePaused", 0], ["WritesArePaused", 0], ["NetBelowMin", 2],
    ["TooManySeries", "b"], ["ShapeCanOwe", 0], ["ShapeTooComplex", 2], ["LegsNotCanonical", 1], ["FirstQtyNotOne", "i"], ["NoCoverNeeded", 0],
    ["NotWriter", 1], ["NothingToUnwrite", 1], ["Unbounded", 0], ["HistoryGone", 1], ["Unknown", 1], ["NoHistory", 0],
  ].map(([name, kind]) => ({
    type: "error" as const,
    name: name as string,
    inputs:
      kind === 0 ? [] : kind === 1 ? [{ type: "uint256" }] : kind === 2 ? [{ type: "uint256" }, { type: "uint256" }] : kind === "b" ? [{ type: "bytes32" }] : kind === "i" ? [{ type: "int256" }] : [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
  })),
  { type: "error", name: "Stale", inputs: [{ type: "bytes32" }, { type: "address" }] },
  { type: "error", name: "Stale", inputs: [{ type: "bytes32" }, { type: "uint256" }] },
  { type: "error", name: "CreditBelowMin", inputs: [{ type: "int256" }, { type: "int256" }] },
  { type: "error", name: "CostAboveMax", inputs: [{ type: "int256" }, { type: "int256" }] },
] as const;
const events = [
  {
    type: "event",
    name: "Bought",
    inputs: [
      { type: "address", name: "buyer", indexed: true }, { type: "uint256", name: "id", indexed: true }, { type: "bytes32", name: "market", indexed: true },
      { type: "uint256", name: "units" }, { type: "uint256", name: "raw" }, { type: "uint256", name: "sWad" }, { type: "uint256", name: "sigmaBps" },
      { type: "uint256", name: "unitValueWad" }, { type: "uint256", name: "premium" }, { type: "uint256", name: "fee" },
    ],
  },
  {
    type: "event",
    name: "ShapeBought",
    inputs: [
      { type: "address", name: "buyer", indexed: true }, { type: "uint256", name: "id", indexed: true }, { type: "bytes32", name: "market", indexed: true },
      { type: "uint256", name: "units" }, { type: "uint256", name: "raw" }, { type: "uint256", name: "sWad" }, { type: "uint256", name: "sigmaBps" },
      { type: "int256", name: "unitValueWad" }, { type: "uint256", name: "premium" }, { type: "uint256", name: "fee" },
    ],
  },
  {
    type: "event",
    name: "Sold",
    inputs: [
      { type: "address", name: "seller", indexed: true }, { type: "uint256", name: "id", indexed: true }, { type: "bytes32", name: "market", indexed: true },
      { type: "uint256", name: "units" }, { type: "uint256", name: "raw" }, { type: "uint256", name: "sWad" }, { type: "uint256", name: "sigmaBps" },
      { type: "uint256", name: "unitValueWad" }, { type: "uint256", name: "gross" }, { type: "uint256", name: "fee" }, { type: "uint256", name: "net" },
      { type: "bool", name: "markFromSample" }, { type: "bool", name: "volFromSample" },
    ],
  },
  {
    type: "event",
    name: "Written",
    inputs: [
      { type: "address", name: "writer", indexed: true }, { type: "uint256", name: "writeId", indexed: true }, { type: "uint256", name: "seriesId", indexed: true },
      { type: "bytes32", name: "market" }, { type: "uint256", name: "units" }, { type: "uint256", name: "raw" }, { type: "uint256", name: "sWad" },
      { type: "uint256", name: "sigmaBps" }, { type: "uint256", name: "usdcLocked" }, { type: "uint256", name: "whypeLocked" }, { type: "int256", name: "credit" },
      { type: "uint256", name: "fee" },
    ],
  },
  { type: "event", name: "Claimed", inputs: [{ type: "uint256", name: "writeId", indexed: true }, { type: "uint256", name: "usdcReleased" }, { type: "uint256", name: "whypeReleased" }] },
  {
    type: "event",
    name: "Unwritten",
    inputs: [
      { type: "uint256", name: "writeId", indexed: true }, { type: "uint256", name: "units" }, { type: "uint256", name: "raw" }, { type: "uint256", name: "sWad" },
      { type: "uint256", name: "sigmaBps" }, { type: "int256", name: "cost" }, { type: "uint256", name: "fee" }, { type: "uint256", name: "usdcPaid" },
      { type: "uint256", name: "whypePaid" }, { type: "uint256", name: "walletPaid" }, { type: "bool", name: "capped" }, { type: "bool", name: "markFromSample" },
      { type: "bool", name: "volFromSample" },
    ],
  },
] as const;

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return ((await res.json()) as { result: unknown }).result;
}

// ---------------------------------------------------------------- chain and contracts

say(`logs in ${out}; scale ${scale}; no venue outage`);
const anvil = Bun.spawn(["anvil", "--port", String(PORT), "--block-time", "1", "--accounts", "20", "--silent"], { stdout: "ignore", stderr: "ignore" });
const client = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: 300 }) as PublicClient;
for (let i = 0; i < 50; i++) {
  try {
    await client.getChainId();
    break;
  } catch {
    await sleep(100);
  }
}
const acc = (await rpc("eth_accounts")) as Address[];
const [DEPLOYER, ADMIN, S1, S2, S3, ANYONE, POKER1, POKER2, RISK, L1, L2, L3, T1, T2, T3, W1, W2, BROKE, PROTO] = acc as Address[];
const LPS = [L1!, L2!, L3!];
const TRADERS = [T1!, T2!, T3!];
const WRITERS = [W1!, W2!, BROKE!];
const env = { ...process.env, ADMIN: ADMIN!, SIGNERS: `${S1},${S2},${S3}`, RISK_PAUSER: RISK!, PROTOCOL_RECIPIENT: PROTO! };
for (const [script, sender] of [["DeployM1.s.sol:DeployM1", DEPLOYER!], ["DeployM4.s.sol:DeployM4", DEPLOYER!], ["ListEquityFeed.s.sol:ListEquityFeed", ADMIN!]] as const) {
  const r = Bun.spawnSync(["forge", "script", `script/${script}`, "--rpc-url", RPC, "--unlocked", "--sender", sender, "--broadcast"], { cwd: CONTRACTS, env });
  if (r.exitCode !== 0) throw new Error(`${script} failed: ${r.stderr.toString()}`);
}
const m1File = join(out, "31337.json");
const m4File = join(out, "31337-m4.json");
copyFileSync(join(CONTRACTS, "deployments", "31337.json"), m1File);
copyFileSync(join(CONTRACTS, "deployments", "31337-m4.json"), m4File);
const m1 = JSON.parse(readFileSync(m1File, "utf8")) as Record<string, Address>;
const m4 = JSON.parse(readFileSync(m4File, "utf8")) as Record<string, Address>;
const POOL = m4.MainspringPool!;
const ENGINE = m4.Engine!;
const BOOK = m4.PathFundingBook!;
const WB = m4.WriterBook!;
const MUSDC = m4.MockUSDC!;
const MWHYPE = m4.MockWHYPE!;
await rpc("evm_increaseTime", [3600]);
await rpc("evm_mine");

type Receipt = Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>>;
async function tx(from: Address, address: Address, functionName: string, args: readonly unknown[] = []): Promise<{ ok: true; receipt: Receipt } | { ok: false; reason: string }> {
  const call = { address, abi, functionName, args, account: from } as const;
  let gas: bigint;
  try {
    gas = await client.estimateContractGas(call as never);
  } catch (e) {
    const name = revertName(e);
    if (name) return { ok: false, reason: name };
    const sel = /0x[0-9a-fA-F]{8}/.exec((e as Error).message)?.[0];
    return { ok: false, reason: sel ? `unknown error ${sel}` : (e as Error).message.split("\n")[0]! };
  }
  const hash = await createWalletClient({ chain: foundry, transport: http(RPC), account: from }).writeContract({ ...(call as object), gas: gas * 2n } as never);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") return { ok: false, reason: `reverted on chain: ${await revertedWith(hash)}` };
  return { ok: true, receipt };
}
async function revertedWith(hash: `0x${string}`): Promise<string> {
  try {
    const t = (await rpc("debug_traceTransaction", [hash, { tracer: "callTracer" }])) as { output?: `0x${string}` };
    if (!t.output || t.output === "0x") return "no data";
    try {
      return decodeErrorResult({ abi, data: t.output }).errorName;
    } catch {
      return `unknown error ${t.output.slice(0, 10)}`;
    }
  } catch (e) {
    return `trace failed: ${(e as Error).message.split("\n")[0]}`;
  }
}
async function must(from: Address, address: Address, fn: string, args: readonly unknown[] = []): Promise<Receipt> {
  const r = await tx(from, address, fn, args);
  if (!r.ok) throw new Error(`${fn} failed: ${r.reason}`);
  return r.receipt;
}
const read = <T>(address: Address, functionName: string, args: readonly unknown[] = []) => client.readContract({ address, abi, functionName, args } as never) as Promise<T>;
function decoded(receipt: Receipt): { eventName: string; args: Record<string, unknown> }[] {
  const outEv: { eventName: string; args: Record<string, unknown> }[] = [];
  for (const l of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: events, data: l.data, topics: l.topics });
      outEv.push({ eventName: ev.eventName, args: ev.args as Record<string, unknown> });
    } catch {}
  }
  return outEv;
}

for (const m of MARKETS) await must(ANYONE!, m1.MarkRouter!, "applyRoute", [b32(m)]);
const START_USDC: Record<string, bigint> = {};
for (const w of [...LPS, ...TRADERS, W1!, W2!]) {
  await must(w, MUSDC, "mint", [w, 20_000_000n * USDC]);
  await must(w, MUSDC, "approve", [POOL, 10n ** 30n]);
  await must(w, MUSDC, "approve", [ENGINE, 10n ** 30n]);
  await must(w, MUSDC, "approve", [WB, 10n ** 30n]);
  START_USDC[w] = 20_000_000n * USDC;
}
await must(BROKE!, MUSDC, "mint", [BROKE!, 100n * USDC]); // a covered writer: a little USDC for small debits, later none
await must(BROKE!, MUSDC, "approve", [WB, 10n ** 30n]);
for (const w of WRITERS) {
  await must(w, MWHYPE, "mint", [w, 100_000n * WAD]);
  await must(w, MWHYPE, "approve", [WB, 10n ** 30n]);
}
say(`deployed; pool ${POOL}; WriterBook ${WB}`);

// ---------------------------------------------------------------- the simulated venue and the price path

const PRICE: Record<string, number> = { BTC: 100_000, ETH: 3_000, HYPE: 40 };
const sim = new SimVenue(MARKETS.map((n) => ({ name: n, szDecimals: SZ[n]!, mid: PRICE[n]! })));
sim.deposit(1_000_000);
let walking = true;
const shock: Record<string, number | null> = { BTC: null, HYPE: null };
const pricer = (async () => {
  let k = 1;
  while (walking) {
    for (const m of MARKETS) {
      let p = PRICE[m]!;
      const target = shock[m];
      if (target !== null && target !== undefined) p = Math.min(target, p * 1.015); // the shock: +1.5% per step
      else p = p * (1 + Math.sin(k * 1.7 + m.length) * 0.0015); // a gentle wander, ±0.15%
      PRICE[m] = p;
      sim.setMid(m, Number(p.toPrecision(5)));
    }
    k++;
    await sleep(30_000);
  }
})();

// ---------------------------------------------------------------- services

type Proc = ReturnType<typeof Bun.spawn>;
async function pipe(stream: ReadableStream<Uint8Array>, file: string) {
  for await (const c of stream) appendFileSync(file, c);
}
function service(name: string, cwd: string, args: string[]): Proc {
  const p = Bun.spawn(["bun", "src/main.ts", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  void pipe(p.stdout, join(out, `${name}.log`));
  void pipe(p.stderr, join(out, `${name}.err`));
  say(`${name} started`);
  return p;
}
const statusFile = join(out, "hedger-status.json");
const procs: Proc[] = [];
for (const [i, s] of [S1!, S2!, S3!].entries()) {
  procs.push(service(`signer-${i + 1}`, join(SERVICES, "quorum-signer"), ["--deployment", m1File, "--rpc", RPC, "--local-unlocked", s, "--hl-api", sim.url, "--test-vol", "0.5", "--equity-pool", POOL, "--equity-hl-user", POOL_HL]));
}
procs.push(service("poker-primary", join(SERVICES, "poker"), ["--deployment", m4File, "--rpc", RPC, "--local-unlocked", POKER1!, "--role", "primary"]));
procs.push(service("poker-backup", join(SERVICES, "poker"), ["--deployment", m4File, "--rpc", RPC, "--local-unlocked", POKER2!, "--role", "backup"]));
procs.push(service("hedger", join(SERVICES, "hedger"), ["--deployment", m4File, "--rpc", RPC, "--hl-user", POOL_HL, "--venue", "sim", "--venue-url", sim.url, "--status-file", statusFile, "--tick-seconds", "15"]));
procs.push(service("risk-monitor", join(SERVICES, "risk-monitor"), ["--deployment", m4File, "--rpc", RPC, "--local-unlocked", RISK!, "--hl-api", sim.url, "--hl-user", POOL_HL, "--hedger-status", statusFile, "--equity-every-seconds", "300"]));

// ---------------------------------------------------------------- shapes, ledgers and checks

type Leg = { isCall: boolean; k: number; qty: number };
type Attempt = { kind: "buy" | "buyShape" | "sell" | "write" | "claim" | "unwrite"; who: string; ok: boolean; reason?: string; gas?: bigint; phase: string; legs?: number; capped?: boolean };
const attempts: Attempt[] = [];
let phase = "warm-up";
let rng = 0x4d34;
const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
const DAY = 86_400;

/// Every series the run touched: its legs from the holder's side (a single leg is one leg of +1) and its tempo.
const seriesTerms = new Map<string, { market: string; legs: Leg[]; tempo: number }>();
const held = new Map<Address, Set<string>>(); // trader → series ids
const traderPaid = new Map<Address, bigint>();
const traderGot = new Map<Address, bigint>();
type W = { wid: bigint; writer: Address; market: string; legs: Leg[]; cover: bigint; seriesId: bigint; lockedAtWrite: [bigint, bigint]; claimed: [bigint, bigint]; released: [bigint, bigint] };
const writesMade: W[] = [];
const violations: string[] = []; // law 4 and the gate, in the runner's own maths
let obligationRose = 0;
const lastObligation = new Map<string, bigint>();
let capped = 0;
let walkerMisses = 0;
let quiet = false;
let busy = false;

async function routerMark(m: string): Promise<number | null> {
  try {
    return Number(formatUnits(await read<bigint>(m1.MarkRouter!, "markWad", [b32(m)]), 18));
  } catch {
    return null;
  }
}
const kAt = (m: string, x: number) => Math.round(x / STEP[m]!) * STEP[m]!;
const legArgs = (legs: Leg[]) => legs.map((l) => ({ isCall: l.isCall, kWad: wadStr(l.k), qty: wadStr(l.qty) }));
const neg = (legs: Leg[]) => legs.map((l) => ({ ...l, qty: -l.qty }));
const tempoArg = (t: number) => [{ tempo: BigInt(t), weight: WAD }];

/// Buyer shapes (holder's side, spelled the book's one way) around the mark.
function buyerShape(m: string, mark: number, kind: number): Leg[] {
  const K = kAt(m, mark);
  const w = Math.max(STEP[m]!, kAt(m, mark * 0.02));
  if (kind === 0) return [{ isCall: true, k: K, qty: 1 }, { isCall: true, k: K + w, qty: -1 }];
  if (kind === 1) return [{ isCall: false, k: K - w, qty: -1 }, { isCall: false, k: K, qty: 1 }];
  if (kind === 2) return [{ isCall: false, k: K, qty: 1 }, { isCall: true, k: K, qty: 1 }];
  return [{ isCall: true, k: K - 2 * w, qty: 1 }, { isCall: true, k: K - w, qty: -1 }, { isCall: true, k: K + w, qty: -1 }, { isCall: true, k: K + 2 * w, qty: 1 }];
}

/// Writer shapes (the writer's side) and whether WHYPE covers them.
function writerShape(m: string, mark: number, kind: number): { legs: Leg[]; cover: boolean } {
  const K = kAt(m, mark);
  const w = Math.max(STEP[m]!, kAt(m, mark * 0.02));
  if (kind === 0) return { legs: [{ isCall: true, k: K, qty: -1 }, { isCall: true, k: K + w, qty: 1 }], cover: false }; // written call spread
  if (kind === 1) return { legs: [{ isCall: false, k: K - 2 * w, qty: 1 }, { isCall: false, k: K - w, qty: -1 }, { isCall: true, k: K + w, qty: -1 }, { isCall: true, k: K + 2 * w, qty: 1 }], cover: false }; // Band
  if (kind === 2) return { legs: [{ isCall: true, k: K - w, qty: -1 }, { isCall: true, k: K, qty: 2 }, { isCall: true, k: K + w, qty: -1 }], cover: false }; // written butterfly
  if (kind === 3) return { legs: [{ isCall: true, k: kAt(m, mark * 1.1), qty: -1 }], cover: true }; // covered HYPE Rise
  return { legs: [{ isCall: false, k: kAt(m, mark * 0.9), qty: 1 }, { isCall: true, k: kAt(m, mark * 1.1), qty: -1 }], cover: true }; // Guard
}

function rememberBought(who: Address, receipt: Receipt, m: string, legs: Leg[], tempo: number) {
  for (const ev of decoded(receipt)) {
    if (ev.eventName === "Bought" || ev.eventName === "ShapeBought") {
      const id = (ev.args.id as bigint).toString();
      seriesTerms.set(id, { market: m, legs, tempo });
      const set = held.get(who) ?? new Set();
      set.add(id);
      held.set(who, set);
      traderPaid.set(who, (traderPaid.get(who) ?? 0n) + (ev.args.premium as bigint) + (ev.args.fee as bigint));
    }
  }
}

async function buySingle(who: Address, m: string): Promise<void> {
  const mark = (await routerMark(m)) ?? PRICE[m]!;
  const isCall = rand() < 0.5;
  const k = kAt(m, mark + (Math.floor(rand() * 5) - 2) * STEP[m]! * (m === "BTC" ? 10 : 2));
  const tempo = pick([3600, DAY, 7 * DAY]);
  const units = (2_000 + rand() * 18_000) / PRICE[m]!;
  const r = await tx(who, ENGINE, "buy", [b32(m), isCall, wadStr(k), tempoArg(tempo), wadStr(units), 10n ** 13n, 99_999_999_999n]);
  attempts.push({ kind: "buy", who, ok: r.ok, reason: r.ok ? undefined : r.reason, gas: r.ok ? r.receipt.gasUsed : undefined, phase, legs: 1 });
  if (r.ok) rememberBought(who, r.receipt, m, [{ isCall, k, qty: 1 }], tempo);
}

async function buyShape(who: Address, m: string, kind: number): Promise<void> {
  const mark = (await routerMark(m)) ?? PRICE[m]!;
  const legs = buyerShape(m, mark, kind);
  const tempo = pick([DAY, 7 * DAY]);
  const units = (5_000 + rand() * 20_000) / PRICE[m]!;
  const r = await tx(who, ENGINE, "buyShape", [b32(m), legArgs(legs), tempoArg(tempo), wadStr(units), 10n ** 13n, 99_999_999_999n]);
  attempts.push({ kind: "buyShape", who, ok: r.ok, reason: r.ok ? undefined : r.reason, gas: r.ok ? r.receipt.gasUsed : undefined, phase, legs: legs.length });
  if (r.ok) rememberBought(who, r.receipt, m, legs, tempo);
}

async function sell(who: Address, id: string, all = true): Promise<void> {
  const bal = await read<bigint>(BOOK, "balanceOf", [BigInt(id), who]);
  if (bal === 0n) {
    held.get(who)?.delete(id);
    return;
  }
  const r = await tx(who, ENGINE, "sell", [BigInt(id), all ? MAX : wadStr(0.0001), 0n, 99_999_999_999n]);
  attempts.push({ kind: "sell", who, ok: r.ok, reason: r.ok ? undefined : r.reason, gas: r.ok ? r.receipt.gasUsed : undefined, phase, legs: seriesTerms.get(id)?.legs.length });
  if (r.ok) {
    for (const ev of decoded(r.receipt)) if (ev.eventName === "Sold") traderGot.set(who, (traderGot.get(who) ?? 0n) + (ev.args.net as bigint));
    if (all) held.get(who)?.delete(id);
  }
}

async function sellAll(who: Address): Promise<void> {
  for (const id of [...(held.get(who) ?? [])]) await sell(who, id);
}

async function write(who: Address, m: string, kind: number): Promise<W | null> {
  const mark = (await routerMark(m)) ?? PRICE[m]!;
  const { legs, cover } = writerShape(m, mark, kind);
  const units = m === "HYPE" ? 50 + Math.floor(rand() * 150) : (10_000 + rand() * 20_000) / PRICE[m]!;
  const r = await tx(who, WB, "write", [b32(m), legArgs(legs), tempoArg(DAY), wadStr(units), cover, -(2n ** 200n), 99_999_999_999n]);
  attempts.push({ kind: "write", who, ok: r.ok, reason: r.ok ? undefined : r.reason, gas: r.ok ? r.receipt.gasUsed : undefined, phase, legs: legs.length });
  if (!r.ok) return null;
  const ev = decoded(r.receipt).find((e) => e.eventName === "Written")!;
  let coverQty = 0;
  if (cover) for (const l of legs) if (l.isCall) coverQty -= l.qty;
  const w: W = {
    wid: ev.args.writeId as bigint,
    writer: who,
    market: m,
    legs,
    cover: wadStr(Math.max(0, coverQty)),
    seriesId: ev.args.seriesId as bigint,
    lockedAtWrite: [ev.args.usdcLocked as bigint, ev.args.whypeLocked as bigint],
    claimed: [0n, 0n],
    released: [0n, 0n],
  };
  writesMade.push(w);
  seriesTerms.set(w.seriesId.toString(), { market: m, legs: neg(legs), tempo: DAY });
  return w;
}

type WState = { writer: Address; raw: bigint; usdcL: bigint; whypeL: bigint };
async function wstate(wid: bigint): Promise<WState> {
  const r = await read<readonly [Address, string, bigint, bigint, bigint, bigint, bigint, bigint]>(WB, "writes", [wid]);
  return { writer: r[0], raw: r[3], usdcL: r[6], whypeL: r[7] };
}

async function claim(w: W): Promise<void> {
  const r = await tx(w.writer, WB, "claim", [w.wid]);
  attempts.push({ kind: "claim", who: w.writer, ok: r.ok, reason: r.ok ? undefined : r.reason, gas: r.ok ? r.receipt.gasUsed : undefined, phase });
  if (r.ok) {
    const ev = decoded(r.receipt).find((e) => e.eventName === "Claimed")!;
    w.claimed = [w.claimed[0] + (ev.args.usdcReleased as bigint), w.claimed[1] + (ev.args.whypeReleased as bigint)];
  }
}

async function unwrite(w: W, frac: number): Promise<void> {
  const before = await wstate(w.wid);
  if (before.raw === 0n) return;
  let units = MAX;
  if (frac < 1) {
    const norm = await walkedNorm(w.seriesId);
    units = (((before.raw * norm) / WAD) * BigInt(Math.round(frac * 1000))) / 1000n;
    if (units === 0n) units = MAX;
  }
  const r = await tx(w.writer, WB, "unwrite", [w.wid, units, 2n ** 200n, 99_999_999_999n]);
  const a: Attempt = { kind: "unwrite", who: w.writer, ok: r.ok, reason: r.ok ? undefined : r.reason, gas: r.ok ? r.receipt.gasUsed : undefined, phase };
  attempts.push(a);
  if (!r.ok) return;
  const ev = decoded(r.receipt).find((e) => e.eventName === "Unwritten")!;
  const after = await wstate(w.wid);
  const usdcPart = before.usdcL - after.usdcL;
  const whypePart = before.whypeL - after.whypeL;
  w.released = [w.released[0] + usdcPart, w.released[1] + whypePart];
  const s = ev.args.sWad as bigint;
  const cap = usdcPart + (whypePart * s) / WAD / 10n ** 12n;
  const cost = ev.args.cost as bigint;
  if (cost > cap) violations.push(`gate: unwrite ${w.wid} cost ${cost} above the collateral's value ${cap}`);
  if (ev.args.capped as boolean) {
    capped++;
    a.capped = true;
  }
}

/// The walked norm of a series: book.accrue simulated with no step limit (no transaction).
async function walkedNorm(id: bigint): Promise<bigint> {
  const { result } = await client.simulateContract({ address: BOOK, abi, functionName: "accrue", args: [id, MAX], account: ANYONE! } as never);
  return (result as readonly [bigint, boolean])[0];
}

/// Law 4 in the runner's own maths (WAD × WAD payoff at 0 and every strike, the walked norm), the gate at the mark and
/// ±50%, and "the obligation only shrinks", for every open write.
async function checkWrites(label: string): Promise<void> {
  for (const w of writesMade) {
    const st = await wstate(w.wid);
    if (st.raw === 0n) continue;
    const norm = await walkedNorm(w.seriesId);
    const unitsNow = (st.raw * norm + WAD - 1n) / WAD;
    // exact worst case per unit (WAD × WAD)
    const payoff = (s: bigint) =>
      w.legs.reduce((acc, l) => {
        const k = wadStr(l.k);
        const intr = l.isCall ? (s > k ? s - k : 0n) : k > s ? k - s : 0n;
        return acc + wadStr(l.qty) * intr;
      }, w.cover * s);
    let min = payoff(0n);
    for (const l of w.legs) {
      const p = payoff(wadStr(l.k));
      if (p < min) min = p;
    }
    if (min < 0n && st.usdcL * 10n ** 12n * WAD < ((-min) * unitsNow) / WAD) violations.push(`${label}: write ${w.wid} USDC below the exact worst case`);
    if (st.whypeL < (w.cover * unitsNow) / WAD) violations.push(`${label}: write ${w.wid} WHYPE below the cover`);
    // the obligation only shrinks
    const obligation = min < 0n ? ((-min) * unitsNow) / WAD : 0n;
    const key = w.wid.toString();
    const last = lastObligation.get(key);
    if (last !== undefined && obligation > last) obligationRose++;
    lastObligation.set(key, obligation);
  }
  const [tu, th, bu, bh] = await Promise.all([read<bigint>(WB, "totalUsdcLocked"), read<bigint>(WB, "totalWhypeLocked"), read<bigint>(MUSDC, "balanceOf", [WB]), read<bigint>(MWHYPE, "balanceOf", [WB])]);
  if (tu !== bu || th !== bh) violations.push(`${label}: the WriterBook holds ${bu}/${bh}, locked ${tu}/${th}`);
}

// ---------------------------------------------------------------- trading loop

async function randomTrade(): Promise<void> {
  const t = pick(TRADERS);
  if (rand() < 0.35 && (held.get(t)?.size ?? 0) > 0) return sell(t, pick([...held.get(t)!]), rand() < 0.6);
  const m = pick(["BTC", "ETH"]);
  if (rand() < 0.4) return buySingle(t, m);
  return buyShape(t, m, Math.floor(rand() * 4));
}
let trading = true;
const traderLoop = (async () => {
  while (trading) {
    if (!quiet) {
      busy = true;
      try {
        await randomTrade();
      } catch (e) {
        say(`trade threw: ${(e as Error).message.split("\n")[0]}`);
      }
      busy = false;
    }
    await sleep(20_000 * scale);
  }
})();
async function hush(): Promise<void> {
  quiet = true;
  while (busy) await sleep(500);
}

// ---------------------------------------------------------------- timing helpers

const warps: number[] = [];
async function warp(label: string) {
  await rpc("evm_increaseTime", [3600]);
  await rpc("evm_mine");
  warps.push(Date.now());
  say(`chain clock +1 h (${label})`);
}
async function waitFor(label: string, check: () => Promise<boolean>, maxMs: number): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < maxMs) {
    if (await check()) return true;
    await sleep(5_000);
  }
  say(`timeout waiting for ${label}`);
  return false;
}
const settledRound = async (r: bigint) => (await read<bigint>(POOL, "round")) > r;
async function nextSettlement(label: string, maxMs = 300_000): Promise<bigint> {
  const r = await read<bigint>(POOL, "round");
  await waitFor(label, () => settledRound(r), maxMs);
  return r;
}
async function claimAll(r: bigint) {
  for (const lp of LPS) {
    if ((await read<bigint>(POOL, "depositOf", [r, lp])) > 0n) await must(lp, POOL, "claimShares", [r]);
    if ((await read<bigint>(POOL, "withdrawOf", [r, lp])) > 0n) await must(lp, POOL, "withdraw", [r]);
  }
}
const marksFresh = () => waitFor("router marks fresh", async () => (await Promise.all(MARKETS.map(routerMark))).every((x) => x !== null), 180_000);
const lines = (name: string) =>
  existsSync(join(out, `${name}.log`))
    ? readFileSync(join(out, `${name}.log`), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as Record<string, unknown>];
          } catch {
            return [];
          }
        })
    : [];

/// NAV checkpoint (owner's rule from step 7b): with nothing else moving, a write changes NAV only by the pool's share
/// of the fee. NAV is compared without the equity and WHYPE terms, which move with the venue and the HYPE mark.
const navChecks: { label: string; d: bigint; expected: bigint; ok: boolean }[] = [];
async function navCheckpoint(label: string, who: Address, m: string, kind: number) {
  await hush();
  const core = async () => (await read<bigint>(POOL, "navNow")) - (await read<bigint>(POOL, "equityTerm")) - (await read<bigint>(POOL, "whypeTerm"));
  for (let attempt = 0; attempt < 3; attempt++) {
    const e0 = await read<bigint>(POOL, "epoch");
    const n0 = await core();
    const w = await write(who, m, kind);
    const n1 = await core();
    if ((await read<bigint>(POOL, "epoch")) !== e0) continue; // an epoch finalised in between: try again
    if (!w) break;
    const rec = attempts[attempts.length - 1]!;
    const logs = await client.getLogs({ address: WB, fromBlock: 0n });
    let fee = 0n;
    for (const l of logs) {
      try {
        const ev = decodeEventLog({ abi: events, data: l.data, topics: l.topics });
        if (ev.eventName === "Written" && (ev.args as { writeId: bigint }).writeId === w.wid) fee = (ev.args as { fee: bigint }).fee;
      } catch {}
    }
    const expected = fee - (fee * BigInt(await read<number>(POOL, "protocolFeeBps"))) / 10_000n;
    const d = n1 - n0;
    const ok = d >= expected - 2n && d <= expected + 2n;
    navChecks.push({ label, d, expected, ok });
    say(`NAV checkpoint ${label}: changed by ${usd(d)} for a fee share of ${usd(expected)} (${ok ? "ok" : "MISMATCH"}); write gas ${rec.gas}`);
    break;
  }
  quiet = false;
}

/// Hedger checkpoint: with nothing else moving, the hedger's next target for each market equals an independent delta
/// from the run's own ledger of legs, the pool's raw and written raw, the walked norm and the pool's WHYPE.
const hedgeChecks: { label: string; market: string; target: number; expected: number; ok: boolean }[] = [];
async function hedgerCheckpoint(label: string) {
  await hush();
  const since = Date.now();
  await waitFor("the hedger's next passes", async () => MARKETS.every((m) => lines("hedger").some((l) => l.msg === "plan" && l.market === m && Date.parse(String(l.t)) > since + 1_000)), 120_000);
  for (const m of MARKETS) {
    const plan = lines("hedger").filter((l) => l.msg === "plan" && l.market === m && Date.parse(String(l.t)) > since + 1_000).at(-1);
    if (!plan) continue;
    const s = Number(plan.s);
    const sig = Number(plan.sigmaBps);
    const ids = await read<readonly bigint[]>(POOL, "openSeries", [b32(m)]);
    let sum = 0;
    for (const id of ids) {
      const terms = seriesTerms.get(id.toString());
      if (!terms) continue;
      const [raw, wraw, norm] = await Promise.all([read<bigint>(POOL, "seriesRaw", [id]), read<bigint>(POOL, "writtenRaw", [id]), walkedNorm(id)]);
      const units = Number(formatUnits((raw * norm) / WAD, 18)) - Number(formatUnits((wraw * norm) / WAD, 18));
      const ud = terms.legs.reduce((a, l) => a + l.qty * blendDelta(l.isCall, s, l.k, sig, [{ tempo: terms.tempo, weight: 1 }]), 0);
      sum += units * ud;
    }
    const heldCoins = m === "HYPE" ? Number(formatUnits(await read<bigint>(MWHYPE, "balanceOf", [POOL]), 18)) : 0;
    const expected = sum - heldCoins; // target = −(pool delta) = Σ units × delta − held coins
    const target = Number(plan.target);
    const ok = Math.abs(target - expected) <= Math.max(0.01, Math.abs(expected) * 0.01);
    hedgeChecks.push({ label, market: m, target, expected, ok });
    say(`hedger checkpoint ${label} ${m}: target ${target.toFixed(4)} vs independent ${expected.toFixed(4)} (${ok ? "ok" : "MISMATCH"})`);
  }
  quiet = false;
}

// ---------------------------------------------------------------- the run

const phaseAt: Record<string, number> = {};
const mark = (p: string) => {
  phase = p;
  phaseAt[p] = Date.now();
  say(`phase: ${p}`);
};

await marksFresh();
mark("A warm-up");
await waitFor("the keeper's first settlement", () => settledRound(0n), 240_000);
for (const [i, lp] of LPS.entries()) await must(lp, POOL, "deposit", [BigInt([3_000_000, 2_000_000, 1_000_000][i]!) * USDC]);
await sleep(120_000 * scale);
await warp("hour 1: the LP round");
const lpRound = await nextSettlement("the LP round settled");
await claimAll(lpRound);
say(`NAV ${usd(await read<bigint>(POOL, "navNow")).toFixed(2)} after the LP round`);

mark("B writing");
await marksFresh();
await navCheckpoint("written BTC call spread", W1!, "BTC", 0);
await navCheckpoint("written BTC Band", W2!, "BTC", 1);
await navCheckpoint("covered HYPE Rise", BROKE!, "HYPE", 3);
for (let i = 0; i < 8; i++) {
  const who = pick([W1!, W2!]);
  const m = pick(["BTC", "ETH", "HYPE"]);
  const kind = m === "HYPE" ? pick([3, 4]) : pick([0, 1, 2]);
  await write(who, m, kind);
  await sleep(10_000 * scale);
}
for (let i = 0; i < 3; i++) await write(BROKE!, "HYPE", 3); // more covered Rises for the WHYPE-only writer
await checkWrites("after the writes");
await hedgerCheckpoint("after the writes");
for (const h of [2, 3]) {
  await warp(`hour ${h}: decay`);
  await nextSettlement(`hour ${h} settled`);
  await marksFresh();
  await checkWrites(`hour ${h}`);
}
for (const w of writesMade) await claim(w); // funding received
await checkWrites("after the claims");
for (const w of writesMade.filter((_, i) => i % 3 === 0)) await unwrite(w, 1 / 3);
await checkWrites("after the partial unwrites");

mark("C shock");
shock.BTC = PRICE.BTC! * 1.15;
shock.HYPE = PRICE.HYPE! * 1.25;
say(`shock: BTC to ${shock.BTC.toFixed(0)} (+15%), HYPE to ${shock.HYPE.toFixed(2)} (+25%) in 1.5% steps`);
await waitFor("router at the shock prices", async () => ((await routerMark("BTC")) ?? 0) >= shock.BTC! * 0.995 && ((await routerMark("HYPE")) ?? 0) >= shock.HYPE! * 0.995, 900_000);
await checkWrites("at the shock");
const shockStart = attempts.length;
for (const w of writesMade.filter((x) => x.market === "BTC" && x.legs.length === 2)) await unwrite(w, 1); // written call spreads, deep in the money
// the WHYPE-only writer keeps no USDC and closes every covered Rise
const brokeUsdc = await read<bigint>(MUSDC, "balanceOf", [BROKE!]);
if (brokeUsdc > 0n) await must(BROKE!, MUSDC, "transfer", [ANYONE!, brokeUsdc]);
for (const w of writesMade.filter((x) => x.writer === BROKE)) await unwrite(w, 1);
const brokeAfter = await read<bigint>(MUSDC, "balanceOf", [BROKE!]);
for (const t of TRADERS) await sellAll(t);
const shockActs = attempts.slice(shockStart);
const poolWhype = await read<bigint>(MWHYPE, "balanceOf", [POOL]);
say(`shock: ${shockActs.filter((a) => a.ok).length}/${shockActs.length} unwrites and sells ok; ${capped} capped; the WHYPE-only writer ends with ${usd(brokeAfter)} USDC; the pool holds ${formatUnits(poolWhype, 18)} WHYPE (NAV term ${usd(await read<bigint>(POOL, "whypeTerm"))})`);
await checkWrites("after the shock unwrites");
await hedgerCheckpoint("after the shock (pool WHYPE)");
shock.BTC = null;
shock.HYPE = null;

mark("D pauses");
await warp("hour 4");
await nextSettlement("hour 4 settled");
await marksFresh();
if (await read<boolean>(POOL, "opensPaused")) {
  say("drawdown pause after the shock; the admin resumes");
  await must(ADMIN!, POOL, "resumeOpens");
}
for (const t of TRADERS) await buyShape(t, "ETH", 0); // positions to close while paused
await write(W1!, "ETH", 0);
await must(ADMIN!, ENGINE, "pauseBuys");
await must(RISK!, POOL, "pauseMarket", [b32("ETH")]);
const pauseStart = attempts.length;
await buyShape(T1!, "BTC", 0); // refused: buys paused
await write(W2!, "BTC", 0); // refused: writes follow the buy pause
for (const t of TRADERS) await sellAll(t); // works
for (const w of writesMade.filter((x) => x.market === "ETH")) await unwrite(w, 1); // works
const pauseActs = attempts.slice(pauseStart);
await must(ADMIN!, ENGINE, "unpauseBuys");
await must(ADMIN!, POOL, "unpauseMarket", [b32("ETH")]);
say(`pauses: ${pauseActs.map((a) => `${a.kind}:${a.ok ? "ok" : a.reason}`).join(", ")}`);
await checkWrites("after the pauses");

mark("E wind-down");
trading = false;
await traderLoop;
for (const t of TRADERS) await sellAll(t);
for (const w of writesMade) await claim(w);
for (const w of writesMade) await unwrite(w, 1);
await checkWrites("at the end");
for (const lp of LPS) {
  const sh = await read<bigint>(POOL, "balanceOf", [lp]);
  if (sh > 0n) await must(lp, POOL, "requestWithdraw", [sh / 2n]);
}
await warp("hour 5: wind-down settlement");
const windDown = await nextSettlement("wind-down round settled");
await claimAll(windDown);
await hedgerCheckpoint("at the end");
const endTime = Date.now();
say(`NAV ${usd(await read<bigint>(POOL, "navNow")).toFixed(2)} at the end`);

walking = false;
await pricer;
for (const p of procs) p.kill("SIGTERM");
await Promise.all(procs.map((p) => p.exited));
sim.stop();

// ---------------------------------------------------------------- report

const report: string[] = [];
const crit: string[] = ["== criteria"];
const check = (ok: boolean, what: string) => crit.push(`${ok ? "PASS" : "FAIL"}  ${what}`);
const median = (xs: bigint[]) => (xs.length ? [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[Math.floor(xs.length / 2)]! : 0n);
const of = (kind: Attempt["kind"]) => attempts.filter((a) => a.kind === kind);

// 1. law 3 for buyers and writers
const sells = of("sell");
const unwrites = of("unwrite");
const sellFails = sells.filter((a) => !a.ok && a.reason !== "NothingToSell");
const unwriteFails = unwrites.filter((a) => !a.ok && a.reason !== "NothingToUnwrite");
const pausedCloses = pauseActs.filter((a) => a.kind === "sell" || a.kind === "unwrite");
report.push(`sells ${sells.filter((a) => a.ok).length}/${sells.length}; unwrites ${unwrites.filter((a) => a.ok).length}/${unwrites.length}; during the shock ${shockActs.filter((a) => a.ok).length}/${shockActs.length}; while paused ${pausedCloses.filter((a) => a.ok).length}/${pausedCloses.length}`);
check(sellFails.length === 0 && unwriteFails.length === 0 && shockActs.length > 0 && pausedCloses.length > 0 && pausedCloses.every((a) => a.ok), `law 3, buyers and writers: every sell and unwrite succeeded, in every phase incl. the shock and the pauses (${sellFails.length + unwriteFails.length} failed: ${[...sellFails, ...unwriteFails].map((a) => `${a.phase}/${a.reason}`).join(", ")})`);

// 2. law 4, 3. the gate
const law4 = violations.filter((v) => !v.startsWith("gate"));
const gate = violations.filter((v) => v.startsWith("gate"));
check(law4.length === 0, `law 4: every open write's locked collateral covered the exact worst case of the units owed now, checked ${writesMade.length} writes at 9 checkpoints in the runner's own maths; the WriterBook held exactly what was locked (${law4.length} violations${law4.length ? ": " + law4.slice(0, 3).join(" | ") : ""})`);
check(gate.length === 0 && unwrites.some((a) => a.ok), `gate: no unwrite cost more than its collateral's value (${unwrites.filter((a) => a.ok).length} unwrites, ${capped} capped at the collateral; ${gate.length} above)`);

// 4. law 1
let law1 = 0;
const law1Lines: string[] = [];
for (const t of TRADERS) {
  const bal = await read<bigint>(MUSDC, "balanceOf", [t]).catch(() => -1n);
  const expected = START_USDC[t]! - (traderPaid.get(t) ?? 0n) + (traderGot.get(t) ?? 0n);
  if (bal !== expected) law1++;
  law1Lines.push(`${t.slice(0, 6)}: paid ${usd(traderPaid.get(t) ?? 0n).toFixed(2)}, got ${usd(traderGot.get(t) ?? 0n).toFixed(2)}`);
}
const shapeBuys = of("buyShape");
report.push(`shape buys ${shapeBuys.filter((a) => a.ok).length}/${shapeBuys.length} (2 legs ${shapeBuys.filter((a) => a.ok && a.legs === 2).length}, 4 legs ${shapeBuys.filter((a) => a.ok && a.legs === 4).length}); single buys ${of("buy").filter((a) => a.ok).length}/${of("buy").length}; traders: ${law1Lines.join("; ")}`);
check(law1 === 0, `law 1: every trader's USDC is exactly start − paid + received after selling everything; no one lost more than they paid (${law1} mismatches)`);

// 5. NAV
report.push(`NAV checkpoints: ${navChecks.map((c) => `${c.label} ${usd(c.d)} vs ${usd(c.expected)}`).join("; ")}`);
check(navChecks.length === 3 && navChecks.every((c) => c.ok), "NAV: each checkpoint write moved NAV only by the pool's share of the fee (within 2 units)");

// 6. claims and obligations
let claimMismatch = 0;
for (const w of writesMade) {
  const st = await wstate(w.wid);
  const inU = w.lockedAtWrite[0];
  const inH = w.lockedAtWrite[1];
  if (w.claimed[0] + w.released[0] + st.usdcL !== inU || w.claimed[1] + w.released[1] + st.whypeL !== inH) claimMismatch++;
}
const claims = of("claim");
const claimedUsdc = writesMade.reduce((a, w) => a + w.claimed[0], 0n);
const claimedWhype = writesMade.reduce((a, w) => a + w.claimed[1], 0n);
report.push(`claims ${claims.filter((a) => a.ok).length}/${claims.length}: funding received ${usd(claimedUsdc).toFixed(2)} USDC and ${formatUnits(claimedWhype, 18)} WHYPE released by decay`);
check(claimMismatch === 0 && obligationRose === 0 && claimedUsdc + claimedWhype > 0n, `claims and obligations: per write, claimed + released + still locked = locked at the write (${claimMismatch} mismatches); no obligation rose (${obligationRose}); claims released only what decay freed (law 4 held after every claim)`);

// 7. hedger
const hedger = lines("hedger");
const plans = hedger.filter((l) => l.msg === "plan");
const inBand = plans.filter((l) => l.reason === "in-band").length;
const hedgeRows = hedger.filter((l) => l.msg === "hedge");
const hedgeErrors = hedgeRows.filter((l) => l.status === "error");
report.push(`hedger: ${hedgeRows.length} hedge rows (${hedgeRows.filter((l) => l.status === "filled").length} filled), ${plans.length} plans, ${inBand} in band; checkpoints: ${hedgeChecks.map((c) => `${c.label} ${c.market} ${c.target.toFixed(3)} vs ${c.expected.toFixed(3)}`).join("; ")}`);
check(hedgeErrors.length === 0 && inBand / Math.max(1, plans.length) >= 0.8 && hedgeChecks.length >= 9 && hedgeChecks.every((c) => c.ok), `hedger: no venue errors, ≥80% of passes in band (${((100 * inBand) / Math.max(1, plans.length)).toFixed(0)}%), every checkpoint target = the independent delta incl. shapes, writes and the pool's WHYPE (${hedgeChecks.filter((c) => c.ok).length}/${hedgeChecks.length})`);

// 8. walker
walkerMisses = attempts.filter((a) => (a.kind === "buyShape" || a.kind === "buy" || a.kind === "write") && !a.ok && (a.reason ?? "").includes("NotCaughtUp")).length;
const walks = lines("poker-primary").concat(lines("poker-backup")).filter((l) => l.msg === "walked");
report.push(`walker: ${walks.length} walks; NotCaughtUp refusals ${walkerMisses}`);
check(walkerMisses === 0, "walker: no buy or write refused NotCaughtUp");

// 9. accounting
const engineUsdc = await read<bigint>(MUSDC, "balanceOf", [ENGINE]).catch(() => -1n);
let onchain = 0n;
for (const w of [POOL, WB, PROTO!, ANYONE!, DEPLOYER!, ADMIN!, ...LPS, ...TRADERS, ...WRITERS]) onchain += await read<bigint>(MUSDC, "balanceOf", [w]).catch(() => 0n);
const supply = await read<bigint>(MUSDC, "totalSupply").catch(() => 0n);
let whypeOn = 0n;
for (const w of [POOL, WB, ...WRITERS]) whypeOn += await read<bigint>(MWHYPE, "balanceOf", [w]).catch(() => 0n);
const whypeSupply = await read<bigint>(MWHYPE, "totalSupply").catch(() => 0n);
const bps = BigInt(await read<number>(POOL, "protocolFeeBps"));
let protoExpected = 0n;
for (const addr of [ENGINE, WB]) {
  for (const l of await client.getLogs({ address: addr, fromBlock: 0n })) {
    try {
      const ev = decodeEventLog({ abi: events, data: l.data, topics: l.topics });
      const fee = (ev.args as { fee?: bigint }).fee;
      if (fee !== undefined) protoExpected += (fee * bps) / 10_000n;
    } catch {}
  }
}
const protoGot = await read<bigint>(MUSDC, "balanceOf", [PROTO!]).catch(() => 0n);
let writtenMismatch = 0;
const bySeries = new Map<string, bigint>();
for (const w of writesMade) {
  const st = await wstate(w.wid);
  bySeries.set(w.seriesId.toString(), (bySeries.get(w.seriesId.toString()) ?? 0n) + st.raw);
}
for (const [id, raw] of bySeries) if ((await read<bigint>(POOL, "writtenRaw", [BigInt(id)])) !== raw) writtenMismatch++;
report.push(`accounting: engine ${usd(engineUsdc)}; USDC ${usd(onchain)} of supply ${usd(supply)}; WHYPE ${formatUnits(whypeOn, 18)} of ${formatUnits(whypeSupply, 18)}; protocol ${usd(protoGot)} vs 10% of every fee ${usd(protoExpected)}; written raw mismatches ${writtenMismatch}`);
check(engineUsdc === 0n && onchain === supply && whypeOn === whypeSupply && protoGot === protoExpected && writtenMismatch === 0, "accounting: Engine 0; USDC and WHYPE conserved; the pool's written raw = the WriterBook's; the protocol got exactly 10% of every fee (buys, sells, writes, unwrites)");

// 10. keeper, poker, logs
const settles = lines("poker-primary").concat(lines("poker-backup")).filter((l) => l.msg === "keeper: settled");
const risk = lines("risk-monitor").filter((l) => l.msg === "alarm");
const settleStale = risk.filter((l) => l.name === "SETTLEMENT_STALE" && l.state === "raised");
const nearWarp = (t: number) => warps.some((w) => t >= w && t <= w + 180_000);
const sampleStale = risk.filter((l) => l.name === "SAMPLE_STALE" && l.state === "raised" && !nearWarp(Date.parse(String(l.t))));
let errorLines = 0;
const samples: string[] = [];
for (const f of ["signer-1", "signer-2", "signer-3", "poker-primary", "poker-backup", "hedger", "risk-monitor"]) {
  for (const l of lines(f)) {
    if (l.level === "error") {
      errorLines++;
      if (samples.length < 4) samples.push(`${f}: ${JSON.stringify(l).slice(0, 220)}`);
    }
  }
}
report.push(`keeper: ${settles.length} settlements; SETTLEMENT_STALE ${settleStale.length}; SAMPLE_STALE outside clock jumps ${sampleStale.length}; error lines ${errorLines}`);
check(settles.length >= warps.length && settleStale.length === 0 && sampleStale.length === 0 && errorLines === 0, `keeper and poker: every hour settled, no stale alarms, no error lines${samples.length ? " (" + samples.join(" | ") + ")" : ""}`);

// 11. gas
const gasOf = (f: (a: Attempt) => boolean) => attempts.filter((a) => a.ok && a.gas !== undefined && f(a)).map((a) => a.gas!);
const svc = lines("poker-primary").concat(lines("poker-backup"));
const g = {
  buyShape2: median(gasOf((a) => a.kind === "buyShape" && a.legs === 2)),
  buyShape4: median(gasOf((a) => a.kind === "buyShape" && a.legs === 4)),
  buy: median(gasOf((a) => a.kind === "buy")),
  sellShape: median(gasOf((a) => a.kind === "sell" && (a.legs ?? 1) > 1)),
  sell: median(gasOf((a) => a.kind === "sell" && (a.legs ?? 1) === 1)),
  write2: median(gasOf((a) => a.kind === "write" && a.legs === 2)),
  write4: median(gasOf((a) => a.kind === "write" && a.legs === 4)),
  claim: median(gasOf((a) => a.kind === "claim")),
  unwrite: median(gasOf((a) => a.kind === "unwrite")),
  poke: median(svc.filter((l) => l.msg === "poked").map((l) => BigInt(String(l.gasUsed)))),
  markChunk: median(svc.filter((l) => l.msg === "keeper: marked").map((l) => BigInt(String(l.gasUsed)))),
  settle: median(settles.map((l) => BigInt(String(l.gasUsed)))),
};
report.push(`gas medians: ${Object.entries(g).map(([k, v]) => `${k} ${v}`).join(", ")}`);
check(Object.values(g).every((v) => v > 0n), "gas measured for shape buys (2 and 4 legs), shape sells, writes (2 and 4 legs), claims, unwrites, pokes, markChunk with shapes, settle");

const text = [`run ${((endTime - T0) / 60_000).toFixed(1)} min; logs in ${out}`, ...report, "", ...crit].join("\n") + "\n";
writeFileSync(join(out, "report.txt"), text);
writeFileSync(join(out, "attempts.json"), JSON.stringify(attempts, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1));
console.log("\n" + text);
anvil.kill();
say("done");
