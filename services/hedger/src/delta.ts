import { blendDelta, type Part } from "./tempo.ts";

/// One leg of a series, from the holder's side (+ long, − short), amount as a ratio (a single leg is ±1).
export type Leg = { isCall: boolean; k: number; qty: number };

/// One open series as the hedger sees it (M4): its legs (a single leg is one leg of +1), its movement, and the units
/// held AGAINST the pool: positive when buyers hold them (the pool is short), negative when the pool holds written
/// shapes (the pool is long).
export type Position = { legs: Leg[]; parts: Part[]; units: number };

/// A single-leg position (calls and puts, as before M4).
export function single(isCall: boolean, k: number, parts: Part[], units: number): Position {
  return { legs: [{ isCall, k, qty: 1 }], parts, units };
}

/// Delta of one unit of a series: Σ qty × the leg's blended delta.
export function unitDelta(p: Position, s: number, sigmaBps: number): number {
  let d = 0;
  for (const l of p.legs) d += l.qty * blendDelta(l.isCall, s, l.k, sigmaBps, p.parts);
  return d;
}

/// The pool's net delta on a market, in coins: −Σ units × unit delta (it is short what holders own and long what it
/// holds from writers), plus `heldCoins` the pool holds outright (its WHYPE on HYPE, M4 decision A).
export function poolNetDelta(positions: Position[], s: number, sigmaBps: number, heldCoins = 0): number {
  let sum = 0;
  for (const p of positions) {
    if (p.units === 0) continue;
    sum += p.units * unitDelta(p, s, sigmaBps);
  }
  return heldCoins - sum;
}

/// The perp position that offsets it (coins; + long).
export function targetHedge(positions: Position[], s: number, sigmaBps: number, heldCoins = 0): number {
  return -poolNetDelta(positions, s, sigmaBps, heldCoins);
}
