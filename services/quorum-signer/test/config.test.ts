import { expect, test } from "bun:test";
import { parseEther } from "viem";
import { checkForChain, parseArgs } from "../src/config.ts";
import { parseDeployment } from "../src/deployment.ts";

const A = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

test("parses a keystore run", () => {
  const c = parseArgs(["--deployment", "d.json", "--keystore", "tourbillon-signer-1"]);
  expect(c.key).toEqual({ type: "keystore", name: "tourbillon-signer-1", dir: undefined });
  expect(c.dryRun).toBe(false);
});

test("exactly one key input; --watch only with --dry-run; no unknown flags", () => {
  expect(() => parseArgs(["--deployment", "d.json"])).toThrow("exactly one");
  expect(() => parseArgs(["--deployment", "d.json", "--keystore", "a", "--watch", A])).toThrow("exactly one");
  expect(() => parseArgs(["--deployment", "d.json", "--watch", A])).toThrow("--dry-run only");
  expect(() => parseArgs(["--deployment", "d.json", "--watch", A, "--dry-run", "--private-key", "x"])).toThrow("unknown flag");
  expect(() => parseArgs(["--keystore", "a"])).toThrow("--deployment is required");
});

test("unlocked accounts and test values are refused off the local chain", () => {
  const unlocked = parseArgs(["--deployment", "d.json", "--local-unlocked", A]);
  expect(() => checkForChain(unlocked, 99801)).toThrow("local anvil");
  checkForChain(unlocked, 31337);
  const fixed = parseArgs(["--deployment", "d.json", "--watch", A, "--dry-run", "--test-marks", "BTC=100000"]);
  expect(fixed.testMarks?.get("BTC")).toBe(parseEther("100000"));
  expect(() => checkForChain(fixed, 99801)).toThrow("local anvil");
});

test("reads the deployment file written by DeployM1", () => {
  const d = parseDeployment(
    JSON.stringify({
      chainId: 31337,
      QuorumBoard: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
      MarkRouter: "0x2279b7a0a67db372996a5fab50d91eaa73d2ebe6",
      markets: ["BTC", "ETH", "HYPE"],
      signers: [A],
    }),
  );
  expect(d.chainId).toBe(31337);
  expect(d.board).toBe("0x5FbDB2315678afecb367f032d93F642f64180aa3");
  expect(d.markets).toEqual(["BTC", "ETH", "HYPE"]);
  expect(() => parseDeployment(JSON.stringify({ chainId: 31337 }))).toThrow("QuorumBoard");
});
