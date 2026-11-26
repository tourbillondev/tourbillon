/// Exact decimal strings to WAD (18 decimals), without floating point.

const WAD_DECIMALS = 18;

/// Exact decimal string to WAD. Refuses anything that isn't a plain positive decimal with at most 18 decimals.
export function decimalToWad(s: unknown): bigint {
  if (typeof s !== "string" || !/^\d+(\.\d+)?$/.test(s)) throw new Error(`not a plain decimal: ${String(s)}`);
  const [int, frac = ""] = s.split(".");
  if (frac.length > WAD_DECIMALS) throw new Error(`more than 18 decimals: ${s}`);
  const wad = BigInt(int!) * 10n ** 18n + BigInt(frac.padEnd(WAD_DECIMALS, "0"));
  if (wad === 0n) throw new Error("zero price");
  return wad;
}
