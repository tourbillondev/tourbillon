import { expect, test } from "bun:test";
import { excluded, excludes, secretFindings } from "../../../scripts/publish.ts";

test("the publish exclude list and the secret patterns", () => {
  const rules = excludes("# comment\ndocs/spec/\ndocs/notes/\nqueue/\nCLAUDE.md\n");
  expect(rules).toEqual(["docs/spec/", "docs/notes/", "queue/", "CLAUDE.md"]);
  for (const p of ["docs/spec/TOURBILLON_Overview.md", "docs/notes/M7_NOTES.md", "queue/07/update.json", "CLAUDE.md"]) expect(excluded(p, rules)).toBe(true);
  for (const p of ["docs/backend/api-v1.md", "services/CLAUDE.md.bak", "contracts/src/Engine.sol"]) expect(excluded(p, rules)).toBe(false);

  const anvil = ["ac0974bec39a17e36ba4a6b4d238ff94", "4bacb478cbed5efcae784d7bf4f2ff80"].join("");
  const bad: [string, string][] = [
    ["a.md", ["-----BEGIN OPENSSH ", "PRIVATE KEY-----"].join("")],
    ["a.ts", `const t = "ghp_${"a".repeat(36)}"`],
    ["a.txt", `token 123456789:${"A".repeat(35)}`],
    ["a.ts", `PRIVATE_KEY=0x${"1".repeat(64)}`],
    ["a.ts", `mnemonic: "${Array(12).fill("word").join(" ")}"`],
    ["k.json", `{"crypto":{"ciphertext":"${"ab".repeat(32)}"}}`],
    ["a.ts", anvil],
  ];
  for (const [p, text] of bad) expect(secretFindings(p, text).length).toBeGreaterThan(0);
  expect(secretFindings(".env", "")).toEqual([".env: a secrets file"]);
  expect(secretFindings("services/.env.example", "")).toEqual([]);
  // ordinary code: hashes and bytes32 constants are not secrets
  expect(secretFindings("a.ts", `const ZERO32 = "0x${"0".repeat(64)}"; const h = keccak256(x);`)).toEqual([]);
});
