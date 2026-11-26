import { expect, test } from "bun:test";
import { lintText, RULES, why } from "../src/words.ts";
import { ALLOW } from "../src/words-allow.ts";

// Every line below that quotes a listed word carries the opt-out marker, so the words gate does not flag this file.
const rules = (text: string) => lintText(text).map((f) => f.rule);

test("the studio list: every word is refused", () => {
  const bad: [string, string][] = [
    ["the pool's yield", "yield"], // words-lint: allow
    ["12% APY", "apy"], // words-lint: allow
    ["an APR of 8", "apr"], // words-lint: allow
    ["writers earn more", "earn"], // words-lint: allow
    ["steady returns", "returns"], // words-lint: allow
    ["passive income", "passive"], // words-lint: allow
    ["guaranteed payout", "guaranteed"], // words-lint: allow
    ["a risk-free way to hedge", "risk-free"], // words-lint: allow
    ["your money is safe", "safe"], // words-lint: allow
    ["an investment club", "investment club"], // words-lint: allow
    ["the funds are locked", "fund"], // words-lint: allow
    ["like a bank account", "bank account"], // words-lint: allow
    ["our partners", "partner"], // words-lint: allow
    ["the official venue", "official"], // words-lint: allow
    ["learn how to win", "learn"], // words-lint: allow
    ["fully audited", "audited"], // words-lint: allow
    ["profitable writers", "profit"], // words-lint: allow
    ["past performance", "performance"], // words-lint: allow
    ["an income stream", "income"], // words-lint: allow
    ["passkey-only sign-in", "passkey-only"], // words-lint: allow
  ];
  for (const [text, rule] of bad) expect(rules(text)).toContain(rule);
});

test("the spec's rules (Overview section 9, Robinhood Chain)", () => {
  const bad: [string, string][] = [
    ["a 20% return on your capital", "return-wording"], // words-lint: allow
    ["free protection for your shares", "free-protection"], // words-lint: allow
    ["endorsed by Robinhood Markets", "affiliation"], // words-lint: allow
    ["affiliated with Robinhood Chain operators", "affiliation"], // words-lint: allow
    ["the official Robinhood Chain options venue", "official"], // words-lint: allow
    ["partnered with a venue", "partner"], // words-lint: allow
    ["the first options on tokenized stocks", "first-claim"], // words-lint: allow
    ["the first on-chain volatility feed on Robinhood Chain", "first-claim"], // words-lint: allow
  ];
  for (const [text, rule] of bad) expect(rules(text)).toContain(rule);
  // a "first" claim with the (U) qualifier on the same line is allowed
  expect(lintText("The first options that never expire on tokenized stocks (U).")).toEqual([]);
});

test("writing tools and attribution lines", () => {
  const name = ["Cla", "ude"].join("");
  for (const text of [`made with ${name}`, ["Ope", "nAI"].join(""), ["Chat", "GPT"].join(""), `an ${["assis", "tant"].join("")}`, ["A", "I"].join("") + " wrote it", ["Co-Auth", "ored-By: x"].join(""), ["Generated", " with"].join("")]) {
    expect(lintText(text).length).toBeGreaterThan(0);
  }
  expect(lintText(`the session rules file ${name.toUpperCase()}.md`).map((f) => f.rule)).toContain("tool-name");
  // inside a string literal, an escaped newline still separates words
  expect(lintText(`"docs/spec/\\n${name.toUpperCase()}.md\\n"`).map((f) => f.rule)).toContain("tool-name");
  expect(lintText("said in passing, aim and air")).toEqual([]); // whole words only; the two-letter name only in capitals
});

