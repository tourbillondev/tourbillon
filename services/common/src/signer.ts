import { createWalletClient, http, type Account, type Address, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainFor } from "./chain.ts";
import { decryptKeystore, promptHidden, readKeystore } from "./keystore.ts";

export type KeyInput =
  | { type: "keystore"; name: string; dir?: string }
  | { type: "local-unlocked"; address: Address } // anvil only
  | { type: "watch"; address: Address }; // dry run only, no key

export type Signer = { address: Address; wallet?: WalletClient; account?: Account | Address };

/// Loads the sending account. A keystore key is decrypted in memory after a hidden password prompt; nothing is
/// written or logged. `local-unlocked` uses the node's unlocked account (anvil only, checked by the caller);
/// `watch` has no key at all (dry run).
export async function loadSigner(key: KeyInput, chainId: number, rpc?: string): Promise<Signer> {
  const chain = chainFor(chainId);
  if (key.type === "watch") return { address: key.address };
  if (key.type === "local-unlocked") {
    const wallet = createWalletClient({ chain, transport: http(rpc), account: key.address });
    return { address: key.address, wallet, account: key.address };
  }
  const ks = readKeystore(key.name, key.dir);
  const password = await promptHidden(`password for keystore ${key.name}: `);
  const account = privateKeyToAccount(decryptKeystore(ks, password));
  const wallet = createWalletClient({ chain, transport: http(rpc), account });
  return { address: account.address, wallet, account };
}
