import { readFileSync } from "node:fs";
import { encodeFunctionData, formatEther, formatUnits, getAddress, parseAbi, parseAbiItem, parseEther, stringToHex, type Address, type Hex, type PublicClient } from "viem";
import { blendValue } from "@tourbillon/common/tempo.ts";
import type { Tool } from "./protocol.ts";

/// The MCP tools (spec: "Chains by tempo, vol feed, shapes, quotes, positions, mandates"; M7 G17). Read tools answer
/// from the chain (and the maker-gateway for quotes); builder tools return unsigned transactions and EIP-712 mandates
/// to sign elsewhere. Nothing here holds or asks for a key. Values from `chains_by_tempo` are indicative (an off-chain
/// copy of the closed form at the board's σ); the on-chain router prices every fill.

export type M7 = {
  chainId: number;
  router: Address;
  board: Address;
  book: Address;
  engine: Address;
  openBook: Address;
  agents: Address;
  volFeed: Address;
  markets: string[];
  deployBlock: bigint;
};

export function loadM7(path: string): M7 {
  const d = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const need = (k: string) => {
    if (typeof d[k] !== "string") throw new Error(`deployment: missing ${k} (an M7 file is needed)`);
    return getAddress(d[k] as string);
  };
  return {
    chainId: Number(d.chainId),
    router: need("MarkRouter"),
    board: need("QuorumBoard"),
    book: need("PathFundingBook"),
    engine: need("Engine"),
    openBook: need("OpenBook"),
    agents: need("AgentRouter"),
    volFeed: need("VolFeed"),
    markets: d.markets as string[],
    deployBlock: BigInt(Number(d.deployBlock ?? 0)),
  };
}

export const abi = parseAbi([
  "struct Leg { bool isCall; uint128 kWad; int128 qty; }",
  "struct Part { uint256 tempo; uint256 weight; }",
  "struct Quote { address maker; bytes32 name; uint8 sides; uint128 kLoWad; uint128 kHiWad; uint32 tauLo; uint32 tauHi; uint64 sigmaBps; uint128 maxUnits; uint64 validUntil; uint64 nonce; }",
  "struct Mandate { address owner; address agent; bytes32[] markets; uint256 shapes; uint256 maxPremiumPerTrade; uint256 maxPremiumTotal; uint256 deltaBudgetUsd; uint256 vegaBudgetUsd; uint64 expiry; bool closeOnly; uint64 nonce; }",
  "struct BuyArgs { bytes32 market; Leg[] legs; Part[] movement; uint256 units; uint256 maxCost; uint256 deadline; Quote[] quotes; bytes[] sigs; uint256[] offerIds; }",
  "function markWad(bytes32) view returns (uint256)",
  "function volBps(bytes32) view returns (uint256)",
  "function markets(bytes32) view returns (bool listed, uint16 spreadBps, uint128 strikeStepWad)",
  "function read(bytes32, uint256) view returns (uint256 lastSigma, uint256 avgSigma, uint256 boardSigmaAtLast, uint256 count, uint256 updatedAt)",
  "function rawOf(address, uint256) view returns (uint256)",
  "function normNow(uint256) view returns (uint256)",
  "function balanceOf(uint256, address) view returns (uint256)",
  "function hashMandate(Mandate m) view returns (bytes32)",
  "function premiumUsed(bytes32) view returns (uint256)",
  "function deltaUsed(bytes32) view returns (uint256)",
  "function vegaUsed(bytes32) view returns (uint256)",
  "function revoked(address, uint64) view returns (bool)",
  "function buy(bytes32 market, Leg[] legs, Part[] movement, uint256 units, uint256 maxCost, uint256 deadline, Quote[] quotes, bytes[] sigs, uint256[] offerIds) returns (uint256, uint256, uint8)",
  "function agentBuy(Mandate m, bytes sig, BuyArgs a) returns (uint256, uint256, uint256)",
  "function agentSell(Mandate m, bytes sig, uint256 id, uint256 units, uint256 minOut, uint256 deadline) returns (uint256, uint256)",
  "function ownerSell(uint256 id, uint256 units, uint256 minOut, uint256 deadline) returns (uint256, uint256)",
  "function sell(uint256 id, uint256 units, uint256 minOut, uint256 deadline) returns (uint256, uint256)",
  "function revoke(uint64 nonce)",
]);

