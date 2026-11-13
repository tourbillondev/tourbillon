/// JSON lines on stdout. Never pass key material or passwords here.
export type Level = "info" | "warn" | "alarm" | "error";

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  process.stdout.write(line + "\n");
}
