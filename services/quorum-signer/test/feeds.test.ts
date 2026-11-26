import { describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import { at, ExchangeFeed, JsonFeed, OnchainFeed, parseCoinbase, parseJsonFeed, parseKraken, parseOkx, parsePyth, PythFeed, toWad } from "../src/feeds.ts";

// Reply shapes as each provider documents them (values made up). No test here touches the network.
const COINBASE = { trade_id: 1, price: "97123.45", size: "0.01", time: "2026-11-24T15:00:00.123Z", bid: "97123.4", ask: "97123.5" };
const KRAKEN = { error: [], result: { XXBTZUSD: { a: ["97124.0", "1", "1.0"], b: ["97123.0", "1", "1.0"], c: ["97123.5", "0.002"] } } };
const OKX = { code: "0", msg: "", data: [{ instId: "BTC-USDC", last: "97122.9", ts: "1795014000000" }] };
const PYTH_ID = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const PYTH = { parsed: [{ id: PYTH_ID.slice(2), price: { price: "9712300000000", conf: "1", expo: -8, publish_time: 1795014000 } }] };

const respond = (body: unknown, status = 200) => async (_u: string) => new Response(JSON.stringify(body), { status });

describe("exact amounts", () => {
  test("decimals become WAD exactly; anything else is refused", () => {
    expect(toWad("97123.45")).toBe(parseEther("97123.45"));
    expect(toWad(412.5)).toBe(parseEther("412.5"));
    for (const bad of ["", "-1", "1e5", "abc", null, undefined, 0, -3, Number.NaN, 1e21]) expect(() => toWad(bad)).toThrow();
    expect(at({ a: [{ b: "x" }] }, "a.0.b")).toBe("x");
    expect(at({ a: 1 }, "a.b.c")).toBeUndefined();
  });
});

describe("exchange tickers", () => {
  test("Coinbase, Kraken and OKX replies", () => {
    expect(parseCoinbase(COINBASE)).toEqual({ px: parseEther("97123.45"), atMs: Date.parse("2026-11-24T15:00:00.123Z") });
    expect(parseKraken(KRAKEN, 42)).toEqual({ px: parseEther("97123.5"), atMs: 42 }); // no time in the reply: arrival time
    expect(parseOkx(OKX)).toEqual({ px: parseEther("97122.9"), atMs: 1_795_014_000_000 });
  });

  test("malformed replies are refused", () => {
    expect(() => parseCoinbase({ price: "97123.45" })).toThrow("bad time");
    expect(() => parseCoinbase({ price: "-1", time: COINBASE.time })).toThrow();
    expect(() => parseKraken({ error: ["EQuery:Unknown asset pair"], result: {} }, 1)).toThrow("kraken error");
    expect(() => parseKraken({ error: [], result: { A: KRAKEN.result.XXBTZUSD, B: KRAKEN.result.XXBTZUSD } }, 1)).toThrow("exactly one pair");
    expect(() => parseOkx({ code: "51001", data: [] })).toThrow("okx code");
    expect(() => parseOkx({ code: "0", data: [] })).toThrow();
  });

  test("each feed asks its own public endpoint, or a local stand-in; HTTP errors throw", async () => {
    const seen: string[] = [];
    const f = (body: unknown) => async (u: string) => (seen.push(u), new Response(JSON.stringify(body)));
    await new ExchangeFeed("coinbase", "BTC-USD", f(COINBASE)).read();
    await new ExchangeFeed("kraken", "XBTUSD", f(KRAKEN)).read();
    await new ExchangeFeed("okx", "BTC-USDC", f(OKX)).read();
    await new ExchangeFeed("okx", "BTC-USDC", f(OKX), "http://127.0.0.1:9999").read();
    expect(seen).toEqual([
      "https://api.exchange.coinbase.com/products/BTC-USD/ticker",
      "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
      "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDC",
      "http://127.0.0.1:9999/okx/BTC-USDC",
    ]);
    await expect(new ExchangeFeed("coinbase", "BTC-USD", respond({}, 503)).read()).rejects.toThrow("HTTP 503");
  });
});

describe("Pyth", () => {
  test("integer price and exponent become WAD; publish time in seconds", () => {
    expect(parsePyth(PYTH, PYTH_ID)).toEqual({ px: parseEther("97123"), atMs: 1_795_014_000_000 });
  });

  test("a wrong id, a bad exponent or a bad price is refused", () => {
    expect(() => parsePyth(PYTH, "0x" + "11".repeat(32))).toThrow("not in the reply");
    const e = (price: unknown, expo: unknown) => ({ parsed: [{ id: PYTH_ID, price: { price, expo, publish_time: 1 } }] });
    expect(() => parsePyth(e("100", 2), PYTH_ID)).toThrow("bad expo");
    expect(() => parsePyth(e("100", -19), PYTH_ID)).toThrow("bad expo");
    expect(() => parsePyth(e("-100", -8), PYTH_ID)).toThrow("bad price");
    expect(() => parsePyth(e("0", -8), PYTH_ID)).toThrow("zero price");
    expect(() => parsePyth({}, PYTH_ID)).toThrow();
  });

  test("asks Hermes for the one id, parsed", async () => {
    let url = "";
    await new PythFeed(PYTH_ID, async (u: string) => ((url = u), new Response(JSON.stringify(PYTH)))).read();
    expect(url).toBe(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${PYTH_ID}&parsed=true`);
  });
});

describe("the equity reference (provider-neutral JSON)", () => {
  test("price and time paths, in seconds, milliseconds or ISO; no time path means arrival time", async () => {
    const body = { results: [{ ticker: "STK1", price: "412.35", t: 1795014000 }] };
    expect(parseJsonFeed(body, { url: "https://x", price: "results.0.price", time: "results.0.t", timeUnit: "s" }, 0)).toEqual({ px: parseEther("412.35"), atMs: 1_795_014_000_000 });
    expect(parseJsonFeed({ p: "1.5", t: "2026-11-24T15:00:00Z" }, { url: "https://x", price: "p", time: "t", timeUnit: "iso" }, 0).atMs).toBe(Date.parse("2026-11-24T15:00:00Z"));
    expect(parseJsonFeed({ p: "1.5" }, { url: "https://x", price: "p" }, 77).atMs).toBe(77);
    expect(() => parseJsonFeed({ p: "x" }, { url: "https://x", price: "p" }, 77)).toThrow();
    const feed = new JsonFeed({ url: "https://feeds.example/stk1", price: "p" }, respond({ p: "400" }), () => 5);
    expect(await feed.read()).toEqual({ px: parseEther("400"), atMs: 5 });
    expect(feed.name).toBe("json:feeds.example");
  });
});

describe("the on-chain token price", () => {
  const ADAPTER = "0x00000000000000000000000000000000000Ad407" as `0x${string}`;
  const ID = `0x${"ab".repeat(32)}` as const;
  const LOCAL = 1_800_000_000_000;
  const chain = (blockTs: bigint, mark: readonly [bigint, bigint]) => {
    const asked: unknown[] = [];
    return { asked, client: { getBlock: async () => ({ number: 7n, timestamp: blockTs }), readContract: async (a: unknown) => (asked.push(a), mark) } };
  };

  test("reads mark(assetId) at the latest block: the age comes from chain time, placed on the local clock", async () => {
    const c = chain(1_795_014_010n, [parseEther("412.3"), 1_795_014_007n]); // 3 s old in chain time
    expect(await new OnchainFeed(c.client as never, ADAPTER, ID, () => LOCAL).read()).toEqual({ px: parseEther("412.3"), atMs: LOCAL - 3_000 });
    const a = c.asked[0] as { functionName: string; args: unknown[]; blockNumber: bigint };
    expect([a.functionName, a.args, a.blockNumber]).toEqual(["mark", [ID], 7n]);
  });

  test("a chain clock far from the local clock changes nothing: a fresh price stays fresh", async () => {
    const ahead = chain(1_900_000_000n, [parseEther("1"), 1_900_000_000n]); // the chain is years ahead of this machine
    expect((await new OnchainFeed(ahead.client as never, ADAPTER, ID, () => LOCAL).read()).atMs).toBe(LOCAL);
  });

  test("a zero price, a missing time, or a time newer than its block is refused", async () => {
    const f = (mark: readonly [bigint, bigint]) => new OnchainFeed(chain(100n, mark).client as never, ADAPTER, ID, () => LOCAL).read();
    await expect(f([0n, 1n])).rejects.toThrow("zero");
    await expect(f([1n, 0n])).rejects.toThrow("no time");
    await expect(f([1n, 101n])).rejects.toThrow("newer than its block");
  });
});
