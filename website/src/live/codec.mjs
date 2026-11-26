// Exact conversions between what the dashboard shows and what the contracts take. Amounts never pass through a
// JavaScript Number on their way to a transaction: decimal strings in, bigint base units out, and back.
//   settlement amounts: the token's own decimals (from the deployment, read back from the token)
//   strikes, marks and units: WAD (18 decimals)    tempos: whole seconds    Movement weights: WAD, summing to 1e18

export const WAD = 10n ** 18n;
export const MIN_TEMPO = 3600; // TempoMath.MIN_TEMPO, 1 hour
export const MAX_TEMPO = 30 * 86400; // TempoMath.MAX_TEMPO, 30 days
export const MAX_PARTS = 4; // TempoBlend.MAX_PARTS
export const MAX_LEGS = 4; // StrategyMath.MAX_LEGS

export class CodecError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CodecError';
  }
}

/// "12.5" with 6 decimals → 12500000n. Refuses signs, exponents, empty parts and more decimals than the unit has
/// (nothing is rounded away silently).
export function parseDecimal(text, decimals, what = 'amount') {
  const s = String(text ?? '').trim();
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) throw new CodecError(`${what}: a plain decimal number is needed`);
  const [whole, frac = ''] = s.startsWith('.') ? ['0', s.slice(1)] : s.split('.');
  if (frac.length > decimals) throw new CodecError(`${what}: at most ${decimals} decimal places`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/// 12500000n with 6 decimals → "12.5" (exact; no trailing zeros).
export function formatUnits(value, decimals) {
  const v = BigInt(value);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const frac = (a % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${a / base}${frac ? `.${frac}` : ''}`;
}

/// The same, rounded for display to `places` decimals (half up), never used for an amount sent anywhere.
export function displayUnits(value, decimals, places = 2) {
  const v = BigInt(value);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const p = Math.min(places, decimals);
  const step = 10n ** BigInt(decimals - p);
  const r = (a + step / 2n) / step;
  const s = formatUnits(r, p);
  const [w, f = ''] = s.split('.');
  return `${neg && r > 0n ? '-' : ''}${Number(w).toLocaleString('en-US')}${p ? `.${f.padEnd(p, '0')}` : ''}`;
}

export const toWad = (text, what) => parseDecimal(text, 18, what);
export const fromWad = (v) => formatUnits(v, 18);

/// A tempo in days (the ticket's control) → whole seconds, inside TempoMath's range.
export function tempoSeconds(days) {
  if (!Number.isFinite(days)) throw new CodecError('tempo: a number of days is needed');
  const s = Math.round(days * 86400);
  if (s < MIN_TEMPO || s > MAX_TEMPO) throw new CodecError('tempo: from 1 hour to 30 days');
  return s;
}

/// The ticket's Movement rows [{days, percent}] → TempoBlend parts [{tempo, weight}]: whole percents summing to 100,
/// one to four distinct tempos; the weights sum to exactly 1e18.
export function movementParts(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_PARTS) throw new CodecError('Movement: one to four tempos');
  const parts = rows.map((r) => {
    const pct = Number(r.percent);
    if (!Number.isInteger(pct) || pct < 1 || pct > 100) throw new CodecError('Movement: each weight a whole percent from 1 to 100');
    return { tempo: BigInt(tempoSeconds(Number(r.days))), weight: BigInt(pct) * 10n ** 16n };
  });
  if (parts.reduce((s, p) => s + p.weight, 0n) !== WAD) throw new CodecError('Movement: the weights must add up to 100%');
  if (new Set(parts.map((p) => p.tempo)).size !== parts.length) throw new CodecError('Movement: each tempo once');
  return parts;
}

export const singleTempo = (days) => [{ tempo: BigInt(tempoSeconds(days)), weight: WAD }];

/// The legs of a shape from the buyer's side, spelled the book's one way (PathFundingBook: puts before calls, then
/// increasing strike, no repeats, first amount ±1). The writer's side is the same legs negated.
///   Rise k · Fall k · Spread k..k+w · Swing k · Band k±w, k±2w (a four-call condor)
export function shapeLegs(shape, strike, width, side = 'buy') {
  const k = toWad(strike, 'strike');
  const needsWidth = shape === 'Spread' || shape === 'Band';
  const w = needsWidth ? toWad(width, 'width') : 0n;
  if (k <= 0n) throw new CodecError('strike: more than 0');
  if (needsWidth && w <= 0n) throw new CodecError('width: more than 0');
  const call = (kWad, qty) => ({ isCall: true, kWad, qty: qty * WAD });
  const put = (kWad, qty) => ({ isCall: false, kWad, qty: qty * WAD });
  let legs;
  if (shape === 'Rise') legs = [call(k, 1n)];
  else if (shape === 'Fall') legs = [put(k, 1n)];
  else if (shape === 'Spread') legs = [call(k, 1n), call(k + w, -1n)];
  else if (shape === 'Swing') legs = [put(k, 1n), call(k, 1n)];
  else if (shape === 'Band') {
    if (k <= 2n * w) throw new CodecError('Band: the lowest wing must stay above 0');
    legs = [call(k - 2n * w, 1n), call(k - w, -1n), call(k + w, -1n), call(k + 2n * w, 1n)];
  } else throw new CodecError(`${shape} is not open in this site`);
  if (side === 'write') legs = legs.map((l) => ({ ...l, qty: -l.qty }));
  checkCanonical(legs);
  return legs;
}

/// The book's spelling rule, checked here so a refusal is explained before any transaction.
export function checkCanonical(legs) {
  if (!legs.length || legs.length > MAX_LEGS) throw new CodecError('legs: one to four');
  if (legs[0].qty !== WAD && legs[0].qty !== -WAD) throw new CodecError('legs: the first amount must be 1 or -1');
  for (let j = 1; j < legs.length; j++) {
    const a = legs[j - 1];
    const b = legs[j];
    const ordered = a.isCall === b.isCall ? a.kWad < b.kWad : !a.isCall;
    if (!ordered) throw new CodecError('legs: puts before calls, then increasing strike, no repeats');
  }
}

/// EnginePricing.checkStrike: a multiple of the market's strike step, between half and twice the mark.
export function strikeProblem(kWad, markWad, stepWad) {
  if (stepWad <= 0n) return 'this market has no strike step';
  if (kWad <= 0n || kWad % stepWad !== 0n) return `the strike must be a multiple of ${fromWad(stepWad)}`;
  if (2n * kWad < markWad || kWad > 2n * markWad) return `the strike must be between ${fromWad(markWad / 2n)} and ${fromWad(2n * markWad)} (half to twice the mark)`;
  return null;
}

/// The nearest strike on the step, as a decimal string.
export function snapStrike(text, stepWad) {
  const k = toWad(text, 'strike');
  const down = (k / stepWad) * stepWad;
  return fromWad(k - down >= stepWad / 2n ? down + stepWad : down);
}

/// Bounds the wallet signs: at most cost + bps for a buy, at least net − bps for a sale (rounded against the user's
/// counterparty, so the bound is never looser than asked).
export const maxCostFor = (cost, bps) => cost + (cost * BigInt(bps) + 9999n) / 10000n;
export const minOutFor = (net, bps) => net - (net * BigInt(bps) + 9999n) / 10000n;

/// StrategyMath.writerCollateral for a cash write, exactly as the contract computes it: the buyer's payoff is piecewise
/// linear with kinks at the strikes, so its maximum is at 0 or a strike unless it still rises above the top strike
/// (then the write is unbounded and refused: null). Per unit in WAD, rounded up; locked = ceil(units × perUnit / WAD)
/// in WAD, then rounded up to the settlement token's units (WriterBook._settlementFor).
export function payoffAtScaled(legs, sWad) {
  let v = 0n;
  for (const l of legs) {
    const intrinsic = l.isCall ? (sWad > l.kWad ? sWad - l.kWad : 0n) : (l.kWad > sWad ? l.kWad - sWad : 0n);
    v += l.qty * intrinsic;
  }
  return v; // WAD × WAD
}
export function writerCollateral(buyerLegs, units, decimals) {
  let slope = 0n;
  for (const l of buyerLegs) if (l.isCall) slope += l.qty;
  if (slope > 0n) return null;
  let maxS = payoffAtScaled(buyerLegs, 0n);
  for (const l of buyerLegs) {
    const v = payoffAtScaled(buyerLegs, l.kWad);
    if (v > maxS) maxS = v;
  }
  if (maxS < 0n) maxS = 0n;
  const perUnit = (maxS + WAD - 1n) / WAD;
  const lockedWad = (units * perUnit + WAD - 1n) / WAD;
  const scale = 10n ** BigInt(18 - decimals);
  return { perUnit, locked: (lockedWad + scale - 1n) / scale };
}
