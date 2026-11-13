import { expect, test } from "bun:test";
import { parseEther } from "viem";
import { lowKeys, parseKeys } from "../src/keys.ts";

test("the key list (addresses only, min in HYPE, default 0.2) and the keys below their minimum", () => {
  const keys = parseKeys(JSON.stringify([
    { name: "signer-1", address: "0x00000000000000000000000000000000000000a1" },
    { name: "receipts", address: "0x00000000000000000000000000000000000000a2", min: "0.05" },
  ]));
  expect(keys[0]!.min).toBe(parseEther("0.2"));
  expect(keys[1]!.min).toBe(parseEther("0.05"));
  const low = lowKeys(keys, new Map([[keys[0]!.address, parseEther("0.19")], [keys[1]!.address, parseEther("0.05")]]));
  expect(low).toEqual([{ name: "signer-1", address: keys[0]!.address, balance: 0.19, min: 0.2 }]);
  expect(lowKeys(keys, new Map()).length).toBe(2); // unknown balance counts as empty
  expect(() => parseKeys('[{"name":"a","address":"0x00000000000000000000000000000000000000a1"},{"name":"a","address":"0x00000000000000000000000000000000000000a2"}]')).toThrow("duplicate");
  expect(() => parseKeys('[{"address":"0x00000000000000000000000000000000000000a1"}]')).toThrow("no name");
  expect(() => parseKeys('{"name":"x"}')).toThrow("array");
});
