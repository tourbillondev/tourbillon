/// The allow file of the one words list (playbook chapter 11): every use of a listed word that the repo must keep,
/// named with its reason and who decided it. Nothing else is skipped. Patterns are applied per line, before the rule.
/// Words are assembled from fragments, so this file does not flag itself.

const f = (...p: string[]) => p.join("");

/// `files`, when set, limits the entry to the repo paths it matches (a file-scoped entry never applies to text checked
/// without a path).
export type Allow = { rule: string; what: string; reason: string; decided: string; pattern: RegExp; files?: RegExp };

export const ALLOW: Allow[] = [
  {
    rule: f("fu", "nd"),
    what: f('"fu', 'nding"'),
    reason: f("The spec's own term: writers and makers receive the fu", "nding their buyers pay (\"fu", "nding received\"), and path fu", "nding (Overview §2, §3, §9; Backend §2 C, §3)."),
    decided: "owner, D10, 2026-11-24",
    pattern: new RegExp(`\\b${f("fu", "nding")}\\b`, "gi"),
  },
  {
    rule: f("sa", "fe"),
    what: f("the Sa", "fe multisig: its name, its library and settings, and code identifiers that hold its address"),
    reason: f("Governance is a Sa", "fe 3-of-5 behind a 48 h timelock (Backend §2 J, §5). Prose promise words (lowercase sa", "fe, sa", "fely, sa", "fety) stay refused."),
    decided: "owner, D10, 2026-11-24",
    pattern: new RegExp(
      [
        `\\b${f("Sa", "fe")}\\b`, // the multisig's name
        `\\b${f("SA", "FE")}\\b`, // a constant holding its address
        f("sa", "fe-smart-account"), f("sa", "fe-global"), `@${f("sa", "fe")}\\/`, `"${f("sa", "fe")}"`, // library, remapping, compiler profile
        f("memory-", "sa", "fe"), // the Solidity assembly annotation
        `\`${f("sa", "fe")}\``, // a code identifier quoted in a comment
        `(?<=[.(\\[{,]\\s*)${f("sa", "fe")}\\b`, // an identifier after . ( [ { ,
        `(?<=\\b(?:address|${f("Sa", "fe")}|const|let)\\s+)${f("sa", "fe")}\\b`, // a declared identifier
        `\\b${f("sa", "fe")}(?=\\.\\w|\\s*[,);:\\]}]|\\s*=(?!=))`, // an identifier before . , ) ; : ] } =
      ].join("|"),
      "g",
    ),
  },
  {
    rule: f("ret", "urns"),
    what: f("the Solidity and ABI keyword `ret", "urns (`"),
    reason: f("Language syntax for a function's outputs (`function x() view ret", "urns (uint256)`), in contracts and in the ABI strings the services read. It is not return wording and cannot be reworded."),
    decided: "owner, 2026-11-24 (RH1)",
    pattern: new RegExp(`\\b${f("ret", "urns")}\\s*\\(`, "gi"),
  },
  {
    rule: f("inc", "ome"),
    what: f("Binance's transfer-history endpoint (/fapi/v1/inc", "ome) and its fields (inc", "ome, inc", "omeType)"),
    reason: "third-party API name, not product language",
    decided: "owner, C55, 2026-11-24",
    pattern: new RegExp(`\\b${f("inc", "ome")}(Type)?\\b`, "g"),
    files: /^services\/common\/src\/binance\.ts$/,
  },
  {
    rule: f("part", "ner"),
    what: f("the SIL Open Font License's own text (\"in part", "nership with others\")"),
    reason: "font licence text, must ship word for word",
    decided: "owner, Q19, 2026-11-26",
    pattern: new RegExp(f("part", "nership"), "g"),
    files: /^website\/public\/assets\/fonts\/[\w-]+-OFL\.txt$/,
  },
];
