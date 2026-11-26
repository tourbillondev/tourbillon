/// From a target hedge and the current position to intended trades (owner defaults, all configurable). Two venues
/// (Backend §6): perpetual orders at the crypto hedge exchange (`plan`), and on-chain swaps of a tokenized stock that
/// the pool holds (`planSwap`). For the exchange:
/// - the hard position limit is the market's delta cap in coins (cap USD / mid); a target beyond it is clipped and an
///   ALARM reports the unhedged remainder;
/// - nothing is traded while |target − current| is within the band (10% of the delta cap);
/// - orders are IOC limits at mid ± 0.5%, sized in the market's size decimals, at least $10 of notional;
/// - an order that shrinks a position without crossing zero is reduce-only; one that crosses zero is split into a
///   reduce-only close and an opening order;
/// - sizes and prices follow the market's own size and price decimals (from the exchange).

export type Policy = { bandFraction: number; limitBps: number; minNotionalUsd: number };
export const DEFAULT_POLICY: Policy = { bandFraction: 0.1, limitBps: 50, minNotionalUsd: 10 };

export type Order = { market: string; side: "buy" | "sell"; sz: number; limitPx: number; reduceOnly: boolean; tif: "Ioc" };

export type Plan = {
  market: string;
  target: number; // after clipping
  wanted: number; // before clipping
  current: number;
  hardLimit: number;
  band: number;
  unhedged: number; // coins beyond the hard limit (0 if none)
  orders: Order[];
  reason: "in-band" | "rebalance" | "below-minimum";
};

/// Rounds a size down to the market's size decimals.
export function roundSize(sz: number, szDecimals: number): number {
  const f = 10 ** szDecimals;
  return Math.floor(sz * f + 1e-9) / f;
}

/// Rounds a price to the market's price decimals. `up` rounds towards a higher price (used for sells, keeping the
/// limit inside the ±0.5% band), else down (buys).
export function roundPrice(px: number, pxDecimals: number, up: boolean): number {
  const f = 10 ** pxDecimals;
  const v = up ? Math.ceil(px * f - 1e-9) / f : Math.floor(px * f + 1e-9) / f;
  return Number(v.toFixed(pxDecimals));
}

export function plan(
  market: string,
  wanted: number,
  current: number,
  mid: number,
  szDecimals: number,
  pxDecimals: number,
  deltaCapUsd: number,
  policy: Policy = DEFAULT_POLICY,
): Plan {
  const hardLimit = deltaCapUsd / mid;
  const target = Math.max(-hardLimit, Math.min(hardLimit, wanted));
  const unhedged = Math.abs(wanted) - Math.abs(target);
  const band = policy.bandFraction * hardLimit;
  const base = { market, target, wanted, current, hardLimit, band, unhedged: unhedged > 1e-12 ? unhedged : 0 };
  const err = target - current;
  if (Math.abs(err) <= band) return { ...base, orders: [], reason: "in-band" };

  const legs: { side: "buy" | "sell"; sz: number; reduceOnly: boolean }[] = [];
  const side = err > 0 ? "buy" : "sell";
  const crosses = current !== 0 && Math.sign(target) !== Math.sign(current) && target !== 0;
  if (crosses) {
    legs.push({ side, sz: Math.abs(current), reduceOnly: true });
    legs.push({ side, sz: Math.abs(target), reduceOnly: false });
  } else {
    const shrinking = current !== 0 && Math.abs(target) < Math.abs(current);
    legs.push({ side, sz: Math.abs(err), reduceOnly: shrinking });
  }
  const orders: Order[] = [];
  for (const l of legs) {
    const sz = roundSize(l.sz, szDecimals);
    const limitPx = roundPrice(l.side === "buy" ? mid * (1 + policy.limitBps / 10_000) : mid * (1 - policy.limitBps / 10_000), pxDecimals, l.side === "sell");
    if (sz * mid < policy.minNotionalUsd) continue;
    orders.push({ market, side: l.side, sz, limitPx, reduceOnly: l.reduceOnly, tif: "Ioc" });
  }
  return { ...base, orders, reason: orders.length ? "rebalance" : "below-minimum" };
}

/// On-chain stock hedging (Backend §6, owner G7): the pool holds the tokenized stock itself, so the hedge is a holding,
/// never a short. `wanted` is the holding (shares) that offsets the pool's option delta; it is clipped to [0, the hard
/// limit] (the delta cap in shares, and the pool's inventory cap). Nothing trades within the band (10% of the hard
/// limit). A buy is also clipped to the USDC the pool may spend (available above the stressed liability) and to the
/// day's swap room; a swap worth less than the minimum is skipped. `minOut` is set by the caller from the router mark
/// and the slippage policy; the pool refuses anything below its own floor.
export type SwapPolicy = { bandFraction: number; slippageBps: number; minNotionalUsd: number };
export const DEFAULT_SWAP_POLICY: SwapPolicy = { bandFraction: 0.1, slippageBps: 50, minNotionalUsd: 10 };

export type SwapPlan = {
  market: string;
  wanted: number;
  target: number;
  current: number;
  hardLimit: number;
  band: number;
  unhedged: number; // shares the pool cannot hold: beyond the hard limit, or a short (negative) target
  swap: { buy: boolean; shares: number; usdc: number } | null;
  reason: "in-band" | "rebalance" | "below-minimum" | "no-room";
};

export function planSwap(
  market: string,
  wanted: number,
  current: number,
  s: number,
  deltaCapUsd: number,
  inventoryCapShares: number,
  spendableUsdc: number,
  dayRoomUsdc: number,
  policy: SwapPolicy = DEFAULT_SWAP_POLICY,
): SwapPlan {
  const hardLimit = Math.min(deltaCapUsd / s, inventoryCapShares);
  const target = Math.max(0, Math.min(hardLimit, wanted));
  const unhedged = wanted < 0 ? -wanted : Math.max(0, wanted - target);
  const band = policy.bandFraction * hardLimit;
  const base = { market, wanted, target, current, hardLimit, band, unhedged: unhedged > 1e-12 ? unhedged : 0 };
  const err = target - current;
  if (Math.abs(err) <= band) return { ...base, swap: null, reason: "in-band" };
  const buy = err > 0;
  let usdc = Math.abs(err) * s;
  if (buy) usdc = Math.min(usdc, spendableUsdc);
  usdc = Math.min(usdc, dayRoomUsdc);
  if (usdc <= 0) return { ...base, swap: null, reason: "no-room" };
  if (usdc < policy.minNotionalUsd) return { ...base, swap: null, reason: "below-minimum" };
  return { ...base, swap: { buy, shares: usdc / s, usdc }, reason: "rebalance" };
}
