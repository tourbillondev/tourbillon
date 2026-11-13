import { getAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";

/// Quote v2 (M6 decision D7), as VolQuoteBook verifies it: a maker's σ for a band of strikes and tempos on one
/// market, for calls, puts or both, up to a size, until a deadline. EIP-712 domain: "Tourbillon", version "1", the
/// chain id, the VolQuoteBook as verifying contract.

export const SIDE_CALLS = 1;
export const SIDE_PUTS = 2;
export const SIDE_BOTH = 3;
export const MIN_SIGMA_BPS = 500n; // the maths bounds (TempoMath): 5% … 500%
export const MAX_SIGMA_BPS = 50_000n;
export const MAX_QUOTES_PER_ORDER = 4; // the OpenBook takes at most 4 quotes

export type Quote = {
  maker: Address;
  name: Hex; // bytes32 market
  sides: number;
  kLoWad: bigint;
  kHiWad: bigint;
  tauLo: number;
  tauHi: number;
  sigmaBps: bigint;
  maxUnits: bigint;
  validUntil: bigint;
  nonce: bigint;
};

export type Leg = { isCall: boolean; kWad: bigint; qty: bigint }; // the buyer's side, as the OpenBook takes it
export type Part = { tempo: bigint; weight: bigint };
export type Order = { name: Hex; legs: Leg[]; movement: Part[]; units: bigint };

export const quoteTypes = {
  Quote: [
    { name: "maker", type: "address" },
    { name: "name", type: "bytes32" },
    { name: "sides", type: "uint8" },
    { name: "kLoWad", type: "uint128" },
    { name: "kHiWad", type: "uint128" },
    { name: "tauLo", type: "uint32" },
    { name: "tauHi", type: "uint32" },
    { name: "sigmaBps", type: "uint64" },
    { name: "maxUnits", type: "uint128" },
    { name: "validUntil", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

export function domainFor(chainId: number, quoteBook: Address) {
  return { name: "Tourbillon", version: "1", chainId, verifyingContract: quoteBook } as const;
}

/// The quote's own terms, as the contract checks them before any order: sides, σ inside the maths bounds, bands in
/// order, a size. Returns the reason it is refused, or null.
export function termsProblem(q: Quote): string | null {
  if (!Number.isInteger(q.sides) || q.sides < SIDE_CALLS || q.sides > SIDE_BOTH) return "sides must be 1 (calls), 2 (puts) or 3 (both)";
  if (q.sigmaBps < MIN_SIGMA_BPS || q.sigmaBps > MAX_SIGMA_BPS) return "sigma outside 5%–500%";
  if (q.kLoWad > q.kHiWad) return "strike band reversed";
  if (q.tauLo > q.tauHi) return "tempo band reversed";
  if (q.maxUnits <= 0n) return "no size";
  return null;
}

/// True when the signature over `q` recovers to `q.maker` (EOA signatures only, as on-chain).
export async function signedByMaker(q: Quote, sig: Hex, chainId: number, quoteBook: Address): Promise<boolean> {
  try {
    const who = await recoverTypedDataAddress({ domain: domainFor(chainId, quoteBook), types: quoteTypes, primaryType: "Quote", message: q, signature: sig });
    return who.toLowerCase() === q.maker.toLowerCase();
  } catch {
    return false;
  }
}

/// Whether the whole order fits the quote's band, as VolQuote.check: same market, every leg's side and strike, every
/// Movement part's tempo, and the units given what is already filled.
export function fits(q: Quote, o: Order, alreadyFilled: bigint): boolean {
  if (q.name.toLowerCase() !== o.name.toLowerCase() || o.legs.length === 0 || o.movement.length === 0 || o.units <= 0n) return false;
  for (const l of o.legs) {
    const side = l.isCall ? SIDE_CALLS : SIDE_PUTS;
    if ((q.sides & side) === 0 || l.kWad < q.kLoWad || l.kWad > q.kHiWad) return false;
  }
  for (const p of o.movement) if (p.tempo < BigInt(q.tauLo) || p.tempo > BigInt(q.tauHi)) return false;
  return alreadyFilled + o.units <= q.maxUnits;
}

const WAD = 10n ** 18n;

/// The writer's worst case per unit of the order (USD, WAD), the side a maker takes: the buyer's legs negated, the
/// lowest payoff over S = 0 and every strike. null when unbounded (the maker would be net short calls), which the
/// MatchBook refuses (law 4). Mirrors StrategyMath.writerCollateral without cover.
export function writerWorstPerUnit(buyerLegs: Leg[]): bigint | null {
  let callSlope = 0n;
  for (const l of buyerLegs) if (l.isCall) callSlope -= l.qty;
  if (callSlope < 0n) return null;
  const payoff = (s: bigint) => {
    let v = 0n;
    for (const l of buyerLegs) {
      const intrinsic = l.isCall ? (s > l.kWad ? s - l.kWad : 0n) : l.kWad > s ? l.kWad - s : 0n;
      v -= (l.qty * intrinsic) / WAD;
    }
    return v;
  };
  let min = payoff(0n);
  for (const l of buyerLegs) {
    const v = payoff(l.kWad);
    if (v < min) min = v;
  }
  return min < 0n ? -min : 0n;
}

/// The USDC (6 decimals) a maker needs free in its vault to fill `units` of the order: worst per unit × units,
/// rounded up. null when unbounded.
export function collateralUsdc(buyerLegs: Leg[], units: bigint): bigint | null {
  const w = writerWorstPerUnit(buyerLegs);
  if (w === null) return null;
  const wad = (w * units + WAD - 1n) / WAD;
  return (wad + 10n ** 12n - 1n) / 10n ** 12n;
}

/// JSON with bigints as decimal strings.
export function toJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
}

const isHex = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v);
const big = (v: unknown, what: string): bigint => {
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^-?[0-9]+$/.test(v)) return BigInt(v);
  throw new Error(`${what}: an integer (string) is needed`);
};

export function parseQuote(v: unknown): Quote {
  const q = v as Record<string, unknown>;
  if (!q || typeof q !== "object") throw new Error("quote missing");
  if (!isHex(q.maker) || q.maker.length !== 42) throw new Error("maker: an address is needed");
  if (!isHex(q.name) || q.name.length !== 66) throw new Error("name: bytes32 is needed");
  return {
    maker: getAddress(q.maker),
    name: q.name,
    sides: Number(q.sides),
    kLoWad: big(q.kLoWad, "kLoWad"),
    kHiWad: big(q.kHiWad, "kHiWad"),
    tauLo: Number(big(q.tauLo, "tauLo")),
    tauHi: Number(big(q.tauHi, "tauHi")),
    sigmaBps: big(q.sigmaBps, "sigmaBps"),
    maxUnits: big(q.maxUnits, "maxUnits"),
    validUntil: big(q.validUntil, "validUntil"),
    nonce: big(q.nonce, "nonce"),
  };
}

export function parseOrder(v: unknown): Order {
  const o = v as Record<string, unknown>;
  if (!o || typeof o !== "object") throw new Error("order missing");
  if (!isHex(o.name) || o.name.length !== 66) throw new Error("name: bytes32 is needed");
  if (!Array.isArray(o.legs) || !Array.isArray(o.movement)) throw new Error("legs and movement are needed");
  return {
    name: o.name,
    legs: o.legs.map((l: Record<string, unknown>) => ({ isCall: l.isCall === true, kWad: big(l.kWad, "kWad"), qty: big(l.qty, "qty") })),
    movement: o.movement.map((p: Record<string, unknown>) => ({ tempo: big(p.tempo, "tempo"), weight: big(p.weight, "weight") })),
    units: big(o.units, "units"),
  };
}

export function parseSig(v: unknown): Hex {
  if (!isHex(v) || v.length !== 132) throw new Error("sig: 65 bytes hex is needed");
  return v;
}
