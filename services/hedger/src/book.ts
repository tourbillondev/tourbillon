import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, formatEther, stringToHex, zeroAddress, type Address, type PublicClient } from "viem";
import type { Leg, Position } from "./delta.ts";

/// Reads the pool's open positions on a market from the chain: open series (pool.openSeries), raw held against the
/// pool (pool.seriesRaw) less raw the pool holds from writers (pool.writtenRaw, M4) and less raw matched to makers,
/// writer offers and auction winners (pool.matchedRawOf, M6: their collateral carries it, so the pool does not hedge
/// it; raw a buyback left uncovered is no longer matched and is hedged again), terms (book.seriesOf for a single
/// leg, book.shapeOf for a shape). Units use a WALKED norm: book.accrue simulated with a read-only call (no
/// transaction), so a series that is behind the latest sample is not overstated (the M2 step 6 finding).

export const poolAbi = [
  { type: "function", name: "openSeries", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256[]" }] },
  { type: "function", name: "seriesRaw", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "writtenRaw", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "matchedRawOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "whype", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "whypeMarket", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
] as const;

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export const bookAbi = [
  {
    type: "function",
    name: "seriesOf",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [
      { type: "bytes32", name: "name" },
      { type: "bool", name: "isCall" },
      { type: "uint128", name: "kWad" },
      { type: "tuple[]", name: "movement", components: [{ type: "uint256", name: "tempo" }, { type: "uint256", name: "weight" }] },
    ],
  },
  {
    type: "function",
    name: "shapeOf",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [
      { type: "bytes32", name: "name" },
      { type: "tuple[]", name: "legs", components: [{ type: "bool", name: "isCall" }, { type: "uint128", name: "kWad" }, { type: "int128", name: "qty" }] },
      { type: "tuple[]", name: "movement", components: [{ type: "uint256", name: "tempo" }, { type: "uint256", name: "weight" }] },
    ],
  },
  { type: "function", name: "isShape", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "accrue",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint256" }, { type: "uint256" }],
    outputs: [{ type: "uint256", name: "norm" }, { type: "bool", name: "done" }],
  },
] as const;

export const sourcesAbi = [
  { type: "function", name: "markWad", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "volBps", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
] as const;

export const MAX_UINT = 2n ** 256n - 1n;
const WAD = 10n ** 18n;

/// The walked norm of a series (WAD), from a simulated accrue with no step limit.
export async function walkedNorm(client: PublicClient, book: Address, id: bigint): Promise<bigint> {
  const { result } = await client.simulateContract({ address: book, abi: bookAbi, functionName: "accrue", args: [id, MAX_UINT] });
  return result[0];
}

/// Raw of a series matched to outside writers (M6); 0 on a pool without the open book (M3/M4 deployments: the call
/// returns no data). Any other failure (an RPC error) is thrown, so a pass never hedges matched raw by mistake.
export async function matchedRaw(client: PublicClient, pool: Address, id: bigint): Promise<bigint> {
  try {
    return await client.readContract({ address: pool, abi: poolAbi, functionName: "matchedRawOf", args: [id] });
  } catch (e) {
    if (e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionZeroDataError || x instanceof ContractFunctionRevertedError)) return 0n;
    throw e;
  }
}

export async function readPositions(client: PublicClient, pool: Address, book: Address, market: string): Promise<Position[]> {
  const ids = await client.readContract({ address: pool, abi: poolAbi, functionName: "openSeries", args: [stringToHex(market, { size: 32 })] });
  const out: Position[] = [];
  for (const id of ids) {
    const [raw, wraw, mraw, shape, norm] = await Promise.all([
      client.readContract({ address: pool, abi: poolAbi, functionName: "seriesRaw", args: [id] }),
      client.readContract({ address: pool, abi: poolAbi, functionName: "writtenRaw", args: [id] }),
      matchedRaw(client, pool, id),
      client.readContract({ address: book, abi: bookAbi, functionName: "isShape", args: [id] }),
      walkedNorm(client, book, id),
    ]);
    let legs: Leg[];
    let movement: readonly { tempo: bigint; weight: bigint }[];
    if (shape) {
      const [, ls, mv] = await client.readContract({ address: book, abi: bookAbi, functionName: "shapeOf", args: [id] });
      legs = ls.map((l) => ({ isCall: l.isCall, k: Number(formatEther(l.kWad)), qty: Number(formatEther(l.qty)) }));
      movement = mv;
    } else {
      const [, isCall, kWad, mv] = await client.readContract({ address: book, abi: bookAbi, functionName: "seriesOf", args: [id] });
      legs = [{ isCall, k: Number(formatEther(kWad)), qty: 1 }];
      movement = mv;
    }
    // units against the pool: bought and not matched (the pool is short) less written (the pool is long)
    const carried = raw > mraw ? raw - mraw : 0n;
    const units = Number(formatEther((carried * norm) / WAD)) - Number(formatEther((wraw * norm) / WAD));
    out.push({ legs, parts: movement.map((p) => ({ tempo: Number(p.tempo), weight: Number(formatEther(p.weight)) })), units });
  }
  return out;
}

/// WHYPE the pool holds outright (received in buybacks), in coins, if `market` is the market whose mark values it
/// (M4 decision A); 0 otherwise. WHYPE locked in the WriterBook belongs to writers and is not counted.
export async function poolHeldCoins(client: PublicClient, pool: Address, market: string): Promise<number> {
  const [token, whypeMarket] = await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: "whype" }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "whypeMarket" }),
  ]);
  if (token === zeroAddress || whypeMarket !== stringToHex(market, { size: 32 })) return 0;
  const bal = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [pool] });
  return Number(formatEther(bal));
}
