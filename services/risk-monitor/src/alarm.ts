import { log } from "@tourbillon/common/log.ts";

/// Alarm lines in one stable shape, so a staff alert bot (Telegram, later) can post them without parsing prose:
///   { t, level: "alarm" | "warn", msg: "alarm", name, state: "raised" | "cleared" | "event", what, who, market, values }
/// - name   a fixed identifier (the list below), lower-dash as the playbook names them (06b §1); the bot posts it
///          joined with the market (mark-stale-STK1). Renamed once, in RH7, from the M3 UPPER_SNAKE names
/// - state  "raised" when a condition starts, "cleared" when it ends, "event" for one-off events (treasury moves)
/// - what   one plain sentence: what happened
/// - who    who has to act (or "nobody: automatic action taken")
/// - market the market, or null for pool-wide alarms
/// - values the numbers behind it
/// A condition is announced once when raised and once when cleared, not every pass.

export type AlarmName =
  | "venue-down-paused"
  | "venue-recovered"
  | "equity-mismatch"
  | "equity-not-ready"
  | "treasury-sent"
  | "treasury-returned"
  | "coverage-low"
  | "coverage-breached"
  | "cap-high"
  | "drawdown-paused"
  | "mark-stale"
  | "sample-stale"
  | "settlement-stale"
  | "hedger-silent"
  | "pause-failed"
  | "monitor-error"
  // M6, the open book
  | "buyback-failed"
  | "buyback-shortfall"
  | "matched-uncovered"
  | "dust-absorbed"
  | "vault-slashed"
  | "auction-started"
  | "auction-forfeit"
  | "auction-settled"
  | "auction-settle-due"
  // M7, governance and receipts
  | "timelock-queued"
  | "timelock-executed"
  | "timelock-cancelled"
  | "role-changed"
  | "paused"
  | "unpaused"
  | "receipts-stale"
  // launch core
  | "key-balance-low"
  // RH7, Robinhood Chain (posted as name-MARKET)
  | "dex-down"
  | "cex-down"
  | "transfer-stuck"
  | "session-anchored"
  | "quarter-cap-high"
  | "inventory-mismatch"
  | "split-mismatch";

export type Alarm = {
  name: AlarmName;
  state: "raised" | "cleared" | "event";
  level: "alarm" | "warn";
  what: string;
  who: string;
  market: string | null;
  values: Record<string, unknown>;
};

export function emit(a: Alarm): void {
  log(a.level, "alarm", { name: a.name, state: a.state, what: a.what, who: a.who, market: a.market, values: a.values });
}

/// Announces conditions on change only.
export class Conditions {
  private active = new Map<string, Alarm>();

  /// `a` is the alarm while the condition holds; `cleared` describes its end.
  /// `id` tells apart conditions of the same name and market (for example one per hedger).
  set(holds: boolean, a: Omit<Alarm, "state">, cleared: string, id?: string): void {
    const key = `${a.name}:${a.market ?? "*"}${id ? `:${id}` : ""}`;
    const was = this.active.has(key);
    if (holds && !was) {
      this.active.set(key, { ...a, state: "raised" });
      emit({ ...a, state: "raised" });
    } else if (!holds && was) {
      this.active.delete(key);
      emit({ ...a, state: "cleared", level: "warn", what: cleared, who: "nobody" });
    }
  }

  isActive(name: AlarmName, market: string | null): boolean {
    return this.active.has(`${name}:${market ?? "*"}`);
  }
}
