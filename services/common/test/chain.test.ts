import { expect, test } from "bun:test";
import { chainFor, elysiumTestnet } from "../src/chain.ts";

test("Elysium testnet is chain 99801 with HYPE gas", () => {
  expect(elysiumTestnet.id).toBe(99801);
  expect(elysiumTestnet.nativeCurrency.symbol).toBe("HYPE");
  expect(chainFor(99801)).toBe(elysiumTestnet);
  expect(chainFor(31337).id).toBe(31337);
});

test("any other chain is refused, mainnets included", () => {
  for (const id of [1, 999, 1338, 42161]) expect(() => chainFor(id)).toThrow("unsupported chain id");
});
