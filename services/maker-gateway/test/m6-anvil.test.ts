import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicClient, createWalletClient, getAddress, hashTypedData, http, parseEther, parseEventLogs, stringToHex, type Address, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { readPositions } from "../../hedger/src/book.ts";
import { Walker } from "../../poker/src/walker.ts";
import { fund, quoteOnce, type BotParams } from "../src/bot.ts";
import { chainReader, loadM6Deployment, type M6Deployment } from "../src/chain.ts";
import { domainFor, quoteTypes, toJson, type Quote } from "../src/quote.ts";
import { makeHandler } from "../src/server.ts";

// On a local anvil: DeployM1 + DeployM6, markets live, an LP round. The reference bot funds its vault and posts a
// quote it signed through anvil's unlocked account; the gateway serves it; the OpenBook fills the buyer from it. Then:
// the hedger leaves matched raw out; a pool-carried buy can be auctioned; the risk-monitor announces the lot; a sell
// buys the maker back. Skipped without anvil/forge.
const haveTools = Bun.which("anvil") !== null && Bun.which("forge") !== null;
const CONTRACTS = resolve(import.meta.dir, "../../../contracts");
const PORT = 23545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const PX: Record<string, string> = { BTC: "74000", ETH: "2000", HYPE: "40" };

const b32 = (m: string) => stringToHex(m, { size: 32 });
const legT = { type: "tuple[]", components: [{ type: "bool", name: "isCall" }, { type: "uint128", name: "kWad" }, { type: "int128", name: "qty" }] } as const;
const partT = { type: "tuple[]", components: [{ type: "uint256", name: "tempo" }, { type: "uint256", name: "weight" }] } as const;
const quoteT = {
  type: "tuple[]",
  components: quoteTypes.Quote.map((f) => ({ type: f.type, name: f.name })),
} as const;
const abi = [
  { type: "function", name: "markKey", stateMutability: "pure", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "volKey", stateMutability: "pure", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "latestRoundData", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] },
  { type: "function", name: "vote", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint80" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "applyRoute", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] },
  { type: "function", name: "poke", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }, { type: "bool" }, { type: "bool" }] },
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "startEpoch", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "markChunk", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "settle", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "hashQuote", stateMutability: "view", inputs: [{ type: "tuple", components: quoteT.components }], outputs: [{ type: "bytes32" }] },
  {
    type: "function",
    name: "buy",
    stateMutability: "nonpayable",
    inputs: [{ type: "bytes32" }, legT, partT, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, quoteT, { type: "bytes[]" }, { type: "uint256[]" }],
    outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint8" }],
  },
  { type: "function", name: "sell", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "matchedRawOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "lockedOf", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "start", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "event", name: "Routed", inputs: [{ type: "address", name: "buyer", indexed: true }, { type: "uint256", name: "id", indexed: true }, { type: "uint8", name: "kind" }, { type: "uint256", name: "sigmaBps" }, { type: "uint256", name: "cost" }, { type: "address", name: "source" }] },
  { type: "event", name: "BuybackSettled", inputs: [{ type: "uint256", name: "id", indexed: true }, { type: "uint256", name: "paidUsdc" }, { type: "uint256", name: "paidWhype" }, { type: "uint256", name: "shortfall" }] },
] as const;

let anvil: ReturnType<typeof Bun.spawn> | undefined;
let gw: ReturnType<typeof Bun.serve> | undefined;
let hl: ReturnType<typeof Bun.serve> | undefined;
let tmp = "";
let m6File = "";
let m1: Record<string, Address>;
let m6: Record<string, Address> & { deployBlock?: unknown };
let dep: M6Deployment;
let acc: Address[] = [];
const client = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: 100 }) as PublicClient;
const wallet = (a: Address) => createWalletClient({ chain: foundry, transport: http(RPC), account: a });

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return ((await res.json()) as { result: unknown }).result;
}

async function send(from: Address, address: Address, functionName: string, args: readonly unknown[] = []) {
  const gas = await client.estimateContractGas({ address, abi, functionName, args, account: from } as never);
  const hash = await wallet(from).writeContract({ address, abi, functionName, args, gas: gas * 2n } as never);
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return r;
}

async function vote(): Promise<void> {
  for (const m of ["BTC", "ETH", "HYPE"]) {
    for (const fn of ["markKey", "volKey"] as const) {
      const key = await client.readContract({ address: m1.QuorumBoard!, abi, functionName: fn, args: [b32(m)] });
      let round = 0n;
      try {
        [round] = await client.readContract({ address: m1.QuorumBoard!, abi, functionName: "latestRoundData", args: [key] });
      } catch {
        round = 0n;
      }
      const v = fn === "markKey" ? parseEther(PX[m]!) : parseEther("0.45");
      for (const s of [acc[2]!, acc[3]!, acc[4]!]) await send(s, m1.QuorumBoard!, "vote", [key, round + 1n, v]);
    }
  }
}

