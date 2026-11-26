/// LOCAL ONLY: the port to start a local service on: the one asked for when it is free on 127.0.0.1, otherwise one the
/// system picks. Test files choose ports at random in ranges that can overlap (one file's Postgres range is another's
/// anvil range), and a port can still be held for a moment after the previous file stopped its service; starting on a
/// busy port fails late and slowly. Callers read the address back from the helper (its rpc or url).
export function freePort(wanted: number): number {
  for (const p of [wanted, 0]) {
    try {
      const s = Bun.listen({ hostname: "127.0.0.1", port: p, socket: { data() {} } });
      const got = s.port;
      s.stop(true);
      return got;
    } catch {
      // busy: let the system pick one
    }
  }
  throw new Error("no free local port");
}
