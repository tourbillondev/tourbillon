import { expect, test } from "bun:test";
import { hookLimit, within } from "../src/hooks.ts";

// A setup or teardown hook past its limit fails at once, naming its test file and step (RH14: a hook once hung 81 min).
test("a hook past its limit fails with its file and step named; one within it passes its result through", async () => {
  const slow = within(import.meta.path, "setup", 50, () => new Promise((r) => setTimeout(r, 2_000)));
  await expect(slow()).rejects.toThrow("services/common/test/hooks.test.ts: setup did not finish in 0.05 s");
  expect(await within(import.meta.path, "teardown", 1_000, async () => 7)()).toBe(7);
  expect(await within(import.meta.path, "teardown", 1_000, () => 8)()).toBe(8); // a plain function works too
  await expect(within(import.meta.path, "setup", 1_000, async () => { throw new Error("own failure"); })()).rejects.toThrow("own failure");
  expect(hookLimit(60_000)).toBe(65_000); // bun's own limit sits above, so this message is the one reported
});
