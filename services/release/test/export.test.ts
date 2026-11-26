import { describe, expect, test } from "bun:test";
import { testNames } from "../src/export.ts";

describe("the export's test names", () => {
  test("plain and conditional tests, under their describe, with routes spelled out", () => {
    const src = [
      'import { test } from "bun:test";',
      'describe("the pool", () => {',
      '  test("NAV and coverage", () => {});',
      '  test.skipIf(!ok)("reads equal the chain", async () => {}, 240_000);',
      "});",
      "test(`each ${route} answers`, () => {});",
      'test.skipIf(!haveFoundry() || !havePostgres())("rows match the contract", async () => {});',
      '// test("a comment is not a test", …)',
      "test.skipIf(!ok)(",
      '  "the six laws with their live numbers",',
      "  async () => {},",
      ");",
    ].join("\n");
    expect(testNames(src, "services/api/test/pool-anvil.test.ts")).toEqual([
      "pool-anvil.test.ts: the pool > NAV and coverage",
      "pool-anvil.test.ts: the pool > reads equal the chain",
      "pool-anvil.test.ts: each <each route> answers",
      "pool-anvil.test.ts: rows match the contract",
      "pool-anvil.test.ts: the six laws with their live numbers",
    ]);
  });
});
