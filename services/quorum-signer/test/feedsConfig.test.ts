import { describe, expect, test } from "bun:test";
import { buildFeeds, parseFeeds } from "../src/feedsConfig.ts";

const ADAPTER = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const ID32 = `0x${"ab".repeat(32)}`;
const PYTH = `0x${"e6".repeat(32)}`;
const stock = { kind: "stock", onchain: { adapter: ADAPTER, assetId: ID32 }, reference: { url: "https://feeds.example/stk1", price: "p", time: "t", timeUnit: "s" } };
const crypto = { kind: "crypto", exchanges: [{ exchange: "coinbase", symbol: "BTC-USD" }, { exchange: "kraken", symbol: "XBTUSD" }], pyth: { id: PYTH } };

describe("the feeds file", () => {
  test("a good file for every market on the board", () => {
    const spec = parseFeeds({ markets: { STK1: stock, BTC: crypto } }, ["STK1", "BTC"], false);
    expect(Object.keys(spec.markets)).toEqual(["STK1", "BTC"]);
    const feeds = buildFeeds(spec, { readContract: async () => [1n, 1n], getBlock: async () => ({ number: 1n, timestamp: 1n }) } as never);
    expect(feeds.get("STK1")!.kind).toBe("stock");
    const btc = feeds.get("BTC")!;
    expect(btc.kind === "crypto" && btc.exchanges.map((f) => f.name)).toEqual(["coinbase:BTC-USD", "kraken:XBTUSD"]);
  });

  test("every board market needs feeds; a market not on the board is refused", () => {
    expect(() => parseFeeds({ markets: { STK1: stock } }, ["STK1", "BTC"], false)).toThrow("no feeds for BTC");
    expect(() => parseFeeds({ markets: { STK1: stock, BTC: crypto, HYPE: crypto } }, ["STK1", "BTC"], false)).toThrow("HYPE is not a market on the board");
    expect(() => parseFeeds({}, ["STK1"], false)).toThrow("markets");
  });

  test("crypto needs two different exchanges and a 32-byte Pyth id", () => {
    const one = { ...crypto, exchanges: [crypto.exchanges[0]] };
    expect(() => parseFeeds({ markets: { BTC: one } }, ["BTC"], false)).toThrow("at least 2 exchanges");
    const twice = { ...crypto, exchanges: [crypto.exchanges[0], crypto.exchanges[0]] };
    expect(() => parseFeeds({ markets: { BTC: twice } }, ["BTC"], false)).toThrow("listed twice");
    const unknown = { ...crypto, exchanges: [{ exchange: "binance", symbol: "BTCUSDT" }, crypto.exchanges[1]] };
    expect(() => parseFeeds({ markets: { BTC: unknown } }, ["BTC"], false)).toThrow("exchange is one of");
    expect(() => parseFeeds({ markets: { BTC: { ...crypto, pyth: { id: "0x12" } } } }, ["BTC"], false)).toThrow("pyth");
  });

  test("stocks need an adapter, a 32-byte asset id and a reference with a price path", () => {
    expect(() => parseFeeds({ markets: { STK1: { ...stock, onchain: { adapter: ADAPTER, assetId: "0x12" } } } }, ["STK1"], false)).toThrow("32 bytes");
    expect(() => parseFeeds({ markets: { STK1: { ...stock, onchain: { adapter: "nope", assetId: ID32 } } } }, ["STK1"], false)).toThrow();
    expect(() => parseFeeds({ markets: { STK1: { ...stock, reference: { url: "https://x" } } } }, ["STK1"], false)).toThrow("reference");
    expect(() => parseFeeds({ markets: { STK1: { ...stock, reference: { ...stock.reference, timeUnit: "days" } } } }, ["STK1"], false)).toThrow("timeUnit");
    expect(() => parseFeeds({ markets: { STK1: { ...stock, kind: "bond" } } }, ["STK1"], false)).toThrow("kind");
  });

  test("https only; plain http to this machine on a local anvil only", () => {
    const local = { ...stock, reference: { ...stock.reference, url: "http://127.0.0.1:8600/stk1" } };
    expect(() => parseFeeds({ markets: { STK1: local } }, ["STK1"], false)).toThrow("refused");
    expect(parseFeeds({ markets: { STK1: local } }, ["STK1"], true).markets.STK1!.kind).toBe("stock");
    const remoteHttp = { ...stock, reference: { ...stock.reference, url: "http://feeds.example/stk1" } };
    expect(() => parseFeeds({ markets: { STK1: remoteHttp } }, ["STK1"], true)).toThrow("refused");
  });
});
