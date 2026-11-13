/// TypeScript port of TempoMath (contracts/src/TempoMath.sol) and TempoBlend, in floating point, with the analytic
/// delta. Off-chain only: the hedger sizes hedges with it and the maker-gateway ranks quotes with it; on-chain prices
/// never come from here.
///
///   a = 2 / (σ² τ),  d = √(1/4 + a),  p± = 1/2 ± d,  x = S / K
///   time value  tv = K · x^p / (2d),  p = p+ when S ≤ K, p− when S > K   (the same for a call and a put)
///   call = max(S − K, 0) + tv,  put = max(K − S, 0) + tv
///   d tv / dS = p · x^(p − 1) / (2d)
///   call delta = [S > K] + d tv/dS,  put delta = call delta − 1 (parity; this also holds at S = K)
/// σ in bps, tempo in seconds, a 365-day year (as on-chain).

export const YEAR = 365 * 86_400;
export const MIN_TEMPO = 3_600;
export const MAX_TEMPO = 30 * 86_400;

export type Part = { tempo: number; weight: number }; // weight as a fraction (sum 1)

function check(s: number, k: number, sigmaBps: number, tempo: number): void {
  if (!(s > 0) || !(k > 0) || !(sigmaBps > 0)) throw new Error("tempo: S, K and σ must be positive");
  if (tempo < MIN_TEMPO || tempo > MAX_TEMPO) throw new Error(`tempo: ${tempo} s out of range`);
}

function roots(sigmaBps: number, tempo: number): { d: number; pPlus: number; pMinus: number } {
  const sigma = sigmaBps / 10_000;
  const tau = tempo / YEAR;
  const d = Math.sqrt(0.25 + 2 / (sigma * sigma * tau));
  return { d, pPlus: 0.5 + d, pMinus: 0.5 - d };
}

export function timeValue(s: number, k: number, sigmaBps: number, tempo: number): number {
  check(s, k, sigmaBps, tempo);
  const { d, pPlus, pMinus } = roots(sigmaBps, tempo);
  const p = s <= k ? pPlus : pMinus;
  return (k * Math.pow(s / k, p)) / (2 * d);
}

export function value(isCall: boolean, s: number, k: number, sigmaBps: number, tempo: number): number {
  const intrinsic = isCall ? Math.max(s - k, 0) : Math.max(k - s, 0);
  return intrinsic + timeValue(s, k, sigmaBps, tempo);
}

export function delta(isCall: boolean, s: number, k: number, sigmaBps: number, tempo: number): number {
  check(s, k, sigmaBps, tempo);
  const { d, pPlus, pMinus } = roots(sigmaBps, tempo);
  const p = s <= k ? pPlus : pMinus;
  const dtv = (p * Math.pow(s / k, p - 1)) / (2 * d);
  const callDelta = (s > k ? 1 : 0) + dtv;
  return isCall ? callDelta : callDelta - 1; // put = call − 1 everywhere (parity), including S = K
}

/// A Movement's value and delta: the weighted sums (a single tempo is one part of weight 1).
export function blendValue(isCall: boolean, s: number, k: number, sigmaBps: number, parts: Part[]): number {
  return parts.reduce((acc, p) => acc + p.weight * value(isCall, s, k, sigmaBps, p.tempo), 0);
}

export function blendDelta(isCall: boolean, s: number, k: number, sigmaBps: number, parts: Part[]): number {
  return parts.reduce((acc, p) => acc + p.weight * delta(isCall, s, k, sigmaBps, p.tempo), 0);
}
