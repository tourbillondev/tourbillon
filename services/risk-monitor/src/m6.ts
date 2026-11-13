import { formatUnits, hexToString, type Address, type Log } from "viem";
import type { Alarm } from "./alarm.ts";

/// M6 (the open book): the pool's buybacks, the MatchBook's backstop, maker vault slashes and the weekly risk auction.
/// Pure: logs in, alarm lines out. Dust (a buyback shortfall of at most 1 micro-USDC per source, absorbed by the pool:
/// owner's option A) is summed into one line per pass, not one per event.

const usdc = (v: bigint) => Number(formatUnits(v, 6));
const marketName = (h: `0x${string}`) => hexToString(h, { size: 32 }).replace(/\0+$/, "");

export const m6Abi = [
  { type: "event", name: "BuybackSettled", inputs: [{ type: "uint256", name: "id", indexed: true }, { type: "uint256", name: "paidUsdc" }, { type: "uint256", name: "paidWhype" }, { type: "uint256", name: "shortfall" }] },
  { type: "event", name: "BuybackFailed", inputs: [{ type: "uint256", name: "id", indexed: true }, { type: "uint256", name: "rawSold" }] },
  { type: "event", name: "AuctionFilled", inputs: [{ type: "uint256", name: "id", indexed: true }, { type: "uint256", name: "raw" }, { type: "uint256", name: "price" }, { type: "address", name: "winner" }] },
  { type: "event", name: "Flagged", inputs: [{ type: "bytes32", name: "key", indexed: true }, { type: "uint256", name: "seriesId", indexed: true }, { type: "uint256", name: "uncoveredRaw" }] },
  { type: "event", name: "DustAbsorbed", inputs: [{ type: "bytes32", name: "key", indexed: true }, { type: "uint256", name: "seriesId", indexed: true }, { type: "uint256", name: "usdc" }] },
  {
    type: "event",
    name: "Slashed",
    inputs: [
      { type: "address", name: "maker", indexed: true },
      { type: "address", name: "token", indexed: true },
      { type: "uint256", name: "asked" },
      { type: "uint256", name: "taken" },
      { type: "address", name: "to" },
      { type: "address", name: "by", indexed: true },
    ],
  },
  {
    type: "event",
    name: "Started",
    inputs: [
      { type: "uint256", name: "lotId", indexed: true },
      { type: "bytes32", name: "market", indexed: true },
      { type: "uint256", name: "seriesId", indexed: true },
      { type: "uint256", name: "raw" },
      { type: "uint256", name: "bond" },
      { type: "uint64", name: "commitEnd" },
      { type: "uint64", name: "revealEnd" },
    ],
  },
  { type: "event", name: "Forfeited", inputs: [{ type: "uint256", name: "lotId", indexed: true }, { type: "address", name: "bidder", indexed: true }, { type: "uint256", name: "bond" }, { type: "string", name: "why" }] },
  {
    type: "event",
    name: "Settled",
    inputs: [
      { type: "uint256", name: "lotId", indexed: true },
      { type: "address", name: "winner" },
      { type: "uint256", name: "sigmaBps" },
      { type: "uint256", name: "raw" },
      { type: "uint256", name: "price" },
      { type: "uint256", name: "reserve" },
    ],
  },
] as const;

export type M6Event = { eventName: string; args: Record<string, unknown>; transactionHash: Log["transactionHash"] };

/// An auction lot the monitor is waiting on: started, not yet settled.
export type OpenLot = { lotId: bigint; market: string; revealEnd: number };

