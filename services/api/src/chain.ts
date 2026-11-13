import { readFileSync } from "node:fs";
import { encodeAbiParameters, formatEther, formatUnits, getAddress, keccak256, parseAbi, stringToHex, toHex, type Address, type Hex, type PublicClient } from "viem";

/// Chain reads for the API: market and pool state, and the exact buy quote. The quote simulates the real
/// `OpenBook.buy` (the cheapest of the pool, the given maker quotes and offers) from a dummy buyer whose USDC balance and
/// allowance are set for the call only (a state override: nothing is sent, nothing changes on-chain). The token's storage
/// slots are found once by probing; if that fails the API says so instead of guessing a price.

export type Dep = {
  chainId: number;
  router: Address;
  board: Address;
  engine: Address;
  pool: Address;
  book: Address;
  openBook: Address;
  usdc: Address;
  receipts: Address | null;
  markets: string[];
};

export function loadDep(path: string): Dep {
  const d = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const need = (k: string) => {
    if (typeof d[k] !== "string") throw new Error(`deployment: missing ${k}`);
    return getAddress(d[k] as string);
  };
  return {
    chainId: Number(d.chainId),
    router: need("MarkRouter"),
    board: need("QuorumBoard"),
    engine: need("Engine"),
    pool: need("MainspringPool"),
    book: need("PathFundingBook"),
    openBook: need("OpenBook"),
    usdc: need("MockUSDC"),
    receipts: typeof d.ReceiptRoots === "string" ? getAddress(d.ReceiptRoots) : null,
    markets: d.markets as string[],
  };
}

export const abi = parseAbi([
  "struct Leg { bool isCall; uint128 kWad; int128 qty; }",
  "struct Part { uint256 tempo; uint256 weight; }",
  "struct Quote { address maker; bytes32 name; uint8 sides; uint128 kLoWad; uint128 kHiWad; uint32 tauLo; uint32 tauHi; uint64 sigmaBps; uint128 maxUnits; uint64 validUntil; uint64 nonce; }",
  "function markWad(bytes32) view returns (uint256)",
  "function volBps(bytes32) view returns (uint256)",
  "function markets(bytes32) view returns (bool listed, uint16 spreadBps, uint128 strikeStepWad)",
  "function buysPaused() view returns (bool)",
  "function navNow() view returns (uint256)",
  "function available() view returns (uint256)",
  "function stressedLiability() view returns (uint256)",
  "function opensPaused() view returns (bool)",
  "function depositsPaused() view returns (bool)",
  "function marketPaused(bytes32) view returns (bool)",
  "function round() view returns (uint256)",
  "function rounds(uint256) view returns (uint256, uint256, bool, bool, uint256, uint256, uint256, uint256, uint256, uint64)",
  "function notionalCap(bytes32) view returns (uint256)",
  "function openNotional(bytes32) view returns (uint256)",
  "function directionalCap(bytes32) view returns (uint256)",
  "function directional(bytes32) view returns (uint256)",
  "function normNow(uint256) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function lastEpoch() view returns (uint256)",
  "function anyPosted() view returns (bool)",
  "function buy(bytes32 market, Leg[] legs, Part[] movement, uint256 units, uint256 maxCost, uint256 deadline, Quote[] quotes, bytes[] sigs, uint256[] offerIds) returns (uint256, uint256, uint8)",
]);

export const b32 = (m: string) => stringToHex(m, { size: 32 });
export const usdc = (v: bigint) => formatUnits(v, 6);
export const QUOTER = "0x000000000000000000000000000000000000ab01" as Address; // a dummy buyer for quotes, never a real account
const BIG = 10n ** 30n;

