import type { Address, Hex } from "viem";
import { blendValue } from "@tourbillon/common/tempo.ts";
import { collateralUsdc, fits, MAX_QUOTES_PER_ORDER, type Order, type Quote } from "./quote.ts";

/// The gateway's book of signed quotes, in memory. One entry per (maker, nonce): a re-signed quote with the same nonce
/// replaces the old one. Expired quotes are dropped on every read. The gateway holds no keys and no funds; it only
/// keeps what makers signed and passes it on. The OpenBook re-checks every quote on-chain at fill time.

export type Signed = { quote: Quote; sig: Hex; receivedAt: number };

/// On-chain state the gateway reads per maker and quote (VolQuoteBook and MakerVault), injected so the store is pure.
export type QuoteState = {
  filled(maker: Address, nonce: bigint): Promise<bigint>;
  cancelled(maker: Address, nonce: bigint): Promise<boolean>;
  freeUsdc(maker: Address): Promise<bigint>;
};

const keyOf = (q: Quote) => `${q.maker.toLowerCase()}:${q.nonce}`;

export class QuoteStore {
  private readonly quotes = new Map<string, Signed>();

  constructor(private readonly maxPerMaker = 64) {}

  get size(): number {
    return this.quotes.size;
  }

  add(s: Signed): void {
    const mine = [...this.quotes.values()].filter((x) => x.quote.maker.toLowerCase() === s.quote.maker.toLowerCase());
    if (!this.quotes.has(keyOf(s.quote)) && mine.length >= this.maxPerMaker) throw new Error(`at most ${this.maxPerMaker} live quotes per maker`);
    this.quotes.set(keyOf(s.quote), s);
  }

  prune(now: bigint): void {
    for (const [k, s] of this.quotes) if (s.quote.validUntil < now) this.quotes.delete(k);
  }

  /// The best quotes for an order: live, not cancelled, with room for the units, and from a maker whose vault holds
  /// the order's exact collateral free; cheapest first at the mark `s` (the order's value at each quote's σ: a shape
  /// can be short vega, so a lower σ is not always cheaper), ties to the earlier quote; one per maker; at most 4 (the
  /// OpenBook's limit). An order the maker side cannot collateralise (unbounded) gets none. The ranking is advisory:
  /// the OpenBook prices every candidate on-chain and takes the cheapest.
  async best(o: Order, s: number, now: bigint, st: QuoteState, n = MAX_QUOTES_PER_ORDER): Promise<Signed[]> {
    this.prune(now);
    const need = collateralUsdc(o.legs, o.units);
    if (need === null) return [];
    const price = new Map<Signed, number>();
    for (const x of this.quotes.values()) price.set(x, orderValue(o, s, Number(x.quote.sigmaBps)));
    const ranked = [...this.quotes.values()].sort((a, b) => price.get(a)! - price.get(b)! || a.receivedAt - b.receivedAt);
    const out: Signed[] = [];
    const usedMakers = new Set<string>();
    for (const s of ranked) {
      if (out.length >= n) break;
      const q = s.quote;
      const maker = q.maker.toLowerCase();
      if (usedMakers.has(maker)) continue; // one quote per maker: a vault backs one fill per order
      if (!fits(q, o, 0n)) continue;
      const [filled, cancelled, free] = await Promise.all([st.filled(q.maker, q.nonce), st.cancelled(q.maker, q.nonce), st.freeUsdc(q.maker)]);
      if (cancelled) {
        this.quotes.delete(keyOf(q));
        continue;
      }
      if (!fits(q, o, filled) || free < need) continue;
      usedMakers.add(maker);
      out.push(s);
    }
    return out;
  }
}

/// The order's value per unit (USD) at σ, in floating point (ranking only).
export function orderValue(o: Order, s: number, sigmaBps: number): number {
  const parts = o.movement.map((p) => ({ tempo: Number(p.tempo), weight: Number(p.weight) / 1e18 }));
  let v = 0;
  for (const l of o.legs) v += (Number(l.qty) / 1e18) * blendValue(l.isCall, s, Number(l.kWad) / 1e18, sigmaBps, parts);
  return v;
}
