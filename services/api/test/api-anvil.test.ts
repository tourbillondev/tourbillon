import { afterAll, beforeAll, expect, test } from "bun:test";
import { parseAbi, parseEventLogs, type PublicClient } from "viem";
import { b32, haveFoundry, startLocalM7, type LocalM7 } from "@tourbillon/common/localM7.ts";
import { havePostgres, startLocalPg, type LocalPg } from "@tourbillon/common/localPg.ts";
import { connect, migrate, type Db } from "../../indexer/src/db.ts";
import { indexOnce, loadDep as loadIndexerDep } from "../../indexer/src/main.ts";
import { loadDep, makeReads } from "../src/chain.ts";
import { makeApi, type PositionRow } from "../src/server.ts";

// On a local anvil with DeployM7 and a throwaway Postgres fed by the indexer: the API's status and markets reflect the
// chain; the buy quote equals the cost of the real buy that follows; positions equal the book's balances with live
// units. Skipped without anvil/forge or Postgres.
const ok = haveFoundry() && havePostgres();
const PORT = 29545 + Math.floor(Math.random() * 1000);
let L: LocalM7 | undefined;
let P: LocalPg | undefined;
let db: Db | undefined;

const abi = parseAbi([
  "struct Leg { bool isCall; uint128 kWad; int128 qty; }",
  "struct Part { uint256 tempo; uint256 weight; }",
  "struct Quote { address maker; bytes32 name; uint8 sides; uint128 kLoWad; uint128 kHiWad; uint32 tauLo; uint32 tauHi; uint64 sigmaBps; uint128 maxUnits; uint64 validUntil; uint64 nonce; }",
  "function mint(address, uint256)",
  "function approve(address, uint256) returns (bool)",
  "function buy(bytes32 market, Leg[] legs, Part[] movement, uint256 units, uint256 maxCost, uint256 deadline, Quote[] quotes, bytes[] sigs, uint256[] offerIds) returns (uint256, uint256, uint8)",
  "function balanceOf(uint256, address) view returns (uint256)",
  "function normNow(uint256) view returns (uint256)",
  "event Routed(address indexed buyer, uint256 indexed id, uint8 kind, uint256 sigmaBps, uint256 cost, address source)",
]);
const W = 10n ** 18n;

beforeAll(async () => {
  if (!ok) return;
  L = await startLocalM7(PORT);
  P = await startLocalPg(PORT + 1000);
  db = connect(P.url);
  await migrate(db);
}, 240_000);
afterAll(async () => {
  await db?.close();
  P?.stop();
  L?.stop();
});

test.skipIf(!ok)(
  "status, markets, chains; the quote equals the real buy's cost; positions with live units",
  async () => {
    const { acc, m7, client, send } = L!;
    const dep = loadDep(L!.m7File);
    const api = makeApi({
      dep,
      reads: makeReads(client as PublicClient, dep),
      positionsOf: async (owner) => (await db!`SELECT id::text, owner, held, market, legs_json, tempo_or_movement, raw::text FROM positions WHERE owner = ${owner} AND raw > 0 ORDER BY id`) as PositionRow[],
      now: async () => (await client.getBlock()).timestamp,
    });
    const get = async (p: string) => {
      const r = await api.fetch(new Request(`http://api${p}`));
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };

    const st = await get("/v1/status");
    expect(st.status).toBe(200);
    expect((st.body.pool as Record<string, unknown>).nav).toBe("5000000");
    expect((st.body.pool as Record<string, unknown>).covered).toBe(true);
    expect((st.body.markets as { markFresh: boolean }[]).every((m) => m.markFresh)).toBe(true);
    const mk = await get("/v1/markets");
    const btc = (mk.body.markets as Record<string, unknown>[]).find((m) => m.market === "BTC")!;
    expect(btc.mark).toBe("74000");
    expect(btc.spreadBps).toBe(200);
    const ch = await get("/v1/chains/BTC?strikes=2&tempos=86400");
    expect(((ch.body.chains as { rows: unknown[] }[])[0]!.rows).length).toBe(5);

    // the exact quote, then the real buy at the same state
    const q = await get("/v1/quote/buy?market=BTC&legs=call:74000:1,call:76000:-1&tempo=86400&units=2");
    if (q.body.quoted !== true) throw new Error(`quote: ${JSON.stringify(q.body)}`);
    expect(q.body.source).toBe("pool");
    const T = acc[16]!;
    await send(T, m7.MockUSDC!, abi, "mint", [T, 1_000_000n * 10n ** 6n]);
    await send(T, m7.MockUSDC!, abi, "approve", [m7.Engine!, 1_000_000n * 10n ** 6n]);
    const legs = [
      { isCall: true, kWad: 74_000n * W, qty: W },
      { isCall: true, kWad: 76_000n * W, qty: -W },
    ];
    const r = await send(T, m7.OpenBook!, abi, "buy", [b32("BTC"), legs, [{ tempo: 86_400n, weight: W }], 2n * W, 10n ** 12n, (await client.getBlock()).timestamp + 600n, [], [], []]);
    const routed = parseEventLogs({ abi, logs: r.logs, eventName: "Routed" })[0]!;
    expect(q.body.cost).toBe((Number(routed.args.cost) / 1e6).toString());
    const refused = await get("/v1/quote/buy?market=BTC&legs=call:74000:-1&tempo=86400&units=1");
    expect(refused.body.quoted).toBe(false); // a shape a buyer cannot hold

    // positions from the indexer, with live units
    await indexOnce(client as PublicClient, db!, loadIndexerDep(L!.m7File));
    const pos = await get(`/v1/positions/${T}`);
    const rows = pos.body.positions as { id: string; raw: string; units: string; held: string }[];
    expect(rows.length).toBe(1);
    const id = BigInt(rows[0]!.id);
    expect(BigInt(rows[0]!.raw)).toBe(await client.readContract({ address: dep.book, abi, functionName: "balanceOf", args: [id, T] }));
    expect(rows[0]!.held).toBe("direct");
    expect(BigInt(rows[0]!.units)).toBe((BigInt(rows[0]!.raw) * (await client.readContract({ address: dep.book, abi, functionName: "normNow", args: [id] }))) / W);
    expect((await get("/v1/receipts/proof?tx=0x" + "1".repeat(64) + "&logIndex=0")).status).toBe(503);
  },
  240_000,
);
