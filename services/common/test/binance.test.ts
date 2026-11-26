import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { assertBinanceBase, BinanceFutures, fmt, stepDecimals, TRANSFER_AMOUNT_FIELD, TRANSFER_HISTORY_PATH, TRANSFER_TYPE_FIELD } from "../src/binance.ts";
import { EquitySource, EQUITY_OFFSET } from "../src/equity.ts";
import { openExchange } from "../src/exchange.ts";

// RH7b (owner Q5): the Binance USDⓈ-M adapter against a local fake of Binance's futures API. The fake checks every
// signature with an independent HMAC (Web Crypto, not the adapter's node:crypto), the API key header, the timestamp
// against its own clock (5 s ahead of this machine: the adapter must follow the server time) and the key's permissions.
// All keys here are made up for this test.


const READ = { apiKey: "test-read-key", secret: "test-read-secret" };
const TRADE = { apiKey: "test-trade-key", secret: "test-trade-secret" };
const SKEW_MS = 5_000;

type Pos = { amt: number; entry: number };
const state = {
  mid: { BTCUSDT: 97_000, ETHUSDT: 3_000 } as Record<string, number>,
  positions: new Map<string, Pos>(),
  wallet: 10_000,
  transfers: [] as Record<string, string | number>[],
  partial: 1,
  paths: [] as string[],
  rejected: [] as string[],
};

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let server: ReturnType<typeof Bun.serve>;
const err = (status: number, code: number, msg: string) => Response.json({ code, msg }, { status });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      state.paths.push(`${req.method} ${u.pathname}`);
      const now = Date.now() + SKEW_MS;
      if (u.pathname === "/fapi/v1/time") return Response.json({ serverTime: now });
      if (u.pathname === "/fapi/v1/exchangeInfo") {
        return Response.json({
          symbols: [
            { symbol: "BTCUSDT", filters: [{ filterType: "PRICE_FILTER", tickSize: "0.10" }, { filterType: "LOT_SIZE", stepSize: "0.001" }] },
            { symbol: "ETHUSDT", filters: [{ filterType: "PRICE_FILTER", tickSize: "0.01" }, { filterType: "LOT_SIZE", stepSize: "0.001" }] },
            { symbol: "SOLUSDT", filters: [{ filterType: "PRICE_FILTER", tickSize: "0.001" }, { filterType: "LOT_SIZE", stepSize: "1" }] },
          ],
        });
      }
      if (u.pathname === "/fapi/v1/premiumIndex") return Response.json(Object.entries(state.mid).map(([symbol, m]) => ({ symbol, markPrice: String(m + 1) })));
      if (u.pathname === "/fapi/v1/ticker/bookTicker") return Response.json(Object.entries(state.mid).map(([symbol, m]) => ({ symbol, bidPrice: String(m - 0.5), askPrice: String(m + 0.5) })));
      // signed endpoints
      const apiKey = req.headers.get("X-MBX-APIKEY");
      const k = [READ, TRADE].find((x) => x.apiKey === apiKey);
      if (!k) return err(401, -2015, "Invalid API-key, IP, or permissions for action.");
      const raw = u.search.slice(1);
      const at = raw.lastIndexOf("&signature=");
      if (at < 0) return err(400, -1102, "signature missing");
      const query = raw.slice(0, at);
      if ((await hmacHex(k.secret, query)) !== raw.slice(at + "&signature=".length)) return err(400, -1022, "Signature for this request is not valid.");
      const p = new URLSearchParams(query);
      const ts = Number(p.get("timestamp"));
      if (!(ts <= now + 1000 && now - ts <= Number(p.get("recvWindow") ?? 5000))) return err(400, -1021, "Timestamp for this request is outside of the recvWindow.");
      if (u.pathname === "/fapi/v2/positionRisk") return Response.json([...state.positions].map(([symbol, x]) => ({ symbol, positionAmt: String(x.amt), positionSide: "BOTH" })));
      if (u.pathname === "/fapi/v2/account") {
        let upnl = 0;
        for (const [s, x] of state.positions) upnl += x.amt * (state.mid[s]! - x.entry);
        return Response.json({ totalWalletBalance: String(state.wallet), totalMarginBalance: String(state.wallet + upnl) });
      }
      if (u.pathname === TRANSFER_HISTORY_PATH) {
        if (p.get(TRANSFER_TYPE_FIELD) !== "TRANSFER") return err(400, -1, "only TRANSFER here");
        const start = Number(p.get("startTime") ?? 0);
        const limit = Math.min(1000, Number(p.get("limit") ?? 100));
        return Response.json(state.transfers.filter((t) => Number(t.time) >= start).slice(0, limit));
      }
      if (u.pathname === "/fapi/v1/order" && req.method === "POST") {
        if (k !== TRADE) {
          state.rejected.push("a read-only key tried to trade");
          return err(401, -2015, "Invalid API-key, IP, or permissions for action.");
        }
        const symbol = p.get("symbol")!;
        if (p.get("type") !== "LIMIT" || p.get("timeInForce") !== "IOC") return err(400, -1116, "IOC limits only in this fake");
        const buy = p.get("side") === "BUY";
        const qty = Number(p.get("quantity"));
        const px = Number(p.get("price"));
        const fillPx = state.mid[symbol]! * (buy ? 1.0002 : 0.9998);
        const pos = state.positions.get(symbol) ?? { amt: 0, entry: fillPx };
        let exec = (buy ? px >= fillPx : px <= fillPx) ? qty * state.partial : 0;
        if (p.get("reduceOnly") === "true") exec = Math.min(exec, buy ? Math.max(0, -pos.amt) : Math.max(0, pos.amt));
        exec = Math.floor(exec * 1000 + 1e-9) / 1000;
        if (exec > 0) {
          const next = pos.amt + (buy ? exec : -exec);
          state.positions.set(symbol, { amt: Number(next.toFixed(3)), entry: fillPx });
        }
        return Response.json({ symbol, executedQty: String(exec), avgPrice: exec > 0 ? String(fillPx) : "0", status: exec === 0 ? "EXPIRED" : exec < qty ? "EXPIRED" : "FILLED" });
      }
      return err(404, -1, "not found");
    },
  });
});
afterAll(() => server.stop(true));

