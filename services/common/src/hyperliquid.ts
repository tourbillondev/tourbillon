/// Hyperliquid's public info API, read-only. Only the `/info` path is ever called; this service has no way to
/// reach `/exchange` and holds no Hyperliquid key.

export const HL_API = "https://api.hyperliquid.xyz";
export const TIMEOUT_MS = 3_000;
/// Skip a market when its mark and oracle prices differ by more than 5% (owner decision): broken data, not a
/// price to vote.
export const MAX_ORACLE_DEV_BPS = 500n;

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

export type MarkResult =
  | { ok: true; mark: bigint; oracle: bigint; mid: bigint | null; szDecimals: number }
  | { ok: false; reason: "missing" | "delisted" | "bad-price" | "oracle-deviation"; detail?: string };

/// Picks `markets` out of a `metaAndAssetCtxs` reply: [meta{universe}, assetCtxs[]], matched by position.
export function parseMarks(body: unknown, markets: string[]): Map<string, MarkResult> {
  if (!Array.isArray(body) || body.length < 2) throw new Error("reply is not [meta, assetCtxs]");
  const universe = (body[0] as { universe?: unknown })?.universe;
  const ctxs = body[1];
  if (!Array.isArray(universe) || !Array.isArray(ctxs) || universe.length !== ctxs.length) {
    throw new Error("universe and assetCtxs do not line up");
  }
  const out = new Map<string, MarkResult>();
  for (const market of markets) {
    const i = universe.findIndex((u) => (u as { name?: unknown })?.name === market);
    if (i < 0) {
      out.set(market, { ok: false, reason: "missing" });
      continue;
    }
    if ((universe[i] as { isDelisted?: unknown }).isDelisted === true) {
      out.set(market, { ok: false, reason: "delisted" });
      continue;
    }
    const ctx = ctxs[i] as { markPx?: unknown; oraclePx?: unknown; midPx?: unknown };
    const szDecimals = Number((universe[i] as { szDecimals?: unknown }).szDecimals ?? 0);
    let mark: bigint, oracle: bigint;
    try {
      mark = decimalToWad(ctx?.markPx);
      oracle = decimalToWad(ctx?.oraclePx);
    } catch (e) {
      out.set(market, { ok: false, reason: "bad-price", detail: (e as Error).message });
      continue;
    }
    const diff = mark > oracle ? mark - oracle : oracle - mark;
    if (diff * 10_000n > oracle * MAX_ORACLE_DEV_BPS) {
      out.set(market, { ok: false, reason: "oracle-deviation", detail: `mark ${ctx.markPx} oracle ${ctx.oraclePx}` });
      continue;
    }
    let mid: bigint | null = null;
    try {
      mid = decimalToWad(ctx.midPx);
    } catch {
      mid = null; // midPx can be null on a thin book
    }
    out.set(market, { ok: true, mark, oracle, mid, szDecimals });
  }
  return out;
}

/// One `metaAndAssetCtxs` request with a hard timeout.
export async function fetchMetaAndAssetCtxs(base = HL_API, timeoutMs = TIMEOUT_MS): Promise<unknown> {
  const url = new URL("/info", base);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/// One `candleSnapshot` request: 5-minute trade candles for `coin` over [startMs, endMs].
export async function fetchCandles(
  coin: string,
  startMs: number,
  endMs: number,
  base = HL_API,
  timeoutMs = TIMEOUT_MS,
): Promise<unknown> {
  const url = new URL("/info", base);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval: "5m", startTime: startMs, endTime: endMs } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/// Closes of complete 5-minute candles as boundary prices: a candle opening at t closes at t + 5 min, so its
/// close is the price at that boundary. A candle still open at `nowMs` is dropped. Times in seconds.
export function parseCandles(body: unknown, coin: string, nowMs: number): { t: number; px: number }[] {
  if (!Array.isArray(body)) throw new Error("candles: reply is not a list");
  const out: { t: number; px: number }[] = [];
  for (const c of body as Record<string, unknown>[]) {
    if (c?.s !== coin || c?.i !== "5m") throw new Error("candles: wrong coin or interval");
    const t = c.t;
    const T = c.T;
    if (typeof t !== "number" || typeof T !== "number" || t % 300_000 !== 0) throw new Error("candles: bad time");
    if (T >= nowMs) continue; // still open
    decimalToWad(c.c); // a plain positive decimal, or throws
    const close = { t: t / 1000 + 300, px: Number(c.c) };
    const prev = out.at(-1);
    if (prev && close.t <= prev.t) throw new Error("candles: not in time order");
    out.push(close);
  }
  return out;
}
