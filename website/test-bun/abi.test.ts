import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "../scripts/abi.ts";

// The website's contract interface is generated from the Foundry build; this fails when a contract changed and the
// generated file was not remade (bun scripts/abi.ts).
test("abi.generated.mjs matches the contracts' build", () => {
  expect(readFileSync(join(import.meta.dir, "../src/live/abi.generated.mjs"), "utf8")).toBe(build());
});
