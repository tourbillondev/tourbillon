import { describe, expect, spyOn, test } from "bun:test";
import { parseEther } from "viem";
import type { Price, PriceFeed } from "../src/feeds.ts";
import { FeedSource, type MarketFeeds } from "../src/source.ts";
import { MIN_START_RETURNS, STEP_S } from "../src/vol.ts";

/// A feed whose answer the test sets; counts its reads.
class FakeFeed implements PriceFeed {
  reads = 0;
  constructor(
    readonly name: string,
    public answer: (() => Price) | null,
  ) {}
  async read(): Promise<Price> {
    this.reads++;
    if (!this.answer) throw new Error("down");
    return this.answer();
  }
}

const quiet = () => spyOn(process.stdout, "write").mockImplementation(() => true);

function setup(inSession: boolean) {
  let nowMs = 1_795_014_000_000;
  const clock = () => nowMs;
  const px = (v: string) => () => ({ px: parseEther(v), atMs: nowMs - 500 });
  const onchain = new FakeFeed("onchain", px("412.30"));
  const reference = new FakeFeed("reference", px("412.00"));
  const ex = [new FakeFeed("a", px("97100")), new FakeFeed("b", px("97120")), new FakeFeed("c", px("97110"))];
  const pyth = new FakeFeed("pyth", px("97115"));
  const feeds = new Map<string, MarketFeeds>([
    ["STK1", { kind: "stock", onchain, reference }],
    ["BTC", { kind: "crypto", exchanges: ex, pyth }],
  ]);
  const src = new FeedSource(feeds, clock, () => inSession, () => false);
  return { src, onchain, reference, ex, pyth, advance: (ms: number) => (nowMs += ms), now: () => Math.floor(nowMs / 1000) };
}

describe("FeedSource: MARK", () => {
  test("a stock in session votes the checked on-chain price; crypto votes the checked median", async () => {
    const q = quiet();
    try {
      const s = setup(true);
      expect(await s.src.read("STK1", "MARK", s.now())).toEqual({ value: parseEther("412.30"), at: s.now() - 1 });
      expect(await s.src.read("BTC", "MARK", s.now())).toEqual({ value: parseEther("97110"), at: s.now() - 1 });
      expect(await s.src.read("ETH", "MARK", s.now())).toBeNull(); // not in the feeds file
      expect(await s.src.read("BTC", "EQUITY", s.now())).toBeNull();
    } finally {
      q.mockRestore();
    }
  });

  test("a disagreement, a missing reference or a broken feed means no reading; an alarm after three in a row", async () => {
    const lines: string[] = [];
    const q = spyOn(process.stdout, "write").mockImplementation((l) => (lines.push(String(l)), true));
    try {
      const s = setup(true);
      s.onchain.answer = () => ({ px: parseEther("420"), atMs: s.now() * 1000 }); // fresh, by the test clock
      s.reference.answer = null; // the reference is down
      for (let i = 0; i < 3; i++) {
        expect(await s.src.read("STK1", "MARK", s.now())).toBeNull();
        s.advance(6_000);
      }
      const marks = lines.map((l) => JSON.parse(l)).filter((l) => l.msg === "mark: refused, no vote");
      expect(marks.map((l) => l.level)).toEqual(["warn", "warn", "alarm"]);
      expect(marks.every((l) => l.reason === "no-reference" && l.market === "STK1")).toBe(true);
    } finally {
      q.mockRestore();
    }
  });

  test("out of session a stock votes the token price alone, without asking whether the reference agrees", async () => {
    const q = quiet();
    try {
      const s = setup(false);
      s.reference.answer = null;
      expect((await s.src.read("STK1", "MARK", s.now()))?.value).toBe(parseEther("412.30"));
    } finally {
      q.mockRestore();
    }
  });

  test("one round of reads serves MARK and VOL within five seconds", async () => {
    const q = quiet();
    try {
      const s = setup(true);
      await Promise.all([s.src.read("BTC", "MARK", s.now()), s.src.read("BTC", "VOL", s.now()), s.src.read("BTC", "MARK", s.now())]);
      expect(s.pyth.reads).toBe(1);
      expect(s.ex.map((f) => f.reads)).toEqual([1, 1, 1]);
      s.advance(5_001);
      await s.src.read("BTC", "MARK", s.now());
      expect(s.pyth.reads).toBe(2);
    } finally {
      q.mockRestore();
    }
  });
});

describe("FeedSource: VOL from this signer's own accepted marks", () => {
  test("no vol until a day of 5-minute steps is in; then a vol, aged by the last kept price", async () => {
    const q = quiet();
    try {
      const s = setup(true);
      let level = 97_000;
      const step = async () => {
        for (const f of [...s.ex, s.pyth]) f.answer = ((v: string, t: number) => () => ({ px: parseEther(v), atMs: t }))(level.toFixed(2), s.now() * 1000);
        await s.src.read("BTC", "MARK", s.now());
      };
      for (let i = 0; i < MIN_START_RETURNS; i++) {
        await step();
        expect(await s.src.read("BTC", "VOL", s.now())).toBeNull();
        level *= i % 2 ? 1.003 : 0.997;
        s.advance(STEP_S * 1000);
      }
      await step();
      const v = await s.src.read("BTC", "VOL", s.now());
      expect(v).not.toBeNull();
      expect(v!.value % 10n ** 14n).toBe(0n); // whole bps, as the board reads it
      s.advance(90_000);
      const later = await s.src.read("BTC", "VOL", s.now());
      // the market keeps being checked (and sampled), so the vol stays as fresh as the last kept price
      expect(later!.at).toBeLessThanOrEqual(s.now());
    } finally {
      q.mockRestore();
    }
  });
});
