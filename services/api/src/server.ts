import { getAddress, isAddress, parseEther, type Address, type Hex } from "viem";
import { blendValue } from "@tourbillon/common/tempo.ts";
import { b32, usdc, type Dep, type Reads } from "./chain.ts";

/// API v1 (launch core; owner D4: open, read-only, no keys, per-IP rate limits). JSON over GET only:
///   /v1/status                      pauses, pool NAV and coverage, mark and vol freshness per market, receipts
///   /v1/markets                     listing, spread, strike step, mark, vol, caps and use, pauses
///   /v1/chains/:market              indicative call and put values around the mark per tempo (board vol)
///   /v1/quote/buy                   the exact cost of a buy now (best of the pool and the maker quotes)
///   /v1/positions/:owner            held directly and in the AgentRouter sub-account, with units now
///   /v1/receipts/proof              a receipt's Merkle proof (from the receipts service)
/// Amounts: USDC as decimal strings (6 decimals); strikes, units and marks as decimal strings. Wording follows the spec's
/// rules (Overview section 9): "NAV", never return or income language.

export type PositionRow = { id: string; owner: string; held: string; market: string; legs_json: unknown; tempo_or_movement: unknown; raw: string };
export type Deps = {
  dep: Dep;
  reads: Reads;
  positionsOf(owner: Address): Promise<PositionRow[]>;
  gatewayBest?(body: unknown): Promise<{ quotes: { quote: Record<string, string>; sig: Hex }[] }>;
  receiptsProof?(tx: string, logIndex: string): Promise<{ status: number; body: unknown }>;
  now(): Promise<bigint>;
};

const KINDS: Record<number, string> = { 1: "pool", 2: "maker", 3: "offer" };

export class RateLimit {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private readonly perMinute: number) {}
  allow(ip: string, nowMs = Date.now()): boolean {
    const h = this.hits.get(ip);
    if (!h || nowMs >= h.reset) {
      this.hits.set(ip, { n: 1, reset: nowMs + 60_000 });
      return true;
    }
    if (h.n >= this.perMinute) return false;
    h.n++;
    return true;
  }
}

/// "call:74000:1,call:76000:-1" → buyer legs (strike and amount in WAD).
export function parseLegs(s: string): { isCall: boolean; kWad: bigint; qty: bigint }[] {
  const legs = s.split(",").map((part) => {
    const [side, k, q] = part.split(":");
    if ((side !== "call" && side !== "put") || !k || !q) throw new Error('legs: "call|put:strike:amount", comma-separated');
    return { isCall: side === "call", kWad: parseEther(k), qty: parseEther(q) };
  });
  if (legs.length === 0 || legs.length > 4) throw new Error("legs: 1 to 4 legs");
  return legs;
}

