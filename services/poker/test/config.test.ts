import { expect, test } from "bun:test";
import { checkForChain, parseArgs } from "../src/config.ts";
import { parseM2Deployment } from "../src/deployment.ts";

const A = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

test("arguments: role defaults to primary; exactly one key input; watch only in dry run", () => {
  const c = parseArgs(["--deployment", "d.json", "--keystore", "tourbillon-poker"]);
  expect(c.role).toBe("primary");
  expect(parseArgs(["--deployment", "d.json", "--watch", A, "--dry-run", "--role", "backup"]).role).toBe("backup");
  expect(() => parseArgs(["--deployment", "d.json"])).toThrow("exactly one");
  expect(() => parseArgs(["--deployment", "d.json", "--watch", A])).toThrow("--dry-run only");
  expect(() => parseArgs(["--deployment", "d.json", "--keystore", "a", "--role", "third"])).toThrow("primary or backup");
  expect(() => parseArgs(["--deployment", "d.json", "--keystore", "a", "--private-key", "x"])).toThrow("unknown flag");
  expect(() => checkForChain(parseArgs(["--deployment", "d.json", "--local-unlocked", A]), 99801)).toThrow("local anvil");
});

test("reads the M2 deployment file", () => {
  const d = parseM2Deployment(
    JSON.stringify({
      chainId: 31337,
      PathFundingBook: "0x68b1d87f95878fe05b998f19b66f4baba5de1aed",
      Engine: "0x3aa5ebb10dc797cac828524e59a333d0a371443c",
      markets: ["BTC", "ETH", "HYPE"],
      deployBlock: 12,
    }),
  );
  expect(d.book).toBe("0x68B1D87F95878fE05B998F19b66F4baba5De1aed");
  expect(d.markets).toEqual(["BTC", "ETH", "HYPE"]);
  expect(d.deployBlock).toBe(12n);
  expect(d.writerBook).toBeNull();
  const m4 = parseM2Deployment(
    JSON.stringify({
      chainId: 31337,
      PathFundingBook: "0x68b1d87f95878fe05b998f19b66f4baba5de1aed",
      Engine: "0x3aa5ebb10dc797cac828524e59a333d0a371443c",
      WriterBook: "0x59b670e9fa9d0a427751af201d676719a970857b",
      markets: ["BTC"],
    }),
  );
  expect(m4.writerBook).toBe("0x59b670e9fA9D0A427751Af201D676719a970857b");
  expect(() => parseM2Deployment(JSON.stringify({ chainId: 31337, Engine: "0x3aa5ebb10dc797cac828524e59a333d0a371443c" }))).toThrow("PathFundingBook");
});
