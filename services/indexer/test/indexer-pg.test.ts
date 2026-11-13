import { afterAll, beforeAll, expect, test } from "bun:test";
import { parseAbi, type PublicClient } from "viem";
import { b32, haveFoundry, startLocalM7, type LocalM7 } from "@tourbillon/common/localM7.ts";
import { havePostgres, startLocalPg, type LocalPg } from "@tourbillon/common/localPg.ts";
import { connect, migrate, labelKeys, type Db } from "../src/db.ts";
import { boardKeys } from "../src/events.ts";
import { indexOnce, loadDep } from "../src/main.ts";

// On a local anvil with DeployM7 and a throwaway Postgres: trades, then the indexer fills samples, board votes and
// finals (labelled by market and kind) and positions equal to the book's balances; a second pass changes nothing; a
// partial sell later moves the position by exactly the raw sold. Skipped without anvil/forge or Postgres.
const ok = haveFoundry() && havePostgres();
const PORT = 28545 + Math.floor(Math.random() * 1000);
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
  "function sell(uint256, uint256, uint256, uint256) returns (uint256, uint256)",
  "function balanceOf(uint256, address) view returns (uint256)",
  "function equityKey() view returns (bytes32)",
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
  "samples, votes and finals, and positions equal to the book's balances; idempotent; follows a partial sell",
  async () => {
    const { acc, m7, client, send } = L!;
    const T = acc[16]!;
    await send(T, m7.MockUSDC!, abi, "mint", [T, 1_000_000n * 10n ** 6n]);
    await send(T, m7.MockUSDC!, abi, "approve", [m7.Engine!, 1_000_000n * 10n ** 6n]);
    const legs = [
      { isCall: true, kWad: 74_000n * W, qty: W },
      { isCall: true, kWad: 76_000n * W, qty: -W },
    ];
    const deadline = (await client.getBlock()).timestamp + 3600n;
    await send(T, m7.OpenBook!, abi, "buy", [b32("BTC"), legs, [{ tempo: 86_400n, weight: W }], 3n * W, 10n ** 12n, deadline, [], [], []]);
    const d = loadDep(L!.m7File);
    const equityKey = await client.readContract({ address: d.pool, abi, functionName: "equityKey" });
    await labelKeys(db!, boardKeys(d.markets, equityKey));
    const first = await indexOnce(client as PublicClient, db!, d);
    expect(first.ops).toBeGreaterThan(0);

    const samples = await db!`SELECT market, count(*)::int AS n FROM samples GROUP BY market ORDER BY market`;
    expect(samples.map((r: { market: string }) => r.market)).toEqual(["BTC", "ETH", "HYPE"]);
    const finals = await db!`SELECT k.market, k.kind, count(*)::int AS n FROM board_finals f JOIN board_keys k ON k.key = f.key GROUP BY k.market, k.kind ORDER BY 1, 2`;
    expect(finals.length).toBe(6); // MARK and VOL for three markets
    const votes = await db!`SELECT count(DISTINCT signer)::int AS n FROM board_votes`;
    expect(votes[0].n).toBe(3);
    const pos = await db!`SELECT id, owner, held, raw, market, legs_json FROM positions WHERE raw > 0`;
    expect(pos.length).toBe(1);
    expect(pos[0].owner).toBe(T);
    expect(pos[0].held).toBe("direct");
    expect(pos[0].market).toBe("BTC");
    expect(pos[0].legs_json.length).toBe(2);
    const id = BigInt(pos[0].id);
    expect(BigInt(pos[0].raw)).toBe(await client.readContract({ address: d.book, abi, functionName: "balanceOf", args: [id, T] }));

    // a second pass from the cursor: nothing new, nothing doubled
    const again = await indexOnce(client as PublicClient, db!, d);
    expect(again.ops).toBe(0);
    expect((await db!`SELECT count(*)::int AS n FROM positions`)[0].n).toBe(1);

    // a partial sell moves the position by exactly the raw sold
    await send(T, m7.Engine!, abi, "sell", [id, W, 0n, deadline + 3600n]);
    await indexOnce(client as PublicClient, db!, d);
    const after = await db!`SELECT raw FROM positions WHERE id = ${id.toString()} AND owner = ${T}`;
    expect(BigInt(after[0].raw)).toBe(await client.readContract({ address: d.book, abi, functionName: "balanceOf", args: [id, T] }));
  },
  240_000,
);
