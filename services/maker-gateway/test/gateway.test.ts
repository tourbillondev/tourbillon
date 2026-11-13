import { describe, expect, test } from "bun:test";
import { parseEther, stringToHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { collateralUsdc, domainFor, fits, quoteTypes, signedByMaker, termsProblem, writerWorstPerUnit, type Leg, type Order, type Quote } from "../src/quote.ts";
import { makeHandler, type Chain } from "../src/server.ts";
import { orderValue, QuoteStore, type QuoteState } from "../src/store.ts";
import { buildQuote } from "../src/bot.ts";

const BOOK = "0x00000000000000000000000000000000000b00c5" as Address;
const CHAIN = 31337;
const BTC = stringToHex("BTC", { size: 32 });
const w = (n: number | string) => parseEther(String(n));
const day = [{ tempo: 86_400n, weight: w(1) }];
const spread: Leg[] = [
  { isCall: true, kWad: w(74_000), qty: w(1) },
  { isCall: true, kWad: w(76_000), qty: w(-1) },
];

// throwaway in-memory test makers: nothing is written anywhere
const makers = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()));

function quote(maker: Address, sigmaBps: bigint, nonce: bigint, over: Partial<Quote> = {}): Quote {
  return { maker, name: BTC, sides: 1, kLoWad: w(60_000), kHiWad: w(90_000), tauLo: 3_600, tauHi: 30 * 86_400, sigmaBps, maxUnits: w(100), validUntil: 2_000n, nonce, ...over };
}

async function sign(i: number, q: Quote): Promise<Hex> {
  return makers[i]!.signTypedData({ domain: domainFor(CHAIN, BOOK), types: quoteTypes, primaryType: "Quote", message: q });
}

function fakeChain(over: Partial<Chain> = {}, free = new Map<string, bigint>(), cancelled = new Set<string>(), filled = new Map<string, bigint>()): Chain {
  return {
    chainId: CHAIN,
    quoteBook: BOOK,
    now: async () => 1_000n,
    markOf: async () => 75_000,
    filled: async (m, n) => filled.get(`${m.toLowerCase()}:${n}`) ?? 0n,
    cancelled: async (m, n) => cancelled.has(`${m.toLowerCase()}:${n}`),
    freeUsdc: async (m) => free.get(m.toLowerCase()) ?? 0n,
    ...over,
  };
}

const order = (units = w(2), legs = spread, movement = day): Order => ({ name: BTC, legs, movement, units });

describe("quote checks", () => {
  test("a signature recovers to its maker only for this chain and quote book; a tampered quote fails", async () => {
    const q = quote(makers[0]!.address, 4000n, 1n);
    const sig = await sign(0, q);
    expect(await signedByMaker(q, sig, CHAIN, BOOK)).toBe(true);
    expect(await signedByMaker(q, sig, 99801, BOOK)).toBe(false);
    expect(await signedByMaker(q, sig, CHAIN, makers[1]!.address)).toBe(false);
    expect(await signedByMaker({ ...q, sigmaBps: 3000n }, sig, CHAIN, BOOK)).toBe(false);
    expect(await signedByMaker({ ...q, maker: makers[1]!.address }, sig, CHAIN, BOOK)).toBe(false);
  });

  test("terms: sides, the σ bounds, bands in order, a size", () => {
    const q = quote(makers[0]!.address, 4000n, 1n);
    expect(termsProblem(q)).toBeNull();
    expect(termsProblem({ ...q, sides: 0 })).not.toBeNull();
    expect(termsProblem({ ...q, sides: 4 })).not.toBeNull();
    expect(termsProblem({ ...q, sigmaBps: 499n })).not.toBeNull();
    expect(termsProblem({ ...q, sigmaBps: 50_001n })).not.toBeNull();
    expect(termsProblem({ ...q, kLoWad: w(91_000) })).not.toBeNull();
    expect(termsProblem({ ...q, tauLo: 40 * 86_400 })).not.toBeNull();
    expect(termsProblem({ ...q, maxUnits: 0n })).not.toBeNull();
  });

  test("the whole order must fit: every leg's side and strike, every Movement part's tempo, the size left", () => {
    const q = quote(makers[0]!.address, 4000n, 1n);
    expect(fits(q, order(), 0n)).toBe(true);
    expect(fits(q, order(w(2)), w(98))).toBe(true);
    expect(fits(q, order(w(2)), w(99))).toBe(false);
    expect(fits(q, order(w(1), [{ isCall: false, kWad: w(70_000), qty: w(1) }]), 0n)).toBe(false); // calls only
    expect(fits({ ...q, sides: 3 }, order(w(1), [{ isCall: false, kWad: w(70_000), qty: w(1) }]), 0n)).toBe(true);
    expect(fits(q, order(w(1), [{ isCall: true, kWad: w(95_000), qty: w(1) }]), 0n)).toBe(false); // strike outside
    expect(fits(q, order(w(1), spread, [{ tempo: 1_800n, weight: w(0.5) }, { tempo: 86_400n, weight: w(0.5) }]), 0n)).toBe(false);
    expect(fits(q, { ...order(), name: stringToHex("ETH", { size: 32 }) }, 0n)).toBe(false);
  });

  test("the maker's worst case mirrors StrategyMath: a spread is its width, a put its strike, a naked call unbounded", () => {
    expect(writerWorstPerUnit(spread)).toBe(w(2_000));
    expect(collateralUsdc(spread, w(2))).toBe(4_000_000_000n);
    expect(writerWorstPerUnit([{ isCall: false, kWad: w(70_000), qty: w(1) }])).toBe(w(70_000));
    expect(writerWorstPerUnit([{ isCall: true, kWad: w(74_000), qty: w(1) }])).toBeNull();
    // a call butterfly: the maker's worst is the wing width
    const fly: Leg[] = [
      { isCall: true, kWad: w(72_000), qty: w(1) },
      { isCall: true, kWad: w(74_000), qty: w(-2) },
      { isCall: true, kWad: w(76_000), qty: w(1) },
    ];
    expect(writerWorstPerUnit(fly)).toBe(w(2_000));
  });
});

