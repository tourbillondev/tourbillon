import { stringToHex, zeroAddress, type Address, type PublicClient } from "viem";

/// The pool's covering-asset table (RH5) as the services read it: a market with a listed token is a stock market,
/// hedged on-chain (hedger-onchain) with its venue health from that hedger; a market without one is a crypto market,
/// hedged at the crypto hedge exchange (hedger-cex).

const poolCoversAbi = [{ type: "function", name: "coverAssets", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
export const coversAbi = [
  { type: "function", name: "coverOf", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }, { type: "uint256" }] },
] as const;

/// The market's tokenized stock { token, scale }, or null for a crypto market.
export async function stockToken(client: PublicClient, pool: Address, market: string): Promise<{ token: Address; scale: bigint } | null> {
  const covers = await client.readContract({ address: pool, abi: poolCoversAbi, functionName: "coverAssets" });
  if (covers === zeroAddress) return null;
  const [token, scale] = await client.readContract({ address: covers, abi: coversAbi, functionName: "coverOf", args: [stringToHex(market, { size: 32 })] });
  return token === zeroAddress ? null : { token, scale };
}
