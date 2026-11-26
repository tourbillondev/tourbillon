import { defineChain, type Chain } from "viem";
import { foundry } from "viem/chains";

/// Robinhood Chain testnet (an Arbitrum Orbit L2), defined by hand.
/// - The chain id comes from the studio's record, not the spec: (U) until RobinhoodProbe measures it.
/// - The gas token is (U) in the spec (Backend header); ETH is assumed until it is measured.
/// - **No default RPC.** A library's built-in RPC list for a chain can include third-party endpoints, so every
///   service takes its RPC from its own settings (`--rpc`). Without one, the client refuses to start.
export const ROBINHOOD_TESTNET_ID = 46630;

export const robinhoodTestnet = defineChain({
  id: ROBINHOOD_TESTNET_ID,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [] } },
  testnet: true,
});

export const LOCAL_CHAIN_ID = 31337;

/// The only chains this service runs on. Mainnet (4663) is deliberately absent.
export function chainFor(id: number): Chain {
  if (id === robinhoodTestnet.id) return robinhoodTestnet;
  if (id === LOCAL_CHAIN_ID) return foundry;
  throw new Error(`unsupported chain id ${id} (Robinhood Chain testnet ${ROBINHOOD_TESTNET_ID} or local ${LOCAL_CHAIN_ID} only)`);
}
