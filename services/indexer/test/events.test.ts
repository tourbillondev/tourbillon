import { expect, test } from "bun:test";
import { getAddress, stringToHex } from "viem";
import { boardKeys, opsFor } from "../src/events.ts";

const A = getAddress("0x00000000000000000000000000000000000000a1");
const R = getAddress("0x00000000000000000000000000000000000000ae"); // the AgentRouter
const BTC = stringToHex("BTC", { size: 32 });

test("each event becomes its rows; the AgentRouter's own Engine trades are its sub-accounts, not a direct holding", () => {
  expect(opsFor({ eventName: "Recorded", args: { name: BTC, t: 3600n, sWad: 7n, sigmaBps: 4500n, l0: true, l1: true, l2: false } }, 9n, R).map((o) => (o as { level: number }).level)).toEqual([0, 1]);
  const vote = opsFor({ eventName: "Voted", args: { key: "0xaa", round: 3n, signer: A, value: 5n } }, 9n, R)[0]!;
  expect(vote).toEqual({ t: "vote", key: "0xaa", round: 3n, signer: A, value: 5n, ts: 9n });
  expect(opsFor({ eventName: "Finalised", args: { key: "0xaa", round: 3n, median: 5n, published: 5n, votes: 3n } }, 9n, R)[0]!.t).toBe("final");
  const buy = opsFor({ eventName: "ShapeBought", args: { buyer: A, id: 1n, market: BTC, units: 2n * 10n ** 18n, raw: 10n ** 18n } }, 9n, R)[0]!;
  expect(buy).toEqual({ t: "position", id: 1n, owner: A, held: "direct", market: "BTC", delta: 10n ** 18n, norm: 2n * 10n ** 18n, ts: 9n });
  expect((opsFor({ eventName: "Sold", args: { seller: A, id: 1n, market: BTC, units: 10n ** 18n, raw: 5n * 10n ** 17n } }, 9n, R)[0] as { delta: bigint }).delta).toBe(-5n * 10n ** 17n);
  expect(opsFor({ eventName: "ShapeBought", args: { buyer: R, id: 1n, market: BTC, units: 1n, raw: 1n } }, 9n, R)).toEqual([]); // the router's
  expect((opsFor({ eventName: "AgentBought", args: { owner: A, id: 1n, raw: 4n } }, 9n, R)[0] as { held: string }).held).toBe("agentRouter");
  expect(opsFor({ eventName: "Approval", args: {} }, 9n, R)).toEqual([]);
  expect(boardKeys(["BTC"], "0xee").map((k) => k.kind)).toEqual(["MARK", "VOL", "EQUITY"]);
});
