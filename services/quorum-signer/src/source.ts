import type { Kind, Reading } from "./decide.ts";
import { formatEther } from "viem";
import { fetchCandles, fetchMetaAndAssetCtxs, HL_API, parseCandles, parseMarks, TIMEOUT_MS, type MarkResult } from "./hyperliquid.ts";
import { bpsToWad, EwmaVol, STEP_S } from "./vol.ts";
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

/// Alarm after this many failed fetches in a row (one fetch per tick, so about one minute).
export const ALARM_AFTER_FAILURES = 3;
/// A snapshot younger than this serves every market of the same tick.
const SNAPSHOT_REUSE_MS = 5_000;
/// Vol start-up: 7 days of 5-minute candles (owner decision); at least 1 day is required (vol.ts).
export const START_WINDOW_MS = 7 * 86_400_000;
/// A failed start-up is retried at most this often (about 160 request weight per attempt for three markets).
export const START_RETRY_MS = 60_000;

type VolState = {
  est: EwmaVol | null;
  lastPointMs: number; // wall-clock time of the last price absorbed
  lastAttemptMs: number;
  starting: Promise<void> | null;
};

/// MARK = Hyperliquid's markPx (the HyperCore mark). VOL = realised vol (vol.ts), started from 7 days of
/// 5-minute candles, then fed the first markPx reading of each 5-minute boundary. State is in memory only:
/// every start begins again from candles.
export class HyperliquidSource implements ValueSource {
  readonly name = "hyperliquid";
  failures = 0;
  private snap: { localMs: number; marks: Map<string, MarkResult> } | null = null;
  private inflight: Promise<void> | null = null;
  readonly vols = new Map<string, VolState>();

  constructor(
    private readonly markets: string[],
    private readonly base = HL_API,
    private readonly timeoutMs = TIMEOUT_MS,
    private readonly clock: () => number = Date.now,
  ) {
    for (const m of markets) this.vols.set(m, { est: null, lastPointMs: 0, lastAttemptMs: -Infinity, starting: null });
  }

  private async refresh(): Promise<void> {
    try {
      const body = await fetchMetaAndAssetCtxs(this.base, this.timeoutMs);
      const marks = parseMarks(body, this.markets);
      const localMs = this.clock();
      this.snap = { localMs, marks };
      if (this.failures >= ALARM_AFTER_FAILURES) log("info", "hyperliquid recovered", { after: this.failures });
      this.failures = 0;
      for (const [market, r] of marks) {
        if (!r.ok) {
          log(r.reason === "oracle-deviation" ? "warn" : "info", "hyperliquid: no mark", { market, reason: r.reason, detail: r.detail });
          continue;
        }
        this.sample(market, r.mark, localMs);
      }
    } catch (e) {
      this.snap = null;
      this.failures++;
      const fields = { failures: this.failures, error: (e as Error).message };
      if (this.failures >= ALARM_AFTER_FAILURES) log("alarm", "hyperliquid unreachable", fields);
      else log("warn", "hyperliquid fetch failed", fields);
    }
  }

  /// The first mark of each 5-minute boundary feeds the vol estimator.
  private sample(market: string, markWad: bigint, localMs: number): void {
    const v = this.vols.get(market);
    if (!v?.est) return;
    const t = Math.floor(localMs / 1000 / STEP_S) * STEP_S;
    const res = v.est.update({ t, px: Number(formatEther(markWad)) });
    if (res === "ok") {
      v.lastPointMs = localMs;
    } else if (res === "gap-too-long") {
      log("warn", "vol: gap over 1 h, starting again from candles", { market, lastT: v.est.lastT, t });
      v.est = null;
      v.lastAttemptMs = -Infinity;
    }
  }

  private async start(market: string): Promise<void> {
    const v = this.vols.get(market)!;
    const nowMs = this.clock();
    v.lastAttemptMs = nowMs;
    try {
      const body = await fetchCandles(market, nowMs - START_WINDOW_MS, nowMs, this.base, this.timeoutMs);
      const points = parseCandles(body, market, nowMs);
      const est = EwmaVol.start(points);
      const last = points.at(-1)!;
      if (nowMs - last.t * 1000 > 2 * STEP_S * 1000) throw new Error("latest candle too old");
      v.est = est;
      v.lastPointMs = last.t * 1000;
      log("info", "vol started from candles", { market, candles: points.length, sigmaBps: est.sigmaBps(), capped: est.capped });
    } catch (e) {
      log("warn", "vol start-up failed", { market, error: (e as Error).message });
    }
  }

  private async ensureSnapshot(): Promise<void> {
    if (!this.snap || this.clock() - this.snap.localMs > SNAPSHOT_REUSE_MS) {
      this.inflight ??= this.refresh().finally(() => (this.inflight = null));
      await this.inflight;
    }
  }

  async read(market: string, kind: Kind, now: number): Promise<Reading> {
    if (kind === "EQUITY") return null;
    if (kind === "VOL") return this.readVol(market, now);
    await this.ensureSnapshot();
    const r = this.snap?.marks.get(market);
    if (!this.snap || !r || !r.ok) return null;
    // The reply has no timestamp: its age is measured on this machine's clock, then expressed in chain time,
    // so clock drift between this machine and the chain cannot make an old reading look fresh.
    return { value: r.mark, at: now - ageSeconds(this.clock(), this.snap.localMs) };
  }

  private async readVol(market: string, now: number): Promise<Reading> {
    const v = this.vols.get(market);
    if (!v) return null;
    if (!v.est && !v.starting && this.clock() - v.lastAttemptMs >= START_RETRY_MS) {
      v.starting = this.start(market).finally(() => (v.starting = null));
    }
    if (v.starting) await v.starting;
    await this.ensureSnapshot(); // keeps the 5-minute samples flowing even when only VOL is read
    if (!v.est) return null;
    const raw = v.est.sigma() * 10_000;
    const bps = v.est.sigmaBps();
    if (Math.round(raw) !== bps) log("warn", "vol clipped", { market, sigmaBps: Math.round(raw), voted: bps });
    // Age = time since the last price absorbed (local clock), so a vol that stops updating stops being voted.
    return { value: bpsToWad(bps), at: now - ageSeconds(this.clock(), v.lastPointMs) };
  }
}

function ageSeconds(nowMs: number, thenMs: number): number {
  return Math.max(0, Math.ceil((nowMs - thenMs) / 1000));
}
