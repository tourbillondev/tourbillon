import { expect, test } from "bun:test";
import { createPublicClient, http } from "viem";
import { chainFor, ROBINHOOD_TESTNET_ID, robinhoodTestnet } from "../src/chain.ts";

test("Robinhood Chain testnet is chain 46630; local anvil is 31337", () => {
  expect(ROBINHOOD_TESTNET_ID).toBe(46630);
  expect(robinhoodTestnet.id).toBe(46630);
  expect(robinhoodTestnet.testnet).toBe(true);
  expect(chainFor(46630)).toBe(robinhoodTestnet);
  expect(chainFor(31337).id).toBe(31337);
});

test("no default RPC: a client without its own RPC setting refuses to start", () => {
  expect(robinhoodTestnet.rpcUrls.default.http).toEqual([]);
  expect(() => createPublicClient({ chain: robinhoodTestnet, transport: http() })).toThrow();
  expect(() => createPublicClient({ chain: robinhoodTestnet, transport: http("http://127.0.0.1:9") })).not.toThrow();
});

test("any other chain is refused: Robinhood Chain mainnet, the old Elysium testnet, other mainnets", () => {
  for (const id of [4663, 99801, 1, 999, 1338, 42161]) expect(() => chainFor(id)).toThrow("unsupported chain id");
});
