import { readFileSync } from "node:fs";
import { formatEther, getAddress, type Address, type Hex, type PublicClient } from "viem";
import type { Chain } from "./server.ts";

/// Reads for the gateway and the maker bot: VolQuoteBook (fills, cancels), MakerVault (free balances), the router's
/// mark and the board's vol. Written by contracts/script/DeployM6.s.sol to contracts/deployments/<chainId>-m6.json.

export type M6Deployment = {
  chainId: number;
  usdc: Address;
  router: Address;
  board: Address;
  vault: Address;
  quoteBook: Address;
  openBook: Address;
  markets: string[];
};

export function parseM6Deployment(json: string): M6Deployment {
  const d = JSON.parse(json) as Record<string, unknown>;
  const need = (k: string) => {
    if (typeof d[k] !== "string") throw new Error(`deployment: missing ${k} (an M6 file is needed)`);
    return getAddress(d[k] as string);
  };
  return {
    chainId: Number(d.chainId),
    usdc: need("MockUSDC"),
    router: need("MarkRouter"),
    board: need("QuorumBoard"),
    vault: need("MakerVault"),
    quoteBook: need("VolQuoteBook"),
    openBook: need("OpenBook"),
    markets: d.markets as string[],
  };
}

export const loadM6Deployment = (path: string) => parseM6Deployment(readFileSync(path, "utf8"));

export const quoteBookAbi = [
  { type: "function", name: "filled", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint64" }], outputs: [{ type: "uint128" }] },
  { type: "function", name: "cancelled", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint64" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "cancel", stateMutability: "nonpayable", inputs: [{ type: "uint64" }], outputs: [] },
] as const;

export const vaultAbi = [
  { type: "function", name: "freeOf", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "lockedOf", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
] as const;

export const sourcesAbi = [
  { type: "function", name: "markWad", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "volBps", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
] as const;

export function chainReader(client: PublicClient, d: M6Deployment): Chain {
  return {
    chainId: d.chainId,
    quoteBook: d.quoteBook,
    now: async () => (await client.getBlock()).timestamp,
    filled: (maker, nonce) => client.readContract({ address: d.quoteBook, abi: quoteBookAbi, functionName: "filled", args: [maker, nonce] }),
    cancelled: (maker, nonce) => client.readContract({ address: d.quoteBook, abi: quoteBookAbi, functionName: "cancelled", args: [maker, nonce] }),
    freeUsdc: (maker) => client.readContract({ address: d.vault, abi: vaultAbi, functionName: "freeOf", args: [maker, d.usdc] }),
    markOf: async (name: Hex) => {
      try {
        return Number(formatEther(await client.readContract({ address: d.router, abi: sourcesAbi, functionName: "markWad", args: [name] })));
      } catch {
        return null;
      }
    },
  };
}
