import { decodeEventLog, formatEther, formatUnits, stringToHex, type Address, type PublicClient } from "viem";
import { MAX_FEE_PER_GAS, POLL_MS, withHeadroom } from "@tourbillon/common/gas.ts";
import { log } from "@tourbillon/common/log.ts";
import { loadSigner, type Signer } from "@tourbillon/common/signer.ts";
import { revertName } from "@tourbillon/common/tx.ts";
import { erc20Abi, readPositions, sourcesAbi, stockToken } from "./book.ts";
import { checkOnchainForChain, parseOnchainArgs, type Dep, type OnchainConfig } from "./config.ts";
import { targetHedge } from "./delta.ts";
import { planSwap } from "./policy.ts";
import { connect, fatal, loadDeployment, loop, StatusBook } from "./run.ts";

/// hedger-onchain (Backend §6, §7; owner G7): for each stock market, the tokenized-stock holding that offsets the
/// pool's option delta, reached by the pool's own hedgeSwap through the listed router. The pool's keeper role sits on
/// the hedge keeper gate (RH8b, C63), which forwards only this key's calls and which the guardian can freeze; the key
/// may only call hedgeSwap: the pool holds the stock, the mark comes from the router, and the pool refuses a
/// minOut below its own floor. Without a key, or with --dry-run, it only logs the swaps it would send.

