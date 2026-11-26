/// The one words list (playbook chapter 11: one full list everywhere, CI included). It joins:
/// - the studio's release list (every update text and every line an update adds);
/// - the spec's own rules (Overview section 9, "What we don't say");
/// - the names of writing tools and attribution lines (never anywhere in the project).
/// Used by CI on the published tree (tools/banned-words.ts), by the publish script, the release gate and the alert bot.
///
/// Allowed uses of a listed word are named, each with its reason, in words-allow.ts; they are never skipped silently.
/// A line may opt out with the marker `words-lint: allow` (only to quote the rules, as in the lint's own tests); the
/// release gate refuses any update text that carries the marker.
///
/// Every word is assembled from fragments, so this file does not flag itself.

import { ALLOW } from "./words-allow.ts";

export type Finding = { rule: string; match: string; line: number; text: string };
export type Rule = { id: string; why: string; re: RegExp; unlessLineHas?: string };

const f = (...p: string[]) => p.join("");
const rx = (src: string, flags = "i") => new RegExp(src, flags);
const SAY = f('say "fu', 'nding received" or "NAV"');
const INC = f("inc", "ome wording");
const RET = f("ret", "urn wording");

export const RULES: Rule[] = [
  // studio release list
  { id: f("yi", "eld"), why: `${INC}: ${SAY}`, re: rx(`\\b${f("yi", "eld")}(s|ed|ing)?\\b`) },
  { id: f("a", "py"), why: `${RET}: ${SAY}`, re: rx(`\\b${f("a", "py")}\\b`) },
  { id: f("a", "pr"), why: `${RET}: ${SAY}`, re: rx(`\\b${f("a", "pr")}\\b`) },
  { id: f("ea", "rn"), why: `${INC}: ${SAY}`, re: rx(`\\b${f("ea", "rn")}(s|ed|ing|ings)?\\b`) },
  { id: f("ret", "urns"), why: `${RET}: ${SAY}; in code docs say "gives back" or "sends back"`, re: rx(`\\b${f("ret", "urns")}\\b`) },
  { id: f("pass", "ive"), why: `${INC}: ${SAY}`, re: rx(`\\b${f("pass", "ive")}\\b`) },
  { id: f("guaran", "teed"), why: "promise wording: say what the contract does, never a promise", re: rx(`\\b${f("guaran", "tee")}(d|s)?\\b`) },
  { id: f("risk", "-free"), why: f('"ri', 'sk-free": buyers can lose what they paid; writers their locked collateral'), re: rx(`\\b${f("ri", "sk")}[\\s-]*${f("fr", "ee")}\\b`) },
  { id: f("sa", "fe"), why: "promise wording: say what is checked or limited (the multisig's name is allowed, see words-allow.ts)", re: rx(`\\b${f("sa", "fe")}(ly|ty)?\\b`) },
  { id: f("investment", " club"), why: f("never describe the product as an invest", "ment club"), re: rx(`\\b${f("invest", "ment")}\\s+${f("cl", "ub")}\\b`) },
  { id: f("fu", "nd"), why: 'say "money", "USDC" or "balance" (the spec\'s own term is allowed, see words-allow.ts)', re: rx(`\\b${f("fu", "nd")}(s|ed|ing)?\\b`) },
  { id: f("bank", " account"), why: f("never compare the product to a ba", "nk account"), re: rx(`\\b${f("ba", "nk")}\\s+${f("acc", "ount")}\\b`) },
  { id: f("part", "ner"), why: f("affiliation wording: never call a third party a part", "ner"), re: rx(`\\b${f("part", "ner")}(s|ship|ships|ed|ing)?\\b`) },
  { id: f("offi", "cial"), why: f("affiliation wording: never offi", "cial, about Robinhood Markets, Robinhood Chain operators or any venue"), re: rx(`\\b${f("offi", "cial")}(ly)?\\b`) },
  { id: f("le", "arn"), why: "never promise what someone will get out of it", re: rx(`\\b${f("le", "arn")}(s|ed|ing)?\\b`) },
  { id: f("aud", "ited"), why: f('never "aud', 'ited": say "automated pre-audit grade"'), re: rx(`\\b${f("aud", "ited")}\\b`) },
  { id: f("pro", "fit"), why: `${INC}: ${SAY}`, re: rx(`\\b${f("pro", "fit")}(s|able)?\\b`) },
  { id: f("perfor", "mance"), why: `${RET}: ${SAY}`, re: rx(`\\b${f("perfor", "mance")}\\b`) },
  { id: f("inc", "ome"), why: `${INC}: ${SAY}`, re: rx(`\\b${f("inc", "ome")}\\b`) },
  { id: f("passkey", "-only"), why: '"your key" means a passkey or a connected wallet', re: rx(`\\b${f("pass", "key")}[\\s-]${f("on", "ly")}\\b`) },
  // the spec's own rules (Overview section 9)
  { id: "return-wording", why: `percentage-return wording: ${SAY}`, re: rx(`\\d+(\\.\\d+)?\\s*%\\s*(${f("ret", "urn")}s?|gains?)\\b|\\b${f("ret", "urn")}s?\\s+(of|on)\\s+(your|capital|deposits?|investment)\\b`) },
  { id: "free-protection", why: f('"fr', 'ee protection": a Guard caps your upside to pay for the Fall'), re: rx(`${f("fr", "ee")}\\s+${f("prote", "ction")}`) },
  { id: "affiliation", why: "affiliation wording about Robinhood Markets, Robinhood Chain operators or any venue", re: rx(`\\b(${f("endor", "sed")}|${f("endor", "ses")}|${f("affil", "iated")})\\b`) },
  { id: "first-claim", why: 'a "first" claim needs the (U) qualifier on the same line (Overview claims)', re: rx(`\\b${f("fir", "st")}\\s+(options|on-chain\\s+vol(atility)?)\\b`), unlessLineHas: "(U)" },
  // writing tools and attribution lines
  { id: "tool-name", why: f("no writing tool or assis", "tant is named anywhere"), re: rx(`\\b(${f("cla", "ude")}|${f("anthr", "opic")}|${f("chat", "-?gpt")}|${f("ope", "n-?ai")}|${f("assis", "tant")}s?)\\b`) },
  { id: "tool-name-ai", why: f("no writing tool or assis", "tant is named anywhere"), re: rx(`\\b${f("A", "I")}\\b`, "") },
  { id: "attribution", why: "no attribution lines", re: rx(`${f("co-auth", "ored-by")}|${f("gener", "ated")}\\s+with`) },
];

/// Blanks every allowed use of `rule` on the line, so only the remaining text is checked. A file-scoped entry applies
/// only when `file` (a repo path) matches it.
function withoutAllowed(rule: string, line: string, file?: string): string {
  let out = line.replace(/\\[ntr]/g, "  "); // an escaped newline or tab in a string literal separates words too
  for (const a of ALLOW) {
    if (a.rule !== rule) continue;
    if (a.files && !(file !== undefined && a.files.test(file))) continue;
    out = out.replace(a.pattern, (m) => " ".repeat(m.length));
  }
  return out;
}

/// The findings in `text`; `file` is its repo path when it comes from a file (for file-scoped allow entries).
export function lintText(text: string, file?: string): Finding[] {
  const out: Finding[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.includes("words-lint: allow")) return;
    for (const r of RULES) {
      if (r.unlessLineHas && line.includes(r.unlessLineHas)) continue;
      const m = r.re.exec(withoutAllowed(r.id, line, file));
      if (m) out.push({ rule: r.id, match: line.slice(m.index, m.index + m[0].length), line: i + 1, text: line.trim() });
    }
  });
  return out;
}

export const why = (rule: string) => RULES.find((r) => r.id === rule)?.why ?? rule;
