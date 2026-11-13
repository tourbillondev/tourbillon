import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { SQL } from "bun";
import { chainFor } from "@tourbillon/common/chain.ts";
import { log } from "@tourbillon/common/log.ts";
import { loadDep, makeReads } from "./chain.ts";
import { makeApi, type PositionRow } from "./server.ts";

/// The public API v1 (launch core). Reads the chain and the indexer's Postgres; no key.
///   DATABASE_URL=postgres://… bun src/main.ts --deployment <m7.json> [--rpc URL] [--port 8550] [--host 0.0.0.0]
///     [--gateway http://127.0.0.1:8547] [--receipts http://127.0.0.1:8548] [--per-minute 120] [--trust-proxy]
/// The database URL comes from the environment only and is never logged.

function parseArgs(argv: string[]) {
  const a = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (k === "--trust-proxy") a.set("trust-proxy", true);
    else if (k.startsWith("--")) a.set(k.slice(2), argv[++i] ?? "");
    else throw new Error(`unexpected argument ${k}`);
  }
  for (const k of a.keys()) if (!["deployment", "rpc", "port", "host", "gateway", "receipts", "per-minute", "trust-proxy"].includes(k)) throw new Error(`unknown flag --${k}`);
  if (typeof a.get("deployment") !== "string") throw new Error("--deployment is required");
  const s = (k: string) => (typeof a.get(k) === "string" ? (a.get(k) as string) : undefined);
  return { deployment: s("deployment")!, rpc: s("rpc"), port: Number(s("port") ?? 8550), host: s("host") ?? "127.0.0.1", gateway: s("gateway"), receipts: s("receipts"), perMinute: Number(s("per-minute") ?? 120), trustProxy: a.has("trust-proxy") };
}

if (import.meta.main) {
  const cfg = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const dep = loadDep(cfg.deployment);
  const client = createPublicClient({ chain: chainFor(dep.chainId), transport: http(cfg.rpc) }) as PublicClient;
  if ((await client.getChainId()) !== dep.chainId) throw new Error("the RPC is not the deployment's chain");
  const db = new SQL(url);
  const api = makeApi(
    {
      dep,
      reads: makeReads(client, dep),
      positionsOf: async (owner: Address) => (await db`SELECT id::text, owner, held, market, legs_json, tempo_or_movement, raw::text FROM positions WHERE owner = ${owner} AND raw > 0 ORDER BY id`) as PositionRow[],
      gatewayBest: cfg.gateway ? async (body) => (await fetch(new URL("/best", cfg.gateway), { method: "POST", body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), signal: AbortSignal.timeout(3000) })).json() : undefined,
      receiptsProof: cfg.receipts ? async (tx, li) => {
        const r = await fetch(new URL(`/proof?tx=${tx}&logIndex=${li}`, cfg.receipts), { signal: AbortSignal.timeout(5000) });
        return { status: r.status, body: await r.json() };
      } : undefined,
      now: async () => (await client.getBlock()).timestamp,
    },
    { perMinute: cfg.perMinute, trustProxy: cfg.trustProxy },
  );
  const server = Bun.serve({ hostname: cfg.host, port: cfg.port, fetch: (req, srv) => api.fetch(req, srv) });
  log("info", "started", { url: `http://${cfg.host}:${server.port}`, chainId: dep.chainId, perMinute: cfg.perMinute });
}
