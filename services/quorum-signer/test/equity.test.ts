import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { parseEther } from "viem";
import { decide, type KeyState } from "../src/decide.ts";
import { EQUITY_OFFSET, EquitySource, equityKey, equityVote } from "../src/equity.ts";
import { HttpExchange, parseMarkets, parseTransfers } from "@tourbillon/common/exchange.ts";
import { SimExchange } from "../../hedger/src/simexchange.ts";

// Transfers as the exchange adapter gives them (synthetic values).
const TRANSFERS = [
  { type: "deposit", amount: "600000.0", fee: "0" },
  { type: "deposit", amount: "400000.0" },
  { type: "withdraw", amount: "100001.0", fee: "1.0" },
  { type: "internal", amount: "5.0" }, // ignored
];

describe("EQUITY value", () => {
  test("deposits credited and withdrawals sent home net of fee", () => {
    expect(parseTransfers(TRANSFERS)).toEqual({ deposits: parseEther("1000000"), withdrawalsNet: parseEther("100000") });
    expect(() => parseTransfers({})).toThrow("not a list");
  });

  test("P&L only: account value − deposits + withdrawals home, plus the offset", () => {
    const v = equityVote(parseEther("950000.5"), parseEther("1000000"), parseEther("100000"));
    expect(v - EQUITY_OFFSET).toBe(parseEther("50000.5")); // 950,000.5 − 1,000,000 + 100,000
    // a loss is below the offset, still a valid board value
    expect(equityVote(parseEther("700000"), parseEther("1000000"), 0n)).toBe(EQUITY_OFFSET - parseEther("300000"));
    expect(() => equityVote(0n, EQUITY_OFFSET + 1n, 0n)).toThrow("below the offset range");
  });

  test("markets: a missing or non-positive price leaves the market out", () => {
    const m = parseMarkets([
      { name: "BTC", szDecimals: 5, pxDecimals: 1, mid: "100000", mark: "100001" },
      { name: "ETH", szDecimals: 4, pxDecimals: 2, mid: "0", mark: "3000" },
      { name: "SOL", szDecimals: 2, pxDecimals: 3 },
    ]);
    expect([...m.keys()]).toEqual(["BTC"]);
    expect(m.get("BTC")).toEqual({ name: "BTC", szDecimals: 5, pxDecimals: 1, mid: 100000, mark: 100001 });
    expect(() => parseMarkets({})).toThrow("not a list");
  });

  test.skipIf(!Bun.which("cast"))("the key equals keccak256(abi.encode('EQUITY', pool)) as the pool computes it", () => {
    const pool = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
    const enc = Bun.spawnSync(["cast", "abi-encode", "f(string,address)", "EQUITY", pool]).stdout.toString().trim();
    const k = Bun.spawnSync(["cast", "keccak", enc]).stdout.toString().trim();
    expect(equityKey(pool)).toBe(k as `0x${string}`);
  });

  test("hourly cadence; a stale reading is never voted", () => {
    const NOW = 1_800_000_000;
    const s: KeyState = { latestRound: 3n, latestUpdatedAt: NOW - 3599, openVotes: 0, iVoted: false, myVoteAt: null, heartbeat: 7200, quorum: 2 };
    const r = { value: EQUITY_OFFSET, at: NOW - 1 };
    expect(decide("EQUITY", s, r, NOW)).toEqual({ action: "skip", reason: "fresh" });
    expect(decide("EQUITY", { ...s, latestUpdatedAt: NOW - 3600 }, r, NOW)).toMatchObject({ action: "vote", reason: "start" });
    expect(decide("EQUITY", { ...s, latestUpdatedAt: NOW - 3600 }, { value: 1n, at: NOW - 121 }, NOW)).toEqual({ action: "skip", reason: "stale-reading" });
  });
});

describe("EquitySource against the simulated exchange", () => {
  let ex: SimExchange;
  beforeAll(() => {
    ex = new SimExchange([{ name: "BTC", szDecimals: 5, mid: 100_000 }]);
    ex.deposit(1_000_000);
    ex.withdraw(100_001, 1);
    ex.cash += 50_000.5;
  });
  afterAll(() => ex.stop());

  test("a read-only key reads the account value and the transfers; it cannot trade; a failed read gives no reading", async () => {
    const quiet = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const read = new HttpExchange("sim", ex.url, ex.issueKey("read"));
      const src = new EquitySource(read, () => 1_000_000);
      const r = await src.read(1_800_000_000);
      // cash 1,000,000 − 100,001 + 50,000.5; the withdrawal counts net of its 1 USDC fee, so the fee is a cost: P&L 49,999.5
      expect(r).toEqual({ value: EQUITY_OFFSET + parseEther("49999.5"), at: 1_800_000_000 });
      expect(ex.requests.map((q) => q.path).sort()).toEqual(["/v1/account", "/v1/transfers"]);
      await expect(read.placeIoc([{ market: "BTC", side: "buy", sz: 0.01, limitPx: 200_000, reduceOnly: false }])).rejects.toThrow("HTTP 403");
      expect(ex.rejected).toEqual(["a read key tried to trade"]);
      await expect(new HttpExchange("sim", ex.url, "made-up").accountValue()).rejects.toThrow("HTTP 401");
      ex.outage = "http500";
      expect(await src.read(1_800_000_000)).toBeNull();
    } finally {
      quiet.mockRestore();
      ex.outage = "none";
    }
  });
});
