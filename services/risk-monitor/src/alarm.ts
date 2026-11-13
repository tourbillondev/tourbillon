import { log } from "@tourbillon/common/log.ts";

/// Alarm lines in one stable shape, so a staff alert bot (Telegram, later) can post them without parsing prose:
///   { t, level: "alarm" | "warn", msg: "alarm", name, state: "raised" | "cleared" | "event", what, who, market, values }
/// - name   a fixed identifier (the list below); never renamed once used
/// - state  "raised" when a condition starts, "cleared" when it ends, "event" for one-off events (treasury moves)
/// - what   one plain sentence: what happened
/// - who    who has to act (or "nobody: automatic action taken")
/// - market the market, or null for pool-wide alarms
/// - values the numbers behind it
/// A condition is announced once when raised and once when cleared, not every pass.

export type AlarmName =
  | "VENUE_DOWN_PAUSED"
  | "VENUE_RECOVERED"
  | "EQUITY_MISMATCH"
  | "EQUITY_NOT_READY"
  | "TREASURY_SENT"
  | "TREASURY_RETURNED"
  | "COVERAGE_LOW"
  | "COVERAGE_BREACHED"
  | "CAP_HIGH"
  | "DRAWDOWN_PAUSED"
  | "MARK_STALE"
  | "SAMPLE_STALE"
  | "SETTLEMENT_STALE"
  | "HEDGER_SILENT"
  | "PAUSE_FAILED"
  | "MONITOR_ERROR"
  // M6, the open book
  | "BUYBACK_FAILED"
  | "BUYBACK_SHORTFALL"
  | "MATCHED_UNCOVERED"
  | "DUST_ABSORBED"
  | "VAULT_SLASHED"
  | "AUCTION_STARTED"
  | "AUCTION_FORFEIT"
  | "AUCTION_SETTLED"
  | "AUCTION_SETTLE_DUE"
  // M7, governance and receipts
  | "TIMELOCK_QUEUED"
  | "TIMELOCK_EXECUTED"
  | "TIMELOCK_CANCELLED"
  | "ROLE_CHANGED"
  | "PAUSED"
  | "UNPAUSED"
  | "RECEIPTS_STALE"
  // launch core
  | "KEY_BALANCE_LOW";

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
  set(holds: boolean, a: Omit<Alarm, "state">, cleared: string): void {
    const key = `${a.name}:${a.market ?? "*"}`;
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
