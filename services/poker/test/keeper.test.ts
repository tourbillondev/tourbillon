import { expect, test } from "bun:test";
import { decideKeeper, EPOCH_S } from "../src/keeper.ts";

const T = 1_800_000_000;

test("keeper: mark while marking, settle a finished epoch, start once the hour (+ role offset) is up", () => {
  const base = { marking: false, epoch: 3n, lastSettled: 3n, epochStart: T };
  expect(decideKeeper({ ...base, marking: true }, T + 10, "primary")).toBe("mark");
  expect(decideKeeper({ ...base, epoch: 4n }, T + 10, "primary")).toBe("settle");
  expect(decideKeeper(base, T + EPOCH_S + 59, "primary")).toBe("wait");
  expect(decideKeeper(base, T + EPOCH_S + 60, "primary")).toBe("start");
  expect(decideKeeper(base, T + EPOCH_S + 599, "backup")).toBe("wait");
  expect(decideKeeper(base, T + EPOCH_S + 600, "backup")).toBe("start");
  expect(decideKeeper({ marking: false, epoch: 0n, lastSettled: 0n, epochStart: 0 }, T, "backup")).toBe("start"); // never started
});
