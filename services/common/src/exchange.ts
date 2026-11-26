import { decimalToWad } from "./decimal.ts";
import { promptHidden } from "./keystore.ts";
import { assertBinanceBase, BinanceFutures, BINANCE_FUTURES_TESTNET } from "./binance.ts";

/// The crypto hedge exchange (Backend §6): BTC and ETH perpetuals for the pool's account, through a trade-only key
/// with withdrawals off; signers and the risk-monitor read the same account with a read-only key. Which exchange is
/// Binance (owner Q5: USDⓈ-M perpetuals; OKX the fallback): `BinanceFutures` in binance.ts. `HttpExchange` speaks to
/// the local simulated exchange (hedger/src/simexchange.ts) for tests. Keys are typed at hidden prompts, never in a
/// file or a command.

export const EXCHANGE_TIMEOUT_MS = 3_000;

export type ExMarket = { name: string; szDecimals: number; pxDecimals: number; mid: number; mark: number };
export type Transfers = { deposits: bigint; withdrawalsNet: bigint }; // WAD USDC; withdrawals net of the exchange's fee
export type IocOrder = { market: string; side: "buy" | "sell"; sz: number; limitPx: number; reduceOnly: boolean };
export type Fill = {
  market: string;
  side: "buy" | "sell";
  requested: number;
  filled: number;
  avgPx: number | null;
  status: "filled" | "partial" | "unfilled" | "error";
  error?: string;
};

/// What signers, the risk-monitor and the hedger read.
export interface ExchangeRead {
  readonly name: string;
  markets(): Promise<Map<string, ExMarket>>;
  positions(): Promise<Map<string, number>>; // market → signed size (+ long)
  accountValue(): Promise<bigint>; // WAD USDC: cash plus open P&L
  transfers(): Promise<Transfers>;
}

/// What the hedger also does: immediate-or-cancel orders only. There is no withdrawal call anywhere.
export interface ExchangeTrade extends ExchangeRead {
  placeIoc(orders: IocOrder[]): Promise<Fill[]>;
}

function num(v: unknown, what: string): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) throw new Error(`exchange: bad ${what}`);
  return n;
}

/// Parses a /v1/markets reply. A market with a missing or non-positive price is left out (no price, no hedge).
export function parseMarkets(body: unknown): Map<string, ExMarket> {
  if (!Array.isArray(body)) throw new Error("exchange: markets reply is not a list");
  const out = new Map<string, ExMarket>();
  for (const m of body as Record<string, unknown>[]) {
    if (typeof m?.name !== "string") continue;
    try {
      const mid = num(m.mid, "mid");
      const mark = num(m.mark, "mark");
      if (mid <= 0 || mark <= 0) continue;
      out.set(m.name, { name: m.name, szDecimals: num(m.szDecimals, "szDecimals"), pxDecimals: num(m.pxDecimals, "pxDecimals"), mid, mark });
    } catch {
      continue;
    }
  }
  return out;
}

/// Parses /v1/transfers: deposits credited and withdrawals sent home net of fee, WAD.
export function parseTransfers(body: unknown): Transfers {
  if (!Array.isArray(body)) throw new Error("exchange: transfers reply is not a list");
  let deposits = 0n;
  let withdrawalsNet = 0n;
  for (const t of body as Record<string, unknown>[]) {
    if (t?.type === "deposit") deposits += decimalToWad(t.amount);
    else if (t?.type === "withdraw") {
      const gross = decimalToWad(t.amount);
      const fee = t.fee === undefined || Number(t.fee) === 0 ? 0n : decimalToWad(t.fee);
      withdrawalsNet += gross > fee ? gross - fee : 0n;
    }
  }
  return { deposits, withdrawalsNet };
}

/// An exchange spoken to over the adapter's HTTP shape (today: the local simulated exchange only).
export class HttpExchange implements ExchangeTrade {
  constructor(
    readonly name: string,
    private readonly base: string,
    private readonly key: string,
    private readonly timeoutMs = EXCHANGE_TIMEOUT_MS,
  ) {}

  private async call(path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(new URL(path, this.base), {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${this.key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`exchange ${path}: HTTP ${res.status}`);
    return res.json();
  }

  async markets(): Promise<Map<string, ExMarket>> {
    return parseMarkets(await this.call("/v1/markets"));
  }

  async positions(): Promise<Map<string, number>> {
    const a = (await this.call("/v1/account")) as { positions?: { market?: string; size?: unknown }[] };
    const out = new Map<string, number>();
    for (const p of a.positions ?? []) if (typeof p.market === "string") out.set(p.market, num(p.size, "position size"));
    return out;
  }

  async accountValue(): Promise<bigint> {
    const a = (await this.call("/v1/account")) as { accountValue?: unknown };
    return decimalToWad(a.accountValue);
  }

  async transfers(): Promise<Transfers> {
    return parseTransfers(await this.call("/v1/transfers"));
  }

  async placeIoc(orders: IocOrder[]): Promise<Fill[]> {
    const r = (await this.call("/v1/orders", { orders: orders.map((o) => ({ ...o, tif: "IOC" })) })) as { fills?: Fill[] };
    if (!Array.isArray(r.fills) || r.fills.length !== orders.length) throw new Error("exchange: orders reply does not match");
    return r.fills;
  }
}

/// Opens the exchange named on the command line (owner Q5).
/// - "sim": the local simulated exchange (anvil only), which hands out a throwaway key of the asked scope.
/// - "binance": Binance USDⓈ-M futures. Its futures testnet by default; plain http to this machine only on a local
///   anvil (tests); mainnet refused in code. The key and secret are typed at hidden prompts (a read-only key for
///   signers and the risk-monitor, a trade-only key for hedger-cex) and kept in memory only.
/// Any other name is refused (OKX, the fallback, gets its adapter when the owner asks for it).
export async function openExchange(
  name: string,
  url: string | undefined,
  scope: "read" | "trade",
  localChain: boolean,
  readKeys: (prompt: string) => Promise<string> = promptHidden,
): Promise<ExchangeTrade> {
  if (name === "binance") {
    const base = url ?? BINANCE_FUTURES_TESTNET;
    assertBinanceBase(base);
    const loopback = new URL(base).protocol === "http:";
    if (loopback && !localChain) throw new Error("a Binance stand-in on this machine works only on a local anvil (31337)");
    const apiKey = (await readKeys(`Binance ${scope === "read" ? "read-only" : "trade-only"} API key: `)).trim();
    const secret = (await readKeys(`Binance ${scope === "read" ? "read-only" : "trade-only"} API secret: `)).trim();
    if (!apiKey || !secret) throw new Error("a Binance key and secret are needed");
    return new BinanceFutures(base, { apiKey, secret });
  }
  if (name !== "sim") throw new Error(`no adapter for exchange "${name}" (binance, or sim on a local anvil)`);
  if (!localChain) throw new Error("--exchange sim works only on a local anvil (31337)");
  if (!url) throw new Error("--exchange sim needs --exchange-url");
  const res = await fetch(new URL(`/sim/key?scope=${scope}`, url), { signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS) });
  if (!res.ok) throw new Error("the simulated exchange did not issue a key");
  const { key } = (await res.json()) as { key: string };
  return new HttpExchange("sim", url, key);
}
