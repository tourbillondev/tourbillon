import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress } from "viem";
import { parseM2Deployment } from "../../poker/src/deployment.ts";
import { parseM6Deployment } from "../../maker-gateway/src/chain.ts";
import { parseM7Deployment } from "../../receipts/src/collect.ts";
import { loadM7 } from "../../mcp/src/tools.ts";

// M7 step 10: the M7 deployment file (DeployM7) is a superset of the M6 file, so every service reads it unchanged.
const keys = [
  "MarkRouter", "QuorumBoard", "QuorumMarkSource", "MockUSDC", "MockWHYPE", "MainspringPool", "PathFundingBook", "WriterBook", "MakerVault", "MatchBook",
  "VolQuoteBook", "OpenBook", "VolFeed", "RiskAuction", "Engine", "Safe", "Guardian", "Timelock", "SafeSingleton", "SafeProxyFactory", "ReceiptRoots", "AgentRouter",
  "deployer", "admin", "riskPauser", "receiptsPoster", "protocolRecipient",
];

test("every service reads an M7 deployment file", () => {
  const d: Record<string, unknown> = { chainId: 31337, markets: ["BTC", "ETH", "HYPE"], deployBlock: 7, timelockDelay: 3600 };
  keys.forEach((k, i) => (d[k] = getAddress(`0x${(0x1000 + i).toString(16).padStart(40, "0")}`)));
  const json = JSON.stringify(d);
  const m2 = parseM2Deployment(json); // poker: walker, keeper
  expect(m2.pool).toBe(d.MainspringPool as `0x${string}`);
  expect(m2.writerBook).toBe(d.WriterBook as `0x${string}`);
  expect(parseM6Deployment(json).openBook).toBe(d.OpenBook as `0x${string}`); // maker-gateway, maker bot
  expect(parseM7Deployment(json).receipts).toBe(d.ReceiptRoots as `0x${string}`); // receipts
  const tmp = mkdtempSync(join(tmpdir(), "m7-file-"));
  writeFileSync(join(tmp, "m7.json"), json);
  expect(loadM7(join(tmp, "m7.json")).agents).toBe(d.AgentRouter as `0x${string}`); // mcp
  rmSync(tmp, { recursive: true, force: true });
  // an M6 file is refused by the M7-only services, with a clear reason
  const m6only = { ...d };
  delete m6only.ReceiptRoots;
  expect(() => parseM7Deployment(JSON.stringify(m6only))).toThrow("an M7 file is needed");
});
