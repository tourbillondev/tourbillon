import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicClient, createWalletClient, decodeErrorResult, decodeEventLog, encodeAbiParameters, formatUnits, getAddress, http, keccak256, parseAbi, parseEther, stringToHex, toHex, type Address, type Hex, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { revertName } from "@tourbillon/common/tx.ts";
import { blendDelta } from "@tourbillon/common/tempo.ts";
import { SimVenue } from "../../hedger/src/simvenue.ts";
import { buildQuote, signQuote } from "../../maker-gateway/src/bot.ts";
import { loadM6Deployment } from "../../maker-gateway/src/chain.ts";
import { toJson, writerWorstPerUnit, type Quote } from "../../maker-gateway/src/quote.ts";

/// M6 step 11: the open book on anvil for about 20 minutes. Every service runs as a real process (three signers, two
/// pokers, the hedger on the simulated venue, the risk-monitor, the maker-gateway and two reference maker bots). Buyers
/// route through the OpenBook with the gateway's quotes and the writer offers; makers and offer writers are bought back
/// when buyers sell; a maker closes early; then an auction week (the chain clock jumps 3 days, then 1 day). Law 2 is
/// tested with the signers paused. Automining anvil (one transaction per block), so every routed buy is re-priced, per
/// candidate, at the exact state before it. No key: anvil's unlocked accounts. Logs and the report go to a temp folder.
///
///   bun scripts/local-m6-run.ts [--scale 1]   (--scale 0.2 shortens the waits)

const scale = Number(process.argv[process.argv.indexOf("--scale") + 1] ?? 1) || 1;
const SERVICES = resolve(import.meta.dir, "../..");
const CONTRACTS = resolve(SERVICES, "../contracts");
const PORT = 32545;
const RPC = `http://127.0.0.1:${PORT}`;
const MARKETS = ["BTC", "ETH", "HYPE"];
const STEP: Record<string, number> = { BTC: 100, ETH: 5, HYPE: 0.1 };
const SZ: Record<string, number> = { BTC: 5, ETH: 4, HYPE: 2 };
const POOL_HL = "0x00000000000000000000000000000000000000E1" as Address;
const USDC = 10n ** 6n;
const WAD = 10n ** 18n;
const MAX = 2n ** 256n - 1n;
const DAY = 86_400;
const KIND_POOL = 1;
const KIND_QUOTE = 2;
const KIND_OFFER = 3;
const out = mkdtempSync(join(tmpdir(), "tourbillon-m6-run-"));
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

// ---------------------------------------------------------------- ABI (human-readable)

const abi = parseAbi([
  "struct Leg { bool isCall; uint128 kWad; int128 qty; }",
  "struct Part { uint256 tempo; uint256 weight; }",
  "struct Quote { address maker; bytes32 name; uint8 sides; uint128 kLoWad; uint128 kHiWad; uint32 tauLo; uint32 tauHi; uint64 sigmaBps; uint128 maxUnits; uint64 validUntil; uint64 nonce; }",
  "struct Lot { bytes32 market; uint256 seriesId; uint256 raw; uint256 bond; uint64 commitEnd; uint64 revealEnd; bool settled; address winner; uint256 price; }",
  // router, board
  "function applyRoute(bytes32)",
  "function markWad(bytes32) view returns (uint256)",
  "function volBps(bytes32) view returns (uint256)",
  "function markKey(bytes32) pure returns (bytes32)",
  "function latestRoundData(bytes32) view returns (uint80, int256, uint256, uint256, uint80)",
  "function vote(bytes32, uint80, uint256)",
  // tokens
  "function mint(address, uint256)",
  "function approve(address, uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  // pool
  "function deposit(uint256)",
  "function requestWithdraw(uint256)",
  "function claimShares(uint256)",
  "function withdraw(uint256)",
  "function depositOf(uint256, address) view returns (uint256)",
  "function withdrawOf(uint256, address) view returns (uint256)",
  "function round() view returns (uint256)",
  "function epoch() view returns (uint256)",
  "function navNow() view returns (uint256)",
  "function stressedLiability() view returns (uint256)",
  "function openSeries(bytes32) view returns (uint256[])",
  "function seriesRaw(uint256) view returns (uint256)",
  "function matchedRawOf(uint256) view returns (uint256)",
  "function setCaps(bytes32, uint256, uint256)",
  "function opensPaused() view returns (bool)",
  "function resumeOpens()",
  // book, engine, router
  "function balanceOf(uint256, address) view returns (uint256)",
  "function accrue(uint256, uint256) returns (uint256, bool)",
  "function buy(bytes32 market, Leg[] legs, Part[] movement, uint256 units, uint256 maxCost, uint256 deadline, Quote[] quotes, bytes[] sigs, uint256[] offerIds) returns (uint256, uint256, uint8)",
  "function sell(uint256, uint256, uint256, uint256) returns (uint256, uint256)",
  // MatchBook
  "function postOffer(bytes32 market, Leg[] legs, Part[] movement, uint64 sigmaBps, uint128 maxUnits, uint64 validUntil, bool useCover) returns (uint256)",
  "function cancelOffer(uint256)",
  "function claim(bytes32, uint256) returns (uint256, uint256)",
  "function earlyClose(bytes32, uint256, uint256, int256, uint256) returns (uint256, int256)",
  "function required(bytes32, uint256) view returns (uint256, uint256)",
  "function entries(bytes32, uint256) view returns (uint256 raw, uint256 usdcPerUnit, uint256 coverPerUnit, uint256 usdcLocked, uint256 whypeLocked, bool flagged)",
  "function sources(bytes32) view returns (uint8 kind, address owner, uint256 offerId)",
  "function seriesSources(uint256) view returns (bytes32[])",
  "function matchedRaw(uint256) view returns (uint256)",
  "function uncoveredRaw(uint256) view returns (uint256)",
  "function heldUsdc() view returns (uint256)",
  // vault
  "function freeOf(address, address) view returns (uint256)",
  "function lockedOf(address, address) view returns (uint256)",
  "function deposit(address, uint256)",
  "function withdraw(address, uint256)",
  // auction, feed
  "function start(bytes32) returns (uint256)",
  "function commit(uint256, bytes32)",
  "function reveal(uint256, uint64, bytes32)",
  "function settle(uint256)",
  "function lot(uint256) view returns (Lot)",
  "function read(bytes32, uint256) view returns (uint256 lastSigma, uint256 avgSigma, uint256 boardSigmaAtLast, uint256 count, uint256 updatedAt)",
  // errors
  "error Stale(bytes32 market, address source)",
  "error Stale(bytes32 key, uint256 updatedAt)",
  "error NoSource()",
  "error Expired(uint256 deadline)",
  "error NotCaughtUp(uint256 id)",
  "error NothingToSell(uint256 id)",
  "error CostAboveMax(uint256 cost, uint256 maxCost)",
  "error CoverageBreached(uint256 available, uint256 stressedLiability)",
  "error NotionalCapExceeded(bytes32 market, uint256 wouldBe, uint256 cap)",
  "error DirectionalCapExceeded(bytes32 market, uint256 wouldBe, uint256 cap)",
  "error OpenBookCapExceeded(bytes32 market, uint256 wouldBe, uint256 cap)",
  "error OpensArePaused()",
  "error MarketIsPaused(bytes32 market)",
  "error Insolvent(uint256 needed, uint256 available)",
  "error InsufficientFree(uint256 wanted, uint256 free)",
  "error InsufficientLocked(uint256 wanted, uint256 locked)",
  "error TooManySources(uint256 seriesId)",
  "error OfferClosed(uint256 offerId)",
  "error OfferExpired(uint256 offerId)",
  "error OfferTooSmall(uint256 offerId, uint256 left)",
  "error NothingMatched()",
  "error NotOpen(uint256 lotId)",
  "error BadReveal(uint256 lotId)",
  "error NothingToAuction(bytes32 market)",
  "error TooSoon(uint256 nextAt)",
  "error ZeroUnits()",
  "error ZeroRaw()",
]);
const events = parseAbi([
  "event Routed(address indexed buyer, uint256 indexed id, uint8 kind, uint256 sigmaBps, uint256 cost, address source)",
  "event ShapeBought(address indexed buyer, uint256 indexed id, bytes32 indexed market, uint256 units, uint256 raw, uint256 sWad, uint256 sigmaBps, int256 unitValueWad, uint256 premium, uint256 fee)",
  "event Sold(address indexed seller, uint256 indexed id, bytes32 indexed market, uint256 units, uint256 raw, uint256 sWad, uint256 sigmaBps, uint256 unitValueWad, uint256 gross, uint256 fee, uint256 net, bool markFromSample, bool volFromSample)",
  "event Matched(bytes32 indexed key, uint256 indexed seriesId, uint256 units, uint256 raw, uint256 usdcLocked, uint256 whypeLocked)",
  "event BoughtBack(bytes32 indexed key, uint256 indexed seriesId, uint256 raw, uint256 paidUsdc, uint256 paidWhype, uint256 shortfall)",
  "event DustAbsorbed(bytes32 indexed key, uint256 indexed seriesId, uint256 usdc)",
  "event Flagged(bytes32 indexed key, uint256 indexed seriesId, uint256 uncoveredRaw)",
  "event Claimed(bytes32 indexed key, uint256 indexed seriesId, uint256 usdcReleased, uint256 whypeReleased)",
  "event EarlyClosed(bytes32 indexed key, uint256 indexed seriesId, uint256 raw, uint256 units, int256 cost, uint256 fee)",
  "event OfferPosted(uint256 indexed offerId, address indexed writer, uint256 indexed seriesId, uint64 sigmaBps, uint128 maxUnits, uint64 validUntil)",
  "event OfferFilled(uint256 indexed offerId, uint256 units, uint256 raw)",
  "event OfferCancelled(uint256 indexed offerId, uint256 usdcReturned, uint256 whypeReturned)",
  "event BuybackSettled(uint256 indexed id, uint256 paidUsdc, uint256 paidWhype, uint256 shortfall)",
  "event BuybackFailed(uint256 indexed id, uint256 rawSold)",
  "event Started(uint256 indexed lotId, bytes32 indexed market, uint256 indexed seriesId, uint256 raw, uint256 bond, uint64 commitEnd, uint64 revealEnd)",
  "event Forfeited(uint256 indexed lotId, address indexed bidder, uint256 bond, string why)",
  "event Settled(uint256 indexed lotId, address winner, uint256 sigmaBps, uint256 raw, uint256 price, uint256 reserve)",
  "event Fill(bytes32 indexed market, uint8 indexed bucket, uint8 kind, uint256 sigmaBps, uint256 boardSigmaBps, uint256 weight)",
]);

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return ((await res.json()) as { result: unknown }).result;
}