export const FAMILIES: Record<string, number> = { rise: 1, fall: 2, callSpread: 4, putSpread: 8, swing: 16, other: 32 };
const BUCKETS = ["1 hour", "1 day", "7 days", "30 days"];
const b32 = (m: string) => stringToHex(m, { size: 32 });

type LegIn = { isCall: boolean; strike: number | string; qty: number | string };
const legsOf = (legs: unknown) => {
  if (!Array.isArray(legs) || legs.length === 0) throw new Error("legs: a non-empty array of { isCall, strike, qty } is needed");
  return (legs as LegIn[]).map((l) => ({ isCall: l.isCall === true, kWad: parseEther(String(l.strike)), qty: parseEther(String(l.qty)) }));
};
const tempoOf = (t: unknown) => {
  const n = Number(t ?? 86_400);
  if (!Number.isInteger(n) || n < 3_600 || n > 2_592_000) throw new Error("tempo: whole seconds from 3,600 to 2,592,000");
  return [{ tempo: BigInt(n), weight: 10n ** 18n }];
};

/// The shape family of buyer legs, as AgentRouter.familyOf.
export function familyOf(legs: { isCall: boolean; qty: bigint }[]): string {
  if (legs.length === 1) return legs[0]!.isCall ? "rise" : "fall";
  if (legs.length === 2) {
    if (legs[0]!.isCall && legs[1]!.isCall) return "callSpread";
    if (!legs[0]!.isCall && !legs[1]!.isCall) return "putSpread";
    if (legs[0]!.qty > 0n && legs[1]!.qty > 0n) return "swing";
  }
  return "other";
}

/// Whether a buyer can hold the legs: the payoff never goes below 0 (at S = 0, every strike, and as S grows).
export function buyerSafe(legs: { isCall: boolean; kWad: bigint; qty: bigint }[]): boolean {
  let slope = 0n;
  for (const l of legs) if (l.isCall) slope += l.qty;
  if (slope < 0n) return false;
  const payoff = (s: bigint) => legs.reduce((a, l) => a + l.qty * (l.isCall ? (s > l.kWad ? s - l.kWad : 0n) : l.kWad > s ? l.kWad - s : 0n), 0n);
  if (payoff(0n) < 0n) return false;
  return legs.every((l) => payoff(l.kWad) >= 0n);
}