test("named allow entries, each with its reason", () => {
  for (const a of ALLOW) {
    expect(RULES.some((r) => r.id === a.rule)).toBe(true);
    expect(a.reason.length).toBeGreaterThan(20);
    expect(a.decided.length).toBeGreaterThan(0);
  }
  // funding: the spec's own term (D10); the other forms stay refused
  expect(lintText("Writers receive the funding their buyers pay (funding received).")).toEqual([]);
  expect(rules("the pool is funded")).toContain("fund"); // words-lint: allow
  // the Safe multisig (D10): its name, library, settings and code identifiers; prose stays refused
  for (const ok of [
    "Safe 3-of-5 behind a 48 h timelock",
    '"@safe/=lib/safe-smart-account/contracts/",',
    'additional_compiler_profiles = [{ name = "safe", via_ir = false }]',
    'assembly ("memory-safe") {',
    "address safe = d7.gov.safe;",
    "const n = await read<bigint>(safe, \"nonce\");",
    "return safe.execTransaction(to, 0, data);",
    "/// The timelock: `safe` proposes and cancels.",
    "vm.startPrank(SAFE);",
  ]) expect(lintText(ok)).toEqual([]);
  for (const bad of ["it is safe to use", "trade safely", "a safety floor"]) expect(rules(bad)).toContain("safe"); // words-lint: allow
  // the Solidity and ABI keyword (to confirm by the owner); prose stays refused
  expect(lintText("function required(uint256 id) public view returns (uint256 settlementReq) {")).toEqual([]);
  expect(lintText('"function claim(uint256 writeId) returns (uint256 settlementOut)",')).toEqual([]);
  expect(rules("the escrow returns to the writer")).toContain("returns"); // words-lint: allow
});

test("plain wording passes; the opt-out marker; line numbers", () => {
  for (const text of [
    "Writers receive the funding their buyers pay (funding received).",
    "The pool's NAV moves with the book and can fall.",
    "A Guard caps your upside to pay for the Fall.",
    "Buyers can lose 100% of what they paid.",
    "Prices come from Tourbillon's signer quorum until Robinhood Chain publishes a first-party mark.",
    "The offer's escrow goes back to the writer when it is cancelled.",
    "Options settle in USDC on Robinhood Chain.",
  ]) expect(lintText(text)).toEqual([]);
  expect(lintText('Never say "risk-free". words-lint: allow')).toEqual([]);
  expect(lintText("ok\nrisk-free here")[0]!.line).toBe(2); // words-lint: allow
  expect(why("first-claim")).toContain("(U)");
});

test("C55: Binance's endpoint and field name are allowed in the Binance adapter only (a file-scoped entry)", () => {
  const w = ["in", "come"].join(""); // assembled: this test file is checked by the gate too
  const line = `export const TRANSFER_HISTORY_PATH = "/fapi/v1/${w}"; // ${w}Type=TRANSFER`;
  expect(lintText(line, "services/common/src/binance.ts")).toEqual([]);
  expect(lintText(line, "services/hedger/src/cex.ts").length).toBeGreaterThan(0); // any other file: refused
  expect(lintText(line).length).toBeGreaterThan(0); // text without a path (posts, updates): refused
  const other = ["risk", "-free"].join("");
  expect(lintText(`a ${other} hedge`, "services/common/src/binance.ts").map((f) => f.rule)).toContain(other); // other words stay refused there
});

test("Q19: the font licence text is allowed in the OFL files next to the fonts only (a file-scoped entry)", () => {
  const w = ["part", "nership"].join(""); // assembled: this test file is checked by the gate too
  const line = `developed in ${w} with others.`;
  expect(lintText(line, "website/public/assets/fonts/Inter-OFL.txt")).toEqual([]);
  expect(lintText(line, "website/public/assets/fonts/InstrumentSerif-OFL.txt")).toEqual([]);
  expect(lintText(line, "website/src/guide-data.mjs").length).toBeGreaterThan(0); // the site's own text: refused
  expect(lintText(line, "website/public/assets/fonts/notes.txt").length).toBeGreaterThan(0); // another file there: refused
  expect(lintText(line).length).toBeGreaterThan(0); // text without a path: refused
  const p = ["part", "ner"].join("");
  expect(lintText(`our ${p}`, "website/public/assets/fonts/Inter-OFL.txt").length).toBeGreaterThan(0); // only the licence's own phrase
});