// ---------------------------------------------------------------- chain and contracts

say(`logs in ${out}; scale ${scale}`);
const anvil = Bun.spawn(["anvil", "--port", String(PORT), "--accounts", "24", "--silent"], { stdout: "ignore", stderr: "ignore" });
const client = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: 200 }) as PublicClient;
for (let i = 0; i < 50; i++) {
  try {
    await client.getChainId();
    break;
  } catch {
    await sleep(100);
  }
}
const acc = ((await rpc("eth_accounts")) as Address[]).map((a) => getAddress(a));
const [DEPLOYER, ADMIN, S1, S2, S3, ANYONE, POKER1, POKER2, RISK, L1, L2, T1, T2, T3, MK1, MK2, MK3, MK4, W1, W2, PROTO, BIG] = acc as Address[];
const TRADERS = [T1!, T2!, T3!];
const BUYERS = [...TRADERS, BIG!];
const MAKERS = [MK1!, MK2!, MK3!, MK4!];
const env = { ...process.env, ADMIN: ADMIN!, SIGNERS: `${S1},${S2},${S3}`, RISK_PAUSER: RISK!, PROTOCOL_RECIPIENT: PROTO!, M3_DEPLOYMENT: "deployments/31337-m6.json" };
for (const [script, sender] of [["DeployM1.s.sol:DeployM1", DEPLOYER!], ["DeployM6.s.sol:DeployM6", DEPLOYER!], ["ListEquityFeed.s.sol:ListEquityFeed", ADMIN!]] as const) {
  const r = Bun.spawnSync(["forge", "script", `script/${script}`, "--rpc-url", RPC, "--unlocked", "--sender", sender, "--broadcast"], { cwd: CONTRACTS, env });
  if (r.exitCode !== 0) throw new Error(`${script} failed: ${r.stderr.toString()}`);
}
const m1File = join(out, "31337.json");
const m6File = join(out, "31337-m6.json");
copyFileSync(join(CONTRACTS, "deployments", "31337.json"), m1File);
copyFileSync(join(CONTRACTS, "deployments", "31337-m6.json"), m6File);
const m1 = JSON.parse(readFileSync(m1File, "utf8")) as Record<string, Address>;
const m6 = JSON.parse(readFileSync(m6File, "utf8")) as Record<string, Address>;
const dep = loadM6Deployment(m6File);
const POOL = m6.MainspringPool!;
const ENGINE = m6.Engine!;
const BOOK = m6.PathFundingBook!;
const MUSDC = m6.MockUSDC!;
const VAULT = m6.MakerVault!;
const MB = m6.MatchBook!;
const OB = m6.OpenBook!;
const RA = m6.RiskAuction!;
const FEED = m6.VolFeed!;
const ROUTER = m1.MarkRouter!;
const BOARD = m1.QuorumBoard!;
await rpc("evm_increaseTime", [3600]);
await rpc("evm_mine");
// automine (one transaction per block, so a routed buy can be re-priced at its exact parent state) plus an empty block
// every second, so the chain clock moves for the services as it would with a block time
const ticker = setInterval(() => void rpc("evm_mine").catch(() => {}), 1_000);

type Receipt = Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>>;
type TxResult = { ok: true; receipt: Receipt } | { ok: false; reason: string };
const decodeErr = (e: unknown): string => {
  const name = revertName(e);
  if (name) return name;
  const data = /(0x[0-9a-fA-F]{8,})/.exec((e as Error).message)?.[1] as Hex | undefined;
  if (data) {
    try {
      return decodeErrorResult({ abi, data }).errorName;
    } catch {
      return `unknown error ${data.slice(0, 10)}`;
    }
  }
  return (e as Error).message.split("\n")[0]!;
};
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

for (const m of MARKETS) await must(ANYONE!, ROUTER, "applyRoute", [b32(m)]);
const START_USDC = new Map<Address, bigint>();
for (const w of [L1!, L2!, ...BUYERS, W1!, W2!, MK3!, MK4!]) {
  await must(w, MUSDC, "mint", [w, 20_000_000n * USDC]);
  for (const spender of [POOL, ENGINE, MB, VAULT]) await must(w, MUSDC, "approve", [spender, 10n ** 30n]);
  START_USDC.set(w, 20_000_000n * USDC);
}
say(`deployed; pool ${POOL}; OpenBook ${OB}; MatchBook ${MB}; RiskAuction ${RA}`);

// ---------------------------------------------------------------- the simulated venue and the price path