const W = 10n ** 18n;
const KIND_POOL = 1; // OpenBook.KIND_*
const KIND_QUOTE = 2;
const spread = [
  { isCall: true, kWad: 74_000n * W, qty: W },
  { isCall: true, kWad: 76_000n * W, qty: -W },
];
const days = (n: bigint) => [{ tempo: n * 86_400n, weight: W }];

beforeAll(async () => {
  if (!haveTools) return;
  tmp = mkdtempSync(join(tmpdir(), "m6-anvil-"));
  hl = Bun.serve({
    port: 0,
    async fetch(req) {
      const b = (await req.json()) as { type: string };
      if (b.type === "metaAndAssetCtxs") {
        const names = ["BTC", "ETH", "HYPE"];
        return Response.json([{ universe: names.map((n) => ({ name: n, szDecimals: 3 })) }, names.map((n) => ({ markPx: PX[n], oraclePx: PX[n], midPx: PX[n] }))]);
      }
      return new Response("?", { status: 400 });
    },
  });
  anvil = Bun.spawn(["anvil", "--port", String(PORT), "--silent"], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      await client.getChainId();
      break;
    } catch {
      await Bun.sleep(100);
    }
  }
  acc = ((await rpc("eth_accounts")) as Address[]).map((a) => getAddress(a));
  const env = { ...process.env, ADMIN: acc[1]!, SIGNERS: `${acc[2]},${acc[3]},${acc[4]}`, M3_DEPLOYMENT: "deployments/31337-m6.json" };
  for (const [script, sender] of [
    ["DeployM1.s.sol:DeployM1", acc[0]!],
    ["DeployM6.s.sol:DeployM6", acc[0]!],
    ["ListEquityFeed.s.sol:ListEquityFeed", acc[1]!],
  ] as const) {
    const r = Bun.spawnSync(["forge", "script", `script/${script}`, "--rpc-url", RPC, "--unlocked", "--sender", sender, "--broadcast"], { cwd: CONTRACTS, env });
    if (r.exitCode !== 0) throw new Error(`${script} failed: ${r.stderr.toString()}`);
  }
  m6File = join(tmp, "31337-m6.json");
  copyFileSync(join(CONTRACTS, "deployments", "31337-m6.json"), m6File);
  m1 = await Bun.file(join(CONTRACTS, "deployments", "31337.json")).json();
  m6 = await Bun.file(m6File).json();
  dep = loadM6Deployment(m6File);
  await rpc("evm_increaseTime", [3600]);
  await rpc("evm_mine");
  for (const m of ["BTC", "ETH", "HYPE"]) await send(acc[5]!, m1.MarkRouter!, "applyRoute", [b32(m)]);
  await vote();
  for (const m of ["BTC", "ETH", "HYPE"]) await send(acc[9]!, m6.PathFundingBook!, "poke", [b32(m)]);
  const LP = acc[7]!;
  await send(LP, m6.MockUSDC!, "mint", [LP, 5_000_000n * 10n ** 6n]);
  await send(LP, m6.MockUSDC!, "approve", [m6.MainspringPool!, 5_000_000n * 10n ** 6n]);
  await send(LP, m6.MainspringPool!, "deposit", [5_000_000n * 10n ** 6n]);
  await send(acc[9]!, m6.MainspringPool!, "startEpoch");
  await send(acc[9]!, m6.MainspringPool!, "markChunk", [100n]);
  await send(acc[9]!, m6.MainspringPool!, "settle");
  gw = Bun.serve({ port: 0, fetch: makeHandler(chainReader(client, dep)).fetch });
}, 240_000);

