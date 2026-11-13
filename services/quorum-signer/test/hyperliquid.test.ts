import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { formatEther, parseEther } from "viem";
import { decimalToWad, fetchMetaAndAssetCtxs, parseMarks } from "../src/hyperliquid.ts";
import { ALARM_AFTER_FAILURES, HyperliquidSource } from "../src/source.ts";

// A trimmed copy of one real public reply (2026-11-11): BTC, ETH, MATIC (delisted) and HYPE, in reply order.
const fixture = await Bun.file(new URL("./fixtures/metaAndAssetCtxs.json", import.meta.url)).json();
const MARKETS = ["BTC", "ETH", "HYPE"];

describe("decimalToWad", () => {
  test("converts exactly, without floating point", () => {
    expect(decimalToWad("74227.0")).toBe(parseEther("74227"));
    expect(decimalToWad("73.574")).toBe(73_574n * 10n ** 15n);
    expect(decimalToWad("0.000012345678901234")).toBe(12_345_678_901_234n);
    expect(decimalToWad("123456789.123456789123456789")).toBe(123_456_789_123_456_789_123_456_789n);
  });

  test("refuses anything that is not a plain positive decimal", () => {
    for (const bad of ["", "-1", "0", "0.0", "1e5", "NaN", "1.", ".5", " 1", "1,5", "0x10", "1.0000000000000000001", null, 42]) {
      expect(() => decimalToWad(bad)).toThrow();
    }
  });
});

describe("parseMarks", () => {
  test("reads markPx for BTC, ETH and HYPE from the real reply", () => {
    const m = parseMarks(fixture, MARKETS);
    expect(m.get("BTC")).toEqual({ ok: true, mark: parseEther("74227"), oracle: parseEther("74253"), mid: parseEther("74240.5"), szDecimals: 5 });
    expect(m.get("ETH")).toEqual({ ok: true, mark: parseEther("2083.2"), oracle: parseEther("2083.95"), mid: parseEther("2083.65"), szDecimals: 4 });
    expect(m.get("HYPE")).toEqual({ ok: true, mark: parseEther("73.574"), oracle: parseEther("73.561"), mid: parseEther("73.588"), szDecimals: 2 });
  });

  test("missing and delisted markets give no mark", () => {
    const m = parseMarks(fixture, ["MATIC", "NOPE"]);
    expect(m.get("MATIC")).toEqual({ ok: false, reason: "delisted" });
    expect(m.get("NOPE")).toEqual({ ok: false, reason: "missing" });
  });

  test("a malformed price gives no mark", () => {
    const f = structuredClone(fixture);
    f[1][0].markPx = "7.4e4";
    f[1][1].oraclePx = null;
    const m = parseMarks(f, MARKETS);
    expect(m.get("BTC")).toMatchObject({ ok: false, reason: "bad-price" });
    expect(m.get("ETH")).toMatchObject({ ok: false, reason: "bad-price" });
    expect(m.get("HYPE")?.ok).toBe(true);
  });

  test("mark and oracle more than 5% apart: skipped; exactly 5% passes", () => {
    const f = structuredClone(fixture);
    f[1][0].oraclePx = "100000.0";
    f[1][0].markPx = "105000.0"; // exactly 5%
    f[1][1].oraclePx = "2000.0";
    f[1][1].markPx = "1899.99"; // just over 5% below
    const m = parseMarks(f, MARKETS);
    expect(m.get("BTC")?.ok).toBe(true);
    expect(m.get("ETH")).toMatchObject({ ok: false, reason: "oracle-deviation" });
  });

  test("refuses a reply whose lists do not line up", () => {
    expect(() => parseMarks({}, MARKETS)).toThrow();
    expect(() => parseMarks([fixture[0], fixture[1].slice(1)], MARKETS)).toThrow("line up");
  });
});

describe("HyperliquidSource against a local fake server", () => {
  let mode: "ok" | "500" | "garbage" | "slow" = "ok";
  const seen: { method: string; path: string; body: string }[] = [];
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.push({ method: req.method, path: new URL(req.url).pathname, body: await req.text() });
        if (mode === "500") return new Response("down", { status: 500 });
        if (mode === "garbage") return new Response("{not json");
        if (mode === "slow") await Bun.sleep(400);
        return Response.json(fixture);
      },
    });
  });
  afterAll(() => server.stop(true));
  const base = () => `http://127.0.0.1:${server.port}`;

  test("only ever POSTs metaAndAssetCtxs to /info", async () => {
    seen.length = 0;
    mode = "ok";
    await fetchMetaAndAssetCtxs(base());
    expect(seen).toEqual([{ method: "POST", path: "/info", body: '{"type":"metaAndAssetCtxs"}' }]);
  });

  test("one fetch serves every market of a tick; VOL has no reading until started from candles", async () => {
    seen.length = 0;
    mode = "ok";
    const src = new HyperliquidSource(MARKETS, base(), 3_000, () => 1_000_000); // fixed clock: no rounding flake
    const now = 1_800_000_000;
    expect(await src.read("BTC", "MARK", now)).toEqual({ value: parseEther("74227"), at: now });
    expect(await src.read("HYPE", "MARK", now)).toEqual({ value: parseEther("73.574"), at: now });
    expect(await src.read("BTC", "VOL", now)).toBeNull(); // this server has no candles: start-up fails
    expect(seen.filter((r) => r.body.includes("metaAndAssetCtxs")).length).toBe(1);
  });

  test("the reading's age comes from the local clock, expressed in chain time", async () => {
    mode = "ok";
    let t = 1_000_000;
    const src = new HyperliquidSource(MARKETS, base(), 3_000, () => t);
    expect((await src.read("ETH", "MARK", 500))?.at).toBe(500);
    t += 3_200; // 3.2 s later on this machine; the snapshot is reused
    expect((await src.read("ETH", "MARK", 9_999))?.at).toBe(9_999 - 4); // rounded up: never younger than it is
  });

  test("HTTP errors, garbage and timeouts give no reading; alarm after 3 failures; recovery resets", async () => {
    const logs: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => {
      logs.push(String(s));
      return true;
    });
    try {
      let t = 0;
      const src = new HyperliquidSource(MARKETS, base(), 200, () => t);
      for (const m of ["500", "garbage", "slow"] as const) {
        mode = m;
        t += 20_000;
        expect(await src.read("BTC", "MARK", 1)).toBeNull();
      }
      expect(src.failures).toBe(ALARM_AFTER_FAILURES);
      const levels = logs.map((l) => JSON.parse(l)).map((l) => `${l.level}:${l.msg}`);
      expect(levels).toEqual(["warn:hyperliquid fetch failed", "warn:hyperliquid fetch failed", "alarm:hyperliquid unreachable"]);
      mode = "ok";
      t += 20_000;
      expect(await src.read("BTC", "MARK", 1)).not.toBeNull();
      expect(src.failures).toBe(0);
      expect(logs.some((l) => l.includes("hyperliquid recovered"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

// Opt-in: HL_LIVE=1 bun test test/hyperliquid.test.ts
test.skipIf(process.env.HL_LIVE !== "1")("live: reads BTC, ETH and HYPE marks from Hyperliquid mainnet", async () => {
  const body = await fetchMetaAndAssetCtxs();
  const m = parseMarks(body, MARKETS);
  for (const market of MARKETS) {
    const r = m.get(market)!;
    expect(r.ok).toBe(true);
    if (r.ok) {
      console.log(`live ${market}: markPx ${formatEther(r.mark)}  oraclePx ${formatEther(r.oracle)}`);
    }
  }
}, 10_000);
