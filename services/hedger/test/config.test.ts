import { expect, test } from "bun:test";
import { checkCexForChain, checkOnchainForChain, parseCexArgs, parseOnchainArgs } from "../src/config.ts";

test("hedger-cex: an exchange or fixed positions (a dry run); the sim only on anvil", () => {
  expect(() => parseCexArgs(["--deployment", "d.json"])).toThrow("exactly one of");
  const dry = parseCexArgs(["--deployment", "d.json", "--positions", "BTC=0,ETH=1.5"]);
  expect(dry.dryRun).toBe(true);
  expect(dry.positions!.get("ETH")).toBe(1.5);
  expect(() => parseCexArgs(["--deployment", "d.json", "--exchange", "sim"])).toThrow("--exchange-url");
  const sim = parseCexArgs(["--deployment", "d.json", "--exchange", "sim", "--exchange-url", "http://127.0.0.1:1"]);
  expect(sim.dryRun).toBe(false);
  expect(() => checkCexForChain(sim, 46630)).toThrow("local anvil");
  checkCexForChain(sim, 31337);
  expect(() => parseCexArgs(["--deployment", "d.json", "--exchange", "sim", "--exchange-url", "u", "--positions", "BTC=0"])).toThrow("exactly one of");
  expect(() => parseCexArgs(["--deployment", "d.json", "--positions", "BTC=0", "--hl-user", "0x1"])).toThrow("unknown flag");
  expect(parseCexArgs(["--deployment", "d.json", "--positions", "BTC=0", "--delta-cap", "BTC=1000"]).deltaCapUsd.BTC).toBe(1000);
});

test("hedger-onchain: no key is a dry run; a local key only on anvil; slippage at most 3%", () => {
  expect(parseOnchainArgs(["--deployment", "d.json"]).dryRun).toBe(true);
  const k = parseOnchainArgs(["--deployment", "d.json", "--local-unlocked", "0x00000000000000000000000000000000000000E1"]);
  expect(k.dryRun).toBe(false);
  expect(k.slippageBps).toBe(50);
  expect(() => checkOnchainForChain(k, 46630)).toThrow("local anvil");
  expect(parseOnchainArgs(["--deployment", "d.json", "--keystore", "keeper", "--dry-run"]).dryRun).toBe(true);
  expect(() => parseOnchainArgs(["--deployment", "d.json", "--slippage-bps", "301"])).toThrow("0 to 300");
  expect(() => parseOnchainArgs(["--deployment", "d.json", "--keystore", "a", "--local-unlocked", "0x00000000000000000000000000000000000000E1"])).toThrow("at most one");
});