afterAll(() => {
  gw?.stop(true);
  hl?.stop(true);
  anvil?.kill();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test.skipIf(!haveTools)(
  "bot quote → gateway → routed fill; hedger leaves matched raw out; an auction lot and its alarm; a sell buys the maker back",
  async () => {
    const maker = acc[6]!;
    const T = acc[8]!;
    const mw = createWalletClient({ chain: foundry, transport: http(RPC), account: maker });
    // the bot funds its vault and quotes 3 vol points under the board, signing through anvil (no key anywhere)
    await fund(client, mw, dep, maker, 100_000n * 10n ** 6n);
    const p: BotParams = { maker, market: "BTC", sigmaOffsetBps: -300, maxUnits: 50n * W, ttlSeconds: 600, bandPct: 0.3 };
    const q = (await quoteOnce(client, mw, dep, p, gw!.url.toString(), 1n)) as Quote;
    expect(q.sigmaBps).toBe(4200n);
    // the digest the bot signed is the one the quote book checks
    const onChain = await client.readContract({ address: dep.quoteBook, abi, functionName: "hashQuote", args: [q] });
    expect(onChain).toBe(hashTypedData({ domain: domainFor(dep.chainId, dep.quoteBook), types: quoteTypes, primaryType: "Quote", message: q }));

    // the buyer asks the gateway, then routes through the OpenBook
    const order = { name: b32("BTC"), legs: spread, movement: days(1n), units: 2n * W };
    const res = await fetch(new URL("/best", gw!.url), { method: "POST", body: toJson(order) });
    const best = (await res.json()) as { quotes: { quote: Record<string, string>; sig: `0x${string}` }[] };
    expect(best.quotes.length).toBe(1);
    const quotes = best.quotes.map((x) => ({ ...q, ...Object.fromEntries(Object.entries(x.quote).map(([k, v]) => [k, k === "maker" || k === "name" ? v : k === "sides" || k === "tauLo" || k === "tauHi" ? Number(v) : BigInt(v)])) }));
    await send(T, m6.MockUSDC!, "mint", [T, 1_000_000n * 10n ** 6n]);
    await send(T, m6.MockUSDC!, "approve", [m6.Engine!, 1_000_000n * 10n ** 6n]);
    const deadline = (await client.getBlock()).timestamp + 600n;
    let r = await send(T, m6.OpenBook!, "buy", [b32("BTC"), spread, days(1n), 2n * W, 10n ** 12n, deadline, quotes, best.quotes.map((x) => x.sig), []]);
    const routed = parseEventLogs({ abi, logs: r.logs, eventName: "Routed" })[0]!;
    expect(routed.args.kind).toBe(KIND_QUOTE);
    expect(routed.args.sigmaBps).toBe(4200n);
    expect(routed.args.source).toBe(maker);
    const id = routed.args.id;
    expect(await client.readContract({ address: m6.MakerVault!, abi, functionName: "lockedOf", args: [maker, m6.MockUSDC!] })).toBe(4_000n * 10n ** 6n);

    // the hedger: the matched series carries nothing for the pool
    let pos = await readPositions(client, m6.MainspringPool!, m6.PathFundingBook!, "BTC");
    expect(pos.length).toBe(1);
    expect(pos[0]!.units).toBe(0);

    // a pool fill (no quotes) is carried by the pool, hedged, and can be auctioned
    r = await send(T, m6.OpenBook!, "buy", [b32("BTC"), spread, days(7n), 5n * W, 10n ** 12n, deadline, [], [], []]);
    expect(parseEventLogs({ abi, logs: r.logs, eventName: "Routed" })[0]!.args.kind).toBe(KIND_POOL);
    pos = await readPositions(client, m6.MainspringPool!, m6.PathFundingBook!, "BTC");
    expect(pos.map((x) => x.units > 0)).toEqual([false, true]);
    await send(acc[9]!, m6.RiskAuction!, "start", [b32("BTC")]);
    const mon = Bun.spawn(["bun", "src/main.ts", "--deployment", m6File, "--rpc", RPC, "--watch", acc[1]!, "--hl-api", hl!.url.toString(), "--once"], {
      cwd: resolve(import.meta.dir, "../../risk-monitor"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const lines = (await new Response(mon.stdout).text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    await mon.exited;
    const started = lines.find((l) => l.name === "AUCTION_STARTED");
    expect(started?.market).toBe("BTC");
    expect(lines.some((l) => l.name === "MONITOR_ERROR")).toBe(false);

    // the walker sees routed buys (the Engine's openFor emits ShapeBought), so matched series are walked like any other
    const walker = new Walker(client, m6.PathFundingBook!, m6.Engine!, BigInt(Number(m6.deployBlock)), m6.WriterBook!);
    await walker.scan();
    expect(walker.series.get(id)?.openRaw).toBeGreaterThan(0n);

    // the buyer sells the maker-filled series: the maker is bought back in the same transaction
    r = await send(T, m6.Engine!, "sell", [id, 2n ** 256n - 1n, 0n, deadline]);
    const bb = parseEventLogs({ abi, logs: r.logs, eventName: "BuybackSettled" })[0]!;
    expect(bb.args.shortfall).toBe(0n);
    expect(await client.readContract({ address: m6.MainspringPool!, abi, functionName: "matchedRawOf", args: [id] })).toBe(0n);
    expect(await client.readContract({ address: m6.MakerVault!, abi, functionName: "lockedOf", args: [maker, m6.MockUSDC!] })).toBe(0n);
    await walker.scan();
    expect(walker.series.get(id)?.openRaw).toBe(0n);
  },
  240_000,
);
