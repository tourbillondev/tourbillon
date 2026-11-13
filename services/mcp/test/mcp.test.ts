import { describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import { handle, type Tool } from "../src/protocol.ts";
import { buyerSafe, familyOf } from "../src/tools.ts";

const echo: Tool = { name: "echo", description: "x", inputSchema: { type: "object", properties: {} }, run: async (a) => ({ got: a, big: 5n }) };
const boom: Tool = { name: "boom", description: "x", inputSchema: { type: "object", properties: {} }, run: async () => { throw new Error("nope"); } };

describe("the protocol core", () => {
  test("initialize, ping, tools/list, tools/call, notifications, errors", async () => {
    const init = JSON.parse((await handle([echo], JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })))!);
    expect(init.result.capabilities.tools).toEqual({});
    expect(init.result.serverInfo.name).toBe("tourbillon-mcp");
    expect(await handle([echo], JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).toBeNull();
    expect(JSON.parse((await handle([echo], JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })))!).result).toEqual({});
    const list = JSON.parse((await handle([echo, boom], JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })))!);
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["echo", "boom"]);
    const call = JSON.parse((await handle([echo], JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "echo", arguments: { a: 1 } } })))!);
    expect(call.result.isError).toBe(false);
    expect(call.result.structuredContent).toEqual({ got: { a: 1 }, big: "5" });
    const err = JSON.parse((await handle([boom], JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "boom" } })))!);
    expect(err.result.isError).toBe(true);
    expect(err.result.content[0].text).toBe("nope");
    expect(JSON.parse((await handle([echo], JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } })))!).error.code).toBe(-32602);
    expect(JSON.parse((await handle([echo], JSON.stringify({ jsonrpc: "2.0", id: 7, method: "resources/list" })))!).error.code).toBe(-32601);
    expect(JSON.parse((await handle([echo], "{not json"))!).error.code).toBe(-32700);
  });
});

describe("shapes", () => {
  const L = (isCall: boolean, k: number, q: number) => ({ isCall, kWad: parseEther(String(k)), qty: parseEther(String(q)) });
  test("families as AgentRouter.familyOf; a buyer can hold only shapes whose payoff never goes below 0", () => {
    expect(familyOf([L(true, 70_000, 1)])).toBe("rise");
    expect(familyOf([L(false, 70_000, 1)])).toBe("fall");
    expect(familyOf([L(true, 70_000, 1), L(true, 75_000, -1)])).toBe("callSpread");
    expect(familyOf([L(false, 65_000, -1), L(false, 70_000, 1)])).toBe("putSpread");
    expect(familyOf([L(false, 70_000, 1), L(true, 70_000, 1)])).toBe("swing");
    expect(familyOf([L(true, 65_000, 1), L(true, 70_000, -2), L(true, 75_000, 1)])).toBe("other");
    expect(buyerSafe([L(true, 70_000, 1), L(true, 75_000, -1)])).toBe(true);
    expect(buyerSafe([L(true, 70_000, -1), L(true, 75_000, 1)])).toBe(false); // a written spread
    expect(buyerSafe([L(true, 70_000, 1), L(true, 75_000, -2)])).toBe(false); // net short calls
    expect(buyerSafe([L(false, 65_000, 1), L(false, 70_000, -1)])).toBe(false);
    expect(buyerSafe([L(true, 65_000, 1), L(true, 70_000, -2), L(true, 75_000, 1)])).toBe(true);
  });
});