describe("the store", () => {
  test("cheapest first at the mark, one quote per maker, at most 4, and only makers whose vault holds the order's collateral", async () => {
    const s = new QuoteStore();
    const [a, b, c] = makers.map((m) => m.address);
    s.add({ quote: quote(a!, 4500n, 1n), sig: "0x", receivedAt: 1 });
    s.add({ quote: quote(a!, 3500n, 2n), sig: "0x", receivedAt: 2 });
    s.add({ quote: quote(b!, 4000n, 1n), sig: "0x", receivedAt: 3 });
    s.add({ quote: quote(c!, 3000n, 1n), sig: "0x", receivedAt: 4 });
    const free = new Map([[a!.toLowerCase(), 10_000_000_000n], [b!.toLowerCase(), 10_000_000_000n], [c!.toLowerCase(), 3_999_999_999n]]);
    // at 74,000 the spread is long vega (at 75,000, its centre, it is slightly short: see the next test)
    const got = await s.best(order(), 74_000, 1_000n, fakeChain({}, free));
    // c is cheapest but holds less than 4,000 USDC free; a's 35% beats b's 40%
    expect(got.map((x) => [x.quote.maker, x.quote.sigmaBps])).toEqual([[a!, 3500n], [b!, 4000n]]);
  });

  test("a short-vega order ranks the higher σ first (ranking is by value, not by σ)", async () => {
    const fly: Leg[] = [
      { isCall: true, kWad: w(74_000), qty: w(1) },
      { isCall: true, kWad: w(75_000), qty: w(-2) },
      { isCall: true, kWad: w(76_000), qty: w(1) },
    ];
    const o = order(w(1), fly, [{ tempo: 7n * 86_400n, weight: w(1) }]);
    expect(orderValue(o, 75_000, 6000)).toBeLessThan(orderValue(o, 75_000, 2000));
    const s = new QuoteStore();
    s.add({ quote: quote(makers[0]!.address, 2000n, 1n), sig: "0x", receivedAt: 1 });
    s.add({ quote: quote(makers[1]!.address, 6000n, 1n), sig: "0x", receivedAt: 2 });
    const free = new Map(makers.map((m) => [m.address.toLowerCase(), 10n ** 12n]));
    const got = await s.best(o, 75_000, 1_000n, fakeChain({}, free));
    expect(got[0]!.quote.sigmaBps).toBe(6000n);
  });

  test("expired quotes are dropped; cancelled ones removed; a filled nonce's room is respected; unbounded orders get none", async () => {
    const s = new QuoteStore();
    const a = makers[0]!.address;
    s.add({ quote: quote(a, 4000n, 1n, { validUntil: 999n }), sig: "0x", receivedAt: 1 });
    s.add({ quote: quote(a, 4100n, 2n), sig: "0x", receivedAt: 2 });
    s.add({ quote: quote(a, 4200n, 3n), sig: "0x", receivedAt: 3 });
    const free = new Map([[a.toLowerCase(), 10n ** 12n]]);
    const st: QuoteState = fakeChain({}, free, new Set([`${a.toLowerCase()}:2`]), new Map([[`${a.toLowerCase()}:3`, w(99)]]));
    expect(await s.best(order(), 75_000, 1_000n, st)).toEqual([]);
    expect(s.size).toBe(1); // the expired and the cancelled are gone; nonce 3 stays (it has 1 unit left)
    expect((await s.best(order(w(1)), 75_000, 1_000n, st)).length).toBe(1);
    expect(await s.best(order(w(1), [{ isCall: true, kWad: w(74_000), qty: w(1) }]), 75_000, 1_000n, st)).toEqual([]);
  });

  test("a re-signed nonce replaces the old quote; a maker can hold at most the limit", () => {
    const s = new QuoteStore(2);
    const a = makers[0]!.address;
    s.add({ quote: quote(a, 4000n, 1n), sig: "0x", receivedAt: 1 });
    s.add({ quote: quote(a, 3900n, 1n), sig: "0x", receivedAt: 2 });
    expect(s.size).toBe(1);
    s.add({ quote: quote(a, 3900n, 2n), sig: "0x", receivedAt: 3 });
    expect(() => s.add({ quote: quote(a, 3900n, 3n), sig: "0x", receivedAt: 4 })).toThrow();
  });
});

