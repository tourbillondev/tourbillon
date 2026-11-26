import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The manifest maker: a deployment file becomes a manifest the site accepts; mainnet and missing fields are refused.
const A = (n: number) => `0x${String(n).repeat(40).slice(0, 40)}`;
const dep = (chainId: number) => ({ chainId, deployBlock: 7, Engine: A(1), OpenBook: A(2), WriterBook: A(3), PathFundingBook: A(4), MainspringPool: A(5), MarkRouter: A(6), SettlementToken: A(7), settlementSymbol: "USDG", settlementDecimals: 6, markets: ["BTC", "ETH", "STK1"] });
const run = (d: unknown, extra: string[] = []) => {
  const dir = mkdtempSync(join(tmpdir(), "manifest-"));
  try {
    writeFileSync(join(dir, "d.json"), JSON.stringify(d));
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "../scripts/manifest.ts"), "--deployment", join(dir, "d.json"), "--rpc", "https://rpc.testnet.example", "--api", "https://api.example", "--out", join(dir, "m.json"), ...extra], { stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, err: r.stderr.toString(), out: r.exitCode === 0 ? JSON.parse(readFileSync(join(dir, "m.json"), "utf8")) : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("testnet deployment → manifest; mainnet and a missing address refused", () => {
  const ok = run(dep(46630));
  expect(ok.code).toBe(0);
  expect(ok.out).toMatchObject({ version: 1, chainId: 46630, networkName: "Robinhood Chain testnet", deployBlock: "7", settlement: { symbol: "USDG", decimals: 6 } });
  expect(run(dep(4663)).err).toContain("not open for this site");
  const { WriterBook: _, ...noWriter } = dep(46630);
  expect(run(noWriter).err).toContain("no address for WriterBook");
});
