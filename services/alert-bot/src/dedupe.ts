import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { AlarmLine } from "./format.ts";

/// One post per change, no repeats, also across restarts:
/// - a condition posts when it is raised and when it is cleared, never twice in the same state;
/// - an event posts once (keyed by its name, market and transaction when it has one, else its full content).
/// The state is a small JSON file outside the repo.

export class Deduper {
  private state: { conditions: Record<string, string>; seen: string[] };

  constructor(private readonly file: string | null) {
    const saved = file && existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<Deduper["state"]>) : {};
    this.state = { conditions: saved.conditions ?? {}, seen: saved.seen ?? [] }; // older fields (release lines, the board) are dropped
  }

  private save(): void {
    if (!this.file) return;
    if (this.state.seen.length > 5000) this.state.seen = this.state.seen.slice(-5000);
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
}