export function makeTools(client: PublicClient, d: M7, gateway?: string): Tool[] {
  const read = <T>(address: Address, functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  const market = (m: unknown) => {
    const name = String(m ?? "");
    if (!d.markets.includes(name)) throw new Error(`market: one of ${d.markets.join(", ")}`);
    return name;
  };
  const tx = (to: Address, data: Hex) => ({ to, data, value: "0", chainId: d.chainId, note: "unsigned: sign and send it with your own wallet" });

  return [
    {
      name: "chains_by_tempo",
      description: "Indicative call and put values per unit around the mark, for each tempo, at the board's vol (the on-chain router prices every fill).",
      inputSchema: { type: "object", properties: { market: { type: "string" }, tempos: { type: "array", items: { type: "number" } }, strikes: { type: "number" } }, required: ["market"] },
      async run(a) {
        const m = market(a.market);
        const [markWad, sigma, cfg] = await Promise.all([read<bigint>(d.router, "markWad", [b32(m)]), read<bigint>(d.board, "volBps", [b32(m)]), read<readonly [boolean, number, bigint]>(d.engine, "markets", [b32(m)])]);
        const s = Number(formatEther(markWad));
        const step = Number(formatEther(cfg[2]));
        const n = Math.min(10, Math.max(1, Number(a.strikes ?? 3)));
        const tempos = (Array.isArray(a.tempos) ? a.tempos : [3_600, 86_400, 604_800, 2_592_000]).map(Number);
        const atm = Math.round(s / step) * step;
        const ks = Array.from({ length: 2 * n + 1 }, (_, i) => atm + (i - n) * step * Math.max(1, Math.round(s * 0.01 / step)));
        return {
          market: m,
          mark: s,
          sigmaBps: Number(sigma),
          chains: tempos.map((t) => ({
            tempo: t,
            rows: ks.map((k) => ({ strike: k, call: +blendValue(true, s, k, Number(sigma), [{ tempo: t, weight: 1 }]).toFixed(4), put: +blendValue(false, s, k, Number(sigma), [{ tempo: t, weight: 1 }]).toFixed(4) })),
          })),
        };
      },
    },
    {
      name: "vol_feed",
      description: "The open book's vol feed for a market: per tempo bucket, the last fill σ, the size-weighted average, the board σ at the last fill, the fill count.",
      inputSchema: { type: "object", properties: { market: { type: "string" } }, required: ["market"] },
      async run(a) {
        const m = market(a.market);
        const rows = await Promise.all(BUCKETS.map((_, i) => read<readonly [bigint, bigint, bigint, bigint, bigint]>(d.volFeed, "read", [b32(m), BigInt(i)])));
        return { market: m, buckets: rows.map((r, i) => ({ bucket: BUCKETS[i], lastSigmaBps: Number(r[0]), avgSigmaBps: Number(r[1]), boardSigmaAtLastBps: Number(r[2]), fills: Number(r[3]), updatedAt: Number(r[4]) })) };
      },
    },
    {
      name: "shapes",
      description: "The shape families (for mandates) and, given legs (buyer side), their family and whether a buyer can hold them (the payoff never goes below 0).",
      inputSchema: { type: "object", properties: { legs: { type: "array" } } },
      async run(a) {
        const out: Record<string, unknown> = { families: FAMILIES };
        if (a.legs !== undefined) {
          const legs = legsOf(a.legs);
          out.family = familyOf(legs);
          out.buyerSafe = buyerSafe(legs);
        }
        return out;
      },
    },
    {
      name: "quotes",
      description: "The best signed maker quotes for an order, from the maker-gateway (at most 4, one per maker).",
      inputSchema: { type: "object", properties: { market: { type: "string" }, legs: { type: "array" }, tempo: { type: "number" }, units: { type: "string" } }, required: ["market", "legs", "units"] },
      async run(a) {
        if (!gateway) throw new Error("no maker-gateway configured (--gateway)");
        const body = { name: b32(market(a.market)), legs: legsOf(a.legs), movement: tempoOf(a.tempo), units: parseEther(String(a.units)) };
        const res = await fetch(new URL("/best", gateway), { method: "POST", body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) });
        return await res.json();
      },
    },
    {
      name: "positions",
      description: "An owner's positions: held directly (bought through the Engine or the OpenBook) and in its AgentRouter sub-account, with units at the current norm.",
      inputSchema: { type: "object", properties: { owner: { type: "string" } }, required: ["owner"] },
      async run(a) {
        const owner = getAddress(String(a.owner));
        const [direct, viaAgents] = await Promise.all([
          client.getLogs({ address: d.engine, event: parseAbiItem("event ShapeBought(address indexed buyer, uint256 indexed id, bytes32 indexed market, uint256 units, uint256 raw, uint256 sWad, uint256 sigmaBps, int256 unitValueWad, uint256 premium, uint256 fee)"), args: { buyer: owner }, fromBlock: d.deployBlock }),
          client.getLogs({ address: d.agents, event: parseAbiItem("event AgentBought(bytes32 indexed mandate, address indexed owner, uint256 indexed id, uint256 raw, uint256 cost, uint8 kind)"), args: { owner }, fromBlock: d.deployBlock }),
        ]);
        const rows: unknown[] = [];
        for (const id of new Set(direct.map((l) => l.args.id!))) {
          const [raw, norm] = await Promise.all([read<bigint>(d.book, "balanceOf", [id, owner]), read<bigint>(d.book, "normNow", [id])]);
          if (raw > 0n) rows.push({ id: id.toString(), held: "direct", raw: raw.toString(), units: formatEther((raw * norm) / 10n ** 18n) });
        }
        for (const id of new Set(viaAgents.map((l) => l.args.id!))) {
          const [raw, norm] = await Promise.all([read<bigint>(d.agents, "rawOf", [owner, id]), read<bigint>(d.book, "normNow", [id])]);
          if (raw > 0n) rows.push({ id: id.toString(), held: "agentRouter", raw: raw.toString(), units: formatEther((raw * norm) / 10n ** 18n) });
        }
        return { owner, positions: rows };
      },
    },
    {
      name: "mandates",
      description: "A mandate's hash and usage: premium spent (USDC), USD delta and vega in use, whether its nonce is revoked.",
      inputSchema: { type: "object", properties: { mandate: { type: "object" } }, required: ["mandate"] },
      async run(a) {
        const m = mandateOf(a.mandate as Record<string, unknown>);
        const h = await read<Hex>(d.agents, "hashMandate", [m]);
        const [p, dl, vg, rv] = await Promise.all([read<bigint>(d.agents, "premiumUsed", [h]), read<bigint>(d.agents, "deltaUsed", [h]), read<bigint>(d.agents, "vegaUsed", [h]), read<boolean>(d.agents, "revoked", [m.owner, m.nonce])]);
        return { hash: h, premiumUsedUsdc: formatUnits(p, 6), deltaUsedUsd: formatUnits(dl, 6), vegaUsedUsdPerVolPoint: formatUnits(vg, 6), revoked: rv, expired: Number(m.expiry) < Math.floor(Date.now() / 1000) };
      },
    },
    {
      name: "build_mandate",
      description: "An EIP-712 mandate for an owner to sign (domain 'Tourbillon AgentRouter' v1): agent, markets, families, premium caps (USDC), USD delta and vega budgets ('unlimited' allowed), expiry, close-only, nonce.",
      inputSchema: {
        type: "object",
        properties: { owner: { type: "string" }, agent: { type: "string" }, markets: { type: "array" }, families: { type: "array" }, maxPremiumPerTrade: { type: "string" }, maxPremiumTotal: { type: "string" }, deltaBudgetUsd: { type: "string" }, vegaBudgetUsd: { type: "string" }, expiry: { type: "number" }, closeOnly: { type: "boolean" }, nonce: { type: "number" } },
        required: ["owner", "agent", "markets", "families", "maxPremiumPerTrade", "maxPremiumTotal", "expiry", "nonce"],
      },
      async run(a) {
        const fams = (a.families as string[]).map((f) => {
          if (FAMILIES[f] === undefined) throw new Error(`families: from ${Object.keys(FAMILIES).join(", ")}`);
          return FAMILIES[f]!;
        });
        const usd = (v: unknown) => (v === undefined || v === "unlimited" ? 2n ** 256n - 1n : BigInt(Math.round(Number(v) * 1e6)));
        const message = {
          owner: getAddress(String(a.owner)),
          agent: getAddress(String(a.agent)),
          markets: (a.markets as string[]).map((m) => b32(market(m))),
          shapes: BigInt(fams.reduce((x, y) => x | y, 0)),
          maxPremiumPerTrade: usd(a.maxPremiumPerTrade),
          maxPremiumTotal: usd(a.maxPremiumTotal),
          deltaBudgetUsd: usd(a.deltaBudgetUsd),
          vegaBudgetUsd: usd(a.vegaBudgetUsd),
          expiry: BigInt(Number(a.expiry)),
          closeOnly: a.closeOnly === true,
          nonce: BigInt(Number(a.nonce)),
        };
        return { typedData: mandateTypedData(d, message), message };
      },
    },
    {
      name: "build_buy",
      description: "An unsigned buy: through the OpenBook for yourself, or through the AgentRouter under a signed mandate (pass mandate and signature). Uses the gateway's best quotes when configured.",
      inputSchema: { type: "object", properties: { market: { type: "string" }, legs: { type: "array" }, tempo: { type: "number" }, units: { type: "string" }, maxCost: { type: "string" }, deadline: { type: "number" }, mandate: { type: "object" }, signature: { type: "string" } }, required: ["market", "legs", "units", "maxCost"] },
      async run(a) {
        const m = market(a.market);
        const legs = legsOf(a.legs);
        if (!buyerSafe(legs)) throw new Error("legs: a buyer cannot hold this shape (its payoff can go below 0)");
        const movement = tempoOf(a.tempo);
        const units = parseEther(String(a.units));
        const maxCost = BigInt(Math.round(Number(a.maxCost) * 1e6));
        const deadline = BigInt(Number(a.deadline ?? Number((await client.getBlock()).timestamp) + 600));
        let quotes: unknown[] = [];
        let sigs: Hex[] = [];
        if (gateway) {
          const res = await fetch(new URL("/best", gateway), { method: "POST", body: JSON.stringify({ name: b32(m), legs, movement, units }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) }).catch(() => null);
          const body = res ? ((await res.json()) as { quotes?: { quote: Record<string, string>; sig: Hex }[] }) : {};
          quotes = (body.quotes ?? []).map((x) => ({ ...x.quote, sides: Number(x.quote.sides), tauLo: Number(x.quote.tauLo), tauHi: Number(x.quote.tauHi), kLoWad: BigInt(x.quote.kLoWad!), kHiWad: BigInt(x.quote.kHiWad!), sigmaBps: BigInt(x.quote.sigmaBps!), maxUnits: BigInt(x.quote.maxUnits!), validUntil: BigInt(x.quote.validUntil!), nonce: BigInt(x.quote.nonce!) }));
          sigs = (body.quotes ?? []).map((x) => x.sig);
        }
        const buyArgs = { market: b32(m), legs, movement, units, maxCost, deadline, quotes, sigs, offerIds: [] as bigint[] };
        if (a.mandate !== undefined) {
          if (typeof a.signature !== "string") throw new Error("signature: the owner's signature of the mandate is needed");
          const data = encodeFunctionData({ abi, functionName: "agentBuy", args: [mandateOf(a.mandate as Record<string, unknown>), a.signature as Hex, buyArgs] } as never);
          return { ...tx(d.agents, data), from: "the mandate's agent", family: familyOf(legs), quotes: quotes.length };
        }
        const data = encodeFunctionData({ abi, functionName: "buy", args: [buyArgs.market, legs, movement, units, maxCost, deadline, quotes, sigs, []] } as never);
        return { ...tx(d.openBook, data), from: "the buyer (approve USDC to the Engine first)", family: familyOf(legs), quotes: quotes.length };
      },
    },
    {
      name: "build_sell",
      description: "An unsigned sell: from your own holding (Engine), from your AgentRouter sub-account (owner), or by an agent under its mandate.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, units: { type: "string" }, minOut: { type: "string" }, deadline: { type: "number" }, via: { type: "string", enum: ["direct", "owner", "agent"] }, mandate: { type: "object" }, signature: { type: "string" } }, required: ["id", "via"] },
      async run(a) {
        const id = BigInt(String(a.id));
        const units = a.units === undefined || a.units === "all" ? 2n ** 256n - 1n : parseEther(String(a.units));
        const minOut = BigInt(Math.round(Number(a.minOut ?? 0) * 1e6));
        const deadline = BigInt(Number(a.deadline ?? Number((await client.getBlock()).timestamp) + 600));
        if (a.via === "direct") return tx(d.engine, encodeFunctionData({ abi, functionName: "sell", args: [id, units, minOut, deadline] }));
        if (a.via === "owner") return tx(d.agents, encodeFunctionData({ abi, functionName: "ownerSell", args: [id, units, minOut, deadline] }));
        if (a.via === "agent") {
          if (typeof a.signature !== "string" || a.mandate === undefined) throw new Error("mandate and signature are needed");
          return tx(d.agents, encodeFunctionData({ abi, functionName: "agentSell", args: [mandateOf(a.mandate as Record<string, unknown>), a.signature as Hex, id, units, minOut, deadline] } as never));
        }
        throw new Error("via: direct, owner or agent");
      },
    },
  ];
}

