import type { Kind, Reading } from "./decide.ts";
import { formatEther } from "viem";
import { overlapsRegularSession, isRegularSession } from "@tourbillon/common/session.ts";
import type { Price, PriceFeed } from "./feeds.ts";
import { cryptoMark, stockMark, type MarkCheck } from "./marks.ts";
import { bpsToWad, VolTracker } from "./vol.ts";
import { log } from "@tourbillon/common/log.ts";

/// Where a signer's values come from. MARK values are WAD prices; VOL values are WAD fractions (0.5e18 = 50%).
export interface ValueSource {
  readonly name: string;
  read(market: string, kind: Kind, now: number): Promise<Reading>;
}

/// Fixed values, for a local anvil chain only (enforced in config). A kind with no value gives no reading.
export class FixedSource implements ValueSource {
  readonly name = "fixed";
  constructor(
    private readonly marks: Map<string, bigint> | undefined,
    private readonly vol: bigint | undefined,
  ) {}

  async read(market: string, kind: Kind, now: number): Promise<Reading> {
    if (kind === "EQUITY") return null;
    const v = kind === "VOL" ? this.vol : this.marks?.get(market);
    return v === undefined ? null : { value: v, at: now };
  }
}

/// MARK from one source, VOL from another.
export class SplitSource implements ValueSource {
  readonly name: string;
  constructor(
    private readonly marks: ValueSource,
    private readonly vols: ValueSource,
  ) {
    this.name = `mark:${marks.name},vol:${vols.name}`;
  }

  read(market: string, kind: Kind, now: number): Promise<Reading> {
    return (kind === "MARK" ? this.marks : this.vols).read(market, kind, now);
  }
}

/// Alarm after this many refused or failed reads in a row for one market (one read per tick, so about one minute).
export const ALARM_AFTER_FAILURES = 3;
/// A market's checked mark younger than this serves every key of the same tick (MARK and VOL).
const REUSE_MS = 5_000;

/// The feeds of one market (from the signer's feeds file; providers are owner queue Q4, Q6, Q7).
export type MarketFeeds =
  | { kind: "stock"; onchain: PriceFeed; reference: PriceFeed }
  | { kind: "crypto"; exchanges: PriceFeed[]; pyth: PriceFeed };

type MarketState = { feeds: MarketFeeds; vol: VolTracker; last: { localMs: number; check: MarkCheck } | null; inflight: Promise<MarkCheck> | null; failures: number };

async function readOrNull(f: PriceFeed, market: string): Promise<Price | null> {
  try {
    return await f.read();
  } catch (e) {
    log("info", "feed: no reading", { market, feed: f.name, error: (e as Error).message });
    return null;
  }
}

/// MARK: each market's two-source check (marks.ts). VOL: realised vol from this signer's own accepted marks
/// (VolTracker), session-aware for stocks. State is in memory only: a restart warms up again (one day of steps).
export class FeedSource implements ValueSource {
  readonly name = "feeds";
  readonly markets = new Map<string, MarketState>();

  constructor(
    feeds: Map<string, MarketFeeds>,
    private readonly clock: () => number = Date.now,
    private readonly inSession: (ms: number) => boolean = isRegularSession,
    overlaps: (fromMs: number, toMs: number) => boolean = overlapsRegularSession,
  ) {
    for (const [m, f] of feeds) this.markets.set(m, { feeds: f, vol: new VolTracker(f.kind === "stock", overlaps), last: null, inflight: null, failures: 0 });
  }

  private async check(market: string, st: MarketState): Promise<MarkCheck> {
    const nowMs = this.clock();
    let c: MarkCheck;
    if (st.feeds.kind === "stock") {
      const [onchain, reference] = await Promise.all([readOrNull(st.feeds.onchain, market), readOrNull(st.feeds.reference, market)]);
      c = stockMark(onchain, reference, this.clock(), this.inSession(nowMs));
    } else {
      const [pyth, ...ex] = await Promise.all([readOrNull(st.feeds.pyth, market), ...st.feeds.exchanges.map((f) => readOrNull(f, market))]);
      c = cryptoMark(ex, pyth, this.clock());
    }
    if (c.ok) {
      if (st.failures >= ALARM_AFTER_FAILURES) log("info", "mark: votes again", { market, after: st.failures });
      st.failures = 0;
      st.vol.sample(Number(formatEther(c.px)), c.atMs);
    } else {
      st.failures++;
      const fields = { market, reason: c.reason, inARow: st.failures };
      log(st.failures >= ALARM_AFTER_FAILURES ? "alarm" : "warn", "mark: refused, no vote", fields);
    }
    st.last = { localMs: this.clock(), check: c };
    return c;
  }

  private async current(market: string, st: MarketState): Promise<MarkCheck> {
    if (st.last && this.clock() - st.last.localMs <= REUSE_MS) return st.last.check;
    st.inflight ??= this.check(market, st).finally(() => (st.inflight = null));
    return st.inflight;
  }

  async read(market: string, kind: Kind, now: number): Promise<Reading> {
    if (kind === "EQUITY") return null;
    const st = this.markets.get(market);
    if (!st) return null;
    const c = await this.current(market, st); // VOL reads keep the 5-minute samples flowing too
    if (kind === "MARK") {
      if (!c.ok) return null;
      // Age measured on this machine's clock, then expressed in chain time, so clock drift cannot make an old
      // reading look fresh.
      return { value: c.px, at: now - ageSeconds(this.clock(), c.atMs) };
    }
    const bps = st.vol.sigmaBps();
    if (bps === null) return null;
    const raw = st.vol.rawBps()!;
    if (raw !== bps) log("warn", "vol clipped", { market, sigmaBps: raw, voted: bps });
    // Age = time since the last price kept, so a vol that stops updating stops being voted.
    return { value: bpsToWad(bps), at: now - ageSeconds(this.clock(), st.vol.lastPointMs) };
  }
}

function ageSeconds(nowMs: number, thenMs: number): number {
  return Math.max(0, Math.ceil((nowMs - thenMs) / 1000));
}
