/// The 15-minute venue-outage rule, per market. Pure: the caller passes the time.
/// A market is down when the monitor's own probe of Hyperliquid fails for it, or the hedger reports it failing. After
/// `windowMs` of continuous downtime it trips once (the caller pauses opens on that market); any healthy pass resets
/// the timer; a trip is followed by one "recovered" when the market is healthy again.

export type OutageEvent = "none" | "trip" | "recovered";

export class OutageTracker {
  private downSince = new Map<string, number>();
  private tripped = new Set<string>();

  constructor(private readonly windowMs: number) {}

  update(market: string, down: boolean, nowMs: number): OutageEvent {
    if (!down) {
      this.downSince.delete(market);
      if (this.tripped.delete(market)) return "recovered";
      return "none";
    }
    const since = this.downSince.get(market) ?? nowMs;
    this.downSince.set(market, since);
    if (!this.tripped.has(market) && nowMs - since >= this.windowMs) {
      this.tripped.add(market);
      return "trip";
    }
    return "none";
  }

  downFor(market: string, nowMs: number): number {
    const s = this.downSince.get(market);
    return s === undefined ? 0 : nowMs - s;
  }
}
