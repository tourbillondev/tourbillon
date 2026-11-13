import { readFileSync } from "node:fs";
import { getAddress, type Address } from "viem";

/// Written by contracts/script/DeployM2.s.sol to contracts/deployments/<chainId>-m2.json.
export type M2Deployment = {
  chainId: number;
  book: Address;
  engine: Address;
  markets: string[];
  deployBlock: bigint;
  pool: Address | null; // MainspringPool (M3 file): the poker also keeps its hourly epochs
  writerBook: Address | null; // WriterBook (M4 file): the walker also walks series held by writes
};

export function parseM2Deployment(json: string): M2Deployment {
  const d = JSON.parse(json) as Record<string, unknown>;
  const chainId = Number(d.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error("deployment: missing chainId");
  if (typeof d.PathFundingBook !== "string") throw new Error("deployment: missing PathFundingBook");
  if (typeof d.Engine !== "string") throw new Error("deployment: missing Engine");
  const markets = d.markets;
  if (!Array.isArray(markets) || markets.length === 0 || !markets.every((m) => typeof m === "string" && m.length > 0)) {
    throw new Error("deployment: missing markets");
  }
  return {
    chainId,
    book: getAddress(d.PathFundingBook),
    engine: getAddress(d.Engine),
    markets: markets as string[],
    deployBlock: BigInt(Number(d.deployBlock ?? 0)),
    pool: typeof d.MainspringPool === "string" ? getAddress(d.MainspringPool) : null,
    writerBook: typeof d.WriterBook === "string" ? getAddress(d.WriterBook) : null,
  };
}

export function loadM2Deployment(path: string): M2Deployment {
  return parseM2Deployment(readFileSync(path, "utf8"));
}
