import type { Address, Hex, PublicClient } from "viem";
import { decimalToWad } from "@tourbillon/common/decimal.ts";

/// One price reading: WAD, and the time it was produced (Unix milliseconds; the provider's own time when it gives one,
/// else the time the reply arrived).
export type Price = { px: bigint; atMs: number };

/// A source of one price. `read` throws on any failure (network, HTTP status, malformed reply); callers turn a throw
/// into "no reading", so a broken feed can only ever mean no vote, never a wrong vote.
export interface PriceFeed {
  readonly name: string;
  read(): Promise<Price>;
}

export const FEED_TIMEOUT_MS = 3_000;

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

async function getJson(url: string, fetcher: Fetcher, timeoutMs: number): Promise<unknown> {
  const res = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/// A decimal given as a string (or a finite number written in plain decimal form) to WAD, exactly.
export function toWad(v: unknown): bigint {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) throw new Error(`not a positive number: ${v}`);
    const s = String(v);
    if (/e/i.test(s)) throw new Error(`not a plain decimal: ${s}`);
    return decimalToWad(s);
  }
  return decimalToWad(v);
}

/// A dot path into a JSON value: "data.0.last".
export function at(body: unknown, path: string): unknown {
  let v: unknown = body;
  for (const part of path.split(".")) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[part];
  }
  return v;
}

function timeMs(v: unknown, unit: "s" | "ms" | "iso"): number {
  const t = unit === "iso" ? (typeof v === "string" ? Date.parse(v) : NaN) : Number(v) * (unit === "s" ? 1000 : 1);
  if (!Number.isFinite(t) || t <= 0) throw new Error(`bad time: ${String(v)}`);
  return t;
}

// ------------------------------------------------------------------ exchange tickers (crypto, G5; providers: Q7)

/// Coinbase Exchange public ticker: GET /products/{product}/ticker → { price, time (ISO) }.
export function parseCoinbase(body: unknown): Price {
  return { px: toWad(at(body, "price")), atMs: timeMs(at(body, "time"), "iso") };
}

/// Kraken public ticker: GET /0/public/Ticker?pair=… → { error: [], result: { PAIR: { c: [last, volume] } } }.
/// The reply has no time: the arrival time is used.
export function parseKraken(body: unknown, arrivedMs: number): Price {
  const err = at(body, "error");
  if (!Array.isArray(err) || err.length > 0) throw new Error(`kraken error: ${JSON.stringify(err)}`);
  const result = at(body, "result");
  if (!result || typeof result !== "object") throw new Error("kraken: no result");
  const pairs = Object.values(result as Record<string, unknown>);
  if (pairs.length !== 1) throw new Error("kraken: expected exactly one pair");
  return { px: toWad(at(pairs[0], "c.0")), atMs: arrivedMs };
}

/// OKX public ticker: GET /api/v5/market/ticker?instId=… → { code: "0", data: [{ last, ts (ms) }] }.
export function parseOkx(body: unknown): Price {
  if (at(body, "code") !== "0") throw new Error(`okx code ${String(at(body, "code"))}`);
  return { px: toWad(at(body, "data.0.last")), atMs: timeMs(at(body, "data.0.ts"), "ms") };
}

export type ExchangeName = "coinbase" | "kraken" | "okx";

const EXCHANGE_URL: Record<ExchangeName, (symbol: string) => string> = {
  coinbase: (s) => `https://api.exchange.coinbase.com/products/${encodeURIComponent(s)}/ticker`,
  kraken: (s) => `https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(s)}`,
  okx: (s) => `https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(s)}`,
};

export class ExchangeFeed implements PriceFeed {
  readonly name: string;
  constructor(
    readonly exchange: ExchangeName,
    readonly symbol: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly baseUrl?: string, // anvil and tests only: a local stand-in
    private readonly clock: () => number = Date.now,
    private readonly timeoutMs = FEED_TIMEOUT_MS,
  ) {
    this.name = `${exchange}:${symbol}`;
  }

  async read(): Promise<Price> {
    const url = this.baseUrl ? `${this.baseUrl}/${this.exchange}/${encodeURIComponent(this.symbol)}` : EXCHANGE_URL[this.exchange](this.symbol);
    const body = await getJson(url, this.fetcher, this.timeoutMs);
    if (this.exchange === "coinbase") return parseCoinbase(body);
    if (this.exchange === "kraken") return parseKraken(body, this.clock());
    return parseOkx(body);
  }
}

// ------------------------------------------------------------------ Pyth (the crypto cross-check, G5)