const PRICE: Record<string, number> = { BTC: 100_000, ETH: 3_000, HYPE: 40 };
const sim = new SimVenue(MARKETS.map((n) => ({ name: n, szDecimals: SZ[n]!, mid: PRICE[n]! })));
sim.deposit(1_000_000);
let walking = true;
const pricer = (async () => {
  let k = 1;
  while (walking) {
    for (const m of MARKETS) {
      PRICE[m] = PRICE[m]! * (1 + Math.sin(k * 1.7 + m.length) * 0.0015);
      sim.setMid(m, Number(PRICE[m]!.toPrecision(5)));
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
function service(name: string, cwd: string, entry: string, args: string[]): Proc {
  const p = Bun.spawn(["bun", entry, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  void pipe(p.stdout, join(out, `${name}.log`));
  void pipe(p.stderr, join(out, `${name}.err`));
  say(`${name} started`);
  return p;
}
const statusFile = join(out, "hedger-status.json");
const GW_PORT = 32600;
const GATEWAY = `http://127.0.0.1:${GW_PORT}`;
const signers: Proc[] = [];
const procs: Proc[] = [];
process.on("exit", () => {
  for (const p of procs) p.kill("SIGKILL");
  anvil.kill("SIGKILL");
});
for (const [i, s] of [S1!, S2!, S3!].entries()) {
  const p = service(`signer-${i + 1}`, join(SERVICES, "quorum-signer"), "src/main.ts", ["--deployment", m1File, "--rpc", RPC, "--local-unlocked", s, "--hl-api", sim.url, "--test-vol", "0.45", "--equity-pool", POOL, "--equity-hl-user", POOL_HL]);
  signers.push(p);
  procs.push(p);
}
procs.push(service("poker-primary", join(SERVICES, "poker"), "src/main.ts", ["--deployment", m6File, "--rpc", RPC, "--local-unlocked", POKER1!, "--role", "primary"]));
procs.push(service("poker-backup", join(SERVICES, "poker"), "src/main.ts", ["--deployment", m6File, "--rpc", RPC, "--local-unlocked", POKER2!, "--role", "backup"]));
procs.push(service("hedger", join(SERVICES, "hedger"), "src/main.ts", ["--deployment", m6File, "--rpc", RPC, "--hl-user", POOL_HL, "--venue", "sim", "--venue-url", sim.url, "--status-file", statusFile, "--tick-seconds", "15"]));
procs.push(service("risk-monitor", join(SERVICES, "risk-monitor"), "src/main.ts", ["--deployment", m6File, "--rpc", RPC, "--local-unlocked", RISK!, "--hl-api", sim.url, "--hl-user", POOL_HL, "--hedger-status", statusFile, "--equity-every-seconds", "300", "--tick-seconds", "20"]));
procs.push(service("maker-gateway", join(SERVICES, "maker-gateway"), "src/main.ts", ["--deployment", m6File, "--rpc", RPC, "--port", String(GW_PORT)]));

// ---------------------------------------------------------------- helpers

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
const marksFresh = () => waitFor("router marks and board vols fresh", async () => (await Promise.all(MARKETS.map(async (m) => (await routerMark(m)) !== null && (await boardFresh(m))))).every(Boolean), 240_000);
const warps: { at: number; s: number }[] = [];
async function warp(seconds: number, label: string) {
  await rpc("evm_increaseTime", [seconds]);
  await rpc("evm_mine");
  warps.push({ at: Date.now(), s: seconds });
  say(`chain clock +${seconds >= DAY ? `${seconds / DAY} d` : `${seconds / 60} min`} (${label})`);
}
const chainNow = async () => (await client.getBlock()).timestamp;
const settledRound = async (r: bigint) => (await read<bigint>(POOL, "round")) > r;
async function nextSettlement(label: string, maxMs = 300_000): Promise<bigint> {
  const r = await read<bigint>(POOL, "round");
  await waitFor(label, () => settledRound(r), maxMs);
  return r;
}
async function walkedNorm(id: bigint): Promise<bigint> {
  const { result } = await client.simulateContract({ address: BOOK, abi, functionName: "accrue", args: [id, MAX], account: ANYONE! } as never);
  return (result as readonly [bigint, boolean])[0];
}

// ---------------------------------------------------------------- shapes and ledgers

type Leg = { isCall: boolean; k: number; qty: number };
type Attempt = { kind: string; who: string; ok: boolean; reason?: string; gas?: bigint; phase: string; routed?: number };
const attempts: Attempt[] = [];
let phase = "setup";
let rng = 0x4d36;
const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
const kAt = (m: string, x: number) => Math.round(x / STEP[m]!) * STEP[m]!;
const legArgs = (legs: Leg[]) => legs.map((l) => ({ isCall: l.isCall, kWad: wadStr(l.k), qty: wadStr(l.qty) }));
const neg = (legs: Leg[]) => legs.map((l) => ({ ...l, qty: -l.qty }));
const tempoArg = (t: number) => [{ tempo: BigInt(t), weight: WAD }];

/// Buyer shapes around the mark (holder's side, spelled the book's one way).
function buyerShape(m: string, mark: number, kind: number): Leg[] {
  const K = kAt(m, mark);
  const w = Math.max(STEP[m]!, kAt(m, mark * 0.02));
  if (kind === 0) return [{ isCall: true, k: K, qty: 1 }, { isCall: true, k: K + w, qty: -1 }]; // call spread
  if (kind === 1) return [{ isCall: false, k: K - w, qty: -1 }, { isCall: false, k: K, qty: 1 }]; // put spread
  if (kind === 2) return [{ isCall: true, k: K - w, qty: 1 }, { isCall: true, k: K, qty: -2 }, { isCall: true, k: K + w, qty: 1 }]; // call fly
  if (kind === 3) return [{ isCall: true, k: K, qty: 1 }]; // a single call: no maker can write it (unbounded), the pool fills
  return [{ isCall: false, k: kAt(m, mark * 0.97), qty: 1 }]; // a single put: bounded for a maker
}

const seriesTerms = new Map<string, { market: string; legs: Leg[]; tempo: number }>();
const held = new Map<Address, Set<string>>();
const paid = new Map<Address, bigint>();
const got = new Map<Address, bigint>();
type RouteCheck = { id: bigint; kind: number; cost: bigint; expected: bigint; expectedKind: number; ok: boolean; candidates: number };
const routeChecks: RouteCheck[] = [];
const law1Mismatch: string[] = [];
type FeedFill = { market: string; bucket: number; sigma: bigint; weight: bigint; t: bigint };
const feedFills: FeedFill[] = [];
type Offer = { id: bigint; writer: Address; market: string; legs: Leg[]; tempo: number; escrow: bigint; filledUsdc: bigint; cancelled: boolean; returned: bigint };
const offers: Offer[] = [];
const keysSeen = new Map<Hex, { owner: Address; kind: number }>();
const proRata: string[] = [];
let buybacks = 0;
let buybackSources = 0;
let dustEvents = 0;
let shortfallBeyondDust = 0;
const sellFails: Attempt[] = [];

async function bestQuotes(m: string, legs: Leg[], tempo: number, units: bigint): Promise<{ quotes: Quote[]; sigs: Hex[] }> {
  try {
    const res = await fetch(new URL("/best", GATEWAY), { method: "POST", body: toJson({ name: b32(m), legs: legArgs(legs), movement: tempoArg(tempo), units }) });
    const body = (await res.json()) as { quotes?: { quote: Record<string, string>; sig: Hex }[] };
    const qs = (body.quotes ?? []).map((x) => ({
      maker: getAddress(x.quote.maker!),
      name: x.quote.name as Hex,
      sides: Number(x.quote.sides),
      kLoWad: BigInt(x.quote.kLoWad!),
      kHiWad: BigInt(x.quote.kHiWad!),
      tauLo: Number(x.quote.tauLo),
      tauHi: Number(x.quote.tauHi),
      sigmaBps: BigInt(x.quote.sigmaBps!),
      maxUnits: BigInt(x.quote.maxUnits!),
      validUntil: BigInt(x.quote.validUntil!),
      nonce: BigInt(x.quote.nonce!),
    }));
    return { quotes: qs, sigs: (body.quotes ?? []).map((x) => x.sig) };
  } catch {
    return { quotes: [], sigs: [] };
  }
}

/// Re-prices one routed buy candidate by candidate at the state just before it (block − 1): the pool alone, each quote
/// alone, each offer alone. A candidate's cost counts only when the single-candidate simulation filled from it.
async function independentBest(who: Address, args: readonly unknown[], quotes: Quote[], sigs: Hex[], offerIds: bigint[], before: bigint): Promise<{ cost: bigint; kind: number; n: number }> {
  const [m, legs, mv, units, maxCost, deadline] = args;
  const simBuy = async (qs: Quote[], ss: Hex[], os: bigint[]) => {
    try {
      const { result } = await client.simulateContract({ address: OB, abi, functionName: "buy", args: [m, legs, mv, units, maxCost, deadline, qs, ss, os], account: who, blockNumber: before } as never);
      const [, cost, kind] = result as readonly [bigint, bigint, number];
      return { cost, kind };
    } catch {
      return null;
    }
  };
  let best = { cost: MAX, kind: 0 };
  let n = 0;
  const pool = await simBuy([], [], []);
  if (pool && pool.kind === KIND_POOL) {
    best = pool;
    n++;
  }
  for (let i = 0; i < quotes.length; i++) {
    const r = await simBuy([quotes[i]!], [sigs[i]!], []);
    if (r && r.kind === KIND_QUOTE) {
      n++;
      if (r.cost < best.cost) best = r;
    }
  }
  for (const o of offerIds) {
    const r = await simBuy([], [], [o]);
    if (r && r.kind === KIND_OFFER) {
      n++;
      if (r.cost < best.cost) best = r;
    }
  }
  return { ...best, n };
}

function bucketOf(tempo: number): number {
  if (tempo < 17_636) return 0;
  if (tempo < 228_593) return 1;
  if (tempo < 1_252_055) return 2;
  return 3;
}

async function routedBuy(who: Address, m: string, legs: Leg[], tempo: number, unitsF: number, opts: { quotes?: boolean; offers?: boolean } = {}): Promise<bigint | null> {
  const units = wadStr(unitsF);
  const { quotes, sigs } = opts.quotes === false ? { quotes: [], sigs: [] } : await bestQuotes(m, legs, tempo, units);
  const offerIds = opts.offers === false ? [] : offers.filter((o) => !o.cancelled && o.market === m).map((o) => o.id);
  const deadline = (await chainNow()) + 3600n;
  const args = [b32(m), legArgs(legs), tempoArg(tempo), units, 10n ** 13n, deadline, quotes, sigs, offerIds] as const;
  const r = await tx(who, OB, "buy", args);
  const a: Attempt = { kind: "buy", who, ok: r.ok, reason: r.ok ? undefined : r.reason, gas: r.ok ? r.receipt.gasUsed : undefined, phase };
  attempts.push(a);
  if (!r.ok) return null;
  const evs = decoded(r.receipt);
  const routed = evs.find((e) => e.eventName === "Routed")!;
  const sb = evs.find((e) => e.eventName === "ShapeBought")!;
  const id = routed.args.id as bigint;
  const kind = Number(routed.args.kind);
  const cost = routed.args.cost as bigint;
  a.routed = kind;
  if ((sb.args.premium as bigint) + (sb.args.fee as bigint) !== cost) law1Mismatch.push(`buy ${id}: Routed cost ${cost} ≠ premium + fee ${(sb.args.premium as bigint) + (sb.args.fee as bigint)}`);
  seriesTerms.set(id.toString(), { market: m, legs, tempo });
  const set = held.get(who) ?? new Set();
  set.add(id.toString());
  held.set(who, set);
  paid.set(who, (paid.get(who) ?? 0n) + cost);
  for (const e of evs) {
    if (e.eventName === "Matched") {
      const key = e.args.key as Hex;
      if (!keysSeen.has(key)) {
        const [skind, owner] = await read<readonly [number, Address, bigint]>(MB, "sources", [key]);
        keysSeen.set(key, { owner, kind: skind });
      }
      if (kind === KIND_OFFER) {
        const o = offers.find((x) => x.writer === keysSeen.get(key)!.owner && !x.cancelled);
        if (o) o.filledUsdc += e.args.usdcLocked as bigint;
      }
    }
  }
  // the router's choice against an independent re-pricing at the state just before
  const best = await independentBest(who, args, quotes, sigs, offerIds, r.receipt.blockNumber - 1n);
  routeChecks.push({ id, kind, cost, expected: best.cost, expectedKind: best.kind, ok: best.cost === cost, candidates: best.n });
  if (kind !== KIND_POOL) await recordFeed(r.receipt, m, tempo, units, routed.args.sigmaBps as bigint);
  return id;
}

async function recordFeed(receipt: Receipt, m: string, tempo: number, units: bigint, sigma: bigint): Promise<void> {
  const s = await read<bigint>(ROUTER, "markWad", [b32(m)], receipt.blockNumber - 1n);
  feedFills.push({ market: m, bucket: bucketOf(tempo), sigma, weight: ((units * s) / 10n ** 36n) * 10n ** 6n, t: (await client.getBlock({ blockNumber: receipt.blockNumber })).timestamp });
}

async function sell(who: Address, id: string, all = true): Promise<void> {
  const bal = await read<bigint>(BOOK, "balanceOf", [BigInt(id), who]);
  if (bal === 0n) {
    held.get(who)?.delete(id);
    return;
  }
  // the sources and their raw just before
  const keys = await read<readonly Hex[]>(MB, "seriesSources", [BigInt(id)]);
  const before = new Map<Hex, bigint>();
  for (const k of keys) before.set(k, (await read<readonly [bigint, bigint, bigint, bigint, bigint, boolean]>(MB, "entries", [k, BigInt(id)]))[0]);
  const units = all ? MAX : ((bal * (await walkedNorm(BigInt(id)))) / WAD) * 4n / 10n;
  const r = await tx(who, ENGINE, "sell", [BigInt(id), units === 0n ? MAX : units, 0n, (await chainNow()) + 3600n]);
  const a: Attempt = { kind: "sell", who, ok: r.ok, reason: r.ok ? undefined : r.reason, gas: r.ok ? r.receipt.gasUsed : undefined, phase };
  attempts.push(a);
  if (!r.ok) {
    if (r.reason !== "NothingToSell") sellFails.push(a);
    return;
  }
  const evs = decoded(r.receipt);
  const sold = evs.find((e) => e.eventName === "Sold")!;
  got.set(who, (got.get(who) ?? 0n) + (sold.args.net as bigint));
  const bbs = evs.filter((e) => e.eventName === "BoughtBack");
  if (bbs.length > 0) {
    buybacks++;
    buybackSources += new Set(bbs.map((b) => b.args.key as Hex)).size;
    const total = [...before.values()].reduce((x, y) => x + y, 0n);
    const rawSold = sold.args.raw as bigint;
    const closeTotal = rawSold < total ? rawSold : total;
    let closed = 0n;
    // per source: the pro-rata pass and, on a partial sell, the remainder pass (a few wei) each emit BoughtBack
    const perKey = new Map<Hex, bigint>();
    for (const b of bbs) {
      perKey.set(b.args.key as Hex, (perKey.get(b.args.key as Hex) ?? 0n) + (b.args.raw as bigint));
      if ((b.args.shortfall as bigint) > 1n) shortfallBeyondDust++;
    }
    for (const [key, rc] of perKey) {
      const raw0 = before.get(key) ?? 0n;
      closed += rc;
      const exp = rawSold >= total ? raw0 : (closeTotal * raw0) / total;
      if (rc + BigInt(perKey.size) < exp || rc > exp + BigInt(perKey.size)) proRata.push(`series ${id}: source closed ${rc}, pro rata ${exp}`);
    }
    if (closed !== closeTotal) proRata.push(`series ${id}: closed ${closed} ≠ min(sold ${rawSold}, matched ${total})`);
  }
  dustEvents += evs.filter((e) => e.eventName === "DustAbsorbed").length;
  if (all) held.get(who)?.delete(id);
}
const sellAll = async (who: Address) => {
  for (const id of [...(held.get(who) ?? [])]) await sell(who, id);
};

/// Law 4 per matched entry, in the runner's own maths: every entry's locked USDC ≥ the exact worst case of the units
/// owed now (the maker side of the series' legs, the walked norm), and ≥ the MatchBook's own `required`; every maker's
/// vault locked = its entries' locked + any auction bond; the pool mirrors the MatchBook; nothing uncovered.
const law4: string[] = [];
const mirror: string[] = [];
let law4Checks = 0;
const bondsLocked = new Map<Address, bigint>();
async function checkMatched(label: string): Promise<void> {
  const perMaker = new Map<Address, bigint>();
  const ids = new Set<string>();
  for (const m of MARKETS) for (const id of await read<readonly bigint[]>(POOL, "openSeries", [b32(m)])) ids.add(id.toString());
  for (const sid of ids) {
    const id = BigInt(sid);
    const keys = await read<readonly Hex[]>(MB, "seriesSources", [id]);
    let sum = 0n;
    for (const k of keys) {
      const e = await read<readonly [bigint, bigint, bigint, bigint, bigint, boolean]>(MB, "entries", [k, id]);
      const [raw, , , locked, , flagged] = e;
      if (flagged) law4.push(`${label}: series ${sid} source ${k.slice(0, 10)} flagged`);
      sum += raw;
      let src = keysSeen.get(k);
      if (!src) {
        const [skind, owner] = await read<readonly [number, Address, bigint]>(MB, "sources", [k]);
        src = { owner, kind: skind };
        keysSeen.set(k, src);
      }
      if (src.kind !== 2 /* not an offer */) perMaker.set(src.owner, (perMaker.get(src.owner) ?? 0n) + locked);
      if (raw === 0n) continue;
      law4Checks++;
      const terms = seriesTerms.get(sid);
      const [reqU] = await read<readonly [bigint, bigint]>(MB, "required", [k, id]);
      if (locked < reqU) law4.push(`${label}: series ${sid} locked ${locked} < required ${reqU}`);
      if (terms) {
        const w = writerWorstPerUnit(legArgs(terms.legs));
        const norm = await walkedNorm(id);
        const unitsNow = (raw * norm + WAD - 1n) / WAD;
        const need = w === null ? MAX : ((w * unitsNow) / WAD + 10n ** 12n - 1n) / 10n ** 12n;
        if (locked + 1n < need) law4.push(`${label}: series ${sid} locked ${locked} < exact worst case ${need}`);
      }
    }
    const [mbRaw, unc, poolM] = await Promise.all([read<bigint>(MB, "matchedRaw", [id]), read<bigint>(MB, "uncoveredRaw", [id]), read<bigint>(POOL, "matchedRawOf", [id])]);
    if (mbRaw !== sum) mirror.push(`${label}: series ${sid} MatchBook matched ${mbRaw} ≠ Σ entries ${sum}`);
    if (poolM !== mbRaw) mirror.push(`${label}: series ${sid} pool mirror ${poolM} ≠ MatchBook ${mbRaw}`);
    if (unc !== 0n) mirror.push(`${label}: series ${sid} uncovered ${unc}`);
  }
  for (const mk of [MK1!, MK2!]) {
    const vl = await read<bigint>(VAULT, "lockedOf", [mk, MUSDC]);
    const exp = (perMaker.get(mk) ?? 0n) + (bondsLocked.get(mk) ?? 0n);
    if (vl !== exp) law4.push(`${label}: ${mk.slice(0, 6)} vault locked ${vl} ≠ entries ${perMaker.get(mk) ?? 0n} + bonds ${bondsLocked.get(mk) ?? 0n}`);
  }
}

// ---------------------------------------------------------------- trading loop

async function randomTrade(): Promise<void> {
  const t = pick(TRADERS);
  if (rand() < 0.3 && (held.get(t)?.size ?? 0) > 0) return sell(t, pick([...held.get(t)!]), rand() < 0.6);
  const m = pick(["BTC", "ETH"]);
  const mark = (await routerMark(m)) ?? PRICE[m]!;
  const kind = rand() < 0.8 ? Math.floor(rand() * 3) : 3 + Math.floor(rand() * 2);
  const legs = buyerShape(m, mark, kind);
  const tempo = pick([DAY, 7 * DAY]);
  const notional = kind >= 3 ? 2_000 + rand() * 6_000 : 5_000 + rand() * 25_000;
  await routedBuy(t, m, legs, tempo, notional / PRICE[m]!);
}
let trading = false;
let quiet = false;
let busy = false;
const traderLoop = (async () => {
  while (true) {
    if (!trading) {
      if (phase === "done") break;
      await sleep(1_000);
      continue;
    }
    if (!quiet) {
      busy = true;
      try {
        await randomTrade();
      } catch (e) {
        say(`trade threw: ${(e as Error).message.split("\n")[0]}`);
      }
      busy = false;
    }
    await sleep(12_000 * scale);
  }
})();
async function hush(): Promise<void> {
  quiet = true;
  while (busy) await sleep(300);
}

/// Hedger checkpoint: with nothing moving, the hedger's next target per market = an independent delta from the run's
/// ledger of legs and the raw the pool still carries (series raw − the MatchBook's matched raw).
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
    let sum = 0;
    for (const id of await read<readonly bigint[]>(POOL, "openSeries", [b32(m)])) {
      const terms = seriesTerms.get(id.toString());
      if (!terms) continue;
      const [raw, mraw, norm] = await Promise.all([read<bigint>(POOL, "seriesRaw", [id]), read<bigint>(MB, "matchedRaw", [id]), walkedNorm(id)]);
      const carried = raw > mraw ? raw - mraw : 0n;
      const units = Number(formatUnits((carried * norm) / WAD, 18));
      sum += units * terms.legs.reduce((a, l) => a + l.qty * blendDelta(l.isCall, s, l.k, sig, [{ tempo: terms.tempo, weight: 1 }]), 0);
    }
    const target = Number(plan.target);
    const ok = Math.abs(target - sum) <= Math.max(0.01, Math.abs(sum) * 0.01);
    hedgeChecks.push({ label, market: m, target, expected: sum, ok });
    say(`hedger checkpoint ${label} ${m}: target ${target.toFixed(4)} vs independent ${sum.toFixed(4)} (${ok ? "ok" : "MISMATCH"})`);
  }
  quiet = false;
}

// ---------------------------------------------------------------- the run

const phaseAt: Record<string, number> = {};
const setPhase = (p: string) => {
  phase = p;
  phaseAt[p] = Date.now();
  say(`phase: ${p}`);
};

await marksFresh();
setPhase("A warm-up");
await waitFor("the keeper's first settlement", () => settledRound(0n), 240_000);
await must(L1!, POOL, "deposit", [3_000_000n * USDC]);
await must(L2!, POOL, "deposit", [2_000_000n * USDC]);
await warp(3600, "the LP round");
const lpRound = await nextSettlement("the LP round settled");
for (const lp of [L1!, L2!]) if ((await read<bigint>(POOL, "depositOf", [lpRound, lp])) > 0n) await must(lp, POOL, "claimShares", [lpRound]);
await marksFresh();
say(`NAV ${usd(await read<bigint>(POOL, "navNow")).toFixed(2)} after the LP round`);
// two maker bots, each funding its vault (anvil-signed quotes; no key)
// maker 2 is the cheaper one on BTC, maker 1 on ETH, so both fill
for (const [name, mk, btcOff, ethOff, band] of [["maker-1", MK1!, "-300", "-600", "0.3"], ["maker-2", MK2!, "-500", "-300", "0.15"]] as const) {
  procs.push(service(name, join(SERVICES, "maker-gateway"), "src/bot.ts", ["--deployment", m6File, "--rpc", RPC, "--gateway", GATEWAY, "--maker", mk, "--market", "BTC", "--sigma-offset-bps", btcOff, "--band-pct", band, "--max-units", "40", "--every-seconds", "30", "--fund", "300000"]));
  await waitFor(`${name} funded`, async () => (await read<bigint>(VAULT, "freeOf", [mk, MUSDC])) > 0n, 60_000);
  procs.push(service(`${name}-eth`, join(SERVICES, "maker-gateway"), "src/bot.ts", ["--deployment", m6File, "--rpc", RPC, "--gateway", GATEWAY, "--maker", mk, "--market", "ETH", "--sigma-offset-bps", ethOff, "--band-pct", band, "--max-units", "800", "--every-seconds", "30"]));
}
await waitFor("quotes at the gateway", async () => ((await (await fetch(new URL("/health", GATEWAY))).json()) as { quotes: number }).quotes >= 4, 90_000);

setPhase("B routing and offers");
// writer offers: W1 on a BTC 7-day call spread well under the makers; W2 on an ETH 1-day put spread
const offerOf = async (w: Address, m: string, kind: number, tempo: number, sigmaOff: number, maxUnits: number) => {
  const mark = (await routerMark(m))!;
  const legs = buyerShape(m, mark, kind);
  const board = await read<bigint>(BOARD, "volBps", [b32(m)]);
  const r = await must(w, MB, "postOffer", [b32(m), legArgs(neg(legs)), tempoArg(tempo), board + BigInt(sigmaOff), wadStr(maxUnits), (await chainNow()) + 30n * 86_400n, false]);
  attempts.push({ kind: "postOffer", who: w, ok: true, gas: r.gasUsed, phase });
  const ev = decoded(r).find((e) => e.eventName === "OfferPosted")!;
  const bal0 = START_USDC.get(w)!;
  const bal1 = await read<bigint>(MUSDC, "balanceOf", [w]);
  const o: Offer = { id: ev.args.offerId as bigint, writer: w, market: m, legs, tempo, escrow: bal0 - bal1, filledUsdc: 0n, cancelled: false, returned: 0n };
  offers.push(o);
  say(`offer ${o.id} by ${w.slice(0, 6)} on ${m}: σ ${board + BigInt(sigmaOff)} bps, escrow ${usd(o.escrow)}`);
  return o;
};
const oBTC = await offerOf(W1!, "BTC", 0, 7 * DAY, -900, 3);
const oETH = await offerOf(W2!, "ETH", 1, DAY, -1000, 40);
trading = true;
// buyers who want exactly the offers' shapes
await routedBuy(T1!, "BTC", oBTC.legs, oBTC.tempo, 1);
await routedBuy(T2!, "ETH", oETH.legs, oETH.tempo, 10);
await sleep(150_000 * scale);
await routedBuy(T3!, "BTC", oBTC.legs, oBTC.tempo, 1);
await routedBuy(T1!, "ETH", oETH.legs, oETH.tempo, 8);
await sleep(150_000 * scale);
// W2 cancels after a partial fill: the rest of its escrow comes back exactly
await hush();
{
  const r = await must(W2!, MB, "cancelOffer", [oETH.id]);
  attempts.push({ kind: "cancelOffer", who: W2!, ok: true, gas: r.gasUsed, phase });
  const ev = decoded(r).find((e) => e.eventName === "OfferCancelled")!;
  oETH.cancelled = true;
  oETH.returned = ev.args.usdcReturned as bigint;
  say(`offer ${oETH.id} cancelled: ${usd(oETH.returned)} returned of ${usd(oETH.escrow)} escrow (${usd(oETH.filledUsdc)} moved to matched entries)`);
}
quiet = false;
await checkMatched("after routing");
await hedgerCheckpoint("after routing");

setPhase("C law 2");
await hush();
for (const p of signers) p.kill("SIGSTOP");
await warp(16 * 60, "signers paused: marks and board vols go stale");
const law2: { what: string; ok: boolean; detail: string }[] = [];
{
  const mark = PRICE.BTC!;
  const legs = buyerShape("BTC", mark, 0);
  // a fresh quote signed through anvil (the bots skip quoting while the board is stale)
  const mw = createWalletClient({ chain: foundry, transport: http(RPC), account: MK1! });
  const q = buildQuote({ maker: MK1!, market: "BTC", sigmaOffsetBps: 0, maxUnits: 10n * WAD, ttlSeconds: 1800, bandPct: 0.3 }, wadStr(kAt("BTC", mark)), 4000n, await chainNow(), 777n);
  const sig = await signQuote(mw, dep, q);
  const tryBuy = (qs: Quote[], ss: Hex[]) => tx(T1!, OB, "buy", [b32("BTC"), legArgs(legs), tempoArg(DAY), wadStr(0.1), 10n ** 13n, 2n ** 60n, qs, ss, []]);
  let r = await tryBuy([q], [sig]);
  law2.push({ what: "stale mark: no fill from anyone, even a valid quote", ok: !r.ok && r.reason === "Stale", detail: r.ok ? "filled" : r.reason });
  // fresh marks only (the signers' accounts vote MARK by hand; the board vols stay stale)
  for (const m of MARKETS) {
    const key = await read<Hex>(BOARD, "markKey", [b32(m)]);
    const [round] = await read<readonly [bigint, bigint, bigint, bigint, bigint]>(BOARD, "latestRoundData", [key]).catch(() => [0n] as const);
    const px = wadStr(Number(PRICE[m]!.toPrecision(5)));
    for (const s of [S1!, S2!, S3!]) await tx(s, BOARD, "vote", [key, round + 1n, px]);
  }
  const markOk = (await routerMark("BTC")) !== null;
  const volStale = !(await boardFresh("BTC"));
  r = await tryBuy([q], [sig]);
  const kind = r.ok ? Number(decoded(r.receipt).find((e) => e.eventName === "Routed")!.args.kind) : 0;
  law2.push({ what: "fresh mark, stale board: the pool is out, the maker's quote fills", ok: markOk && volStale && r.ok && kind === KIND_QUOTE, detail: `mark fresh ${markOk}, board stale ${volStale}, ${r.ok ? `filled kind ${kind}` : r.reason}` });
  if (r.ok) {
    await recordFeed(r.receipt, "BTC", DAY, wadStr(0.1), q.sigmaBps);
    for (const e of decoded(r.receipt)) if (e.eventName === "Matched" && !keysSeen.has(e.args.key as Hex)) keysSeen.set(e.args.key as Hex, { owner: MK1!, kind: 1 });
    const id = decoded(r.receipt).find((e) => e.eventName === "Routed")!.args.id as bigint;
    seriesTerms.set(id.toString(), { market: "BTC", legs, tempo: DAY });
    held.set(T1!, (held.get(T1!) ?? new Set()).add(id.toString()));
    paid.set(T1!, (paid.get(T1!) ?? 0n) + (decoded(r.receipt).find((e) => e.eventName === "Routed")!.args.cost as bigint));
  }
  r = await tryBuy([], []);
  law2.push({ what: "fresh mark, stale board, no quote: nothing fills", ok: !r.ok && r.reason === "NoSource", detail: r.ok ? "filled" : r.reason });
  for (const l of law2) say(`law 2: ${l.what}: ${l.ok ? "ok" : "FAIL"} (${l.detail})`);
}
for (const p of signers) p.kill("SIGCONT");
await marksFresh();
quiet = false;

setPhase("D early close");
await hush();
const early: { what: string; ok: boolean; detail: string }[] = [];
{
  // the largest matched entry of maker 1
  let best: { key: Hex; id: bigint; raw: bigint; market: string; owner: Address } | null = null;
  for (const [k, src] of keysSeen) {
    if (src.kind === 2) continue;
    for (const sid of seriesTerms.keys()) {
      const e = await read<readonly [bigint, bigint, bigint, bigint, bigint, boolean]>(MB, "entries", [k, BigInt(sid)]);
      if (e[0] > (best?.raw ?? 0n)) best = { key: k, id: BigInt(sid), raw: e[0], market: seriesTerms.get(sid)!.market, owner: src.owner };
    }
  }
  if (!best) early.push({ what: "a maker has a matched entry to close", ok: false, detail: "none" });
  else {
    const units = ((best.raw * (await walkedNorm(best.id))) / WAD) / 2n;
    const caps: Record<string, [bigint, bigint]> = { BTC: [5_000_000n * USDC, 1_000_000n * USDC], ETH: [3_000_000n * USDC, 600_000n * USDC] };
    const c = caps[best.market]!;
    await must(ADMIN!, POOL, "setCaps", [b32(best.market), 1n, c[1]]);
    say(`early close: ${best.owner.slice(0, 6)} on series ${String(best.id).slice(0, 8)}… (${best.market})`);
    let r = await tx(best.owner, MB, "earlyClose", [best.key, best.id, units, 2n ** 200n, (await chainNow()) + 3600n]);
    early.push({ what: "refused while the pool's notional cap blocks it (the pool takes the buyer's side back)", ok: !r.ok && r.reason === "NotionalCapExceeded", detail: r.ok ? "accepted" : r.reason });
    await must(ADMIN!, POOL, "setCaps", [b32(best.market), c[0], c[1]]);
    const m0 = await read<bigint>(POOL, "matchedRawOf", [best.id]);
    r = await tx(best.owner, MB, "earlyClose", [best.key, best.id, units, 2n ** 200n, (await chainNow()) + 3600n]);
    if (r.ok) attempts.push({ kind: "earlyClose", who: best.owner, ok: true, gas: r.receipt.gasUsed, phase });
    const ec = r.ok ? decoded(r.receipt).find((e) => e.eventName === "EarlyClosed") : undefined;
    const m1r = await read<bigint>(POOL, "matchedRawOf", [best.id]);
    early.push({ what: "accepted once the cap allows: the pool's matched raw falls by exactly the raw closed", ok: r.ok && !!ec && m0 - m1r === (ec.args.raw as bigint), detail: r.ok ? `closed raw ${ec?.args.raw}, cost ${usd(BigInt(ec?.args.cost as bigint))} USDC, mirror ${m0} → ${m1r}` : r.reason });
  }
  for (const l of early) say(`early close: ${l.what}: ${l.ok ? "ok" : "FAIL"} (${l.detail})`);
}
quiet = false;
await checkMatched("after the early close");

setPhase("E decay and claims");
await hush(); // no trading across a clock jump: until the signers vote again every open is refused Stale (law 2)
await warp(3600, "decay");
await nextSettlement("hour settled");
await marksFresh();
let claimedUsdc = 0n;
const claimExact: string[] = [];
for (const [k, src] of keysSeen) {
  for (const sid of seriesTerms.keys()) {
    const e = await read<readonly [bigint, bigint, bigint, bigint, bigint, boolean]>(MB, "entries", [k, BigInt(sid)]);
    if (e[3] === 0n) continue;
    const r = await tx(src.owner, MB, "claim", [k, BigInt(sid)]);
    attempts.push({ kind: "claim", who: src.owner, ok: r.ok, reason: r.ok ? undefined : r.reason, gas: r.ok ? r.receipt.gasUsed : undefined, phase });
    if (!r.ok) continue;
    claimedUsdc += decoded(r.receipt).find((x) => x.eventName === "Claimed")!.args.usdcReleased as bigint;
    const after = await read<readonly [bigint, bigint, bigint, bigint, bigint, boolean]>(MB, "entries", [k, BigInt(sid)]);
    const [reqU] = await read<readonly [bigint, bigint]>(MB, "required", [k, BigInt(sid)]);
    if (after[3] !== reqU) claimExact.push(`series ${sid}: locked ${after[3]} ≠ required ${reqU} after the claim`);
  }
}
say(`claims: ${usd(claimedUsdc).toFixed(2)} USDC released by decay; after every claim locked = required (${claimExact.length} exceptions)`);
quiet = false;
await checkMatched("after the claims");

setPhase("F auction week");
// a large pool-carried BTC 30-day call spread for the lot
const lotLegs = buyerShape("BTC", (await routerMark("BTC"))!, 0);
const lotSeries = await routedBuy(BIG!, "BTC", lotLegs, 30 * DAY, 4, { quotes: false, offers: false });
await hush();
trading = false;
await sleep(2_000);
const auction: { what: string; ok: boolean; detail: string }[] = [];
let lotId = 0n;
const salts = new Map<Address, Hex>();
const bidSigma = new Map<Address, bigint>();
{
  let r = await tx(ANYONE!, RA, "start", [b32("BTC")]);
  if (r.ok) attempts.push({ kind: "auction start", who: ANYONE!, ok: true, gas: r.receipt.gasUsed, phase });
  const st = r.ok ? decoded(r.receipt).find((e) => e.eventName === "Started") : undefined;
  lotId = (st?.args.lotId as bigint) ?? 0n;
  const lot = await read<{ seriesId: bigint; raw: bigint; bond: bigint }>(RA, "lot", [lotId]);
  auction.push({ what: "the lot is the largest carried BTC series (the 30-day spread), bond 5% of its worst case", ok: r.ok && lot.seriesId === lotSeries, detail: r.ok ? `series ${lot.seriesId}, raw ${formatUnits(lot.raw, 18)}, bond ${usd(lot.bond)}` : r.reason });
  // MK3 and MK4 fund their vaults for the bond
  for (const mk of [MK3!, MK4!]) await must(mk, VAULT, "deposit", [MUSDC, 50_000n * USDC]);
  const board = await read<bigint>(BOARD, "volBps", [b32("BTC")]);
  for (const [mk, off] of [[MK3!, -1500n], [MK1!, -800n], [MK4!, -1000n], [MK2!, -300n]] as const) {
    const sigma = board + off;
    const salt = keccak256(toHex(`salt-${mk}`));
    const hash = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }], [lotId, mk, sigma, salt]));
    r = await tx(mk, RA, "commit", [lotId, hash]);
    if (r.ok) attempts.push({ kind: "auction commit", who: mk, ok: true, gas: r.receipt.gasUsed, phase });
    else auction.push({ what: `commit by ${mk.slice(0, 6)}`, ok: false, detail: r.reason });
    salts.set(mk, salt);
    bidSigma.set(mk, sigma);
    bondsLocked.set(mk, lot.bond);
  }
  await checkMatched("bonds locked");
}
await warp(3 * DAY + 60, "the commit window ends");
await marksFresh();
{
  for (const mk of [MK3!, MK1!, MK2!]) {
    const r = await tx(mk, RA, "reveal", [lotId, bidSigma.get(mk)!, salts.get(mk)!]);
    if (r.ok) attempts.push({ kind: "auction reveal", who: mk, ok: true, gas: r.receipt.gasUsed, phase });
    else auction.push({ what: `reveal by ${mk.slice(0, 6)}`, ok: false, detail: r.reason });
  }
  // MK3, the lowest bid, empties its free balance: it will not be able to collateralise
  const free3 = await read<bigint>(VAULT, "freeOf", [MK3!, MUSDC]);
  await must(MK3!, VAULT, "withdraw", [MUSDC, free3]);
  say(`auction: three reveals; MK4 never reveals; MK3 withdrew its free ${usd(free3)} USDC`);
}
await warp(DAY + 60, "the reveal window ends");
await marksFresh();
{
  const before = await client.getBlockNumber();
  const stress0 = await read<bigint>(POOL, "stressedLiability");
  const nav0 = await read<bigint>(POOL, "navNow");
  const mraw0 = await read<bigint>(POOL, "matchedRawOf", [lotSeries!]);
  const pool0 = await read<bigint>(MUSDC, "balanceOf", [POOL]);
  const r = await tx(ANYONE!, RA, "settle", [lotId]);
  if (r.ok) attempts.push({ kind: "auction settle", who: ANYONE!, ok: true, gas: r.receipt.gasUsed, phase });
  if (!r.ok) auction.push({ what: "settle", ok: false, detail: r.reason });
  else {
    const n = r.receipt.blockNumber;
    if (n !== before + 1n) say(`note: ${n - before - 1n} other blocks before the settle; NAV read at the settle's parent block`);
    const navB = await read<bigint>(POOL, "navNow", [], n - 1n);
    const navA = await read<bigint>(POOL, "navNow", [], n);
    const evs = decoded(r.receipt);
    const settled = evs.find((e) => e.eventName === "Settled")!;
    const forfeits = evs.filter((e) => e.eventName === "Forfeited");
    const winner = settled.args.winner as Address;
    const price = settled.args.price as bigint;
    const reserve = settled.args.reserve as bigint;
    const base = (reserve * 10_000n) / 11_000n;
    const bonds = forfeits.reduce((a, e) => a + (e.args.bond as bigint), 0n);
    const d = navA - navB;
    const expected = base - price + bonds;
    const mraw1 = await read<bigint>(POOL, "matchedRawOf", [lotSeries!], n);
    const stress1 = await read<bigint>(POOL, "stressedLiability", [], n);
    auction.push({ what: "the lowest bidder (MK3) cannot collateralise: its bond goes to the pool", ok: forfeits.some((e) => e.args.bidder === MK3 && e.args.why === "no collateral"), detail: forfeits.map((e) => `${(e.args.bidder as string).slice(0, 6)}: ${e.args.why}`).join(", ") });
    auction.push({ what: "the unrevealed bid's bond (MK4) goes to the pool", ok: forfeits.some((e) => e.args.bidder === MK4 && e.args.why === "not revealed"), detail: "" });
    auction.push({ what: "the next lowest within the reserve (MK1) wins and writes the slice as a matched entry", ok: winner === MK1 && price <= reserve && mraw1 - mraw0 === (settled.args.raw as bigint) && evs.some((e) => e.eventName === "Matched"), detail: `winner ${winner.slice(0, 6)} at σ ${settled.args.sigmaBps}, price ${usd(price)}, reserve ${usd(reserve)}, matched raw +${formatUnits(mraw1 - mraw0, 18)}` });
    auction.push({ what: "NAV moves at settlement by value − price (+ the forfeited bonds); stress unchanged until the next epoch", ok: d >= expected - 3n && d <= expected + 3n && stress1 === stress0, detail: `NAV ${usd(d)} vs ${usd(base)} − ${usd(price)} + bonds ${usd(bonds)} = ${usd(expected)}; stress ${usd(stress0)} → ${usd(stress1)}; pool USDC ${usd(pool0)} → ${usd(await read<bigint>(MUSDC, "balanceOf", [POOL]))}` });
    for (const mk of MAKERS) bondsLocked.delete(mk);
    const lockedAfter = await Promise.all([MK2!, MK3!, MK4!].map((mk) => read<bigint>(VAULT, "lockedOf", [mk, MUSDC])));
    auction.push({ what: "bonds: the losing revealed bid (MK2) is unlocked; MK3 and MK4 hold nothing locked", ok: lockedAfter[1] === 0n && lockedAfter[2] === 0n, detail: `locked MK2 ${usd(lockedAfter[0]!)} (its matched entries), MK3 ${usd(lockedAfter[1]!)}, MK4 ${usd(lockedAfter[2]!)}` });
    await checkMatched("after the settlement");
    await warp(3600, "the next epoch");
    await nextSettlement("the epoch after the auction");
    const stress2 = await read<bigint>(POOL, "stressedLiability");
    auction.push({ what: "the next epoch's stress no longer counts the slice", ok: stress2 < stress0, detail: `stress ${usd(stress0)} → ${usd(stress2)}` });
  }
  for (const l of auction) say(`auction: ${l.what}: ${l.ok ? "ok" : "FAIL"} (${l.detail})`);
}
await marksFresh();
await hedgerCheckpoint("after the auction");

