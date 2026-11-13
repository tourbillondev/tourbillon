import { describe, expect, test } from "bun:test";
import { decide, type KeyState } from "../src/decide.ts";

const NOW = 1_800_000_000;
const base: KeyState = { latestRound: 5n, latestUpdatedAt: NOW - 30, openVotes: 0, iVoted: false, myVoteAt: null, heartbeat: 60, quorum: 2 };
const fresh = { value: 100n * 10n ** 18n, at: NOW - 1 };

describe("decide", () => {
  test("starts a MARK round once the last final is 20 s old, for the next round", () => {
    expect(decide("MARK", base, fresh, NOW)).toEqual({ action: "vote", reason: "start", round: 6n, value: fresh.value });
    expect(decide("MARK", { ...base, latestUpdatedAt: NOW - 19 }, fresh, NOW)).toEqual({ action: "skip", reason: "fresh" });
  });

  test("VOL waits 5 minutes before starting a round", () => {
    const s = { ...base, heartbeat: 900, latestUpdatedAt: NOW - 299 };
    expect(decide("VOL", s, fresh, NOW).action).toBe("skip");
    expect(decide("VOL", { ...s, latestUpdatedAt: NOW - 300 }, fresh, NOW).action).toBe("vote");
  });

  test("joins an open round at once, however fresh the last final", () => {
    const d = decide("MARK", { ...base, latestUpdatedAt: NOW - 1, openVotes: 1 }, fresh, NOW);
    expect(d).toEqual({ action: "vote", reason: "join", round: 6n, value: fresh.value });
  });

  test("first round when the key was never finalised", () => {
    expect(decide("MARK", { ...base, latestRound: 0n, latestUpdatedAt: 0 }, fresh, NOW)).toMatchObject({ reason: "first", round: 1n });
  });

  test("never votes twice in a round; refreshes only after the heartbeat", () => {
    const voted = { ...base, openVotes: 1, iVoted: true };
    expect(decide("MARK", { ...voted, myVoteAt: NOW - 60 }, fresh, NOW)).toEqual({ action: "skip", reason: "voted" });
    expect(decide("MARK", { ...voted, myVoteAt: null }, fresh, NOW)).toEqual({ action: "skip", reason: "voted" });
    expect(decide("MARK", { ...voted, myVoteAt: NOW - 61 }, fresh, NOW)).toMatchObject({ action: "vote", reason: "refresh" });
  });

  test("a voter calls finalize once m votes are in (not in a first round, not with too few votes)", () => {
    const voted = { ...base, iVoted: true, myVoteAt: NOW - 10 };
    expect(decide("MARK", { ...voted, openVotes: 2 }, fresh, NOW)).toEqual({ action: "finalize" });
    expect(decide("MARK", { ...voted, openVotes: 1 }, fresh, NOW)).toEqual({ action: "skip", reason: "voted" });
    expect(decide("MARK", { ...voted, openVotes: 2, latestRound: 0n }, fresh, NOW)).toEqual({ action: "skip", reason: "voted" });
    expect(decide("MARK", { ...voted, openVotes: 2, myVoteAt: null }, null, NOW)).toEqual({ action: "finalize" }); // needs no reading
    // a stale own vote is refreshed rather than finalised (the refresh vote drops it and may finalise)
    expect(decide("MARK", { ...voted, openVotes: 2, myVoteAt: NOW - 61 }, fresh, NOW)).toMatchObject({ action: "vote", reason: "refresh" });
  });

  test("never votes a missing, zero, stale or future reading", () => {
    expect(decide("MARK", base, null, NOW)).toEqual({ action: "skip", reason: "no-reading" });
    expect(decide("MARK", base, { value: 0n, at: NOW }, NOW)).toEqual({ action: "skip", reason: "zero-reading" });
    expect(decide("MARK", base, { value: 1n, at: NOW - 11 }, NOW)).toEqual({ action: "skip", reason: "stale-reading" });
    expect(decide("MARK", base, { value: 1n, at: NOW + 6 }, NOW)).toEqual({ action: "skip", reason: "stale-reading" });
    const vol = { ...base, heartbeat: 900, latestUpdatedAt: NOW - 300 };
    expect(decide("VOL", vol, { value: 1n, at: NOW - 600 }, NOW).action).toBe("vote");
    expect(decide("VOL", vol, { value: 1n, at: NOW - 601 }, NOW)).toEqual({ action: "skip", reason: "stale-reading" });
  });
});
