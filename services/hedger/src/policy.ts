/// From a target hedge and the current perp position to intended orders (owner defaults, all configurable):
/// - the hard position limit is the market's delta cap in coins (cap USD / mid); a target beyond it is clipped and an
///   ALARM reports the unhedged remainder;
/// - nothing is traded while |target − current| is within the band (10% of the delta cap);
/// - orders are IOC limits at mid ± 0.5%, sized in the market's size decimals, at least $10 of notional;
/// - an order that shrinks a position without crossing zero is reduce-only; one that crosses zero is split into a
///   reduce-only close and an opening order.

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

/// Hyperliquid perp prices: at most 5 significant figures and at most (6 − szDecimals) decimals. `up` rounds towards
/// a higher price (used for sells, keeping the limit inside the ±0.5% band), else down (buys).
export function roundPrice(px: number, szDecimals: number, up: boolean): number {
  const maxDecimals = Math.max(0, 6 - szDecimals);
  const sigDecimals = Math.max(0, 5 - Math.floor(Math.log10(px)) - 1);
  const dec = Math.min(maxDecimals, sigDecimals);
  const f = 10 ** dec;
  const v = up ? Math.ceil(px * f - 1e-9) / f : Math.floor(px * f + 1e-9) / f;
  return Number(v.toFixed(dec));
}

export function plan(
  market: string,
  wanted: number,
  current: number,
  mid: number,
  szDecimals: number,
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
    const limitPx = roundPrice(l.side === "buy" ? mid * (1 + policy.limitBps / 10_000) : mid * (1 - policy.limitBps / 10_000), szDecimals, l.side === "sell");
    if (sz * mid < policy.minNotionalUsd) continue;
    orders.push({ market, side: l.side, sz, limitPx, reduceOnly: l.reduceOnly, tif: "Ioc" });
  }
  return { ...base, orders, reason: orders.length ? "rebalance" : "below-minimum" };
}
