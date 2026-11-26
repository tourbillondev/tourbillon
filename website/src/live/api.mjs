// The Tourbillon API v1, read for the live dashboard. Every answer is tagged with where it came from and when; a
// failure is an error the dashboard shows, never a reason to show sample data instead (docs 03: a live build must
// never fall back to demo data).
import { formatUnits, parseDecimal, toWad } from './codec.mjs';

export class ApiError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind; // 'transport' (unreachable, timeout) | 'domain' (the API refused or found nothing) | 'config'
    this.status = status;
  }
}

export function apiClient(base, { fetch: f = globalThis.fetch, timeoutMs = 8000 } = {}) {
  async function get(path) {
    let res;
    try {
      res = await f(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    } catch {
      throw new ApiError('transport', 'The Tourbillon API could not be reached.');
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw new ApiError('transport', `The Tourbillon API answered ${res.status} without JSON.`, res.status);
    }
    if (!res.ok) throw new ApiError(res.status === 429 ? 'transport' : 'domain', body?.error ?? `The Tourbillon API answered ${res.status}.`, res.status);
    return body;
  }

  /// /v1/status: chain, settlement token, pauses, pool and receipts. Amounts become base units (bigint).
  async function status() {
    const s = await get('/v1/status');
    const d = s?.settlement?.decimals;
    if (typeof d !== 'number') throw new ApiError('domain', 'The API did not name the settlement token.');
    const amt = (x) => (x == null ? null : parseDecimal(x, d, 'amount'));
    return {
      source: 'live',
      chainId: Number(s.chainId),
      settlement: s.settlement,
      block: BigInt(s.block),
      asOf: Number(s.blockTime),
      opens: s.opens,
      pool: {
        nav: amt(s.pool.nav),
        navPerShare: amt(s.pool.navPerShare),
        lastSettlement: s.pool.lastSettlement,
        available: amt(s.pool.available),
        stressedLiability: amt(s.pool.stressedLiability),
        covered: Boolean(s.pool.covered),
      },
      markets: s.markets,
      receipts: s.receipts,
    };
  }

  /// /v1/markets with the settlement decimals: marks and steps in WAD, caps in base units.
  async function markets(decimals) {
    const r = await get('/v1/markets');
    return r.markets.map((m) => ({
      source: 'live',
      market: m.market,
      kind: m.kind,
      listed: Boolean(m.listed),
      spreadBps: m.spreadBps,
      strikeStepWad: toWad(m.strikeStep, 'strike step'),
      markWad: m.mark == null ? null : toWad(m.mark, 'mark'),
      volBps: m.volBps,
      opensPaused: Boolean(m.opensPaused),
      caps: {
        notional: parseDecimal(m.caps.notional, decimals),
        notionalUsed: parseDecimal(m.caps.notionalUsed, decimals),
        directional: parseDecimal(m.caps.directional, decimals),
        directionalUsed: parseDecimal(m.caps.directionalUsed, decimals),
      },
    }));
  }

  /// /v1/quote/buy for one tempo: the exact cost at the current block (premium plus fee) and its source, or the
  /// API's reason for not quoting.
  async function quoteBuy({ market, legs, tempo, units }, decimals) {
    const spell = legs.map((l) => `${l.isCall ? 'call' : 'put'}:${formatUnits(l.kWad, 18)}:${formatUnits(l.qty, 18)}`).join(',');
    const q = new URLSearchParams({ market, legs: spell, tempo: String(tempo), units: formatUnits(units, 18) });
    const r = await get(`/v1/quote/buy?${q}`);
    if (!r.quoted) return { quoted: false, reason: r.reason };
    return { quoted: true, cost: parseDecimal(r.cost, decimals), source: r.source, makerQuotes: r.makerQuotesConsidered };
  }

  /// /v1/positions/:owner: the indexer's positions with units now.
  async function positions(owner) {
    const r = await get(`/v1/positions/${owner}`);
    return r.positions.map((p) => ({ source: 'live', id: BigInt(p.id), held: p.held, market: p.market, legs: p.legs, movement: p.movement, raw: BigInt(p.raw), units: BigInt(p.units) }));
  }

  return { get, status, markets, quoteBuy, positions };
}
