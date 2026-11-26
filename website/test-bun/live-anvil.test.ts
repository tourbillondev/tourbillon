import { afterAll, beforeAll, expect, test } from "bun:test";
import { TEARDOWN_MS, hookLimit, within } from "../../services/common/src/hooks.ts";
import { parseAbi, type Address } from "viem";
import { haveFoundry, b32 } from "../../services/common/src/localM7.ts";
import { havePostgres } from "../../services/common/src/localPg.ts";
import { startStack, type Stack } from "../scripts/stack.ts";
import { checkManifest } from "../src/live/manifest.mjs";
import { apiClient } from "../src/live/api.mjs";
import { liveChain } from "../src/live/chain.mjs";
import { runTrade } from "../src/live/tx.mjs";
import { movementParts, shapeLegs, singleTempo, toWad, writerCollateral } from "../src/live/codec.mjs";

// The live site's own code (manifest check, API client, chain module, transaction machine) against the real back end
// on a local anvil: the deployment cross-check, a buy, a sale and a write each reconciled from events and the API's
// positions; a Movement; refusals by name; and law 3: with the market's opens paused, the buy is refused and the sale
// still pays. The wallet is a stand-in that forwards to anvil's unlocked account (no key). Skipped without
// anvil/forge or Postgres.
const ok = haveFoundry() && havePostgres();
const PORT = 31545 + Math.floor(Math.random() * 1000);
let S: Stack | undefined;

const wallet = (rpcCall: Stack["L"]["rpcCall"], account: Address, chainHex = "0x7a69") => ({
  request: async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [account];
    if (method === "eth_chainId") return chainHex;
    if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
    return rpcCall(method, params ?? []);
  },
});

beforeAll(within(import.meta.path, "setup", 300_000, async () => {
  if (!ok) return;
  S = await startStack(PORT);
}), hookLimit(300_000));
afterAll(within(import.meta.path, "teardown", TEARDOWN_MS, async () => {
  await S?.stop();
}), hookLimit(TEARDOWN_MS));

const untilApi = async (api: ReturnType<typeof apiClient>, owner: Address, test: (rows: { id: bigint }[]) => boolean) => {
  // the indexer follows the chain; on a loaded machine it can lag well behind, so wait up to 90 s (a time limit only)
  for (let i = 0; i < 180; i++) {
    if (test(await api.positions(owner))) return true;
    await Bun.sleep(500);
  }
  return false;
};

