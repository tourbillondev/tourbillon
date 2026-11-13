import { readFileSync } from "node:fs";
import { getAddress, type Address } from "viem";

/// Written by contracts/script/DeployM1.s.sol to contracts/deployments/<chainId>.json.
export type Deployment = {
  chainId: number;
  board: Address;
  router: Address;
  markets: string[];
  signers: Address[];
};

export function parseDeployment(json: string): Deployment {
  const d = JSON.parse(json) as Record<string, unknown>;
  const chainId = Number(d.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error("deployment: missing chainId");
  if (typeof d.QuorumBoard !== "string") throw new Error("deployment: missing QuorumBoard");
  if (typeof d.MarkRouter !== "string") throw new Error("deployment: missing MarkRouter");
  const markets = d.markets;
  if (!Array.isArray(markets) || markets.length === 0 || !markets.every((m) => typeof m === "string" && m.length > 0)) {
    throw new Error("deployment: missing markets");
  }
  const signers = Array.isArray(d.signers) ? d.signers.map((s) => getAddress(String(s))) : [];
  return {
    chainId,
    board: getAddress(d.QuorumBoard),
    router: getAddress(d.MarkRouter),
    markets: markets as string[],
    signers,
  };
}

export function loadDeployment(path: string): Deployment {
  return parseDeployment(readFileSync(path, "utf8"));
}