export const hedgeAbi = [
  {
    type: "function",
    name: "hedgeSwap",
    stateMutability: "nonpayable",
    inputs: [{ type: "bytes32" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "hedgeLimits",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }, { type: "uint256" }],
    outputs: [{ type: "address" }, { type: "uint16" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
  },
  { type: "function", name: "freeForWithdrawals", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "event",
    name: "HedgeSwapped",
    inputs: [
      { type: "bytes32", name: "market", indexed: true },
      { type: "bool", name: "buy", indexed: false },
      { type: "uint256", name: "amountIn", indexed: false },
      { type: "uint256", name: "amountOut", indexed: false },
      { type: "uint256", name: "markWad", indexed: false },
    ],
  },
  { type: "error", name: "AboveFree", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "DailyCapExceeded", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "InventoryCapExceeded", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "MinOutBelowFloor", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "SwapShort", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "NoHedgeRouter", inputs: [] },
  { type: "error", name: "Frozen", inputs: [] },
  { type: "error", name: "NotHedger", inputs: [] },
] as const;

const WAD = 10n ** 18n;
const BPS = 10_000n;

/// The pool's floor (HedgeSwap.floorOut) at `slipBps`: USDC → token units when buying, token → USDC units otherwise.
export function floorOut(buy: boolean, amountIn: bigint, s: bigint, scale: bigint, slipBps: bigint): bigint {
  const fair = buy ? (amountIn * 10n ** 12n * WAD) / (s * scale) : (amountIn * scale * s) / (WAD * 10n ** 12n);
  return (fair * (BPS - slipBps)) / BPS;
}

/// Reverts that only mean the chain moved since this pass read it (room used up by trades or another swap).
const RACE = new Set(["AboveFree", "DailyCapExceeded", "InventoryCapExceeded"]);

async function tick(cfg: OnchainConfig, client: PublicClient, dep: Dep, markets: { market: string; token: Address; scale: bigint }[], signer: Signer | null, st: StatusBook): Promise<void> {
  for (const { market, token, scale } of markets) {
    const at = { market };
    const name = stringToHex(market, { size: 32 });
    let s: bigint;
    let sigmaBps: number;
    try {
      s = await client.readContract({ address: dep.router, abi: sourcesAbi, functionName: "markWad", args: [name] });
      sigmaBps = Number(await client.readContract({ address: dep.board, abi: sourcesAbi, functionName: "volBps", args: [name] }));
    } catch {
      log("warn", "router mark or board vol stale: market not hedged this pass", at);
      continue;
    }
    const block = await client.getBlock();
    const chainDay = block.timestamp / 86_400n;
    const [router, poolSlip, invCap, dailyCap, swapped] = await client.readContract({ address: dep.pool, abi: hedgeAbi, functionName: "hedgeLimits", args: [name, chainDay] });
    const sNum = Number(formatEther(s));
    const book = await readPositions(client, dep.pool, dep.book, market);
    const wanted = targetHedge(book, sNum, sigmaBps, 0); // the holding that offsets the option delta
    const heldUnits = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [dep.pool] });
    const held = Number(formatEther(heldUnits * scale));
    const spendable = Number(formatUnits(await client.readContract({ address: dep.pool, abi: hedgeAbi, functionName: "freeForWithdrawals" }), 6));
    const dayRoom = dailyCap > swapped ? Number(formatUnits(dailyCap - swapped, 6)) : 0;
    const cap = cfg.deltaCapUsd[market];
    if (cap === undefined) {
      log("warn", "no delta cap configured: market not hedged", at);
      continue;
    }
    const p = planSwap(market, wanted, held, sNum, cap, Number(formatEther(invCap)), spendable, dayRoom);
    const inv = { held, target: p.target, band: p.band };
    if (p.unhedged > 0) log("alarm", "stock hedge beyond what the pool may hold: remainder unhedged", { ...at, wanted: p.wanted, target: p.target, unhedgedShares: p.unhedged, unhedgedUsd: p.unhedged * sNum });
    log("info", "plan", { ...at, venue: "onchain", s: sNum, sigmaBps, series: book.length, wanted: p.wanted, target: p.target, current: held, band: p.band, reason: p.reason, swap: p.swap });
    if (router === "0x0000000000000000000000000000000000000000") {
      // no venue listed: the market cannot be hedged, which the risk-monitor treats as an outage (opens pause)
      log("alarm", "no on-chain hedge router listed: stock market not hedged", at);
      st.set(market, false, "no hedge router listed", inv);
      continue;
    }
    if (!p.swap) {
      st.set(market, true, undefined, inv);
      continue;
    }
    const slip = BigInt(Math.min(cfg.slippageBps, poolSlip));
    const amountIn = p.swap.buy ? BigInt(Math.floor(p.swap.usdc * 1e6)) : (BigInt(Math.floor(p.swap.shares * 1e6)) * 10n ** 12n) / scale;
    const minOut = floorOut(p.swap.buy, amountIn, s, scale, slip);
    if (amountIn === 0n || minOut === 0n) {
      st.set(market, true, undefined, inv);
      continue;
    }
    if (cfg.dryRun || !signer?.wallet) {
      log("info", "would send", { ...at, buy: p.swap.buy, amountIn: amountIn.toString(), minOut: minOut.toString(), dryRun: true });
      st.set(market, true, undefined, inv);
      continue;
    }
    const call = { address: dep.gate ?? dep.pool, abi: hedgeAbi, functionName: "hedgeSwap", args: [name, p.swap.buy, amountIn, minOut], account: signer.account! } as const;
    let gas: bigint;
    try {
      gas = await client.estimateContractGas(call);
    } catch (e) {
      const err = revertName(e);
      if (err && RACE.has(err)) {
        log("info", "skip", { ...at, reason: "room changed since read", error: err });
        st.set(market, true, undefined, inv);
        continue;
      }
      if (err === "Frozen") {
        // the guardian froze the gate: no swap until the Safe unfreezes it (the risk monitor counts it as an outage)
        log("alarm", "on-chain hedging frozen at the gate: stock market not hedged", at);
        st.set(market, false, "hedging frozen", inv);
        continue;
      }
      st.set(market, false, err ?? "swap simulation failed");
      throw new Error(`hedge swap on ${market} would fail: ${err ?? (e as Error).message.split("\n")[0]}`);
    }
    const sentAt = new Date().toISOString();
    const hash = await signer.wallet.writeContract({ ...call, chain: signer.wallet.chain, gas: withHeadroom(gas), maxFeePerGas: MAX_FEE_PER_GAS });
    const rc = await client.waitForTransactionReceipt({ hash, pollingInterval: POLL_MS });
    if (rc.status !== "success") {
      st.set(market, false, "swap reverted");
      throw new Error(`hedge swap on ${market} reverted (${hash})`);
    }
    let out = 0n;
    for (const l of rc.logs) {
      try {
        const ev = decodeEventLog({ abi: hedgeAbi, data: l.data, topics: l.topics });
        if (ev.eventName === "HedgeSwapped") out = ev.args.amountOut;
      } catch {}
    }
    const after = Number(formatEther((await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [dep.pool] })) * scale));
    // a row shaped like the spec's hedges table (Backend §8)
    log("info", "hedge", {
      id: hash,
      market,
      side: p.swap.buy ? "buy" : "sell",
      sz: p.swap.shares,
      px: p.swap.buy ? Number(formatUnits(amountIn, 6)) / Number(formatEther(out * scale)) : Number(formatUnits(out, 6)) / Number(formatEther(amountIn * scale)),
      sent_at: sentAt,
      reconciled_at: new Date().toISOString(),
      filled_sz: p.swap.buy ? Number(formatEther(out * scale)) : Number(formatEther(amountIn * scale)),
      status: "filled",
      position_after: after,
      via: "onchain_dex",
    });
    st.set(market, true, undefined, { held: after, target: p.target, band: p.band });
  }
}

async function main(): Promise<void> {
  const cfg = parseOnchainArgs(process.argv.slice(2));
  const dep = loadDeployment(cfg.deployment);
  const client = await connect(cfg.rpc, dep);
  checkOnchainForChain(cfg, dep.chainId);
  const markets: { market: string; token: Address; scale: bigint }[] = [];
  for (const m of dep.markets) {
    const t = await stockToken(client, dep.pool, m);
    if (t) markets.push({ market: m, ...t });
  }
  const signer = cfg.key && !cfg.dryRun ? await loadSigner(cfg.key, dep.chainId, cfg.rpc) : null;
  const st = new StatusBook(cfg.statusFile, "onchain");
  log("info", "started", { venue: "onchain", pool: dep.pool, markets: markets.map((m) => m.market), keeper: signer?.address ?? null, dryRun: !signer, slippageBps: cfg.slippageBps });
  await loop(markets.map((m) => m.market), st, cfg.once, cfg.tickSeconds, () => tick(cfg, client, dep, markets, signer, st));
}

if (import.meta.main) main().catch(fatal);
