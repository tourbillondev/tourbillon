import { readFileSync } from "node:fs";
import { createPublicClient, formatEther, getAddress, http, parseAbi, parseEventLogs, type Address, type Hex, type PublicClient } from "viem";
import { chainFor } from "@tourbillon/common/chain.ts";
import { log } from "@tourbillon/common/log.ts";
import { apply, connect, cursor, labelKeys, migrate, type Db, type SeriesTerms } from "./db.ts";
import { boardKeys, eventsAbi, marketName, opsFor, type Op } from "./events.ts";

/// The indexer (launch core): reads the chain's events into Postgres (Backend spec section 8): the book's price path
/// (`samples`), the board's votes and finals (`board_votes`, `board_finals`), and who holds what (`positions`: held
/// directly or in the AgentRouter sub-account). The API reads these tables. Read-only on the chain; no key.
///   DATABASE_URL=postgres://… bun src/main.ts --deployment <m7.json> [--rpc URL] [--confirmations 0] [--tick-seconds 10] [--once]
/// The database URL comes from the environment only (it may carry a password); it is never logged.

const bookAbi = parseAbi([
  "struct Leg { bool isCall; uint128 kWad; int128 qty; }",
  "struct Part { uint256 tempo; uint256 weight; }",
  "function isShape(uint256) view returns (bool)",
  "function shapeOf(uint256) view returns (bytes32 name, Leg[] legs, Part[] movement)",
  "function seriesOf(uint256) view returns (bytes32 name, bool isCall, uint128 kWad, Part[] movement)",
]);
const poolAbi = parseAbi(["function equityKey() view returns (bytes32)"]);

export type Dep = { chainId: number; book: Address; board: Address; engine: Address; agents: Address | null; pool: Address; markets: string[]; deployBlock: bigint };

export function loadDep(path: string): Dep {
  const d = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const need = (k: string) => {
    if (typeof d[k] !== "string") throw new Error(`deployment: missing ${k}`);
    return getAddress(d[k] as string);
  };
  return {
    chainId: Number(d.chainId),
    book: need("PathFundingBook"),
    board: need("QuorumBoard"),
    engine: need("Engine"),
    agents: typeof d.AgentRouter === "string" ? getAddress(d.AgentRouter) : null,
    pool: need("MainspringPool"),
    markets: d.markets as string[],
    deployBlock: BigInt(Number(d.deployBlock ?? 0)),
  };
}

export async function termsOf(client: PublicClient, book: Address, id: bigint): Promise<SeriesTerms> {
  const r = <T>(functionName: string) => client.readContract({ address: book, abi: bookAbi, functionName, args: [id] } as never) as Promise<T>;
  if (await r<boolean>("isShape")) {
    const [name, legs, mv] = await r<readonly [Hex, readonly { isCall: boolean; kWad: bigint; qty: bigint }[], readonly { tempo: bigint; weight: bigint }[]]>("shapeOf");
    return { market: marketName(name), shape: true, legs: legs.map((l) => ({ isCall: l.isCall, k: formatEther(l.kWad), qty: formatEther(l.qty) })), movement: mv.map((p) => ({ tempo: p.tempo.toString(), weight: formatEther(p.weight) })) };
  }
  const [name, isCall, kWad, mv] = await r<readonly [Hex, boolean, bigint, readonly { tempo: bigint; weight: bigint }[]]>("seriesOf");
  return { market: marketName(name), shape: false, legs: [{ isCall, k: formatEther(kWad), qty: "1" }], movement: mv.map((p) => ({ tempo: p.tempo.toString(), weight: formatEther(p.weight) })) };
}

const CURSOR = "chain";
const CHUNK = 2000n;

/// One pass: every block range from the cursor to the latest (minus confirmations), each in its own transaction.
export async function indexOnce(client: PublicClient, db: Db, d: Dep, confirmations = 0n): Promise<{ blocks: bigint; ops: number }> {
  const head = (await client.getBlockNumber()) - confirmations;
  let from = (await cursor(db, CURSOR)) ?? d.deployBlock;
  const watched = [d.book, d.board, d.engine, ...(d.agents ? [d.agents] : [])];
  const known = new Set<string>();
  let ops = 0;
  const start = from;
  while (from <= head) {
    const to = from + CHUNK - 1n < head ? from + CHUNK - 1n : head;
    const logs = await client.getLogs({ address: watched, fromBlock: from, toBlock: to });
    const ts = new Map<bigint, bigint>();
    const batch: Op[] = [];
    for (const l of parseEventLogs({ abi: eventsAbi, logs, strict: false }).sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex)) {
      if (!ts.has(l.blockNumber)) ts.set(l.blockNumber, (await client.getBlock({ blockNumber: l.blockNumber })).timestamp);
      batch.push(...opsFor({ eventName: l.eventName, args: l.args as Record<string, unknown> }, ts.get(l.blockNumber)!, d.agents));
    }
    const terms = new Map<string, SeriesTerms>();
    for (const o of batch) {
      if (o.t !== "position") continue;
      const id = o.id.toString();
      if (known.has(id) || terms.has(id)) continue;
      const have = await db`SELECT 1 FROM series WHERE id = ${id}`;
      if (have.length) known.add(id);
      else terms.set(id, await termsOf(client, d.book, o.id));
    }
    await apply(db, CURSOR, to + 1n, batch, terms);
    ops += batch.length;
    from = to + 1n;
  }
  return { blocks: from - start, ops };
}

function parseArgs(argv: string[]) {
  const a = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (k === "--once") a.set("once", true);
    else if (k.startsWith("--")) a.set(k.slice(2), argv[++i] ?? "");
    else throw new Error(`unexpected argument ${k}`);
  }
  for (const k of a.keys()) if (!["deployment", "rpc", "confirmations", "tick-seconds", "once"].includes(k)) throw new Error(`unknown flag --${k}`);
  if (typeof a.get("deployment") !== "string") throw new Error("--deployment is required");
  return { deployment: a.get("deployment") as string, rpc: a.get("rpc") as string | undefined, confirmations: BigInt(Number(a.get("confirmations") ?? 0)), tickS: Math.max(1, Number(a.get("tick-seconds") ?? 10)), once: a.has("once") };
}

if (import.meta.main) {
  const cfg = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const d = loadDep(cfg.deployment);
  const client = createPublicClient({ chain: chainFor(d.chainId), transport: http(cfg.rpc) }) as PublicClient;
  if ((await client.getChainId()) !== d.chainId) throw new Error("the RPC is not the deployment's chain");
  const db = connect(url);
  await migrate(db);
  const equityKey = await client.readContract({ address: d.pool, abi: poolAbi, functionName: "equityKey" }).catch(() => null);
  await labelKeys(db, boardKeys(d.markets, equityKey));
  log("info", "started", { chainId: d.chainId, markets: d.markets, confirmations: cfg.confirmations.toString() });
  let stopping = false;
  process.on("SIGINT", () => (stopping = true));
  process.on("SIGTERM", () => (stopping = true));
  while (!stopping) {
    try {
      const r = await indexOnce(client, db, d, cfg.confirmations);
      if (r.ops > 0) log("info", "indexed", { blocks: r.blocks.toString(), ops: r.ops });
    } catch (e) {
      log("error", "pass failed", { error: (e as Error).message.split("\n")[0] });
    }
    if (cfg.once) break;
    for (let i = 0; i < cfg.tickS && !stopping; i++) await Bun.sleep(1000);
  }
  await db.close();
  log("info", "stopped");
}
