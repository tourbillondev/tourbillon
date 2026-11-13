import { expect, test } from "bun:test";
import type { PublicClient } from "viem";
import { formatReport, Monitor, phaseReport, quantile } from "../src/monitor.ts";

const A = "0x00000000000000000000000000000000000000a1" as const;
const B = "0x00000000000000000000000000000000000000b2" as const;
const dep = { chainId: 31337, board: A, router: B, markets: ["BTC"], signers: [A, B] };

test("quantile", () => {
  expect(quantile([], 0.5)).toBeNull();
  expect(quantile([30, 10, 20], 0.5)).toBe(20);
  expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
});

test("phase report: finals, intervals, 2-vote finals, clamp hits, freshness, gas and failed transactions", () => {
  const m = new Monitor({} as PublicClient, dep, [A, B]);
  const K = "0xkey";
  for (const [t, votes, med, pub] of [
    [100, 3, 5n, 5n],
    [130, 3, 6n, 6n],
    [170, 2, 9n, 7n], // clamped
    [500, 3, 7n, 7n], // outside the phase
  ] as const) {
    m.events.push({ type: "Finalised", t, key: K, round: 1n, median: med, published: pub, votes, tx: `0x${t}` });
  }
  m.events.push({ type: "VoteDropped", t: 150, key: K, round: 3n, signer: A, tx: "0xd" });
  m.txs.set("0x100", { hash: "0x100", t: 100, from: A, gasUsed: 150_000n, voted: true, finalised: true });
  m.txs.set("0x120", { hash: "0x120", t: 120, from: A, gasUsed: 100_000n, voted: true, finalised: false });
  m.txs.set("0x170", { hash: "0x170", t: 170, from: B, gasUsed: 60_000n, voted: false, finalised: true });
  const s = (t: number, r: string, nA: number, nB: number) =>
    m.samples.push({ t, router: { BTC: r }, markAge: { BTC: 10 }, volAge: { BTC: 100 }, nonces: { [A]: nA, [B]: nB } });
  s(90, "fresh", 0, 0);
  s(110, "fresh", 1, 0);
  s(140, "Stale", 2, 0);
  s(180, "fresh", 3, 1); // A sent 3, only 2 landed: 1 failed

  const r = phaseReport(m, { name: "x", start: 95, end: 200 });
  const k = r.keys[K]!;
  expect(k.finals).toBe(3);
  expect([k.p50, k.max]).toEqual([30, 40]);
  expect(k.twoVoteFinals).toBe(1);
  expect(k.clampHits).toBe(1);
  expect(r.droppedVotes).toBe(1);
  expect(r.markets.BTC).toMatchObject({ polls: 3, fresh: 2, firstNotFresh: 45 });
  expect(r.allFreshAfter).toBe(15);
  expect(r.signers[A]).toMatchObject({ votes: 2, finalizes: 0, txs: 2, failedTxs: 1, gas: 250_000n });
  expect(r.signers[B]).toMatchObject({ votes: 0, finalizes: 1, failedTxs: 0 });
  expect(r.gas).toEqual({ vote: [100_000], voteAndFinal: [150_000], finalizeOnly: [60_000] });
  expect(formatReport([r])).toContain("== x");
});