const base = () => `http://127.0.0.1:${server.port}`;

describe("Binance USDⓈ-M adapter", () => {
  test("pure helpers: step decimals, rounding down, the base guard", () => {
    expect(stepDecimals("0.001")).toBe(3);
    expect(stepDecimals("0.10")).toBe(1);
    expect(stepDecimals("1")).toBe(0);
    expect(fmt(0.12399, 3)).toBe("0.123");
    expect(fmt(97000.15, 1)).toBe("97000.1");
    expect(() => assertBinanceBase("https://fapi.binance.com")).toThrow("mainnet is refused");
    expect(() => assertBinanceBase("https://evil.example")).toThrow("refused");
    expect(() => assertBinanceBase("http://10.0.0.1:80")).toThrow("refused");
    assertBinanceBase("https://testnet.binancefuture.com");
    assertBinanceBase("http://127.0.0.1:1");
  });

  test("markets: decimals from the filters, the mark, the mid; only the configured symbols", async () => {
    const ex = new BinanceFutures(base(), READ);
    const mk = await ex.markets();
    expect([...mk.keys()].sort()).toEqual(["BTC", "ETH"]);
    expect(mk.get("BTC")).toEqual({ name: "BTC", szDecimals: 3, pxDecimals: 1, mid: 97_000, mark: 97_001 });
    expect(mk.get("ETH")!.pxDecimals).toBe(2);
  });

  test("a trade key places IOC limits; fills, partials and reduce-only follow; positions read back", async () => {
    const ex = new BinanceFutures(base(), TRADE);
    const [f] = await ex.placeIoc([{ market: "BTC", side: "buy", sz: 0.5004, limitPx: 97_500.07, reduceOnly: false }]);
    expect(f).toMatchObject({ status: "filled", filled: 0.5, avgPx: 97_000 * 1.0002 }); // sent as 0.500 at 97500.0
    expect((await ex.positions()).get("BTC")).toBe(0.5);
    state.partial = 0.4;
    const [p] = await ex.placeIoc([{ market: "ETH", side: "sell", sz: 10, limitPx: 2_990, reduceOnly: false }]);
    expect(p).toMatchObject({ status: "partial", filled: 4 });
    state.partial = 1;
    const [u] = await ex.placeIoc([{ market: "ETH", side: "buy", sz: 1, limitPx: 2_900, reduceOnly: false }]);
    expect(u!.status).toBe("unfilled");
    const [r] = await ex.placeIoc([{ market: "BTC", side: "sell", sz: 2, limitPx: 96_000, reduceOnly: true }]);
    expect(r).toMatchObject({ filled: 0.5 });
    expect((await ex.positions()).get("BTC")).toBe(0);
    const [x] = await ex.placeIoc([{ market: "SOL", side: "buy", sz: 1, limitPx: 1, reduceOnly: false }]);
    expect(x).toMatchObject({ status: "error", error: "unknown market" });
  });

  test("a read-only key reads but cannot trade; a bad key is refused; errors never echo the signature or a key", async () => {
    const ro = new BinanceFutures(base(), READ);
    const [f] = await ro.placeIoc([{ market: "BTC", side: "buy", sz: 0.01, limitPx: 99_000, reduceOnly: false }]);
    expect(f!.status).toBe("error");
    expect(f!.error).toContain("code -2015");
    expect(f!.error).not.toContain("signature");
    expect(f!.error).not.toContain(READ.secret);
    expect(f!.error).not.toContain(READ.apiKey);
    expect(state.rejected).toEqual(["a read-only key tried to trade"]);
    await expect(new BinanceFutures(base(), { apiKey: "test-read-key", secret: "wrong" }).positions()).rejects.toThrow("code -1022");
  });

  test("account value and transfers (paged) give the P&L-only EQUITY the signers vote", async () => {
    state.positions.clear(); // no open P&L from the trades above: the account value is the wallet alone
    state.transfers = [];
    for (let i = 0; i < 1001; i++) state.transfers.push({ [TRANSFER_AMOUNT_FIELD]: "10", time: 1_000 + i }); // 10,010 in, over two pages
    state.transfers.push({ [TRANSFER_AMOUNT_FIELD]: "-15", time: 5_000 }); // 15 out
    state.wallet = 10_010 - 15 + 120; // +120 realised P&L
    const ex = new BinanceFutures(base(), READ);
    expect(await ex.transfers()).toEqual({ deposits: 10_010n * 10n ** 18n, withdrawalsNet: 15n * 10n ** 18n });
    const v = await new EquitySource(ex).read(1_800_000_000);
    expect(v!.value - EQUITY_OFFSET).toBe(120n * 10n ** 18n);
  });

  test("the adapter has no withdrawal or transfer call, and only ever calls the documented paths", () => {
    const methods = Object.getOwnPropertyNames(BinanceFutures.prototype).map((m) => m.toLowerCase());
    expect(methods.some((m) => m.includes("withdraw") || m === "transfer" || m.includes("universal"))).toBe(false);
    const allowed = new Set(["GET /fapi/v1/time", "GET /fapi/v1/exchangeInfo", "GET /fapi/v1/premiumIndex", "GET /fapi/v1/ticker/bookTicker", "GET /fapi/v2/positionRisk", "GET /fapi/v2/account", `GET ${TRANSFER_HISTORY_PATH}`, "POST /fapi/v1/order"]);
    expect(state.paths.filter((x) => !allowed.has(x))).toEqual([]);
  });

  test("openExchange: keys from the prompt reader (never a file), loopback only on anvil", async () => {
    const asked: string[] = [];
    const answers = [TRADE.apiKey, TRADE.secret];
    const ex = await openExchange("binance", base(), "trade", true, async (q) => (asked.push(q), answers.shift()!));
    expect(asked).toEqual(["Binance trade-only API key: ", "Binance trade-only API secret: "]);
    expect(ex.name).toBe("binance");
    expect((await ex.markets()).has("BTC")).toBe(true);
    await expect(openExchange("binance", base(), "read", true, async () => "")).rejects.toThrow("key and secret are needed");
  });
});
