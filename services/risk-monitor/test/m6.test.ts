import { describe, expect, test } from "bun:test";
import { stringToHex, type Address } from "viem";
import { m6Alarms, settleDue, type M6Event, type OpenLot } from "../src/m6.ts";

const USDC = "0x00000000000000000000000000000000000000c1" as Address;
const tx = "0x01" as `0x${string}`;
const ev = (eventName: string, args: Record<string, unknown>): M6Event => ({ eventName, args, transactionHash: tx });

describe("M6 alarms", () => {
  test("buybacks, uncovered raw, slashes: one line each; a buyback with no shortfall is silent; dust is summed", () => {
    const open = new Map<bigint, OpenLot>();
    const out = m6Alarms(
      [
        ev("BuybackSettled", { id: 1n, paidUsdc: 10_000_000n, paidWhype: 0n, shortfall: 0n }),
        ev("BuybackSettled", { id: 2n, paidUsdc: 10_000_000n, paidWhype: 0n, shortfall: 2_500_000n }),
        ev("BuybackFailed", { id: 3n, rawSold: 5n }),
        ev("Flagged", { key: "0xaa", seriesId: 3n, uncoveredRaw: 7n }),
        ev("DustAbsorbed", { key: "0xaa", seriesId: 1n, usdc: 1n }),
        ev("DustAbsorbed", { key: "0xbb", seriesId: 1n, usdc: 1n }),
        ev("Slashed", { maker: "0x01", token: USDC, asked: 4_000_000n, taken: 3_000_000n, to: "0x02", by: "0x03" }),
        ev("AuctionFilled", { id: 1n, raw: 1n, price: 1n, winner: "0x01" }), // covered by Settled
      ],
      open,
      USDC,
    );
    expect(out.map((a) => a.name)).toEqual(["BUYBACK_SHORTFALL", "BUYBACK_FAILED", "MATCHED_UNCOVERED", "VAULT_SLASHED", "DUST_ABSORBED"]);
    expect(out[0]!.values.shortfall).toBe(2.5);
    expect(out[1]!.level).toBe("alarm");
    expect(out[2]!.level).toBe("alarm");
    expect(out[3]!.values.taken).toBe(3);
    expect(out[4]!.values).toEqual({ events: 2, usdc: 0.000002 });
  });

  test("an auction week: started (lot tracked), forfeits, settled (lot released); settle overdue after the grace", () => {
    const open = new Map<bigint, OpenLot>();
    const started = m6Alarms([ev("Started", { lotId: 0n, market: stringToHex("BTC", { size: 32 }), seriesId: 4n, raw: 9n, bond: 4_285_700_000n, commitEnd: 1_000n, revealEnd: 2_000n })], open, USDC);
    expect(started[0]!.name).toBe("AUCTION_STARTED");
    expect(started[0]!.market).toBe("BTC");
    expect(started[0]!.values.bond).toBe(4_285.7);
    expect(open.get(0n)).toEqual({ lotId: 0n, market: "BTC", revealEnd: 2_000 });
    expect(settleDue(open, 5_600, 3_600)).toEqual([]);
    expect(settleDue(open, 5_601, 3_600).length).toBe(1);

    const end = m6Alarms(
      [
        ev("Forfeited", { lotId: 0n, bidder: "0x01", bond: 4_285_700_000n, why: "no collateral" }),
        ev("Forfeited", { lotId: 0n, bidder: "0x02", bond: 4_285_700_000n, why: "not revealed" }),
        ev("Settled", { lotId: 0n, winner: "0x03", sigmaBps: 3500n, raw: 9n, price: 15_977_906n, reserve: 21_000_000n }),
      ],
      open,
      USDC,
    );
    expect(end.map((a) => a.name)).toEqual(["AUCTION_FORFEIT", "AUCTION_FORFEIT", "AUCTION_SETTLED"]);
    expect(end[0]!.what).toContain("could not collateralise");
    expect(end[1]!.what).toContain("did not reveal");
    expect(end[2]!.market).toBe("BTC");
    expect(end[2]!.who).toBe("nobody");
    expect(open.size).toBe(0);
    expect(settleDue(open, 99_999, 3_600)).toEqual([]);
  });

  test("a lot settled with no fill says the pool keeps the risk", () => {
    const open = new Map<bigint, OpenLot>([[1n, { lotId: 1n, market: "ETH", revealEnd: 0 }]]);
    const [a] = m6Alarms([ev("Settled", { lotId: 1n, winner: "0x0000000000000000000000000000000000000000", sigmaBps: 0n, raw: 0n, price: 0n, reserve: 5n })], open, USDC);
    expect(a!.what).toContain("no fill");
    expect(a!.who).toContain("admin");
  });
});
