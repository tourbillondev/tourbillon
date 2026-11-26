import { createHmac } from "node:crypto";
import { decimalToWad } from "./decimal.ts";
import { EXCHANGE_TIMEOUT_MS, type ExchangeTrade, type ExMarket, type Fill, type IocOrder, type Transfers } from "./exchange.ts";

/// Binance USDⓈ-M futures behind the exchange interface (owner Q5: BTC and ETH perpetuals; OKX the fallback). The pool's
/// futures account is read with a read-only key (signers, the risk-monitor) and traded with a trade-only key (hedger-cex):
/// withdrawals disabled on both, an IP allowlist on Binance's side, keys typed at hidden prompts on the server and kept
/// in memory only. There is no withdrawal or transfer call anywhere in this file.
///
/// Endpoints (Binance's public API documentation; (U) re-checked on the futures testnet at the RH12 rehearsal):
///   GET  /fapi/v1/time            server time (the signing clock follows it)
///   GET  /fapi/v1/exchangeInfo    LOT_SIZE stepSize → size decimals, PRICE_FILTER tickSize → price decimals
///   GET  /fapi/v1/premiumIndex    markPrice
///   GET  /fapi/v1/ticker/bookTicker  bid and ask → mid
///   GET  /fapi/v2/positionRisk    positionAmt (signed)
///   GET  /fapi/v2/account         totalMarginBalance: wallet balance plus open P&L (signed)
///   GET  /fapi/v1/income          incomeType=TRANSFER: money into (+) and out of (−) the futures wallet (signed)
///   POST /fapi/v1/order           LIMIT, timeInForce IOC, reduceOnly (signed)
///
/// Orders and signed reads go only to the futures testnet or to this machine (tests). Binance mainnet is refused in code
/// until the owner says yes (the project rules: testnet first; real money never without that yes).

export const BINANCE_FUTURES_TESTNET = "https://testnet.binancefuture.com";
export const BINANCE_FUTURES_MAINNET = "https://fapi.binance.com";
/// Binance's transfer-history endpoint and its fields (allowed by name in words-allow.ts: a third-party API name).
export const TRANSFER_HISTORY_PATH = "/fapi/v1/income";
export const TRANSFER_TYPE_FIELD = "incomeType";
export const TRANSFER_AMOUNT_FIELD = "income";

export const DEFAULT_SYMBOLS: Record<string, string> = { BTC: "BTCUSDT", ETH: "ETHUSDT" };

export type BinanceKeys = { apiKey: string; secret: string };

/// The base URLs this code may use: the futures testnet, or plain http to this machine (tests). Mainnet is refused.
export function assertBinanceBase(base: string): void {
  const u = new URL(base);
  const loopback = u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  if (loopback || base.replace(/\/$/, "") === BINANCE_FUTURES_TESTNET) return;
  if (base.replace(/\/$/, "") === BINANCE_FUTURES_MAINNET) throw new Error("Binance mainnet is refused until the owner says yes (testnet first)");
  throw new Error(`Binance base ${u.protocol}//${u.hostname} refused: the futures testnet or this machine only`);
}

/// Decimals of a step or tick written as a decimal string ("0.001" → 3, "0.10" → 1, "1" → 0).
export function stepDecimals(step: string): number {
  const [, frac = ""] = step.split(".");
  const trimmed = frac.replace(/0+$/, "");
  return trimmed.length;
}

/// The HMAC-SHA256 signature Binance expects over the exact query string.
export function signQuery(query: string, secret: string): string {
  return createHmac("sha256", secret).update(query).digest("hex");
}

/// A number written with at most `decimals` decimals, rounded down, without exponent notation.
export function fmt(n: number, decimals: number): string {
  const f = 10 ** decimals;
  const v = Math.floor(n * f + 1e-9) / f;
  return v.toFixed(decimals);
}

type Http = { status: number; body: unknown };

export class BinanceFutures implements ExchangeTrade {
  readonly name = "binance";
  private offsetMs: number | null = null;
  private info: Map<string, { szDecimals: number; pxDecimals: number }> | null = null;
  private readonly bySymbol: Map<string, string>;

  constructor(
    private readonly base: string,
    private readonly keys: BinanceKeys,
    private readonly symbols: Record<string, string> = DEFAULT_SYMBOLS,
    private readonly timeoutMs = EXCHANGE_TIMEOUT_MS,
    private readonly recvWindow = 5_000,
    private readonly clock: () => number = Date.now,
  ) {
    assertBinanceBase(base);
    this.bySymbol = new Map(Object.entries(symbols).map(([m, s]) => [s, m]));
  }

