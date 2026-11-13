import { expect, test } from "bun:test";
import { lintText } from "../src/words.ts";

test("the spec's wording rules (Overview section 9)", () => {
  const bad: [string, string][] = [
    ["LPs earn 12% APY on deposits", "return-wording"],
    ["a 20% return on your capital", "return-wording"],
    ["writers collect passive income", "income-wording"],
    ["the pool's yield", "income-wording"],
    ["free protection for your BTC", "free-protection"],
    ["a risk-free way to hedge", "risk-free"],
    ["the official Hyperliquid options venue", "affiliation"],
    ["partnered with Kinetiq", "affiliation"],
    ["the first options on Hyperliquid", "first-options"],
  ];
  for (const [text, rule] of bad) expect(lintText(text).map((f) => f.rule)).toContain(rule);
  const good = [
    "Writers receive the funding their buyers pay (funding received).",
    "The pool's NAV moves with the book and can fall.",
    "A Guard caps your upside to pay for the Fall.",
    "Buyers can lose 100% of what they paid.",
    "Prices come from Tourbillon's signer quorum until the precompile ships.",
    "The offer's escrow returns to the writer when it is cancelled.",
  ];
  for (const text of good) expect(lintText(text)).toEqual([]);
  expect(lintText('Never say "risk-free". words-lint: allow')).toEqual([]);
  expect(lintText("ok\nrisk-free here")[0]!.line).toBe(2);
});
