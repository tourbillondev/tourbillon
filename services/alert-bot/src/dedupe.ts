import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { AlarmLine, ReleaseLine } from "./format.ts";

/// One post per change, no repeats, also across restarts:
/// - a condition posts when it is raised and when it is cleared, never twice in the same state;
/// - an event posts once (keyed by its name, market and transaction when it has one, else its full content);
/// - a release outcome posts once per (update, status).
/// The state is a small JSON file outside the repo.

export class Deduper {
  private state: {
    conditions: Record<string, string>;
    seen: string[];
    released: ReleaseLine[];
    dust: Record<string, { events: number; usdc: number }>;
    notShipped: number[]; // held or rolled back, and not released since
    delayed: number[]; // live on the system, the public copy and GitHub release still retrying
    board: { messageId: number | null; text: string | null };
    updateOffset: number;
    releaseDays: string[]; // UTC days with any release line
  };

  constructor(private readonly file: string | null) {
    this.state = { conditions: {}, seen: [], released: [], dust: {}, notShipped: [], delayed: [], board: { messageId: null, text: null }, updateOffset: 0, releaseDays: [], ...(file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}) };
  }

  private save(): void {
    if (!this.file) return;
    if (this.state.seen.length > 5000) this.state.seen = this.state.seen.slice(-5000);
    if (this.state.released.length > 500) this.state.released = this.state.released.slice(-500);
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state));
    renameSync(`${this.file}.tmp`, this.file);
  }

  alarm(a: AlarmLine): boolean {
    const key = `${a.name}:${a.market ?? "*"}`;
    if (a.state === "raised" || a.state === "cleared") {
      if (this.state.conditions[key] === a.state) return false;
      if (a.state === "cleared" && this.state.conditions[key] === undefined) return false; // never raised here: nothing to clear
      this.state.conditions[key] = a.state;
      this.save();
      return true;
    }
    const id = typeof a.values?.tx === "string" ? `${key}:${a.values.tx}` : `${key}:${JSON.stringify(a.values)}:${a.what}`;
    if (this.state.seen.includes(id)) return false;
    this.state.seen.push(id);
    this.save();
    return true;
  }

  release(r: ReleaseLine): boolean {
    const id = `release:${r.update}:${r.status}`;
    if (this.state.seen.includes(id)) return false;
    this.state.seen.push(id);
    const day = r.at.slice(0, 10);
    if (!this.state.releaseDays.includes(day)) this.state.releaseDays.push(day);
    if (r.status === "released") {
      this.state.released.push(r);
      this.state.notShipped = this.state.notShipped.filter((n) => n !== r.update);
      this.state.delayed = this.state.delayed.filter((n) => n !== r.update);
    } else if (r.status === "delayed") {
      // live on the system: neither held nor shipped yet; a later "released" completes it
      if (!this.state.delayed.includes(r.update)) this.state.delayed.push(r.update);
      this.state.notShipped = this.state.notShipped.filter((n) => n !== r.update);
    } else if (!this.state.notShipped.includes(r.update)) this.state.notShipped.push(r.update);
    this.save();
    return true;
  }

  /// For the launch board: every update live (released, or delayed: live on the system with its public release
  /// retrying), and those held or rolled back and not released since.
  progress(): { released: number[]; held: number[] } {
    return { released: [...new Set([...this.state.released.map((r) => r.update), ...this.state.delayed])], held: [...this.state.notShipped] };
  }

  boardMessage(): { messageId: number | null; text: string | null } {
    return this.state.board;
  }

  setBoard(messageId: number, text: string): void {
    this.state.board = { messageId, text };
    this.save();
  }

  get updateOffset(): number {
    return this.state.updateOffset;
  }

  set updateOffset(n: number) {
    this.state.updateOffset = n;
    this.save();
  }

  /// Buyback rounding the pool absorbed (DUST_ABSORBED lines): never posted as an alert, only summed for the day's
  /// summary. `id` makes a line count once even if it is read twice.
  addDust(day: string, id: string, events: number, usdc: number): void {
    if (this.state.seen.includes(id)) return;
    this.state.seen.push(id);
    const d = this.state.dust[day] ?? { events: 0, usdc: 0 };
    this.state.dust[day] = { events: d.events + events, usdc: d.usdc + usdc };
    this.save();
  }

  dustOn(day: string): { events: number; usdc: number } | null {
    return this.state.dust[day] ?? null;
  }

  /// Whether the release pipeline wrote anything (released, held or rolled back) on a UTC day.
  releasesOn(day: string): boolean {
    return this.state.releaseDays.includes(day);
  }

  /// Updates released on a UTC day (kept across restarts, for the daily summary).
  releasedOn(day: string): ReleaseLine[] {
    return this.state.released.filter((r) => r.at.slice(0, 10) === day);
  }

  summary(day: string): boolean {
    const id = `summary:${day}`;
    if (this.state.seen.includes(id)) return false;
    this.state.seen.push(id);
    this.save();
    return true;
  }
}
