import { expect, test } from "bun:test";
import { createCipheriv, pbkdf2Sync, randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decryptKeystore, readKeystore, type Keystore } from "../src/keystore.ts";

// Every key and password here is generated at run time and thrown away; none is stored in a file in the repo.

function encrypt(key: Buffer, password: string, kdf: "scrypt" | "pbkdf2"): Keystore {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const dk =
    kdf === "scrypt" ? scryptSync(password, salt, 32, { N: 1024, r: 8, p: 1 }) : pbkdf2Sync(password, salt, 1000, 32, "sha256");
  const c = createCipheriv("aes-128-ctr", dk.subarray(0, 16), iv);
  const ct = Buffer.concat([c.update(key), c.final()]);
  const mac = keccak256(Buffer.concat([dk.subarray(16, 32), ct])).slice(2);
  const kdfPart =
    kdf === "scrypt"
      ? { kdf: "scrypt" as const, kdfparams: { n: 1024, r: 8, p: 1, dklen: 32, salt: salt.toString("hex") } }
      : { kdf: "pbkdf2" as const, kdfparams: { c: 1000, dklen: 32, prf: "hmac-sha256", salt: salt.toString("hex") } };
  return {
    version: 3,
    crypto: { cipher: "aes-128-ctr", cipherparams: { iv: iv.toString("hex") }, ciphertext: ct.toString("hex"), mac, ...kdfPart },
  };
}

for (const kdf of ["scrypt", "pbkdf2"] as const) {
  test(`decrypts a v3 keystore (${kdf}); a wrong password is refused`, () => {
    const key = randomBytes(32);
    const pw = randomBytes(12).toString("base64");
    const ks = encrypt(key, pw, kdf);
    expect(decryptKeystore(ks, pw)).toBe(`0x${key.toString("hex")}` as Hex);
    expect(() => decryptKeystore(ks, pw + "x")).toThrow("wrong password");
  });
}

test("reads a keystore by name and refuses path tricks", () => {
  const dir = mkdtempSync(join(tmpdir(), "ks-"));
  try {
    const key = randomBytes(32);
    const pw = randomBytes(12).toString("base64");
    writeFileSync(join(dir, "signer-test"), JSON.stringify(encrypt(key, pw, "scrypt")));
    expect(decryptKeystore(readKeystore("signer-test", dir), pw)).toBe(`0x${key.toString("hex")}` as Hex);
    expect(() => readKeystore("../signer-test", dir)).toThrow("keystore name");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(!Bun.which("cast"))("decrypts a keystore made by Foundry's cast", () => {
  const dir = mkdtempSync(join(tmpdir(), "ks-cast-"));
  try {
    const pw = randomBytes(12).toString("hex");
    const r = Bun.spawnSync(["cast", "wallet", "new", dir, "--unsafe-password", pw]);
    expect(r.exitCode).toBe(0);
    const address = /Address:\s+(0x[0-9a-fA-F]{40})/.exec(r.stdout.toString() + r.stderr.toString())?.[1];
    const file = readdirSync(dir)[0]!;
    const key = decryptKeystore(readKeystore(file, dir), pw);
    expect(address).toBeDefined();
    expect(privateKeyToAccount(key).address).toBe(address as `0x${string}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
