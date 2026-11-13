import { parseEventLogs, type Address, type Log, type PublicClient } from "viem";
import { bookAbi, engineAbi, writerBookAbi } from "./abi.ts";

/// The walker keeps series with open positions within the book's 16-interval trade limit, so buys never hit
/// NotCaughtUp. A separate module so it can become the spec's accrual-walker service later.
///
/// - Series are found from the book's `Opened` and `ShapeOpened` events; open raw is tracked from the Engine's
///   `Bought` / `ShapeBought` / `Sold` events (raw minted and burned), which stay the same when MainspringPool replaces
///   HousePool, and from the WriterBook's `Written` / `Unwritten` events (M4: a write holds raw of its series too;
///   `Unwritten` names the write, so the write's series is remembered from `Written`).
/// - A series with open raw is due when its cursor is at least 8 intervals (8 × 5 min) behind the latest sample of
///   its market (time behind is an upper bound on intervals). It is walked 64 intervals per transaction, and again
///   on the next pass if still behind.
/// - A series nobody holds is not walked (owner decision); a buy on it may need someone to call the permissionless
///   accrue first.

export const DUE_BEHIND_S = 8 * 300;
export const STEPS_PER_TX = 64n;

export type Series = { id: bigint; market: `0x${string}`; openRaw: bigint };

export type BookEvent =
  | { kind: "opened"; id: bigint; market: `0x${string}` }
  | { kind: "bought"; id: bigint; raw: bigint }
  | { kind: "sold"; id: bigint; raw: bigint }
  | { kind: "written"; writeId: bigint; id: bigint; raw: bigint }
  | { kind: "unwritten"; writeId: bigint; raw: bigint };

/// Applies events in chain order to the series map. `writeSeries` remembers each write's series (from `Written`).
export function applyEvents(series: Map<bigint, Series>, events: BookEvent[], writeSeries = new Map<bigint, bigint>()): void {
  for (const e of events) {
    if (e.kind === "opened") {
      if (!series.has(e.id)) series.set(e.id, { id: e.id, market: e.market, openRaw: 0n });
      continue;
    }
    let id: bigint;
    let add: boolean;
    if (e.kind === "written") {
      writeSeries.set(e.writeId, e.id);
      id = e.id;
      add = true;
    } else if (e.kind === "unwritten") {
      const known = writeSeries.get(e.writeId);
      if (known === undefined) continue; // cannot happen: a write is made before it is unwritten
      id = known;
      add = false;
    } else {
      id = e.id;
      add = e.kind === "bought";
    }
    const s = series.get(id);
    if (!s) continue; // cannot happen: a series is opened before its first buy
    s.openRaw = add ? s.openRaw + e.raw : s.openRaw > e.raw ? s.openRaw - e.raw : 0n;
  }
}

/// Series with open raw whose cursor is at least DUE_BEHIND_S behind the latest sample of their market.
export function selectDue(
  series: Iterable<Series>,
  cursorAt: Map<bigint, number>,
  latestSampleT: Map<string, number>,
): Series[] {
  const due: Series[] = [];
  for (const s of series) {
    if (s.openRaw === 0n) continue;
    const at = cursorAt.get(s.id);
    const latest = latestSampleT.get(s.market);
    if (at === undefined || latest === undefined) continue;
    if (latest - at >= DUE_BEHIND_S) due.push(s);
  }
  return due;
}

/// Scans the book and Engine events incrementally and keeps the series map.
export class Walker {
  readonly series = new Map<bigint, Series>();
  private readonly writeSeries = new Map<bigint, bigint>();
  private nextBlock: bigint;

  constructor(
    private readonly client: PublicClient,
    private readonly book: Address,
    private readonly engine: Address,
    fromBlock: bigint,
    private readonly writerBook: Address | null = null,
  ) {
    this.nextBlock = fromBlock;
  }

  async scan(): Promise<void> {
    const latest = await this.client.getBlockNumber();
    for (let from = this.nextBlock; from <= latest; from += 2000n) {
      const to = from + 1999n < latest ? from + 1999n : latest;
      const [bookLogs, engineLogs, writerLogs] = await Promise.all([
        this.client.getLogs({ address: this.book, fromBlock: from, toBlock: to }),
        this.client.getLogs({ address: this.engine, fromBlock: from, toBlock: to }),
        this.writerBook ? this.client.getLogs({ address: this.writerBook, fromBlock: from, toBlock: to }) : Promise.resolve([] as Log[]),
      ]);
      const all = [...bookLogs, ...engineLogs, ...writerLogs].sort(byChainOrder);
      const events: BookEvent[] = [];
      for (const l of all) {
        const [p] = parseEventLogs({ abi: [...bookAbi, ...engineAbi, ...writerBookAbi], logs: [l], strict: false });
        if (!p) continue;
        const a = p.args as Record<string, unknown>;
        if (p.eventName === "Opened" || p.eventName === "ShapeOpened") {
          events.push({ kind: "opened", id: a.id as bigint, market: a.name as `0x${string}` });
        } else if (p.eventName === "Bought" || p.eventName === "ShapeBought") {
          events.push({ kind: "bought", id: a.id as bigint, raw: a.raw as bigint });
        } else if (p.eventName === "Sold") {
          events.push({ kind: "sold", id: a.id as bigint, raw: a.raw as bigint });
        } else if (p.eventName === "Written") {
          events.push({ kind: "written", writeId: a.writeId as bigint, id: a.seriesId as bigint, raw: a.raw as bigint });
        } else if (p.eventName === "Unwritten") {
          events.push({ kind: "unwritten", writeId: a.writeId as bigint, raw: a.raw as bigint });
        }
      }
      applyEvents(this.series, events, this.writeSeries);
    }
    this.nextBlock = latest + 1n;
  }
}

function byChainOrder(a: Log, b: Log): number {
  const bn = Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n));
  return bn !== 0 ? bn : (a.logIndex ?? 0) - (b.logIndex ?? 0);
}
