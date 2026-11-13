import { readFileSync } from "node:fs";
import { formatEther, getAddress, parseEther, type Address } from "viem";
import { LOW_BALANCE } from "@tourbillon/common/gas.ts";

/// Key watcher (launch core): every service key's gas balance (HYPE on Elysium), against a minimum. A key that runs dry
/// stops its service (signers stop voting, the poker stops sampling, the receipts poster stops posting, E1 cannot pause).
/// The list holds addresses only, never keys:
///   [{ "name": "signer-1", "address": "0x…", "min": "0.2" }, …]     (min in HYPE; default 0.2, the M1 gas policy)

export type WatchedKey = { name: string; address: Address; min: bigint };

export function parseKeys(json: string): WatchedKey[] {
  const raw = JSON.parse(json) as { name?: unknown; address?: unknown; min?: unknown }[];
  if (!Array.isArray(raw)) throw new Error("keys file: a JSON array is needed");
  const names = new Set<string>();
  return raw.map((k, i) => {
    if (typeof k.name !== "string" || !k.name) throw new Error(`keys file: entry ${i + 1} has no name`);
    if (names.has(k.name)) throw new Error(`keys file: duplicate name ${k.name}`);
    names.add(k.name);
    if (typeof k.address !== "string") throw new Error(`keys file: ${k.name} has no address`);
    return { name: k.name, address: getAddress(k.address), min: k.min === undefined ? LOW_BALANCE : parseEther(String(k.min)) };
  });
}

export const loadKeys = (path: string) => parseKeys(readFileSync(path, "utf8"));

/// The keys below their minimum, with their balances in HYPE.
export function lowKeys(keys: WatchedKey[], balances: Map<Address, bigint>): { name: string; address: Address; balance: number; min: number }[] {
  return keys
    .filter((k) => (balances.get(k.address) ?? 0n) < k.min)
    .map((k) => ({ name: k.name, address: k.address, balance: Number(formatEther(balances.get(k.address) ?? 0n)), min: Number(formatEther(k.min)) }));
}