export function makeReads(client: PublicClient, d: Dep) {
  const read = async <T>(address: Address, functionName: string, args: readonly unknown[] = []): Promise<T> =>
    client.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  const maybe = async <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

  let slots: { balance: Hex; allowance: Hex } | null | undefined;
  async function findSlots(): Promise<{ balance: Hex; allowance: Hex } | null> {
    if (slots !== undefined) return slots;
    const word = (v: bigint) => toHex(v, { size: 32 });
    const balSlot = (i: number) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [QUOTER, BigInt(i)]));
    const allowSlot = (i: number) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [d.engine, keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [QUOTER, BigInt(i)]))]));
    let balance: Hex | null = null;
    let allowance: Hex | null = null;
    for (let i = 0; i <= 160 && (!balance || !allowance); i++) {
      if (!balance) {
        const s = balSlot(i);
        const v = await maybe(client.readContract({ address: d.usdc, abi, functionName: "balanceOf", args: [QUOTER], stateOverride: [{ address: d.usdc, stateDiff: [{ slot: s, value: word(BIG) }] }] } as never) as Promise<bigint>);
        if (v === BIG) balance = s;
      }
      if (!allowance) {
        const s = allowSlot(i);
        const v = await maybe(client.readContract({ address: d.usdc, abi, functionName: "allowance", args: [QUOTER, d.engine], stateOverride: [{ address: d.usdc, stateDiff: [{ slot: s, value: word(BIG) }] }] } as never) as Promise<bigint>);
        if (v === BIG) allowance = s;
      }
    }
    slots = balance && allowance ? { balance, allowance } : null;
    return slots;
  }

  return {
    read,
    maybe,
    async status() {
      const [buysPaused, nav, available, stressed, opensPaused, depositsPaused, round, head] = await Promise.all([
        read<boolean>(d.engine, "buysPaused"),
        read<bigint>(d.pool, "navNow"),
        read<bigint>(d.pool, "available"),
        read<bigint>(d.pool, "stressedLiability"),
        read<boolean>(d.pool, "opensPaused"),
        read<boolean>(d.pool, "depositsPaused"),
        read<bigint>(d.pool, "round"),
        client.getBlock(),
      ]);
      const last = round > 0n ? await read<readonly unknown[]>(d.pool, "rounds", [round - 1n]) : null;
      const markets = await Promise.all(
        d.markets.map(async (m) => ({
          market: m,
          markFresh: (await maybe(read<bigint>(d.router, "markWad", [b32(m)]))) !== null,
          volFresh: (await maybe(read<bigint>(d.board, "volBps", [b32(m)]))) !== null,
          opensPaused: await read<boolean>(d.pool, "marketPaused", [b32(m)]),
        })),
      );
      let receipts: { lastEpoch: number | null } | null = null;
      if (d.receipts) {
        const any = await maybe(read<boolean>(d.receipts, "anyPosted"));
        receipts = { lastEpoch: any ? Number(await read<bigint>(d.receipts, "lastEpoch")) : null };
      }
      return {
        chainId: d.chainId,
        block: head.number.toString(),
        blockTime: Number(head.timestamp),
        opens: { buysPaused, drawdownPaused: opensPaused, depositsPaused },
        pool: {
          nav: usdc(nav),
          navPerShare: last ? usdc(last[8] as bigint) : null,
          lastSettlement: last ? Number(last[9] as bigint) : null,
          available: usdc(available),
          stressedLiability: usdc(stressed),
          covered: available >= stressed,
        },
        markets,
        receipts,
      };
    },
    async markets() {
      return Promise.all(
        d.markets.map(async (m) => {
          const [cfg, mark, vol, nCap, nUse, dCap, dUse, paused] = await Promise.all([
            read<readonly [boolean, number, bigint]>(d.engine, "markets", [b32(m)]),
            maybe(read<bigint>(d.router, "markWad", [b32(m)])),
            maybe(read<bigint>(d.board, "volBps", [b32(m)])),
            read<bigint>(d.pool, "notionalCap", [b32(m)]),
            read<bigint>(d.pool, "openNotional", [b32(m)]),
            read<bigint>(d.pool, "directionalCap", [b32(m)]),
            read<bigint>(d.pool, "directional", [b32(m)]),
            read<boolean>(d.pool, "marketPaused", [b32(m)]),
          ]);
          return {
            market: m,
            listed: cfg[0],
            spreadBps: cfg[1],
            strikeStep: formatEther(cfg[2]),
            mark: mark === null ? null : formatEther(mark),
            volBps: vol === null ? null : Number(vol),
            opensPaused: paused,
            caps: { notional: usdc(nCap), notionalUsed: usdc(nUse), directional: usdc(dCap), directionalUsed: usdc(dUse) },
          };
        }),
      );
    },
    /// The exact cost (premium + fee, USDC) and source of a buy at the current block, or null with a reason.
    async quoteBuy(args: readonly unknown[]): Promise<{ ok: true; cost: bigint; kind: number } | { ok: false; reason: string }> {
      const s = await findSlots();
      if (!s) return { ok: false, reason: "quote simulation unavailable for this token (storage not found)" };
      const word = toHex(BIG, { size: 32 });
      try {
        const { result } = await client.simulateContract({ address: d.openBook, abi, functionName: "buy", args, account: QUOTER, stateOverride: [{ address: d.usdc, stateDiff: [{ slot: s.balance, value: word }, { slot: s.allowance, value: word }] }] } as never);
        const [, cost, kind] = result as readonly [bigint, bigint, number];
        return { ok: true, cost, kind };
      } catch (e) {
        const m = /reverted with the following (?:signature|reason):?\s*\n?\s*([^\n]+)/.exec((e as Error).message);
        return { ok: false, reason: `the buy would revert${m ? `: ${m[1]!.trim()}` : ""}` };
      }
    },
    normNow: (id: bigint) => read<bigint>(d.book, "normNow", [id]),
  };
}

export type Reads = ReturnType<typeof makeReads>;