export type MandateMsg = {
  owner: Address;
  agent: Address;
  markets: Hex[];
  shapes: bigint;
  maxPremiumPerTrade: bigint;
  maxPremiumTotal: bigint;
  deltaBudgetUsd: bigint;
  vegaBudgetUsd: bigint;
  expiry: bigint;
  closeOnly: boolean;
  nonce: bigint;
};

/// A mandate from JSON (integers as decimal strings or numbers, as `build_mandate` returns them).
export function mandateOf(m: Record<string, unknown>): MandateMsg {
  const big = (v: unknown) => BigInt(String(v));
  return {
    owner: getAddress(String(m.owner)),
    agent: getAddress(String(m.agent)),
    markets: (m.markets as Hex[]).map((x) => x),
    shapes: big(m.shapes),
    maxPremiumPerTrade: big(m.maxPremiumPerTrade),
    maxPremiumTotal: big(m.maxPremiumTotal),
    deltaBudgetUsd: big(m.deltaBudgetUsd),
    vegaBudgetUsd: big(m.vegaBudgetUsd),
    expiry: big(m.expiry),
    closeOnly: m.closeOnly === true,
    nonce: big(m.nonce),
  };
}

export const mandateTypes = {
  Mandate: [
    { name: "owner", type: "address" },
    { name: "agent", type: "address" },
    { name: "markets", type: "bytes32[]" },
    { name: "shapes", type: "uint256" },
    { name: "maxPremiumPerTrade", type: "uint256" },
    { name: "maxPremiumTotal", type: "uint256" },
    { name: "deltaBudgetUsd", type: "uint256" },
    { name: "vegaBudgetUsd", type: "uint256" },
    { name: "expiry", type: "uint64" },
    { name: "closeOnly", type: "bool" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

export function mandateTypedData(d: M7, message: MandateMsg) {
  return { domain: { name: "Tourbillon AgentRouter", version: "1", chainId: d.chainId, verifyingContract: d.agents }, types: mandateTypes, primaryType: "Mandate" as const, message };
}