/// One alarm per event that needs a person; open lots updated in place; dust summed.
export function m6Alarms(events: M6Event[], open: Map<bigint, OpenLot>, usdcToken: Address | null): Omit<Alarm, "state">[] {
  const out: Omit<Alarm, "state">[] = [];
  let dust = 0n;
  let dustCount = 0;
  for (const e of events) {
    const a = e.args;
    const tx = e.transactionHash;
    switch (e.eventName) {
      case "BuybackFailed":
        out.push({ name: "BUYBACK_FAILED", level: "alarm", what: "A sell's buyback from the open book failed: the seller was paid by the pool; the series' matched raw is now carried by the pool (counted in coverage).", who: "admin: review the MatchBook sources of this series", market: null, values: { seriesId: a.id, rawSold: a.rawSold, tx } });
        break;
      case "BuybackSettled":
        if ((a.shortfall as bigint) > 0n) out.push({ name: "BUYBACK_SHORTFALL", level: "warn", what: "A buyback fell short of the seller's gross beyond rounding: the shortfall was slashed from the source's vault, then absorbed by the pool.", who: "admin: review the source", market: null, values: { seriesId: a.id, paidUsdc: usdc(a.paidUsdc as bigint), shortfall: usdc(a.shortfall as bigint), tx } });
        break;
      case "Flagged":
        out.push({ name: "MATCHED_UNCOVERED", level: "alarm", what: "A matched source was flagged: its raw is uncovered and the pool now counts it in the stressed liability.", who: "admin: review the source and coverage", market: null, values: { source: a.key, seriesId: a.seriesId, uncoveredRaw: a.uncoveredRaw, tx } });
        break;
      case "DustAbsorbed":
        dust += a.usdc as bigint;
        dustCount++;
        break;
      case "Slashed":
        out.push({ name: "VAULT_SLASHED", level: "warn", what: "A maker's vault was slashed (a buyback shortfall or a forfeited auction bond).", who: "nobody: automatic; makers see it in their vault", market: null, values: { maker: a.maker, asked: a.token === usdcToken ? usdc(a.asked as bigint) : a.asked, taken: a.token === usdcToken ? usdc(a.taken as bigint) : a.taken, token: a.token, tx } });
        break;
      case "Started": {
        const market = marketName(a.market as `0x${string}`);
        open.set(a.lotId as bigint, { lotId: a.lotId as bigint, market, revealEnd: Number(a.revealEnd) });
        out.push({ name: "AUCTION_STARTED", level: "warn", what: "A weekly risk auction lot opened: commits for 3 days, reveals for 1 day, then anyone settles.", who: "makers: bid; nobody else", market, values: { lotId: a.lotId, seriesId: a.seriesId, raw: a.raw, bond: usdc(a.bond as bigint), commitEnd: Number(a.commitEnd), revealEnd: Number(a.revealEnd), tx } });
        break;
      }
      case "Forfeited":
        out.push({ name: "AUCTION_FORFEIT", level: "warn", what: a.why === "not revealed" ? "A bidder did not reveal: its bond went to the pool." : "The lowest bidder could not collateralise: its bond went to the pool and the next bid within the reserve was tried.", who: "nobody: automatic", market: null, values: { lotId: a.lotId, bidder: a.bidder, bond: usdc(a.bond as bigint), why: a.why, tx } });
        break;
      case "Settled": {
        const lot = open.get(a.lotId as bigint);
        open.delete(a.lotId as bigint);
        const filled = (a.raw as bigint) > 0n;
        out.push({ name: "AUCTION_SETTLED", level: "warn", what: filled ? "A risk auction lot settled: the winner now writes the slice against exact collateral and the pool stopped carrying it." : "A risk auction lot settled with no fill (no bid within the reserve): the pool keeps the risk.", who: filled ? "nobody" : "admin: note the pool keeps this risk", market: lot?.market ?? null, values: { lotId: a.lotId, winner: a.winner, sigmaBps: a.sigmaBps, raw: a.raw, price: usdc(a.price as bigint), reserve: usdc(a.reserve as bigint), tx } });
        break;
      }
    }
  }
  if (dustCount > 0) out.push({ name: "DUST_ABSORBED", level: "warn", what: "Buyback rounding (at most 1 micro-USDC per source) was absorbed by the pool.", who: "nobody", market: null, values: { events: dustCount, usdc: usdc(dust) } });
  return out;
}

/// Lots whose reveal ended more than `graceS` ago and are still not settled: anyone can settle; until then bonds stay
/// locked and the pool keeps the risk.
export function settleDue(open: Map<bigint, OpenLot>, now: number, graceS: number): OpenLot[] {
  return [...open.values()].filter((l) => now > l.revealEnd + graceS);
}
