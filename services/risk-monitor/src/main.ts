import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, formatEther, formatUnits, getAddress, http, parseEventLogs, stringToHex, type Address, type PublicClient } from "viem";
import { chainFor, LOCAL_CHAIN_ID } from "@tourbillon/common/chain.ts";
import { accountValueFrom, EQUITY_OFFSET, transfersFromLedger } from "@tourbillon/common/equity.ts";
import { MAX_FEE_PER_GAS, POLL_MS, withHeadroom } from "@tourbillon/common/gas.ts";
import { fetchMetaAndAssetCtxs, HL_API, parseMarks, TIMEOUT_MS } from "@tourbillon/common/hyperliquid.ts";
import { log } from "@tourbillon/common/log.ts";
import { loadSigner, type KeyInput, type Signer } from "@tourbillon/common/signer.ts";
import { Conditions, emit } from "./alarm.ts";
import { capHigh, coverageState, DEFAULTS, equityMismatch, hlMarketDown, type Thresholds } from "./checks.ts";
import { m6Abi, m6Alarms, settleDue, type M6Event, type OpenLot } from "./m6.ts";
import { m7Abi, m7Alarms, receiptsAgeHours, type M7Addresses, type M7Event } from "./m7.ts";
import { OutageTracker } from "./outage.ts";
import { loadKeys, lowKeys, type WatchedKey } from "./keys.ts";

/// The risk-monitor (M3 step 9). Every pass it checks the venue, the pool's risk state and the services' liveness, and
/// writes alarm lines in a stable shape (src/alarm.ts). With an M6 deployment file it also watches the open book
/// (buybacks, uncovered matched raw, dust, vault slashes) and the weekly risk auction (src/m6.ts); with an M7 file, the
/// timelock queue, role changes, pauses and receipts liveness (src/m7.ts). Its only on-chain action: after 15 minutes of continuous venue
/// outage on a market it pauses opens there with the pause-only RISK_PAUSER key. It can never unpause.

const poolAbi = [
  ...["available", "stressedLiability", "sentOut", "receivedBack", "round"].map(
    (name) => ({ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }) as const,
  ),
  { type: "function", name: "opensPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "equityReady", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "equityKey", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  ...["notionalCap", "openNotional", "directionalCap", "directional"].map(
    (name) => ({ type: "function", name, stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] }) as const,
  ),
  { type: "function", name: "marketPaused", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "pauseMarket", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] },
  {
    type: "function",
    name: "rounds",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [
      { type: "uint256" }, { type: "uint256" }, { type: "bool" }, { type: "bool" }, { type: "uint256" },
      { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint64" },
    ],
  },
  {
    type: "event",
    name: "TreasurySent",
    inputs: [
      { type: "address", name: "treasury", indexed: true },
      { type: "uint256", name: "amount" },
      { type: "uint256", name: "sentOut" },
      { type: "uint256", name: "sentToday" },
      { type: "uint256", name: "navBefore" },
    ],
  },
  {
    type: "event",
    name: "TreasuryReturned",
    inputs: [
      { type: "address", name: "treasury", indexed: true },
      { type: "uint256", name: "amount" },
      { type: "uint256", name: "receivedBack" },
    ],
  },
] as const;
const viewAbi = [
  { type: "function", name: "markWad", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "volBps", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "latestValue", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "latestSample", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }] },
] as const;

type Config = {
  deployment: string;
  rpc?: string;
  key: KeyInput;
  hlUser?: Address;
  hlApi?: string;
  hedgerStatus?: string;
  keys: WatchedKey[];
  outageMs: number;
  tickSeconds: number;
  equityEveryS: number;
  once: boolean;
  t: Thresholds;
};

