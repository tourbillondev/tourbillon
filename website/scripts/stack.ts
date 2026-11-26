import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { startLocalM7, type LocalM7 } from "../../services/common/src/localM7.ts";
import { startLocalPg, type LocalPg } from "../../services/common/src/localPg.ts";
import { connect, migrate, type Db } from "../../services/indexer/src/db.ts";
import { indexOnce, loadDep as loadIndexerDep } from "../../services/indexer/src/main.ts";
import { loadDep, makeReads } from "../../services/api/src/chain.ts";
import { makeApi, type PositionRow } from "../../services/api/src/server.ts";
import { checkManifest } from "../src/live/manifest.mjs";

/// LOCAL ONLY: the live site's whole back end on this computer. A fresh anvil with the M7 system (marks, vols and an
/// LP round from the services' own local helper), a throwaway Postgres fed by the indexer every second, the API v1
/// served on a local port, and the deployment manifest the site reads. Anvil's unlocked accounts; no key anywhere.

export type Stack = {
  L: LocalM7;
  pg: LocalPg;
  db: Db;
  apiUrl: string;
  manifest: Record<string, unknown>;
  /// marks and vols voted again (the router refuses stale marks), and each market sampled
  freshen(prices?: Record<string, string>): Promise<void>;
  stop(): Promise<void>;
};

export const PRICES = { BTC: "74000", ETH: "2000", STK1: "40" };

export async function startStack(port: number, prices: Record<string, string> = PRICES): Promise<Stack> {
  const L = await startLocalM7(port, prices);
  const pg = await startLocalPg(port + 1000);
  const db = connect(pg.url);
  await migrate(db);
  const client = createPublicClient({ chain: foundry, transport: http(L.rpc), pollingInterval: 200 }) as PublicClient;
  const idep = loadIndexerDep(L.m7File);
  let indexing = true;
  let lastError = "";
  const loop = (async () => {
    while (indexing) {
      await indexOnce(client, db, idep).catch((e) => {
        const m = String(e?.message ?? e);
        if (m !== lastError) console.error(`local indexer: ${m}`); // each new error once, so a lag has a visible reason
        lastError = m;
      });
      await Bun.sleep(500);
    }
  })();
  const dep = loadDep(L.m7File);
  const api = makeApi({
    dep,
    reads: makeReads(client, dep),
    positionsOf: async (owner: Address) => (await db`SELECT id::text, owner, held, market, legs_json, tempo_or_movement, raw::text FROM positions WHERE owner = ${owner} AND raw > 0 ORDER BY id`) as PositionRow[],
    now: async () => (await client.getBlock()).timestamp,
  }, { perMinute: 100_000 });
  const server = Bun.serve({ hostname: "127.0.0.1", port: port + 2000, fetch: (req, srv) => api.fetch(req, srv) });
  const apiUrl = `http://127.0.0.1:${server.port}`;
  const m7 = L.m7 as Record<string, unknown>;
  const manifest = {
    version: 1,
    chainId: 31337,
    networkName: "Local test chain (anvil)",
    rpcUrl: L.rpc,
    apiUrl,
    explorerUrl: "",
    deployBlock: String(m7.deployBlock ?? 0),
    contracts: Object.fromEntries(["Engine", "OpenBook", "WriterBook", "PathFundingBook", "MainspringPool", "MarkRouter", "SettlementToken"].map((k) => [k, m7[k]])),
    settlement: { symbol: String(m7.settlementSymbol), decimals: Number(m7.settlementDecimals) },
    markets: m7.markets as string[],
  };
  checkManifest(manifest);
  const poke = ["function poke(bytes32) returns (bool, bool, bool)"] as const;
  const { parseAbi } = await import("viem");
  const { b32 } = await import("../../services/common/src/localM7.ts");
  return {
    L,
    pg,
    db,
    apiUrl,
    manifest,
    async freshen(px = prices) {
      await L.vote(px);
      for (const m of Object.keys(px)) await L.send(L.acc[0]!, L.m7.PathFundingBook!, parseAbi(poke), "poke", [b32(m)]).catch(() => {});
    },
    async stop() {
      indexing = false;
      await loop;
      server.stop(true);
      await db.close();
      pg.stop();
      L.stop();
    },
  };
}
