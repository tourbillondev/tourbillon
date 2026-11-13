import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import type { Op } from "./events.ts";

/// The indexer's Postgres layer (owner D3). Bun's built-in client: no dependency. Each block range is written in one
/// transaction together with its cursor, so a crash or restart never applies an event twice or skips one.

export type Db = SQL;

export function connect(url: string): Db {
  return new SQL(url);
}

export async function migrate(db: Db): Promise<void> {
  await db.unsafe(readFileSync(join(import.meta.dir, "schema.sql"), "utf8"));
}

export async function cursor(db: Db, name: string): Promise<bigint | null> {
  const rows = await db`SELECT next_block FROM cursors WHERE name = ${name}`;
  return rows.length ? BigInt(rows[0].next_block) : null;
}

export type SeriesTerms = { market: string; shape: boolean; legs: { isCall: boolean; k: string; qty: string }[]; movement: { tempo: string; weight: string }[] };

/// Applies one block range: the row operations, the series terms they need, and the cursor, atomically.
export async function apply(db: Db, name: string, nextBlock: bigint, ops: Op[], terms: Map<string, SeriesTerms>): Promise<void> {
  await db.begin(async (tx) => {
    for (const [id, t] of terms) {
      await tx`INSERT INTO series (id, market, shape, legs_json, movement) VALUES (${id}, ${t.market}, ${t.shape}, ${JSON.stringify(t.legs)}::text::jsonb, ${JSON.stringify(t.movement)}::text::jsonb) ON CONFLICT (id) DO NOTHING`;
    }
    for (const o of ops) {
      if (o.t === "sample") {
        await tx`INSERT INTO samples (market, level, t, s_wad, sigma_bps) VALUES (${o.market}, ${o.level}, ${o.at.toString()}, ${o.sWad.toString()}, ${Number(o.sigmaBps)}) ON CONFLICT DO NOTHING`;
      } else if (o.t === "vote") {
        await tx`INSERT INTO board_votes (key, round, signer, value, ts) VALUES (${o.key}, ${o.round.toString()}, ${o.signer}, ${o.value.toString()}, ${o.ts.toString()})
                 ON CONFLICT (key, round, signer) DO UPDATE SET value = EXCLUDED.value, ts = EXCLUDED.ts, dropped = false`;
      } else if (o.t === "drop") {
        await tx`UPDATE board_votes SET dropped = true WHERE key = ${o.key} AND round = ${o.round.toString()} AND signer = ${o.signer}`;
      } else if (o.t === "final") {
        await tx`INSERT INTO board_finals (key, round, median, published, votes, ts) VALUES (${o.key}, ${o.round.toString()}, ${o.median.toString()}, ${o.published.toString()}, ${Number(o.votes)}, ${o.ts.toString()}) ON CONFLICT DO NOTHING`;
      } else {
        const id = o.id.toString();
        const s = terms.get(id) ?? (await tx`SELECT market, legs_json, movement FROM series WHERE id = ${id}`).map((r: { market: string; legs_json: unknown; movement: unknown }) => ({ market: r.market, legs: r.legs_json, movement: r.movement }))[0];
        if (!s) throw new Error(`indexer: no terms for series ${id}`);
        const market = o.market ?? s.market;
        await tx`INSERT INTO positions (id, owner, held, market, legs_json, tempo_or_movement, raw, norm, last_accrual)
                 VALUES (${id}, ${o.owner}, ${o.held}, ${market}, ${JSON.stringify(s.legs)}::text::jsonb, ${JSON.stringify(s.movement)}::text::jsonb, ${o.delta.toString()}, ${(o.norm ?? 0n).toString()}, ${o.ts.toString()})
                 ON CONFLICT (id, owner, held) DO UPDATE SET
                   raw = GREATEST(positions.raw + ${o.delta.toString()}::numeric, 0),
                   norm = CASE WHEN ${(o.norm ?? -1n).toString()}::numeric >= 0 THEN ${(o.norm ?? 0n).toString()}::numeric ELSE positions.norm END,
                   last_accrual = EXCLUDED.last_accrual`;
      }
    }
    await tx`INSERT INTO cursors (name, next_block) VALUES (${name}, ${nextBlock.toString()}) ON CONFLICT (name) DO UPDATE SET next_block = EXCLUDED.next_block`;
  });
}

export async function labelKeys(db: Db, keys: { key: string; market: string; kind: string }[]): Promise<void> {
  for (const k of keys) await db`INSERT INTO board_keys (key, market, kind) VALUES (${k.key}, ${k.market}, ${k.kind}) ON CONFLICT (key) DO NOTHING`;
}
