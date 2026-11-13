import { expect, test } from "bun:test";
import { checkForChain, parseArgs } from "../src/config.ts";

const BASE = ["--deployment", "d.json", "--hl-user", "0x00000000000000000000000000000000000000E1"];

test("dry run by default; the sim needs a local URL on anvil; testnet needs a keystore and the explicit approval flag", () => {
  expect(parseArgs(BASE).venue).toBe("none");
  expect(() => parseArgs([...BASE, "--venue", "sim"])).toThrow("--venue-url");
  const sim = parseArgs([...BASE, "--venue", "sim", "--venue-url", "http://127.0.0.1:1"]);
  expect(() => checkForChain(sim, 99801)).toThrow("local anvil");
  checkForChain(sim, 31337);
  expect(() => parseArgs([...BASE, "--venue", "hl-testnet"])).toThrow("owner's yes");
  expect(() => parseArgs([...BASE, "--venue", "hl-testnet", "--agent-keystore", "tourbillon-hedger-agent"])).toThrow("owner's yes");
  expect(parseArgs([...BASE, "--venue", "hl-testnet", "--agent-keystore", "x", "--testnet-orders-approved"]).venue).toBe("hl-testnet");
  expect(() => parseArgs([...BASE, "--venue", "mainnet"])).toThrow("sim or hl-testnet");
  expect(() => parseArgs(["--deployment", "d.json", "--positions", "BTC=0", "--venue", "sim", "--venue-url", "http://127.0.0.1:1"])).toThrow();
});