export function makeApi(x: Deps, opts: { perMinute?: number; trustProxy?: boolean } = {}) {
  const limit = new RateLimit(opts.perMinute ?? 120);
  const json = (b: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(b, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), {
      status,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store", ...extra },
    });
  const bad = (error: string, status = 400) => json({ error }, status);
  const market = (m: string | undefined | null) => {
    if (!m || !x.dep.markets.includes(m)) throw new Error(`market: one of ${x.dep.markets.join(", ")}`);
    return m;
  };

  async function chains(m: string, url: URL) {
    const [mk] = (await x.reads.markets()).filter((r) => r.market === m);
    if (!mk || mk.mark === null || mk.volBps === null) return { market: m, mark: null, volBps: null, chains: [], note: "no fresh mark or vol: nothing opens on this market now" };
    const s = Number(mk.mark);
    const step = Number(mk.strikeStep);
    const n = Math.min(10, Math.max(1, Number(url.searchParams.get("strikes") ?? 3)));
    const tempos = (url.searchParams.get("tempos") ?? "3600,86400,604800,2592000").split(",").map(Number).filter((t) => t >= 3600 && t <= 2_592_000);
    const atm = Math.round(s / step) * step;
    const gap = step * Math.max(1, Math.round((s * 0.01) / step));
    const ks = Array.from({ length: 2 * n + 1 }, (_, i) => atm + (i - n) * gap);
    return {
      market: m,
      mark: mk.mark,
      volBps: mk.volBps,
      indicative: true,
      note: "values per unit at the board's vol, before the spread and fee; /v1/quote/buy gives the exact cost",
      chains: tempos.map((t) => ({ tempo: t, rows: ks.map((k) => ({ strike: k, call: +blendValue(true, s, k, mk.volBps!, [{ tempo: t, weight: 1 }]).toFixed(4), put: +blendValue(false, s, k, mk.volBps!, [{ tempo: t, weight: 1 }]).toFixed(4) })) })),
    };
  }

  async function quote(url: URL) {
    const m = market(url.searchParams.get("market"));
    const legs = parseLegs(url.searchParams.get("legs") ?? "");
    const tempo = Number(url.searchParams.get("tempo") ?? 86_400);
    if (!Number.isInteger(tempo) || tempo < 3600 || tempo > 2_592_000) throw new Error("tempo: whole seconds from 3,600 to 2,592,000");
    const units = parseEther(url.searchParams.get("units") ?? "");
    if (units <= 0n) throw new Error("units: more than 0");
    const movement = [{ tempo: BigInt(tempo), weight: 10n ** 18n }];
    let quotes: unknown[] = [];
    let sigs: Hex[] = [];
    if (x.gatewayBest) {
      const best = await x.gatewayBest({ name: b32(m), legs, movement, units }).catch(() => ({ quotes: [] }));
      quotes = best.quotes.map((q) => ({ ...q.quote, maker: getAddress(q.quote.maker!), sides: Number(q.quote.sides), tauLo: Number(q.quote.tauLo), tauHi: Number(q.quote.tauHi), kLoWad: BigInt(q.quote.kLoWad!), kHiWad: BigInt(q.quote.kHiWad!), sigmaBps: BigInt(q.quote.sigmaBps!), maxUnits: BigInt(q.quote.maxUnits!), validUntil: BigInt(q.quote.validUntil!), nonce: BigInt(q.quote.nonce!) }));
      sigs = best.quotes.map((q) => q.sig);
    }
    const deadline = (await x.now()) + 600n;
    const r = await x.reads.quoteBuy([b32(m), legs, movement, units, 2n ** 128n, deadline, quotes, sigs, []]);
    if (!r.ok) return { market: m, quoted: false, reason: r.reason };
    return { market: m, quoted: true, cost: usdc(r.cost), source: KINDS[r.kind] ?? "unknown", makerQuotesConsidered: quotes.length, note: "premium plus fee at the current block; a buy pays at most the maxCost it sets" };
  }

  async function positions(owner: string) {
    if (!isAddress(owner)) throw new Error("owner: an address");
    const rows = await x.positionsOf(getAddress(owner));
    const out = [];
    for (const r of rows) {
      const norm = await x.reads.normNow(BigInt(r.id));
      out.push({ id: r.id, held: r.held, market: r.market, legs: r.legs_json, movement: r.tempo_or_movement, raw: r.raw, units: ((BigInt(r.raw) * norm) / 10n ** 18n).toString(), unitsDecimal: (Number((BigInt(r.raw) * norm) / 10n ** 12n) / 1e6).toString() });
    }
    return { owner: getAddress(owner), positions: out };
  }

  return {
    async fetch(req: Request, server?: { requestIP(r: Request): { address: string } | null }): Promise<Response> {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET" } });
      if (req.method !== "GET") return bad("read-only: GET only", 405);
      const ip = (opts.trustProxy ? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() : undefined) ?? server?.requestIP(req)?.address ?? "unknown";
      if (!limit.allow(ip)) return bad("rate limit: try again in a minute", 429);
      const url = new URL(req.url);
      const p = url.pathname.replace(/\/+$/, "");
      try {
        if (p === "/v1/status") return json(await x.reads.status());
        if (p === "/v1/markets") return json({ markets: await x.reads.markets() });
        if (p.startsWith("/v1/chains/")) return json(await chains(market(p.split("/")[3]), url));
        if (p === "/v1/quote/buy") return json(await quote(url));
        if (p.startsWith("/v1/positions/")) return json(await positions(p.split("/")[3] ?? ""));
        if (p === "/v1/receipts/proof") {
          if (!x.receiptsProof) return bad("receipts proofs are not configured", 503);
          const tx = url.searchParams.get("tx") ?? "";
          const li = url.searchParams.get("logIndex") ?? "";
          if (!/^0x[0-9a-fA-F]{64}$/.test(tx) || !/^\d+$/.test(li)) throw new Error("tx (0x…, 32 bytes) and logIndex are needed");
          const r = await x.receiptsProof(tx, li);
          return json(r.body, r.status);
        }
        if (p === "" || p === "/v1") return json({ name: "Tourbillon API", version: "v1", endpoints: ["/v1/status", "/v1/markets", "/v1/chains/:market", "/v1/quote/buy", "/v1/positions/:owner", "/v1/receipts/proof"] });
        return bad("not found", 404);
      } catch (e) {
        return bad((e as Error).message.split("\n")[0] ?? "bad request");
      }
    },
  };
}
