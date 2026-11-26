import { readFileSync } from "node:fs";
import { getAddress, isHex, type Hex, type PublicClient } from "viem";
import { ExchangeFeed, JsonFeed, OnchainFeed, PythFeed, PYTH_HERMES, type ExchangeName, type JsonFeedSpec } from "./feeds.ts";
import { MIN_EXCHANGES } from "./marks.ts";
import type { MarketFeeds } from "./source.ts";

/// The signer's feeds file (JSON), one entry per market on the board:
///   { "markets": {
///       "STK1": { "kind": "stock",
///                 "onchain":   { "adapter": "0x…", "assetId": "0x…32 bytes" },
///                 "reference": { "url": "https://…", "price": "data.0.price", "time": "data.0.t", "timeUnit": "s" } },
///       "BTC":  { "kind": "crypto",
///                 "exchanges": [{ "exchange": "coinbase", "symbol": "BTC-USD" }, { "exchange": "kraken", "symbol": "XBTUSD" }],
///                 "pyth": { "id": "0x…" } } } }
/// Each operator chooses its own providers (owner queue Q6, Q7); the venue behind the on-chain adapter is Q4.

export type StockSpec = { kind: "stock"; onchain: { adapter: string; assetId: string }; reference: JsonFeedSpec };
export type CryptoSpec = { kind: "crypto"; exchanges: { exchange: ExchangeName; symbol: string; url?: string }[]; pyth: { id: string; url?: string } };
export type FeedsSpec = { markets: Record<string, StockSpec | CryptoSpec> };

const EXCHANGES: ExchangeName[] = ["coinbase", "kraken", "okx"];

function url(u: unknown, where: string, local: boolean): string {
  if (typeof u !== "string") throw new Error(`${where}: url missing`);
  const p = new URL(u);
  const loopback = p.hostname === "127.0.0.1" || p.hostname === "localhost";
  if (p.protocol === "https:") return u;
  if (p.protocol === "http:" && loopback && local) return u;
  throw new Error(`${where}: ${p.protocol}//${p.hostname} refused (https only; plain http to this machine on a local anvil only)`);
}

/// Checks a feeds file against the board's markets. `local` is true on a local anvil only.
export function parseFeeds(body: unknown, markets: string[], local: boolean): FeedsSpec {
  const m = (body as { markets?: unknown })?.markets;
  if (!m || typeof m !== "object") throw new Error("feeds file: { markets: { … } } expected");
  const entries = m as Record<string, Record<string, unknown>>;
  for (const name of Object.keys(entries)) if (!markets.includes(name)) throw new Error(`feeds file: ${name} is not a market on the board`);
  const out: FeedsSpec = { markets: {} };
  for (const name of markets) {
    const e = entries[name];
    if (!e) throw new Error(`feeds file: no feeds for ${name}`);
    if (e.kind === "stock") {
      const on = e.onchain as Record<string, unknown> | undefined;
      const ref = e.reference as Record<string, unknown> | undefined;
      if (!on || typeof on.adapter !== "string" || typeof on.assetId !== "string") throw new Error(`${name}: onchain { adapter, assetId } needed`);
      if (!isHex(on.assetId) || on.assetId.length !== 66) throw new Error(`${name}: assetId must be 32 bytes of hex`);
      if (!ref || typeof ref.price !== "string") throw new Error(`${name}: reference { url, price } needed`);
      const unit = ref.timeUnit ?? "s";
      if (!["s", "ms", "iso"].includes(unit as string)) throw new Error(`${name}: timeUnit is s, ms or iso`);
      out.markets[name] = {
        kind: "stock",
        onchain: { adapter: getAddress(on.adapter), assetId: on.assetId },
        reference: { url: url(ref.url, `${name} reference`, local), price: ref.price, time: typeof ref.time === "string" ? ref.time : undefined, timeUnit: unit as JsonFeedSpec["timeUnit"] },
      };
    } else if (e.kind === "crypto") {
      const ex = e.exchanges;
      if (!Array.isArray(ex) || ex.length < MIN_EXCHANGES) throw new Error(`${name}: at least ${MIN_EXCHANGES} exchanges needed`);
      const seen = new Set<string>();
      const exchanges = ex.map((x: Record<string, unknown>) => {
        if (!EXCHANGES.includes(x.exchange as ExchangeName) || typeof x.symbol !== "string" || !x.symbol) throw new Error(`${name}: exchange is one of ${EXCHANGES.join(", ")}, with a symbol`);
        if (seen.has(x.exchange as string)) throw new Error(`${name}: ${String(x.exchange)} listed twice`);
        seen.add(x.exchange as string);
        return { exchange: x.exchange as ExchangeName, symbol: x.symbol, url: x.url === undefined ? undefined : url(x.url, `${name} ${String(x.exchange)}`, local) };
      });
      const py = e.pyth as Record<string, unknown> | undefined;
      if (!py || typeof py.id !== "string" || !isHex(py.id) || py.id.length !== 66) throw new Error(`${name}: pyth { id: 32 bytes of hex } needed`);
      out.markets[name] = { kind: "crypto", exchanges, pyth: { id: py.id, url: py.url === undefined ? undefined : url(py.url, `${name} pyth`, local) } };
    } else {
      throw new Error(`${name}: kind is "stock" or "crypto"`);
    }
  }
  return out;
}

export function loadFeeds(file: string, markets: string[], local: boolean): FeedsSpec {
  return parseFeeds(JSON.parse(readFileSync(file, "utf8")), markets, local);
}

/// The feed objects for a checked spec.
export function buildFeeds(spec: FeedsSpec, client: Pick<PublicClient, "readContract" | "getBlock">): Map<string, MarketFeeds> {
  const out = new Map<string, MarketFeeds>();
  for (const [name, s] of Object.entries(spec.markets)) {
    if (s.kind === "stock") {
      out.set(name, { kind: "stock", onchain: new OnchainFeed(client, getAddress(s.onchain.adapter), s.onchain.assetId as Hex), reference: new JsonFeed(s.reference) });
    } else {
      out.set(name, {
        kind: "crypto",
        exchanges: s.exchanges.map((x) => new ExchangeFeed(x.exchange, x.symbol, fetch, x.url)),
        pyth: new PythFeed(s.pyth.id as Hex, fetch, s.pyth.url ?? PYTH_HERMES),
      });
    }
  }
  return out;
}
