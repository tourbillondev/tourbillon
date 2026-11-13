import { expect, test } from "bun:test";
import { parseEther } from "viem";
import { LOW_BALANCE, MAX_FEE_PER_GAS, MIN_GAS_LIMIT, withHeadroom } from "../src/gas.ts";

test("gas policy: 1 gwei cap, 0.2 HYPE warning", () => {
  expect(MAX_FEE_PER_GAS).toBe(1_000_000_000n);
  expect(LOW_BALANCE).toBe(parseEther("0.2"));
  expect(withHeadroom(100_000n)).toBe(MIN_GAS_LIMIT);
  expect(withHeadroom(200_000n)).toBe(400_000n);
});
