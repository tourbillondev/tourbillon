import { expect, test } from "bun:test";
import { freePort } from "../src/ports.ts";

test("the port asked for when free; another when it is busy", () => {
  const p = freePort(0);
  expect(freePort(p)).toBe(p);
  const busy = Bun.listen({ hostname: "127.0.0.1", port: p, socket: { data() {} } });
  try {
    const other = freePort(p);
    expect(other).not.toBe(p);
    expect(other).toBeGreaterThan(0);
  } finally {
    busy.stop(true);
  }
});
