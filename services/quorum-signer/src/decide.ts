/// What a signer does for one board key on one tick. Pure: every input is passed in.

export type Kind = "MARK" | "VOL" | "EQUITY";

/// Cadence: a new round is started once the last final value is this old. MARK heartbeat on the board is 60 s,
/// VOL 15 min, so a round started on cadence has time to finalise before the value goes stale.
export const CADENCE: Record<Kind, number> = { MARK: 20, VOL: 300, EQUITY: 3600 }; // EQUITY: posted hourly (M3)

/// Oldest source reading a signer may vote. A reading older than this is skipped, never voted.
export const MAX_READING_AGE: Record<Kind, number> = { MARK: 10, VOL: 600, EQUITY: 120 };

export type KeyState = {
  latestRound: bigint; // 0n when the key has never been finalised
  latestUpdatedAt: number; // seconds; 0 when none
  openVotes: number; // votes held in the open round (stale ones included until dropped)
  iVoted: boolean; // this signer has a vote in the open round
  myVoteAt: number | null; // when this signer last voted in the open round, if known to this process
  heartbeat: number; // the key's heartbeat on the board, seconds
  quorum: number; // m: votes needed, with the window, to finalise without all n
};

export type Reading = { value: bigint; at: number } | null;

export type Decision =
  | { action: "vote"; reason: "join" | "start" | "first" | "refresh"; round: bigint; value: bigint }
  | { action: "finalize" }
  | { action: "skip"; reason: "voted" | "fresh" | "no-reading" | "stale-reading" | "zero-reading" };

export function decide(kind: Kind, s: KeyState, reading: Reading, now: number): Decision {
  const round = s.latestRound + 1n;

  let reason: "join" | "start" | "first" | "refresh";
  if (s.iVoted) {
    // The board drops a vote older than the heartbeat when the next vote arrives, so this signer may vote again.
    // After a restart the time of our vote is unknown: wait a full heartbeat from start before refreshing.
    if (s.myVoteAt === null || now - s.myVoteAt <= s.heartbeat) {
      // With at least m votes in, the round can be finalised once the board's window has passed. The board only
      // checks the window on a vote or a finalize call, so a voter calls finalize itself (simulated first: it is
      // sent only when the board would accept it). Without this, 2 of 3 would never finalise.
      if (s.openVotes >= s.quorum && s.latestRound > 0n) return { action: "finalize" };
      return { action: "skip", reason: "voted" };
    }
    reason = "refresh";
  } else if (s.openVotes > 0) {
    reason = "join";
  } else if (s.latestRound === 0n) {
    reason = "first";
  } else if (now - s.latestUpdatedAt >= CADENCE[kind]) {
    reason = "start";
  } else {
    return { action: "skip", reason: "fresh" };
  }

  if (reading === null) return { action: "skip", reason: "no-reading" };
  if (reading.value <= 0n) return { action: "skip", reason: "zero-reading" };
  if (now - reading.at > MAX_READING_AGE[kind] || reading.at > now + 5) return { action: "skip", reason: "stale-reading" };
  return { action: "vote", reason, round, value: reading.value };
}
