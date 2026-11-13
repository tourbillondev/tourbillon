import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { orderAction, orderWire, signL1Action } from "../src/hlsign.ts";
import { assertOrderUrlAllowed, HL_MAINNET, HL_TESTNET, HyperliquidVenue } from "../src/hlvenue.ts";
import { SimVenue } from "../src/simvenue.ts";

const USER = "0x00000000000000000000000000000000000000E1";
const agent = privateKeyToAccount(generatePrivateKey()); // a throwaway key, generated for this test
let sim: SimVenue;
let venue: HyperliquidVenue;

beforeAll(async () => {
  sim = new SimVenue([
    { name: "BTC", szDecimals: 5, mid: 100_000 },
    { name: "ETH", szDecimals: 4, mid: 3_000 },
    { name: "HYPE", szDecimals: 2, mid: 40 },
  ]);
  await fetch(`${sim.url}/sim/approve`, { method: "POST", body: JSON.stringify({ user: USER, agent: agent.address }) });
  venue = new HyperliquidVenue(sim.url, USER, agent, ["BTC", "ETH", "HYPE"]);
});
afterAll(() => sim.stop());

describe("simulated venue through the Hyperliquid adapter", () => {
  test("an IOC fills at mid plus slippage; positions follow", async () => {
    const mk = await venue.markets();
    expect(mk.get("BTC")).toMatchObject({ asset: 0, szDecimals: 5, mid: 100_000 });
    const [f] = await venue.placeIoc([{ market: "BTC", side: "buy", sz: 0.5, limitPx: 100_500, reduceOnly: false }], mk);
    expect(f).toMatchObject({ status: "filled", filled: 0.5, avgPx: 100_020 });
    expect((await venue.positions()).get("BTC")).toBe(0.5);
  });

  test("partial fills and limits that are not reached", async () => {
    const mk = await venue.markets();
    sim.partialFraction = 0.4;
    const [p] = await venue.placeIoc([{ market: "ETH", side: "sell", sz: 10, limitPx: 2_985, reduceOnly: false }], mk);
    expect(p).toMatchObject({ status: "partial", filled: 4 });
    sim.partialFraction = 1;
    const [u] = await venue.placeIoc([{ market: "ETH", side: "buy", sz: 1, limitPx: 2_990, reduceOnly: false }], mk);
    expect(u!.status).toBe("unfilled");
  });

  test("reduce-only never grows or flips a position", async () => {
    const mk = await venue.markets();
    const [r] = await venue.placeIoc([{ market: "BTC", side: "sell", sz: 2, limitPx: 99_000, reduceOnly: true }], mk);
    expect(r).toMatchObject({ filled: 0.5 }); // only what was held
    expect((await venue.positions()).get("BTC") ?? 0).toBe(0);
    const [again] = await venue.placeIoc([{ market: "BTC", side: "sell", sz: 1, limitPx: 99_000, reduceOnly: true }], mk);
    expect(again!.status).toBe("unfilled");
  });

  test("an unapproved agent is rejected; a replayed nonce is rejected", async () => {
    const mk = await venue.markets();
    const stranger = new HyperliquidVenue(sim.url, USER, privateKeyToAccount(generatePrivateKey()), ["BTC"]);
    const [x] = await stranger.placeIoc([{ market: "BTC", side: "buy", sz: 0.1, limitPx: 101_000, reduceOnly: false }], mk);
    expect(x!.status).toBe("error");
    expect(sim.rejected.some((r) => r.includes("not an approved agent"))).toBe(true);

    const action = orderAction([orderWire({ asset: 0, isBuy: true, px: 101_000, sz: 0.1, reduceOnly: false, tif: "Ioc" })]);
    const nonce = Date.now() + 10_000_000;
    const signature = await signL1Action(agent, action, nonce, false);
    const send = () => fetch(`${sim.url}/exchange`, { method: "POST", body: JSON.stringify({ action, nonce, signature, vaultAddress: null }) }).then((r) => r.json());
    expect((await send()).status).toBe("ok");
    expect((await send()).status).toBe("err");
  });

  test("outages: HTTP 500 makes the call fail", async () => {
    sim.outage = "http500";
    await expect(venue.markets()).rejects.toThrow("HTTP 500");
    sim.outage = "none";
  });
});

describe("guards", () => {
  test("orders are allowed only to Hyperliquid testnet or a local simulated venue; mainnet is refused", () => {
    expect(() => assertOrderUrlAllowed(HL_MAINNET)).toThrow("refused");
    expect(() => new HyperliquidVenue(HL_MAINNET, USER, agent, ["BTC"])).toThrow("refused");
    expect(() => assertOrderUrlAllowed("https://evil.example")).toThrow("refused");
    assertOrderUrlAllowed(HL_TESTNET);
    assertOrderUrlAllowed("http://127.0.0.1:1234");
    // read-only (no agent) may read mainnet
    expect(() => new HyperliquidVenue(HL_MAINNET, USER, null, ["BTC"])).not.toThrow();
  });
});
