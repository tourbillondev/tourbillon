import { describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import { makeApi, parseLegs, RateLimit } from "../src/server.ts";

describe("API v1 basics", () => {
  test("per-IP rate limit resets each minute", () => {
    const r = new RateLimit(2);
    expect([r.allow("a", 0), r.allow("a", 1), r.allow("a", 2), r.allow("b", 2), r.allow("a", 60_001)]).toEqual([true, true, false, true, true]);
  });

  test("legs: call|put:strike:amount", () => {
    expect(parseLegs("call:74000:1,call:76000:-1")).toEqual([
      { isCall: true, kWad: parseEther("74000"), qty: parseEther("1") },
      { isCall: true, kWad: parseEther("76000"), qty: parseEther("-1") },
    ]);
    expect(() => parseLegs("swap:1:1")).toThrow("call|put");
    expect(() => parseLegs("call:1:1,call:2:1,call:3:1,call:4:1,call:5:1")).toThrow("1 to 4");
  });

  test("GET only, 404s, bad input, 429, CORS; nothing reached on refusals", async () => {
    let reached = 0;
    const api = makeApi(
      {
        dep: { markets: ["BTC"] } as never,
        reads: { status: async () => (reached++, { ok: true }) } as never,
        positionsOf: async () => [],
        now: async () => 0n,
      },
      { perMinute: 3 },
    );
    const get = (p: string, m = "GET") => api.fetch(new Request(`http://api${p}`, { method: m }));
    expect((await get("/v1/status", "POST")).status).toBe(405);
    const ok = await get("/v1/status");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    expect((await get("/v1/nope")).status).toBe(404);
    expect(await (await get("/v1/chains/DOGE")).json()).toEqual({ error: "market: one of BTC" });
    expect((await get("/v1/status")).status).toBe(429);
    expect(reached).toBe(1);
  });
});
