import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createWalletClient, http, parseAbi, type Hex } from "viem";
import { foundry } from "viem/chains";
import { haveFoundry, startLocalM7, type LocalM7 } from "@tourbillon/common/localM7.ts";

// On a local anvil with DeployM7, through the MCP process itself: the read tools answer; build_mandate gives typed
// data the owner signs (anvil eth_signTypedData_v4, no key) and whose hash equals the contract's; build_buy gives the
// agent an unsigned AgentRouter transaction that fills; positions and mandates show it; build_sell gives the owner's
// exit. Skipped without anvil/forge.
const PORT = 26545 + Math.floor(Math.random() * 1000);
let L: LocalM7 | undefined;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let nextId = 1;
const pending = new Map<number, (v: Record<string, unknown>) => void>();

const tokenAbi = parseAbi(["function mint(address, uint256)", "function approve(address, uint256) returns (bool)", "function hashMandate((address owner, address agent, bytes32[] markets, uint256 shapes, uint256 maxPremiumPerTrade, uint256 maxPremiumTotal, uint256 deltaBudgetUsd, uint256 vegaBudgetUsd, uint64 expiry, bool closeOnly, uint64 nonce) m) view returns (bytes32)"]);

async function rpc(method: string, params: unknown = {}): Promise<Record<string, unknown>> {
  const id = nextId++;
  const p = new Promise<Record<string, unknown>>((r) => pending.set(id, r));
  (proc!.stdin as import("bun").FileSink).write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return p;
}
async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = (await rpc("tools/call", { name, arguments: args })).result as { isError: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] };
  if (r.isError) throw new Error(`${name}: ${r.content[0]!.text}`);
  return r.structuredContent!;
}

beforeAll(async () => {
  if (!haveFoundry()) return;
  L = await startLocalM7(PORT);
  proc = Bun.spawn(["bun", "src/main.ts", "--deployment", L.m7File, "--rpc", L.rpc], { cwd: resolve(import.meta.dir, ".."), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  (async () => {
    let buf = "";
    for await (const c of proc!.stdout as ReadableStream<Uint8Array>) {
      buf += new TextDecoder().decode(c);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        pending.get(msg.id)?.(msg);
      }
    }
  })();
}, 240_000);
afterAll(() => {
  proc?.kill();
  L?.stop();
});

test.skipIf(!haveFoundry())(
  "reads, then a mandate signed by the owner, an agent buy built by the tools, the owner's exit",
  async () => {
    const { acc, m7, client, send, rpc: url } = L!;
    const owner = acc[19]!;
    const agent = acc[18]!;
    const init = (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } })).result as Record<string, unknown>;
    expect(init.protocolVersion).toBe("2025-06-18");
    const tools = ((await rpc("tools/list")).result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(tools).toEqual(["chains_by_tempo", "vol_feed", "shapes", "quotes", "positions", "mandates", "build_mandate", "build_buy", "build_sell"]);

    const chains = await call("chains_by_tempo", { market: "BTC", strikes: 2 });
    expect(chains.mark).toBe(74_000);
    expect((chains.chains as { rows: unknown[] }[])[0]!.rows.length).toBe(5);
    const feed = await call("vol_feed", { market: "BTC" });
    expect((feed.buckets as unknown[]).length).toBe(4);
    const legs = [{ isCall: true, strike: 74000, qty: 1 }, { isCall: true, strike: 76000, qty: -1 }];
    expect((await call("shapes", { legs })).family).toBe("callSpread");

    // the owner funds its wallet, allows the router, signs the mandate the tool built
    await send(owner, m7.MockUSDC!, tokenAbi, "mint", [owner, 100_000n * 10n ** 6n]);
    await send(owner, m7.MockUSDC!, tokenAbi, "approve", [m7.AgentRouter!, 2n ** 256n - 1n]);
    const expiry = Number((await client.getBlock()).timestamp) + 86_400;
    const built = await call("build_mandate", { owner, agent, markets: ["BTC"], families: ["callSpread", "putSpread"], maxPremiumPerTrade: "10000", maxPremiumTotal: "20000", deltaBudgetUsd: "500000", vegaBudgetUsd: "unlimited", expiry, nonce: 1 });
    const td = built.typedData as Record<string, unknown>;
    const ow = createWalletClient({ chain: foundry, transport: http(url), account: owner });
    const message = built.message as Record<string, string | boolean | string[]>;
    const msg = { ...message, shapes: BigInt(message.shapes as string), maxPremiumPerTrade: BigInt(message.maxPremiumPerTrade as string), maxPremiumTotal: BigInt(message.maxPremiumTotal as string), deltaBudgetUsd: BigInt(message.deltaBudgetUsd as string), vegaBudgetUsd: BigInt(message.vegaBudgetUsd as string), expiry: BigInt(message.expiry as string), nonce: BigInt(message.nonce as string) };
    const signature = await ow.signTypedData({ ...(td as object), message: msg } as never);
    const onChain = await client.readContract({ address: m7.AgentRouter!, abi: tokenAbi, functionName: "hashMandate", args: [msg as never] });
    expect((await call("mandates", { mandate: message })).hash).toBe(onChain);

    // the agent sends the transaction build_buy gave it
    const b = await call("build_buy", { market: "BTC", legs, tempo: 86_400, units: "2", maxCost: "10000", mandate: message, signature });
    expect(b.to).toBe(m7.AgentRouter);
    const aw = createWalletClient({ chain: foundry, transport: http(url), account: agent });
    const h1 = await aw.sendTransaction({ to: b.to as Hex, data: b.data as Hex, gas: 3_000_000n, chain: foundry });
    expect((await client.waitForTransactionReceipt({ hash: h1 })).status).toBe("success");
    const pos = (await call("positions", { owner })).positions as { id: string; held: string }[];
    expect(pos.length).toBe(1);
    expect(pos[0]!.held).toBe("agentRouter");
    const usage = await call("mandates", { mandate: message });
    expect(Number(usage.premiumUsedUsdc)).toBeGreaterThan(0);
    expect(Number(usage.deltaUsedUsd)).toBeGreaterThan(0);

    // the owner's exit, built by build_sell
    const s = await call("build_sell", { id: pos[0]!.id, via: "owner" });
    const h2 = await ow.sendTransaction({ to: s.to as Hex, data: s.data as Hex, gas: 3_000_000n, chain: foundry });
    expect((await client.waitForTransactionReceipt({ hash: h2 })).status).toBe("success");
    expect(((await call("positions", { owner })).positions as unknown[]).length).toBe(0);
    expect(Number((await call("mandates", { mandate: message })).deltaUsedUsd)).toBe(0);
    // a shape a buyer cannot hold is refused before any transaction exists
    await expect(call("build_buy", { market: "BTC", legs: [{ isCall: true, strike: 74000, qty: -1 }], units: "1", maxCost: "100" })).rejects.toThrow("cannot hold");
  },
  240_000,
);
