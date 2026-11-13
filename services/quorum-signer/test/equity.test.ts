import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { parseEther } from "viem";
import { decide, type KeyState } from "../src/decide.ts";
import { accountValueFrom, EQUITY_OFFSET, EquitySource, equityKey, equityVote, transfersFromLedger } from "../src/equity.ts";

// Ledger entries shaped as Hyperliquid documents userNonFundingLedgerUpdates (synthetic values; field names (U)).
const LEDGER = [
  { time: 1, hash: "0x01", delta: { type: "deposit", usdc: "600000.0" } },
  { time: 2, hash: "0x02", delta: { type: "deposit", usdc: "400000.0" } },
  { time: 3, hash: "0x03", delta: { type: "withdraw", usdc: "100001.0", nonce: 7, fee: "1.0" } },
  { time: 4, hash: "0x04", delta: { type: "accountClassTransfer", usdc: "5.0", toPerp: true } }, // ignored
];
const STATE = { marginSummary: { accountValue: "950000.5", totalNtlPos: "0.0" } };

describe("EQUITY value", () => {
  test("deposits credited and withdrawals sent home net of fee", () => {
    expect(transfersFromLedger(LEDGER)).toEqual({ deposits: parseEther("1000000"), withdrawalsNet: parseEther("100000") });
    expect(() => transfersFromLedger({})).toThrow("not a list");
  });

  test("P&L only: account value − deposits + withdrawals home, plus the offset", () => {
    const v = equityVote(accountValueFrom(STATE), parseEther("1000000"), parseEther("100000"));
    expect(v - EQUITY_OFFSET).toBe(parseEther("50000.5")); // 950,000.5 − 1,000,000 + 100,000
    // a loss is below the offset, still a valid board value
    expect(equityVote(parseEther("700000"), parseEther("1000000"), 0n)).toBe(EQUITY_OFFSET - parseEther("300000"));
    expect(() => equityVote(0n, EQUITY_OFFSET + 1n, 0n)).toThrow("below the offset range");
    expect(accountValueFrom({ marginSummary: { accountValue: "0.0" } })).toBe(0n);
    expect(() => accountValueFrom({})).toThrow();
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

describe("EquitySource against a local fake server", () => {
  let mode: "ok" | "500" = "ok";
  const bodies: Record<string, unknown>[] = [];
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const b = (await req.json()) as Record<string, unknown>;
        bodies.push(b);
        if (mode === "500") return new Response("down", { status: 500 });
        if (b.type === "clearinghouseState") return Response.json(STATE);
        if (b.type === "userNonFundingLedgerUpdates") return Response.json(LEDGER);
        return new Response("?", { status: 400 });
      },
    });
  });
  afterAll(() => server.stop(true));

  test("reads both endpoints for the pool's account; a failed read gives no reading", async () => {
    const quiet = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const user = "0x00000000000000000000000000000000000000E1";
      const src = new EquitySource(user, `http://127.0.0.1:${server.port}`, 3000, () => 1_000_000);
      const r = await src.read(1_800_000_000);
      expect(r).toEqual({ value: EQUITY_OFFSET + parseEther("50000.5"), at: 1_800_000_000 });
      expect(bodies.map((b) => b.type).sort()).toEqual(["clearinghouseState", "userNonFundingLedgerUpdates"]);
      expect(bodies.every((b) => b.user === user)).toBe(true);
      mode = "500";
      expect(await src.read(1_800_000_000)).toBeNull();
    } finally {
      quiet.mockRestore();
      mode = "ok";
    }
  });
});