function parseArgs(argv: string[]): Config {
  const a = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (!k.startsWith("--")) throw new Error(`unexpected argument ${k}`);
    const f = k.slice(2);
    if (f === "once") a.set(f, true);
    else {
      const v = argv[++i];
      if (v === undefined) throw new Error(`--${f} needs a value`);
      a.set(f, v);
    }
  }
  const known = ["deployment", "rpc", "keystore", "keystore-dir", "local-unlocked", "watch", "hl-user", "hl-api", "hedger-status", "keys", "outage-minutes", "tick-seconds", "equity-every-seconds", "once"];
  for (const k of a.keys()) if (!known.includes(k)) throw new Error(`unknown flag --${k}`);
  const s = (k: string) => (typeof a.get(k) === "string" ? (a.get(k) as string) : undefined);
  if (!s("deployment")) throw new Error("--deployment is required");
  const inputs = ["keystore", "local-unlocked", "watch"].filter((k) => a.has(k));
  if (inputs.length !== 1) throw new Error("give exactly one of --keystore, --local-unlocked, --watch (watch: alarms only, no pause)");
  const key: KeyInput = a.has("keystore")
    ? { type: "keystore", name: s("keystore")!, dir: s("keystore-dir") }
    : a.has("local-unlocked")
      ? { type: "local-unlocked", address: getAddress(s("local-unlocked")!) }
      : { type: "watch", address: getAddress(s("watch")!) };
  return {
    deployment: s("deployment")!,
    rpc: s("rpc"),
    key,
    hlUser: s("hl-user") ? getAddress(s("hl-user")!) : undefined,
    hlApi: s("hl-api"),
    hedgerStatus: s("hedger-status"),
    keys: s("keys") ? loadKeys(s("keys")!) : [],
    outageMs: Number(s("outage-minutes") ?? 15) * 60_000,
    tickSeconds: Math.max(1, Number(s("tick-seconds") ?? 60)),
    equityEveryS: Number(s("equity-every-seconds") ?? 3600),
    once: a.has("once"),
    t: DEFAULTS,
  };
}

type Dep = {
  chainId: number;
  router: Address;
  board: Address;
  pool: Address;
  book: Address;
  markets: string[];
  deployBlock: bigint;
  // M6 (absent in older deployment files)
  usdc: Address | null;
  matchBook: Address | null;
  auction: Address | null;
  vault: Address | null;
  // M7
  engine: Address | null;
  m7: M7Addresses;
};

function loadDep(path: string): Dep {
  const d = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const need = (k: string) => getAddress(String(d[k]));
  const maybe = (k: string) => (typeof d[k] === "string" ? getAddress(d[k] as string) : null);
  return {
    chainId: Number(d.chainId),
    router: need("MarkRouter"),
    board: need("QuorumBoard"),
    pool: need("MainspringPool"),
    book: need("PathFundingBook"),
    markets: d.markets as string[],
    deployBlock: BigInt(Number(d.deployBlock ?? 0)),
    usdc: maybe("MockUSDC"),
    matchBook: maybe("MatchBook"),
    auction: maybe("RiskAuction"),
    vault: maybe("MakerVault"),
    engine: maybe("Engine"),
    m7: {
      timelock: maybe("Timelock"),
      receipts: maybe("ReceiptRoots"),
      safe: maybe("Safe"),
      guardian: maybe("Guardian"),
      riskPauser: typeof d.riskPauser === "string" && d.Timelock ? getAddress(d.riskPauser as string) : null,
      deployer: typeof d.deployer === "string" && d.Timelock ? getAddress(d.deployer as string) : null,
      names: new Map(
        ["MainspringPool", "Engine", "QuorumBoard", "MarkRouter", "Timelock", "ReceiptRoots", "OpenBook", "MatchBook", "RiskAuction", "MakerVault", "AgentRouter", "PathFundingBook"]
          .filter((k) => typeof d[k] === "string")
          .map((k) => [(d[k] as string).toLowerCase(), k] as const),
      ),
    },
  };
}

const usdc = (v: bigint) => Number(formatUnits(v, 6));
const b32 = (m: string) => stringToHex(m, { size: 32 });

