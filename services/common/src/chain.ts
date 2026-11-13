import { defineChain, type Chain } from "viem";
import { foundry } from "viem/chains";

/// Elysium testnet (Kinetiq's Hyperliquid L2), defined by hand: viem's built-in `elysiumTestnet` is a different
/// chain (id 1338). Facts measured in M1 step 1: chain id 99801, base fee 0.1 gwei, ~221 ms blocks.
export const elysiumTestnet = defineChain({
  id: 99801,
  name: "Elysium Testnet",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.elysium.kinetiq.xyz"] } },
  blockExplorers: { default: { name: "Elysium Explorer", url: "https://testnet.elysium.kinetiq.xyz" } },
  testnet: true,
});

export const LOCAL_CHAIN_ID = 31337;

/// The only chains this service runs on. Mainnet is deliberately absent.
export function chainFor(id: number): Chain {
  if (id === elysiumTestnet.id) return elysiumTestnet;
  if (id === LOCAL_CHAIN_ID) return foundry;
  throw new Error(`unsupported chain id ${id} (testnet 99801 or local 31337 only)`);
}
