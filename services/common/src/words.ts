/// The spec's wording rules (Overview section 9: "What we don't say"), as one shared list for every text Tourbillon
/// publishes or posts: update texts, release notes, docs, bot posts, API field names.
/// - No percentage-return or income language for writers, makers or the pool ("funding received" and "NAV" instead).
/// - No "free protection". No "risk-free".
/// - No "official" or affiliation language about Hyperliquid, Kinetiq or any venue.
/// - Never "the first options on Hyperliquid".
/// A line may opt out of one check with the marker `words-lint: allow` (for quoting the rules themselves).

export type Finding = { rule: string; match: string; line: number; text: string };

export const RULES: { id: string; why: string; re: RegExp }[] = [
  { id: "return-wording", why: 'percentage-return wording: say "funding received" or "NAV"', re: /\b(apy|apr)\b|\d+(\.\d+)?\s*%\s*(return|returns|gain|gains)\b|\breturns?\s+(of|on)\s+(your|capital|deposits?|investment)\b/i },
  { id: "income-wording", why: 'income wording: say "funding received" or "NAV"', re: /\b(yield|yields|income|passive|earn|earns|earned|earning|earnings|profit|profits|profitable)\b/i },
  { id: "free-protection", why: '"free protection": a Guard caps your upside to pay for the Fall', re: /free\s+protection/i },
  { id: "risk-free", why: '"risk-free": buyers can lose what they paid; writers their locked collateral', re: /risk[\s-]free/i },
  { id: "affiliation", why: '"official" or affiliation wording about Hyperliquid, Kinetiq or a venue', re: /\bofficial\b|\b(partner(ed|ship)?|endorsed|affiliated)\s+(with\s+)?(hyperliquid|kinetiq)\b/i },
  { id: "first-options", why: 'never "the first options on Hyperliquid"', re: /first\s+options\s+on\s+hyperliquid/i },
];

export function lintText(text: string): Finding[] {
  const out: Finding[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.includes("words-lint: allow")) return;
    for (const r of RULES) {
      const m = r.re.exec(line);
      if (m) out.push({ rule: r.id, match: m[0], line: i + 1, text: line.trim() });
    }
  });
  return out;
}

export const why = (rule: string) => RULES.find((r) => r.id === rule)?.why ?? rule;