async function info(base: string, body: object): Promise<unknown> {
  const res = await fetch(new URL("/info", base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  const dep = loadDep(cfg.deployment);
  const client = createPublicClient({ chain: chainFor(dep.chainId), transport: http(cfg.rpc), pollingInterval: POLL_MS }) as PublicClient;
  const chainId = await client.getChainId();
  if (chainId !== dep.chainId) throw new Error(`RPC is chain ${chainId}, deployment file is chain ${dep.chainId}`);
  if ((cfg.hlApi || cfg.key.type === "local-unlocked") && chainId !== LOCAL_CHAIN_ID) throw new Error("--hl-api and --local-unlocked work only on a local anvil (31337)");
  const signer = await loadSigner(cfg.key, dep.chainId, cfg.rpc);
  const base = cfg.hlApi ?? HL_API;
  const outage = new OutageTracker(cfg.outageMs);
  const cond = new Conditions();
  let nextBlock = dep.deployBlock;
  const lots = new Map<bigint, OpenLot>();
  let lastEquityCheck = -Infinity;
  log("info", "started", { pool: dep.pool, markets: dep.markets, pauses: signer.wallet !== undefined, outageMinutes: cfg.outageMs / 60_000 });

  let stopping = false;
  process.on("SIGINT", () => (stopping = true));
  process.on("SIGTERM", () => (stopping = true));
  while (!stopping) {
    try {
      nextBlock = await pass(cfg, client, dep, base, signer, outage, cond, nextBlock, lots, () => {
        const due = Date.now() - lastEquityCheck >= cfg.equityEveryS * 1000;
        if (due) lastEquityCheck = Date.now();
        return due;
      });
    } catch (e) {
      emit({ name: "MONITOR_ERROR", state: "event", level: "alarm", what: "The risk-monitor's pass failed.", who: "risk-monitor operator", market: null, values: { error: (e as Error).message.split("\n")[0] } });
    }
    if (cfg.once) break;
    for (let i = 0; i < cfg.tickSeconds && !stopping; i++) await Bun.sleep(1000);
  }
  log("info", "stopped");
}

async function pass(
  cfg: Config,
  client: PublicClient,
  dep: Dep,
  base: string,
  signer: Signer,
  outage: OutageTracker,
  cond: Conditions,
  fromBlock: bigint,
  lots: Map<bigint, OpenLot>,
  equityDue: () => boolean,
): Promise<bigint> {
  const block = await client.getBlock();
  const now = Number(block.timestamp);
  const read = <T>(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address, abi, functionName, args } as never) as Promise<T>;

  // ---- treasury events (each one is announced)
  // no new block since the last pass: nothing to read (a from > to range is an invalid request)
  const logs = fromBlock <= block.number ? await client.getLogs({ address: dep.pool, fromBlock, toBlock: block.number }) : [];
  for (const l of parseEventLogs({ abi: poolAbi, logs, strict: false })) {
    const v = l.args as Record<string, bigint>;
    if (l.eventName === "TreasurySent") {
      emit({ name: "TREASURY_SENT", state: "event", level: "alarm", what: "The pool sent USDC to the treasury (bound for Hyperliquid).", who: "treasury operator: confirm the move was planned", market: null, values: { amount: usdc(v.amount!), sentOut: usdc(v.sentOut!), sentToday: usdc(v.sentToday!), navBefore: usdc(v.navBefore!), tx: l.transactionHash } });
    } else if (l.eventName === "TreasuryReturned") {
      emit({ name: "TREASURY_RETURNED", state: "event", level: "warn", what: "USDC came back to the pool from the treasury.", who: "treasury operator: confirm", market: null, values: { amount: usdc(v.amount!), receivedBack: usdc(v.receivedBack!), tx: l.transactionHash } });
    }
  }

  // ---- the open book and the risk auction (M6)
  const m6At = [dep.matchBook, dep.auction, dep.vault].filter((a): a is Address => a !== null);
  if (m6At.length > 0) {
    const m6Logs = fromBlock <= block.number ? await client.getLogs({ address: [dep.pool, ...m6At], fromBlock, toBlock: block.number }) : [];
    const events = parseEventLogs({ abi: m6Abi, logs: m6Logs, strict: false }).map((l) => ({ eventName: l.eventName, args: l.args as Record<string, unknown>, transactionHash: l.transactionHash }) as M6Event);
    for (const a of m6Alarms(events, lots, dep.usdc)) emit({ ...a, state: "event" });
    const due = settleDue(lots, now, cfg.t.auctionSettleGraceS);
    cond.set(due.length > 0, { name: "AUCTION_SETTLE_DUE", level: "alarm", what: "A risk auction lot's reveal ended and nobody has settled it: bonds stay locked and the pool keeps the risk.", who: "anyone (keeper operator): call settle on the lot", market: null, values: { lots: due.map((l) => ({ lotId: l.lotId, market: l.market, revealEnd: l.revealEnd })) } }, "Every finished auction lot is settled.");
  }

  // ---- governance and receipts (M7)
  if (dep.m7.timelock) {
    const at = [dep.m7.timelock, dep.pool, dep.board, dep.router, ...(dep.engine ? [dep.engine] : []), ...(dep.m7.receipts ? [dep.m7.receipts] : [])];
    const m7Logs = fromBlock <= block.number ? await client.getLogs({ address: at, fromBlock, toBlock: block.number }) : [];
    const ts = new Map<bigint, number>();
    const events: M7Event[] = [];
    for (const l of parseEventLogs({ abi: m7Abi, logs: m7Logs, strict: false })) {
      if (!ts.has(l.blockNumber)) ts.set(l.blockNumber, Number((await client.getBlock({ blockNumber: l.blockNumber })).timestamp));
      events.push({ eventName: l.eventName, args: l.args as Record<string, unknown>, address: getAddress(l.address), transactionHash: l.transactionHash, blockTimestamp: ts.get(l.blockNumber)! });
    }
    for (const a of m7Alarms(events, dep.m7)) emit({ ...a, state: "event" });
    if (dep.m7.receipts) {
      const receiptsAbi = [
        { type: "function", name: "anyPosted", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
        { type: "function", name: "lastEpoch", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
      ] as const;
      const [anyPosted, lastEpoch] = await Promise.all([read<boolean>(dep.m7.receipts, receiptsAbi, "anyPosted"), read<bigint>(dep.m7.receipts, receiptsAbi, "lastEpoch")]);
      const deployTs = Number((await client.getBlock({ blockNumber: dep.deployBlock })).timestamp);
      const age = receiptsAgeHours(anyPosted, Number(lastEpoch), deployTs, now);
      cond.set(age > cfg.t.receiptsStaleHours, { name: "RECEIPTS_STALE", level: "alarm", what: "No receipt root has been posted for too long: trades, vol finals and NAV snapshots are not being committed.", who: "receipts operator", market: null, values: { hoursSinceLastRoot: Math.round(age * 10) / 10, lastEpoch: anyPosted ? Number(lastEpoch) : null } }, "Receipt roots are being posted again.");
    }
  }

  // ---- key watcher: every service key's gas balance, one condition per key
  if (cfg.keys.length > 0) {
    const balances = new Map<Address, bigint>();
    for (const k of cfg.keys) balances.set(k.address, await client.getBalance({ address: k.address }));
    const low = new Map(lowKeys(cfg.keys, balances).map((k) => [k.name, k]));
    for (const k of cfg.keys) {
      const l = low.get(k.name);
      cond.set(l !== undefined, { name: "KEY_BALANCE_LOW", level: "warn", what: `The ${k.name} key is low on gas: its service stops when it runs dry.`, who: `${k.name} operator: top up the key`, market: k.name, values: { address: k.address, balanceHype: l?.balance ?? null, minHype: l?.min ?? null } }, `The ${k.name} key has enough gas again.`);
    }
  }

  // ---- pool-wide risk state
  const [available, stressed, opensPaused, sentOut, receivedBack, round] = await Promise.all([
    read<bigint>(dep.pool, poolAbi, "available"),
    read<bigint>(dep.pool, poolAbi, "stressedLiability"),
    read<boolean>(dep.pool, poolAbi, "opensPaused"),
    read<bigint>(dep.pool, poolAbi, "sentOut"),
    read<bigint>(dep.pool, poolAbi, "receivedBack"),
    read<bigint>(dep.pool, poolAbi, "round"),
  ]);
  const cov = coverageState(usdc(available), usdc(stressed), cfg.t);
  const covValues = { available: usdc(available), stressedLiability: usdc(stressed) };
  cond.set(cov === "breached", { name: "COVERAGE_BREACHED", level: "alarm", what: "Elysium USDC no longer covers the stressed liability: new opens are refused on-chain; sells beyond the stress band could fail (Insolvent).", who: "admin: add capital or bring capital back from Hyperliquid", market: null, values: covValues }, "Coverage restored.");
  cond.set(cov === "low", { name: "COVERAGE_LOW", level: "warn", what: "Free USDC above the stressed liability is under the headroom threshold.", who: "admin: watch; consider adding capital", market: null, values: covValues }, "Coverage headroom back above the threshold.");
  cond.set(opensPaused, { name: "DRAWDOWN_PAUSED", level: "alarm", what: "NAV per share fell more than 15% below its 30-day high: all opens are paused.", who: "admin: review, then resume opens", market: null, values: {} }, "Opens resumed.");
  if (round > 0n) {
    const r = await read<readonly unknown[]>(dep.pool, poolAbi, "rounds", [round - 1n]);
    const age = now - Number(r[9] as bigint);
    cond.set(age > cfg.t.settlementAgeS, { name: "SETTLEMENT_STALE", level: "alarm", what: "The pool has not settled a round for too long: deposits and withdrawals wait.", who: "keeper operator", market: null, values: { lastSettlementAgeS: age } }, "Settlements running again.");
  }

  // ---- Hyperliquid probe and the hedger's status
  let hl: Map<string, number | null> = new Map();
  try {
    const marks = parseMarks(await fetchMetaAndAssetCtxs(base), dep.markets);
    for (const m of dep.markets) {
      const r = marks.get(m);
      hl.set(m, r && r.ok ? Number(formatEther(r.mark)) : null);
    }
  } catch {
    hl = new Map(dep.markets.map((m) => [m, null]));
  }
  let hedger: Record<string, { ok: boolean }> | null = null;
  if (cfg.hedgerStatus && existsSync(cfg.hedgerStatus)) {
    const st = JSON.parse(readFileSync(cfg.hedgerStatus, "utf8")) as { updatedAt: string; markets: Record<string, { ok: boolean }> };
    const age = (Date.now() - Date.parse(st.updatedAt)) / 1000;
    const silent = age > cfg.t.hedgerSilentS;
    cond.set(silent, { name: "HEDGER_SILENT", level: "alarm", what: "The hedger has not reported for too long.", who: "hedger operator", market: null, values: { statusAgeS: Math.round(age) } }, "The hedger is reporting again.");
    if (!silent) hedger = st.markets;
  }

  // ---- per market
  for (const m of dep.markets) {
    const name = b32(m);
    let routerMark: number | null = null;
    let volOk = true;
    try {
      routerMark = Number(formatEther(await read<bigint>(dep.router, viewAbi, "markWad", [name])));
    } catch {
      routerMark = null;
    }
    try {
      await read<bigint>(dep.board, viewAbi, "volBps", [name]);
    } catch {
      volOk = false;
    }
    cond.set(routerMark === null || !volOk, { name: "MARK_STALE", level: "alarm", what: "The router's mark or the board's vol is stale: opens on this market are closed (law 2).", who: "signer operators", market: m, values: { markFresh: routerMark !== null, volFresh: volOk } }, "Mark and vol fresh again.");

    try {
      const [t] = await read<readonly [bigint, bigint, bigint]>(dep.book, viewAbi, "latestSample", [name]);
      const age = now - Number(t);
      cond.set(age > cfg.t.sampleAgeS, { name: "SAMPLE_STALE", level: "alarm", what: "No price sample recorded for too long: funding runs on an old sample.", who: "keeper operator (poker)", market: m, values: { lastSampleAgeS: age } }, "Samples recorded again.");
    } catch {
      // no sample yet on this market
    }

    const [nCap, nUse, dCap, dUse] = await Promise.all(
      ["notionalCap", "openNotional", "directionalCap", "directional"].map((f) => read<bigint>(dep.pool, poolAbi, f, [name])),
    );
    const high = capHigh(usdc(nUse!), usdc(nCap!), cfg.t) || capHigh(usdc(dUse!), usdc(dCap!), cfg.t);
    cond.set(high, { name: "CAP_HIGH", level: "warn", what: "A cap is nearly used up on this market.", who: "admin: decide whether to raise the cap", market: m, values: { notional: usdc(nUse!), notionalCap: usdc(nCap!), directional: usdc(dUse!), directionalCap: usdc(dCap!) } }, "Cap use back below the threshold.");

    // venue outage
    const hlDown = hlMarketDown(hl.get(m) ?? null, routerMark, cfg.t);
    const hedgerDown = hedger !== null && hedger[m]?.ok === false;
    const ev = outage.update(m, hlDown || hedgerDown, Date.now());
    if (ev === "trip") {
      const values = { downMinutes: outage.downFor(m, Date.now()) / 60_000, hyperliquid: hlDown, hedger: hedgerDown };
      if (await read<boolean>(dep.pool, poolAbi, "marketPaused", [name])) continue;
      if (!signer.wallet || !signer.account) {
        emit({ name: "VENUE_DOWN_PAUSED", state: "event", level: "alarm", what: "Venue down for 15 minutes; watch mode, so opens were NOT paused.", who: "admin: pause opens on this market", market: m, values });
        continue;
      }
      try {
        const call = { address: dep.pool, abi: poolAbi, functionName: "pauseMarket", args: [name], account: signer.account, maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: 0n } as const;
        const gas = await client.estimateContractGas(call);
        const hash = await signer.wallet.writeContract({ ...call, chain: signer.wallet.chain, gas: withHeadroom(gas) });
        const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
        if (receipt.status !== "success") throw new Error("pauseMarket reverted");
        emit({ name: "VENUE_DOWN_PAUSED", state: "event", level: "alarm", what: "Venue down for 15 minutes on this market: opens paused here (sells unaffected).", who: "nobody: automatic pause done; admin unpauses after recovery", market: m, values: { ...values, tx: hash } });
      } catch (e) {
        emit({ name: "PAUSE_FAILED", state: "event", level: "alarm", what: "Venue down for 15 minutes, but pausing opens failed.", who: "admin: pause opens on this market now", market: m, values: { ...values, error: (e as Error).message.split("\n")[0] } });
      }
    } else if (ev === "recovered") {
      emit({ name: "VENUE_RECOVERED", state: "event", level: "warn", what: "The venue is healthy again on this market.", who: "admin: unpause opens when satisfied (the risk key cannot)", market: m, values: {} });
    }
  }

  // ---- hourly equity check
  if (cfg.hlUser && equityDue()) {
    const ready = await read<boolean>(dep.pool, poolAbi, "equityReady");
    const outside = sentOut > receivedBack;
    cond.set(!ready && outside, { name: "EQUITY_NOT_READY", level: "alarm", what: "Capital is outside Elysium but EQUITY is not ready (fewer than two finals or 2 h old): NAV leaves it uncounted.", who: "signer operators", market: null, values: { sentOut: usdc(sentOut), receivedBack: usdc(receivedBack) } }, "EQUITY ready again.");
    try {
      const key = await read<`0x${string}`>(dep.pool, poolAbi, "equityKey");
      const [boardValue] = await read<readonly [bigint, bigint]>(dep.board, viewAbi, "latestValue", [key]);
      const [state, ledger] = await Promise.all([info(base, { type: "clearinghouseState", user: cfg.hlUser }), info(base, { type: "userNonFundingLedgerUpdates", user: cfg.hlUser, startTime: 0 })]);
      const av = accountValueFrom(state);
      const { deposits, withdrawalsNet } = transfersFromLedger(ledger);
      const own = Number(formatEther(av - deposits + withdrawalsNet));
      const board = Number(formatEther(boardValue - EQUITY_OFFSET));
      const accountValue = Number(formatEther(av));
      cond.set(equityMismatch(board, own, accountValue, cfg.t), { name: "EQUITY_MISMATCH", level: "alarm", what: "The board's EQUITY differs from Hyperliquid's account by more than the tolerance.", who: "signer operators and admin: check the signers' EQUITY job and the account", market: null, values: { boardPnl: board, hyperliquidPnl: own, accountValue } }, "EQUITY agrees with Hyperliquid again.");
    } catch {
      // no EQUITY final yet, or Hyperliquid unreachable (raised by the venue checks)
    }
  }
  return block.number + 1n;
}

main().catch((e) => {
  log("error", "fatal", { error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
  process.exit(1);
});
