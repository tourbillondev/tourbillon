import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HttpExchange, openExchange, type ExchangeTrade } from "@tourbillon/common/exchange.ts";
import { SimExchange } from "../src/simexchange.ts";

let sim: SimExchange;
let ex: ExchangeTrade;

beforeAll(async () => {
  sim = new SimExchange([
    { name: "BTC", szDecimals: 5, pxDecimals: 1, mid: 100_000 },
    { name: "ETH", szDecimals: 4, pxDecimals: 2, mid: 3_000 },
  ]);
  ex = await openExchange("sim", sim.url, "trade", true);
});
afterAll(() => sim.stop());

describe("the simulated exchange through the adapter", () => {
  test("markets carry their size and price decimals", async () => {
    const mk = await ex.markets();
    expect(mk.get("BTC")).toEqual({ name: "BTC", szDecimals: 5, pxDecimals: 1, mid: 100_000, mark: 100_000 });
  });

  test("an IOC fills at mid plus slippage; positions follow", async () => {
    const [f] = await ex.placeIoc([{ market: "BTC", side: "buy", sz: 0.5, limitPx: 100_500, reduceOnly: false }]);
    expect(f).toMatchObject({ status: "filled", filled: 0.5, avgPx: 100_020 });
    expect((await ex.positions()).get("BTC")).toBe(0.5);
  });

  test("partial fills and limits that are not reached", async () => {
    sim.partialFraction = 0.4;
    const [p] = await ex.placeIoc([{ market: "ETH", side: "sell", sz: 10, limitPx: 2_985, reduceOnly: false }]);
    expect(p).toMatchObject({ status: "partial", filled: 4 });
    sim.partialFraction = 1;
    const [u] = await ex.placeIoc([{ market: "ETH", side: "buy", sz: 1, limitPx: 2_990, reduceOnly: false }]);
    expect(u!.status).toBe("unfilled");
  });

  test("reduce-only never grows or flips a position", async () => {
    const [r] = await ex.placeIoc([{ market: "BTC", side: "sell", sz: 2, limitPx: 99_000, reduceOnly: true }]);
    expect(r).toMatchObject({ filled: 0.5 }); // only what was held
    expect((await ex.positions()).get("BTC") ?? 0).toBe(0);
    const [again] = await ex.placeIoc([{ market: "BTC", side: "sell", sz: 1, limitPx: 99_000, reduceOnly: true }]);
    expect(again!.status).toBe("unfilled");
  });

  test("account value: cash plus open P&L; transfers net of fee", async () => {
    sim.deposit(10_000);
    sim.withdraw(1_001, 1);
    expect(await ex.accountValue()).toBe(BigInt(Math.round(sim.accountValue() * 1e6)) * 10n ** 12n);
    expect(await ex.transfers()).toEqual({ deposits: 10_000n * 10n ** 18n, withdrawalsNet: 1_000n * 10n ** 18n });
  });

  test("keys: a read key cannot trade, an unknown key gets nothing, and there is no withdrawal endpoint", async () => {
    const read = await openExchange("sim", sim.url, "read", true);
    await expect(read.placeIoc([{ market: "BTC", side: "buy", sz: 0.01, limitPx: 101_000, reduceOnly: false }])).rejects.toThrow("HTTP 403");
    await expect(new HttpExchange("sim", sim.url, "guess").positions()).rejects.toThrow("HTTP 401");
    const w = await fetch(`${sim.url}/v1/withdraw`, { method: "POST", headers: { authorization: "Bearer x" } });
    expect(w.status).toBe(401);
    const tw = await fetch(`${sim.url}/v1/withdraw`, { method: "POST", headers: { authorization: `Bearer ${sim.issueKey("trade")}` } });
    expect(tw.status).toBe(404);
  });

  test("an outage makes the call fail", async () => {
    sim.outage = "http500";
    await expect(ex.markets()).rejects.toThrow("HTTP 500");
    sim.outage = "none";
  });
});

describe("guards", () => {
  test("the simulated exchange only on anvil; Binance only on its futures testnet or this machine; nothing else", async () => {
    const keys = async () => "made-up";
    await expect(openExchange("binance", "https://x.example", "trade", true, keys)).rejects.toThrow("refused");
    await expect(openExchange("binance", "https://fapi.binance.com", "trade", true, keys)).rejects.toThrow("mainnet is refused");
    await expect(openExchange("binance", "http://127.0.0.1:1", "trade", false, keys)).rejects.toThrow("local anvil");
    await expect(openExchange("okx", undefined, "trade", true, keys)).rejects.toThrow("no adapter");
    await expect(openExchange("sim", sim.url, "trade", false)).rejects.toThrow("local anvil");
    await expect(openExchange("sim", undefined, "read", true)).rejects.toThrow("--exchange-url");
  });
});