setPhase("G exits");
quiet = false;
for (const b of BUYERS) await sellAll(b);
await checkMatched("after every exit");
// the remaining offer is cancelled; makers claim what is left
for (const o of offers.filter((x) => !x.cancelled)) {
  const r = await must(o.writer, MB, "cancelOffer", [o.id]);
  o.cancelled = true;
  o.returned = decoded(r).find((e) => e.eventName === "OfferCancelled")!.args.usdcReturned as bigint;
}
for (const [k, src] of keysSeen) {
  for (const sid of seriesTerms.keys()) {
    const e = await read<readonly [bigint, bigint, bigint, bigint, bigint, boolean]>(MB, "entries", [k, BigInt(sid)]);
    if (e[3] > 0n) await tx(src.owner, MB, "claim", [k, BigInt(sid)]);
  }
}
await hedgerCheckpoint("at the end");
const endTime = Date.now();
phase = "done";
await traderLoop;
walking = false;
await pricer;
clearInterval(ticker);
for (const p of procs) p.kill("SIGTERM");
await Promise.all(procs.map((p) => p.exited));
sim.stop();

// ---------------------------------------------------------------- report

const report: string[] = [];
const crit: string[] = ["== criteria"];
const check = (n: number, ok: boolean, what: string) => crit.push(`${ok ? "PASS" : "FAIL"}  ${n}. ${what}`);
const median = (xs: bigint[]) => (xs.length ? [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[Math.floor(xs.length / 2)]! : 0n);
const buys = attempts.filter((a) => a.kind === "buy");
const byKind = (k: number) => buys.filter((a) => a.ok && a.routed === k).length;

// 1. two makers and routing
const makersFilled = new Set<string>();
const gw = lines("maker-gateway");
for (const r of routeChecks) if (r.kind === KIND_QUOTE) makersFilled.add(r.id.toString());
const fillSources = new Set<Address>();
for (const [, src] of keysSeen) if (src.kind !== 2) fillSources.add(src.owner);
const quotedBy = new Set([...lines("maker-1"), ...lines("maker-2")].filter((l) => l.msg === "quoted").map((l) => l.market));
const badRoutes = routeChecks.filter((r) => !r.ok);
report.push(`routed buys ${buys.filter((a) => a.ok).length}/${buys.length}: pool ${byKind(KIND_POOL)}, makers ${byKind(KIND_QUOTE)}, offers ${byKind(KIND_OFFER)}; makers with matched fills: ${[...fillSources].map((a) => a.slice(0, 6)).join(", ")}; bot quotes posted ${lines("maker-1").concat(lines("maker-2"), lines("maker-1-eth"), lines("maker-2-eth")).filter((l) => l.msg === "quoted").length}; routes re-priced ${routeChecks.length}, mean candidates ${(routeChecks.reduce((a, r) => a + r.candidates, 0) / Math.max(1, routeChecks.length)).toFixed(1)}`);
check(1, fillSources.has(MK1!) && fillSources.has(MK2!) && quotedBy.size >= 1 && routeChecks.length > 0 && badRoutes.length === 0 && byKind(KIND_POOL) > 0 && byKind(KIND_QUOTE) > 0, `two makers quote through the gateway and both fill; every routed fill = the cheapest candidate re-priced alone at the state before it (${badRoutes.length} of ${routeChecks.length} differ${badRoutes.length ? ": " + badRoutes.slice(0, 3).map((r) => `${r.id} kind ${r.kind} ${usd(r.cost)} vs ${r.expectedKind} ${usd(r.expected)}`).join(" | ") : ""}); gateway lines ${gw.length}`);

// 2. offers
const offerLines = offers.map((o) => `offer ${o.id} ${o.market}: escrow ${usd(o.escrow)}, moved to entries ${usd(o.filledUsdc)}, returned ${usd(o.returned)}`);
report.push(offerLines.join("; "));
const offerOk = offers.length === 2 && offers.every((o) => o.cancelled && o.returned + o.filledUsdc === o.escrow) && byKind(KIND_OFFER) >= 2 && oETH.filledUsdc > 0n && oETH.returned > 0n;
check(2, offerOk, "writer offers posted, partly filled and cancelled; escrow returned exactly (returned + moved to matched entries = escrow)");

// 3. law 4
report.push(`law 4: ${law4Checks} entry checks at 7 checkpoints; ${claimExact.length} claim exceptions`);
check(3, law4.length === 0 && claimExact.length === 0 && law4Checks > 0, `law 4: every matched entry's locked collateral ≥ the exact worst case (runner's maths) and ≥ the MatchBook's required; = required after every claim; each maker's vault locked = its entries + bonds (${law4.length} violations${law4.length ? ": " + law4.slice(0, 3).join(" | ") : ""})`);

// 4. exits
const sells = attempts.filter((a) => a.kind === "sell");
report.push(`sells ${sells.filter((a) => a.ok).length}/${sells.length}; buybacks ${buybacks} touching ${buybackSources} source closes; dust events ${dustEvents}; shortfall beyond 1 micro-USDC ${shortfallBeyondDust}`);
check(4, sellFails.length === 0 && buybacks > 0 && proRata.length === 0 && shortfallBeyondDust === 0 && mirror.length === 0, `buyer exits: every sell paid (${sellFails.length} failed${sellFails.length ? ": " + sellFails.map((a) => a.reason).join(", ") : ""}); buybacks pro rata across sources (${proRata.length} off${proRata.length ? ": " + proRata.slice(0, 2).join(" | ") : ""}); no shortfall beyond dust; pool mirror = MatchBook and nothing uncovered at every checkpoint (${mirror.length}${mirror.length ? ": " + mirror.slice(0, 2).join(" | ") : ""})`);

// 5. law 2
check(5, law2.length === 3 && law2.every((l) => l.ok), `law 2: ${law2.map((l) => `${l.what} [${l.detail}]`).join("; ")}`);

// 6. early close
check(6, early.length === 2 && early.every((l) => l.ok), `maker early close through the pool's checks: ${early.map((l) => `${l.what} [${l.detail}]`).join("; ")}`);

// 7. auction
check(7, auction.length >= 6 && auction.every((l) => l.ok), `an auction week: ${auction.map((l) => `${l.ok ? "" : "FAILED "}${l.what}`).join("; ")}`);
report.push(...auction.map((l) => `auction: ${l.what}: ${l.detail}`));

// 8. vol feed
const feedIssues: string[] = [];
for (const m of ["BTC", "ETH"]) {
  for (const b of [0, 1, 2, 3]) {
    const fills = feedFills.filter((f) => f.market === m && f.bucket === b);
    const [lastSigma, avg, , count] = await read<readonly [bigint, bigint, bigint, bigint, bigint]>(FEED, "read", [b32(m), BigInt(b)]);
    if (Number(count) !== fills.length) feedIssues.push(`${m}/${b}: count ${count} vs ${fills.length}`);
    if (fills.length === 0) continue;
    const last = fills.at(-1)!;
    if (lastSigma !== last.sigma) feedIssues.push(`${m}/${b}: last σ ${lastSigma} vs ${last.sigma}`);
    let ws = 0;
    let w = 0;
    for (const f of fills) {
      const decay = Math.exp((-Math.LN2 * Number(last.t - f.t)) / DAY);
      ws += Number(f.weight) * Number(f.sigma) * decay;
      w += Number(f.weight) * decay;
    }
    const mine = ws / w;
    if (Math.abs(Number(avg) - mine) > 1.01) feedIssues.push(`${m}/${b}: avg ${avg} vs ${mine.toFixed(2)}`);
    report.push(`vol feed ${m} bucket ${b}: ${fills.length} fills, last ${lastSigma} bps, average ${avg} bps (recomputed ${mine.toFixed(2)})`);
  }
}
check(8, feedIssues.length === 0 && feedFills.length > 0, `vol feed: per bucket, counts, last σ and the size-weighted average (1-day half-life) match a recompute from the routed fills (${feedIssues.length} differ${feedIssues.length ? ": " + feedIssues.slice(0, 3).join(" | ") : ""})`);

// 9. hedger
const hedger = lines("hedger");
const hedgeErrors = hedger.filter((l) => l.msg === "hedge" && l.status === "error");
report.push(`hedger: ${hedger.filter((l) => l.msg === "hedge").length} hedge rows, ${hedger.filter((l) => l.msg === "plan").length} plans; checkpoints: ${hedgeChecks.map((c) => `${c.label} ${c.market} ${c.target.toFixed(3)} vs ${c.expected.toFixed(3)}`).join("; ")}`);
check(9, hedgeErrors.length === 0 && hedgeChecks.length >= 9 && hedgeChecks.every((c) => c.ok), `hedger: every checkpoint target = an independent delta of what the pool carries itself (series raw − the MatchBook's matched raw) (${hedgeChecks.filter((c) => c.ok).length}/${hedgeChecks.length}); no venue errors`);

// 10. risk-monitor
const alarms = lines("risk-monitor").filter((l) => l.msg === "alarm");
const count = (n: string) => alarms.filter((l) => l.name === n).length;
const expectedNames = ["AUCTION_STARTED", "AUCTION_FORFEIT", "AUCTION_SETTLED", "VAULT_SLASHED"];
const unexpected = alarms.filter((l) => ["BUYBACK_FAILED", "MATCHED_UNCOVERED", "BUYBACK_SHORTFALL", "MONITOR_ERROR"].includes(String(l.name)));
const nameCounts = [...new Set(alarms.map((l) => String(l.name)))].map((n) => `${n} ${count(n)}`).join(", ");
report.push(`risk-monitor alarm lines: ${nameCounts}`);
check(10, expectedNames.every((n) => count(n) > 0) && count("AUCTION_FORFEIT") >= 2 && unexpected.length === 0, `risk-monitor: the auction (started, 2 forfeits, settled) and the slash announced; no failed buyback, uncovered raw, shortfall or monitor error (${unexpected.map((l) => l.name).join(", ") || "none"})`);

// 11. conservation
const holders = [POOL, VAULT, MB, ENGINE, OB, RA, BOOK, ...acc];
let onchain = 0n;
for (const h of holders) onchain += await read<bigint>(MUSDC, "balanceOf", [h]);
const supply = await read<bigint>(MUSDC, "totalSupply");
const [eng, obb, rab] = await Promise.all([ENGINE, OB, RA].map((h) => read<bigint>(MUSDC, "balanceOf", [h])));
let vaultBooks = 0n;
for (const mk of MAKERS) vaultBooks += (await read<bigint>(VAULT, "freeOf", [mk, MUSDC])) + (await read<bigint>(VAULT, "lockedOf", [mk, MUSDC]));
const vaultBal = await read<bigint>(MUSDC, "balanceOf", [VAULT]);
const mbHeld = await read<bigint>(MB, "heldUsdc");
const mbBal = await read<bigint>(MUSDC, "balanceOf", [MB]);
const law1: string[] = [...law1Mismatch];
for (const t of BUYERS) {
  const bal = await read<bigint>(MUSDC, "balanceOf", [t]);
  const exp = START_USDC.get(t)! - (paid.get(t) ?? 0n) + (got.get(t) ?? 0n);
  if (bal !== exp) law1.push(`${t.slice(0, 6)}: ${usd(bal)} vs ${usd(exp)}`);
}
report.push(`USDC ${usd(onchain)} of supply ${usd(supply)}; Engine ${usd(eng!)}, OpenBook ${usd(obb!)}, RiskAuction ${usd(rab!)}; vault books ${usd(vaultBooks)} vs balance ${usd(vaultBal)}; MatchBook held ${usd(mbHeld)} vs balance ${usd(mbBal)}; buyers: ${BUYERS.map((t) => `${t.slice(0, 6)} paid ${usd(paid.get(t) ?? 0n).toFixed(2)} got ${usd(got.get(t) ?? 0n).toFixed(2)}`).join("; ")}`);
check(11, onchain === supply && eng === 0n && obb === 0n && rab === 0n && vaultBooks === vaultBal && mbHeld === mbBal && law1.length === 0, `USDC conserved across pool, vault, MatchBook and users against all mints; Engine, OpenBook and RiskAuction hold 0; vault and MatchBook books = balances; every buyer's USDC = start − paid + received (law 1) (${law1.length} mismatches${law1.length ? ": " + law1.slice(0, 3).join(" | ") : ""})`);

// extras: gas, error lines
const gasOf = (f: (a: Attempt) => boolean) => attempts.filter((a) => a.ok && a.gas !== undefined && f(a)).map((a) => a.gas!);
const g: Record<string, bigint> = {
  "buy via pool": median(gasOf((a) => a.kind === "buy" && a.routed === KIND_POOL)),
  "buy via maker": median(gasOf((a) => a.kind === "buy" && a.routed === KIND_QUOTE)),
  "buy via offer": median(gasOf((a) => a.kind === "buy" && a.routed === KIND_OFFER)),
  sell: median(gasOf((a) => a.kind === "sell")),
  postOffer: median(gasOf((a) => a.kind === "postOffer")),
  cancelOffer: median(gasOf((a) => a.kind === "cancelOffer")),
  claim: median(gasOf((a) => a.kind === "claim")),
  earlyClose: median(gasOf((a) => a.kind === "earlyClose")),
  "auction start": median(gasOf((a) => a.kind === "auction start")),
  commit: median(gasOf((a) => a.kind === "auction commit")),
  reveal: median(gasOf((a) => a.kind === "auction reveal")),
  settle: median(gasOf((a) => a.kind === "auction settle")),
};
report.push(`gas medians: ${Object.entries(g).map(([k, v]) => `${k} ${v}`).join(", ")}`);
let errorLines = 0;
const samples: string[] = [];
for (const f of ["signer-1", "signer-2", "signer-3", "poker-primary", "poker-backup", "hedger", "risk-monitor", "maker-gateway", "maker-1", "maker-2", "maker-1-eth", "maker-2-eth"]) {
  for (const l of lines(f)) {
    if (l.level === "error") {
      errorLines++;
      if (samples.length < 6) samples.push(`${f}: ${JSON.stringify(l).slice(0, 200)}`);
    }
  }
}
report.push(`service error lines: ${errorLines}${samples.length ? " (" + samples.join(" | ") + ")" : ""}`);
report.push(`chain clock jumps: ${warps.map((w) => (w.s >= DAY ? `${(w.s / DAY).toFixed(2)} d` : `${w.s / 60} min`)).join(", ")}`);

const text = [`run ${((endTime - T0) / 60_000).toFixed(1)} min; logs in ${out}`, ...report, "", ...crit].join("\n") + "\n";
writeFileSync(join(out, "report.txt"), text);
writeFileSync(join(out, "attempts.json"), JSON.stringify({ attempts, routeChecks }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1));
console.log("\n" + text);
anvil.kill();
say("done");