test.skipIf(!ok)(
  "the deployment cross-check, then buy, sell and write reconciled; a Movement; refusals by name; law 3 with opens paused",
  async () => {
    const { L } = S!;
    const m = checkManifest(S!.manifest);
    const api = apiClient(m.apiUrl);
    const chain = liveChain(m);
    const status = await api.status();
    expect(await chain.verify(status)).toEqual([]);
    // a manifest naming another token is caught before anything is shown as live
    expect((await liveChain({ ...m, contracts: { ...m.contracts, SettlementToken: m.contracts.Engine } }).verify(status)).length).toBeGreaterThan(0);

    const T = L.acc[16]!;
    await L.send(T, m.contracts.SettlementToken as Address, parseAbi(["function mint(address, uint256)"]), "mint", [T, 1_000_000n * 10n ** 6n]);
    const provider = wallet(L.rpcCall, T);
    const auto = async () => true;
    const states: string[] = [];
    const seen = (s: string) => states.push(s);

    // 1. a buy: the API's exact quote is the limit; reconciled once the chain and the API show the position
    const legs = shapeLegs("Spread", "74000", "2000");
    const units = toWad("2");
    const q = await api.quoteBuy({ market: "BTC", legs, tempo: 86400, units }, 6);
    expect(q.quoted).toBe(true);
    const b = chain.buy({ provider, account: T, market: "BTC", legs, movement: singleTempo(1), units, limit: q.cost!, confirm: auto, positionsAgree: (id: bigint) => untilApi(api, T, (rows) => rows.some((r) => r.id === id)) });
    const rb = await runTrade(b.plan, b.io, seen);
    expect(rb.state).toBe("reconciled");
    expect(states).toEqual(["preparing", "needs-approval", "approving", "preparing", "ready-for-review", "awaiting-wallet", "submitted", "confirming", "confirmed", "reconciled"]);
    expect(rb.result.cost).toBe(q.cost); // the quote was exact at that state
    const id = rb.result.id as bigint;
    expect((await api.positions(T)).some((p) => p.id === id)).toBe(true);

    // 2. a Movement buy (no API quote for a Movement: the limit is generous and the review shows the exact cost)
    const mv = movementParts([{ days: 1, percent: 50 }, { days: 7, percent: 50 }]);
    const bm = chain.buy({ provider, account: T, market: "ETH", legs: shapeLegs("Rise", "2000", ""), movement: mv, units: toWad("1"), limit: 1_000n * 10n ** 6n, confirm: auto });
    const rm = await runTrade(bm.plan, bm.io, () => {});
    expect(rm.state).toBe("reconciled");
    expect(rm.result.cost).toBeLessThanOrEqual(1_000n * 10n ** 6n);

    // 3. a write: the collateral locked is exactly what the site computed and approved
    const wl = shapeLegs("Spread", "74000", "2000", "write");
    const wb = shapeLegs("Spread", "74000", "2000", "buy");
    const w = chain.write({ provider, account: T, market: "BTC", buyerLegs: wb, writerLegs: wl, movement: singleTempo(7), units: toWad("1"), confirm: auto });
    expect(w.collateral).toBe(writerCollateral(wb, toWad("1"), 6)!.locked);
    const rw = await runTrade(w.plan, w.io, () => {});
    expect(rw.state).toBe("reconciled");
    expect(rw.result.locked).toBe(w.collateral);
    expect((await chain.writesOf(T)).map((x: { writeId: bigint }) => x.writeId)).toContain(rw.result.writeId);
    // an unbounded write is refused before anything is asked
    expect(() => chain.write({ provider, account: T, market: "BTC", buyerLegs: shapeLegs("Rise", "74000", ""), writerLegs: shapeLegs("Rise", "74000", "", "write"), movement: singleTempo(7), units: toWad("1"), confirm: auto })).toThrow(/no bounded worst case/);

    // 4. refusals by name, before the wallet is asked: a strike off the step
    const off = chain.buy({ provider, account: T, market: "BTC", legs: shapeLegs("Rise", "74000.5", ""), movement: singleTempo(1), units, limit: 10n ** 12n, confirm: auto });
    const ro = await runTrade(off.plan, off.io, () => {});
    expect(ro.state).toBe("failed");
    expect(ro.reason).toMatch(/strike/i);

    // 5. law 3: the risk key pauses opens on BTC; a buy is refused by name, the sale still pays
    await L.send(L.acc[9]!, m.contracts.MainspringPool as Address, parseAbi(["function pauseMarket(bytes32)"]), "pauseMarket", [b32("BTC")]);
    const paused = chain.buy({ provider, account: T, market: "BTC", legs, movement: singleTempo(1), units, limit: q.cost!, confirm: auto });
    const rp = await runTrade(paused.plan, paused.io, () => {});
    expect(rp.state).toBe("failed");
    expect(rp.reason).toMatch(/Selling still works|paused|No source/i);
    const sale = await chain.saleValue(T, id);
    expect(sale).toBeGreaterThan(0n);
    const s = chain.sell({ provider, account: T, id, confirm: auto, positionsAgree: (pid: bigint) => untilApi(api, T, (rows) => !rows.some((r) => r.id === pid)) });
    const rs = await runTrade(s.plan, s.io, () => {});
    expect(rs.state).toBe("reconciled");
    expect(rs.result.net).toBeGreaterThan(0n);
    expect((await api.positions(T)).some((p) => p.id === id)).toBe(false);

    // 6. a wallet on another chain is asked to switch; one that cannot is stopped before any review
    const elsewhere = wallet(L.rpcCall, T, "0x1");
    const x = chain.sell({ provider: { ...elsewhere, request: async (a: { method: string; params?: unknown[] }) => (a.method === "wallet_switchEthereumChain" ? Promise.reject({ code: 4001 }) : elsewhere.request(a)) }, account: T, id: rm.result.id, confirm: auto });
    expect((await runTrade(x.plan, x.io, () => {})).state).toBe("rejected");
  },
  300_000,
);
