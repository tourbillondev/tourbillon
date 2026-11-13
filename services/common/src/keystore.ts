import { createDecipheriv, pbkdf2Sync, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { keccak256, type Hex } from "viem";

/// Foundry keystores are Web3 Secret Storage v3 files (`cast wallet import <name> --interactive`).
/// The key is decrypted in memory only; nothing is written back.

type Kdf =
  | { kdf: "scrypt"; kdfparams: { n: number; r: number; p: number; dklen: number; salt: string } }
  | { kdf: "pbkdf2"; kdfparams: { c: number; dklen: number; prf: string; salt: string } };

export type Keystore = {
  version: number;
  crypto: {
    cipher: string;
    cipherparams: { iv: string };
    ciphertext: string;
    mac: string;
  } & Kdf;
};

export function defaultKeystoreDir(): string {
  return join(homedir(), ".foundry", "keystores");
}

export function readKeystore(name: string, dir = defaultKeystoreDir()): Keystore {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("keystore name: letters, digits, dot, dash, underscore");
  const ks = JSON.parse(readFileSync(join(dir, name), "utf8")) as Keystore;
  if (ks.version !== 3) throw new Error(`keystore ${name}: version ${ks.version}, expected 3`);
  return ks;
}

function deriveKey(c: Keystore["crypto"], password: string): Buffer {
  const pw = Buffer.from(password.normalize("NFKC"), "utf8");
  if (c.kdf === "scrypt") {
    const { n, r, p, dklen, salt } = c.kdfparams;
    return scryptSync(pw, Buffer.from(salt, "hex"), dklen, { N: n, r, p, maxmem: 256 * n * r + 1024 * 1024 });
  }
  if (c.kdf === "pbkdf2") {
    const { c: iter, dklen, prf, salt } = c.kdfparams;
    if (prf !== "hmac-sha256") throw new Error(`keystore: unsupported prf ${prf}`);
    return pbkdf2Sync(pw, Buffer.from(salt, "hex"), iter, dklen, "sha256");
  }
  throw new Error(`keystore: unsupported kdf ${(c as { kdf: string }).kdf}`);
}

/// Returns the private key. Throws on a wrong password (MAC mismatch) without revealing anything else.
export function decryptKeystore(ks: Keystore, password: string): Hex {
  const c = ks.crypto;
  if (c.cipher !== "aes-128-ctr") throw new Error(`keystore: unsupported cipher ${c.cipher}`);
  const dk = deriveKey(c, password);
  const ct = Buffer.from(c.ciphertext, "hex");
  const mac = Buffer.from(keccak256(Buffer.concat([dk.subarray(16, 32), ct])).slice(2), "hex");
  const expected = Buffer.from(c.mac, "hex");
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    throw new Error("keystore: wrong password");
  }
  const d = createDecipheriv("aes-128-ctr", dk.subarray(0, 16), Buffer.from(c.cipherparams.iv, "hex"));
  const key = Buffer.concat([d.update(ct), d.final()]);
  dk.fill(0);
  if (key.length !== 32) throw new Error("keystore: unexpected key length");
  const hex = `0x${key.toString("hex")}` as Hex;
  key.fill(0);
  return hex;
}

/// Reads a line from the terminal without echoing it. Requires an interactive terminal.
export async function promptHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error("a hidden prompt needs an interactive terminal");
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let buf = "";
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(buf);
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}