describe("the HTTP side", () => {
  const post = (h: ReturnType<typeof makeHandler>, path: string, body: unknown) =>
    h.fetch(new Request(`http://gw${path}`, { method: "POST", body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) }));

  test("accepts a sound signed quote and serves it for a fitting order; refuses the rest with a reason", async () => {
    const a = makers[0]!.address;
    const free = new Map([[a.toLowerCase(), 10n ** 12n]]);
    const h = makeHandler(fakeChain({}, free, new Set([`${a.toLowerCase()}:9`]), new Map([[`${a.toLowerCase()}:8`, w(100)]])));
    const q = quote(a, 4000n, 1n);
    let r = await post(h, "/quotes", { quote: q, sig: await sign(0, q) });
    expect(r.status).toBe(200);
    // refusals
    const cases: [Quote, number, string][] = [
      [q, 1, "not signed"],
      [quote(a, 4000n, 2n, { validUntil: 999n }), 0, "expired"],
      [quote(a, 4000n, 9n), 0, "cancelled"],
      [quote(a, 4000n, 8n), 0, "fully filled"],
      [quote(a, 400n, 3n), 0, "sigma"],
    ];
    for (const [cq, signer, why] of cases) {
      r = await post(h, "/quotes", { quote: cq, sig: await sign(signer, cq) });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toContain(why);
    }
    const poor = quote(makers[2]!.address, 4000n, 1n);
    r = await post(h, "/quotes", { quote: poor, sig: await sign(2, poor) });
    expect(((await r.json()) as { error: string }).error).toContain("no free USDC");
    expect((await post(h, "/quotes", { quote: { maker: "nope" }, sig: "0x" })).status).toBe(400);

    r = await post(h, "/best", order());
    const body = (await r.json()) as { quotes: { quote: Record<string, string>; sig: string }[]; mark: number };
    expect(body.mark).toBe(75_000);
    expect(body.quotes.length).toBe(1);
    expect(body.quotes[0]!.quote.sigmaBps).toBe("4000");
    expect((await h.fetch(new Request("http://gw/health"))).status).toBe(200);
    expect((await h.fetch(new Request("http://gw/nope"))).status).toBe(404);
  });

  test("no fresh mark: no quotes (law 2)", async () => {
    const h = makeHandler(fakeChain({ markOf: async () => null }));
    const body = (await (await post(h, "/best", order())).json()) as { quotes: unknown[]; mark: null };
    expect(body.quotes).toEqual([]);
    expect(body.mark).toBeNull();
  });
});

describe("the reference bot's quote", () => {
  test("σ = board + offset inside the bounds; strikes mark ± band; every tempo; a deadline from chain time", () => {
    const p = { maker: makers[0]!.address, market: "BTC", sigmaOffsetBps: -300, maxUnits: w(50), ttlSeconds: 600, bandPct: 0.3 };
    const q = buildQuote(p, w(75_000), 4500n, 1_000n, 7n);
    expect(q.sigmaBps).toBe(4200n);
    expect(q.kLoWad).toBe(w(52_500));
    expect(q.kHiWad).toBe(w(97_500));
    expect([q.tauLo, q.tauHi]).toEqual([3_600, 2_592_000]);
    expect(q.validUntil).toBe(1_600n);
    expect(q.sides).toBe(3);
    expect(termsProblem(q)).toBeNull();
    expect(buildQuote({ ...p, sigmaOffsetBps: -9_000 }, w(75_000), 4500n, 0n, 1n).sigmaBps).toBe(500n);
  });
});