/// Pyth Hermes: GET /v2/updates/price/latest?ids[]=<id>&parsed=true →
/// { parsed: [{ id, price: { price: "<integer>", expo: <negative int>, publish_time: <s> } }] }.
export function parsePyth(body: unknown, id: string): Price {
  const parsed = at(body, "parsed");
  if (!Array.isArray(parsed)) throw new Error("pyth: no parsed prices");
  const want = id.toLowerCase().replace(/^0x/, "");
  const entry = parsed.find((p) => String(at(p, "id")).toLowerCase().replace(/^0x/, "") === want);
  if (!entry) throw new Error("pyth: price id not in the reply");
  const raw = at(entry, "price.price");
  const expo = at(entry, "price.expo");
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) throw new Error(`pyth: bad price ${String(raw)}`);
  if (typeof expo !== "number" || !Number.isInteger(expo) || expo > 0 || expo < -18) throw new Error(`pyth: bad expo ${String(expo)}`);
  const px = BigInt(raw) * 10n ** BigInt(18 + expo);
  if (px === 0n) throw new Error("pyth: zero price");
  return { px, atMs: timeMs(at(entry, "price.publish_time"), "s") };
}

export const PYTH_HERMES = "https://hermes.pyth.network";

export class PythFeed implements PriceFeed {
  readonly name: string;
  constructor(
    readonly id: Hex,
    private readonly fetcher: Fetcher = fetch,
    private readonly base = PYTH_HERMES,
    private readonly timeoutMs = FEED_TIMEOUT_MS,
  ) {
    this.name = `pyth:${id.slice(0, 10)}`;
  }

  async read(): Promise<Price> {
    const url = `${this.base}/v2/updates/price/latest?ids[]=${this.id}&parsed=true`;
    return parsePyth(await getJson(url, this.fetcher, this.timeoutMs), this.id);
  }
}

// ------------------------------------------------------------------ the equity reference (stocks; provider: D6, Q6)

/// A provider-neutral JSON feed for the off-chain equity reference: a URL, the path to the price, and optionally the
/// path to its time. Each signer operator points it at the provider it pays for (owner queue Q6).
export type JsonFeedSpec = { url: string; price: string; time?: string; timeUnit?: "s" | "ms" | "iso" };

export function parseJsonFeed(body: unknown, spec: JsonFeedSpec, arrivedMs: number): Price {
  return { px: toWad(at(body, spec.price)), atMs: spec.time ? timeMs(at(body, spec.time), spec.timeUnit ?? "s") : arrivedMs };
}

export class JsonFeed implements PriceFeed {
  readonly name: string;
  constructor(
    private readonly spec: JsonFeedSpec,
    private readonly fetcher: Fetcher = fetch,
    private readonly clock: () => number = Date.now,
    private readonly timeoutMs = FEED_TIMEOUT_MS,
  ) {
    this.name = `json:${new URL(spec.url).host}`;
  }

  async read(): Promise<Price> {
    return parseJsonFeed(await getJson(this.spec.url, this.fetcher, this.timeoutMs), this.spec, this.clock());
  }
}

// ------------------------------------------------------------------ the on-chain token price (stocks; venue: Q4)

/// The same two-word shape NativeMarkSource reads: an on-chain price adapter in front of Robinhood Chain's own
/// liquidity for one tokenized stock (the venue is owner queue Q4; the adapter is written once it is known).
export const priceAdapterAbi = [
  {
    type: "function",
    name: "mark",
    stateMutability: "view",
    inputs: [{ name: "assetId", type: "bytes32" }],
    outputs: [
      { name: "pxWad", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
    ],
  },
] as const;

/// The price's age is measured in chain time (the latest block's time minus the adapter's time), then placed on this
/// machine's clock, so a drift between the chain's clock and this machine's can neither make an old price look fresh
/// nor make a fresh one look like it comes from the future.
export class OnchainFeed implements PriceFeed {
  readonly name: string;
  constructor(
    private readonly client: Pick<PublicClient, "readContract" | "getBlock">,
    readonly adapter: Address,
    readonly assetId: Hex,
    private readonly clock: () => number = Date.now,
  ) {
    this.name = `onchain:${adapter.slice(0, 10)}`;
  }

  async read(): Promise<Price> {
    const block = await this.client.getBlock({ blockTag: "latest" });
    const [px, updatedAt] = (await this.client.readContract({
      address: this.adapter,
      abi: priceAdapterAbi,
      functionName: "mark",
      args: [this.assetId],
      blockNumber: block.number!,
    })) as readonly [bigint, bigint];
    if (px === 0n) throw new Error("on-chain price is zero");
    if (updatedAt === 0n) throw new Error("on-chain price has no time");
    if (updatedAt > block.timestamp) throw new Error("on-chain price is newer than its block");
    return { px, atMs: this.clock() - Number(block.timestamp - updatedAt) * 1000 };
  }
}