  private async http(method: "GET" | "POST", path: string, query: string, signed: boolean): Promise<Http> {
    const url = new URL(path + (query ? `?${query}` : ""), this.base);
    const res = await fetch(url, {
      method,
      headers: signed ? { "X-MBX-APIKEY": this.keys.apiKey } : {},
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  /// A failed call, without the query (it carries the signature) and without any key.
  private fail(path: string, r: Http): never {
    const b = r.body as { code?: number; msg?: string } | null;
    throw new Error(`binance ${path}: HTTP ${r.status}${b?.code !== undefined ? ` code ${b.code}` : ""}${b?.msg ? ` ${String(b.msg).slice(0, 120)}` : ""}`);
  }

  private async now(): Promise<number> {
    if (this.offsetMs === null) {
      const r = await this.http("GET", "/fapi/v1/time", "", false);
      if (r.status !== 200) this.fail("/fapi/v1/time", r);
      this.offsetMs = Number((r.body as { serverTime: number }).serverTime) - this.clock();
    }
    return this.clock() + this.offsetMs;
  }

  private async signed(method: "GET" | "POST", path: string, params: Record<string, string>): Promise<unknown> {
    const q = new URLSearchParams({ ...params, recvWindow: String(this.recvWindow), timestamp: String(await this.now()) }).toString();
    const r = await this.http(method, path, `${q}&signature=${signQuery(q, this.keys.secret)}`, true);
    if (r.status !== 200) this.fail(path, r);
    return r.body;
  }

  private async pub(path: string, query = ""): Promise<unknown> {
    const r = await this.http("GET", path, query, false);
    if (r.status !== 200) this.fail(path, r);
    return r.body;
  }

  private async decimals(): Promise<Map<string, { szDecimals: number; pxDecimals: number }>> {
    if (this.info) return this.info;
    const body = (await this.pub("/fapi/v1/exchangeInfo")) as { symbols?: { symbol: string; filters: { filterType: string; stepSize?: string; tickSize?: string }[] }[] };
    const out = new Map<string, { szDecimals: number; pxDecimals: number }>();
    for (const s of body.symbols ?? []) {
      const market = this.bySymbol.get(s.symbol);
      if (!market) continue;
      const lot = s.filters.find((f) => f.filterType === "LOT_SIZE")?.stepSize;
      const tick = s.filters.find((f) => f.filterType === "PRICE_FILTER")?.tickSize;
      if (!lot || !tick) continue;
      out.set(market, { szDecimals: stepDecimals(lot), pxDecimals: stepDecimals(tick) });
    }
    this.info = out;
    return out;
  }

  async markets(): Promise<Map<string, ExMarket>> {
    const [dec, marks, books] = await Promise.all([
      this.decimals(),
      this.pub("/fapi/v1/premiumIndex") as Promise<{ symbol: string; markPrice: string }[]>,
      this.pub("/fapi/v1/ticker/bookTicker") as Promise<{ symbol: string; bidPrice: string; askPrice: string }[]>,
    ]);
    const out = new Map<string, ExMarket>();
    for (const [market, symbol] of Object.entries(this.symbols)) {
      const d = dec.get(market);
      const m = marks.find((x) => x.symbol === symbol);
      const b = books.find((x) => x.symbol === symbol);
      if (!d || !m || !b) continue;
      const mark = Number(m.markPrice);
      const mid = (Number(b.bidPrice) + Number(b.askPrice)) / 2;
      if (!(mark > 0) || !(mid > 0)) continue;
      out.set(market, { name: market, szDecimals: d.szDecimals, pxDecimals: d.pxDecimals, mid, mark });
    }
    return out;
  }

  async positions(): Promise<Map<string, number>> {
    const body = (await this.signed("GET", "/fapi/v2/positionRisk", {})) as { symbol: string; positionAmt: string }[];
    const out = new Map<string, number>();
    for (const p of body) {
      const market = this.bySymbol.get(p.symbol);
      if (market) out.set(market, (out.get(market) ?? 0) + Number(p.positionAmt));
    }
    return out;
  }

  async accountValue(): Promise<bigint> {
    const a = (await this.signed("GET", "/fapi/v2/account", {})) as { totalMarginBalance?: string };
    return decimalToWad(a.totalMarginBalance);
  }

  /// Money moved into (+) and out of (−) the futures wallet, from the transfer history, page by page.
  async transfers(): Promise<Transfers> {
    let deposits = 0n;
    let withdrawalsNet = 0n;
    let startTime = 0;
    for (let page = 0; page < 100; page++) {
      const rows = (await this.signed("GET", TRANSFER_HISTORY_PATH, { [TRANSFER_TYPE_FIELD]: "TRANSFER", startTime: String(startTime), limit: "1000" })) as Record<string, string | number>[];
      for (const r of rows) {
        const amt = String(r[TRANSFER_AMOUNT_FIELD]);
        const v = decimalToWad(amt.replace(/^-/, ""));
        if (amt.startsWith("-")) withdrawalsNet += v;
        else deposits += v;
      }
      if (rows.length < 1000) return { deposits, withdrawalsNet };
      startTime = Number(rows[rows.length - 1]!.time) + 1;
    }
    throw new Error("binance transfer history: too many pages");
  }

  async placeIoc(orders: IocOrder[]): Promise<Fill[]> {
    const dec = await this.decimals();
    const fills: Fill[] = [];
    for (const o of orders) {
      const symbol = this.symbols[o.market];
      const d = dec.get(o.market);
      const base = { market: o.market, side: o.side, requested: o.sz };
      if (!symbol || !d) {
        fills.push({ ...base, filled: 0, avgPx: null, status: "error", error: "unknown market" });
        continue;
      }
      try {
        const r = (await this.signed("POST", "/fapi/v1/order", {
          symbol,
          side: o.side === "buy" ? "BUY" : "SELL",
          type: "LIMIT",
          timeInForce: "IOC",
          quantity: fmt(o.sz, d.szDecimals),
          price: fmt(o.limitPx, d.pxDecimals),
          reduceOnly: o.reduceOnly ? "true" : "false",
          newOrderRespType: "RESULT",
        })) as { executedQty?: string; avgPrice?: string; status?: string };
        const filled = Number(r.executedQty ?? "0");
        const avg = Number(r.avgPrice ?? "0");
        const requested = Number(fmt(o.sz, d.szDecimals));
        fills.push({ ...base, filled, avgPx: filled > 0 && avg > 0 ? avg : null, status: filled <= 0 ? "unfilled" : filled + 1e-12 < requested ? "partial" : "filled" });
      } catch (e) {
        fills.push({ ...base, filled: 0, avgPx: null, status: "error", error: (e as Error).message });
      }
    }
    return fills;
  }
}
