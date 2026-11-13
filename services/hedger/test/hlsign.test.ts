import { describe, expect, spyOn, test } from "bun:test";
import { recoverTypedDataAddress, serializeSignature, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ActionRefused,
  actionHash,
  cancelAction,
  floatToWire,
  l1TypedData,
  orderAction,
  orderWire,
  signL1Action,
} from "../src/hlsign.ts";

// Vectors from Hyperliquid's Python SDK, tests/signing_test.py
// (github.com/hyperliquid-dex/hyperliquid-python-sdk, commit 2fdb18f9517675ea03695a0962bd19eece9c83f0).
// The SDK signs them with a published dummy test key; we store only that key's public address and check our hashes
// by recovering the signer from the published signatures. No private key is stored here.
const VECTOR_SIGNER = "0x14791697260E4c9A71f18484C9f997B308e59325";
const pad = (h: string) => (`0x${h.slice(2).padStart(64, "0")}`) as Hex;

async function recovers(hash: Hex, isMainnet: boolean, sig: { r: string; s: string; v: number }) {
  const signature = serializeSignature({ r: pad(sig.r), s: pad(sig.s), v: BigInt(sig.v) });
  return recoverTypedDataAddress({ ...l1TypedData(hash, isMainnet), signature });
}

describe("Hyperliquid signing vectors", () => {
  test("phantom agent of an ETH IOC order (test_phantom_agent_creation_matches_production)", () => {
    const action = orderAction([orderWire({ asset: 4, isBuy: true, px: 1670.1, sz: 0.0147, reduceOnly: false, tif: "Ioc" })]);
    expect(actionHash(action, null, 1677777606040)).toBe("0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908");
  });

  test("an ETH order, mainnet and testnet (test_l1_action_signing_order_matches)", async () => {
    const action = orderAction([orderWire({ asset: 1, isBuy: true, px: 100, sz: 100, reduceOnly: false, tif: "Gtc" })]);
    const h = actionHash(action, null, 0);
    expect(await recovers(h, true, { r: "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e", s: "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e", v: 28 })).toBe(VECTOR_SIGNER);
    expect(await recovers(h, false, { r: "0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54", s: "0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5", v: 27 })).toBe(VECTOR_SIGNER);
  });

  test("hash level only: the SDK's dummy action, without and with a vault (test_l1_action_signing_matches[_with_vault])", async () => {
    const dummy = { type: "dummy", num: 100_000_000_000 }; // float_to_int_for_hashing(1000)
    const h = actionHash(dummy, null, 0);
    expect(await recovers(h, true, { r: "0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298", s: "0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8", v: 27 })).toBe(VECTOR_SIGNER);
    expect(await recovers(h, false, { r: "0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510", s: "0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613", v: 28 })).toBe(VECTOR_SIGNER);
    const hv = actionHash(dummy, "0x1719884eb866cb12b2287399b15f7db5e7d775ea", 0);
    expect(await recovers(hv, true, { r: "0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239", s: "0x4d402be7396ce74fbba3795769cda45aec00dc3125a984f2a9f23177b190da2c", v: 28 })).toBe(VECTOR_SIGNER);
    expect(await recovers(hv, false, { r: "0xe281d2fb5c6e25ca01601f878e4d69c965bb598b88fac58e475dd1f5e56c362b", s: "0x7ddad27e9a238d045c035bc606349d075d5c5cd00a6cd1da23ab5c39d4ef0f60", v: 27 })).toBe(VECTOR_SIGNER);
  });

  test("float_to_wire", () => {
    expect(floatToWire(0.0147)).toBe("0.0147");
    expect(floatToWire(1670.1)).toBe("1670.1");
    expect(floatToWire(100)).toBe("100");
    expect(floatToWire(-0)).toBe("0");
    expect(floatToWire(0.00000001)).toBe("0.00000001");
    expect(() => floatToWire(0.123456789)).toThrow("rounding");
  });
});

describe("signing", () => {
  test("order and cancel round trip with a key generated for this test", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    for (const action of [
      orderAction([orderWire({ asset: 0, isBuy: false, px: 69_650, sz: 0.5, reduceOnly: true, tif: "Ioc" })]),
      cancelAction([{ a: 0, o: 12345 }]),
    ]) {
      const sig = await signL1Action(account, action, 1_800_000_000_000, false);
      const signature = serializeSignature({ r: sig.r, s: sig.s, v: BigInt(sig.v) });
      expect(await recoverTypedDataAddress({ ...l1TypedData(actionHash(action, null, 1_800_000_000_000), false), signature })).toBe(account.address);
    }
  });

  test("OWNER RULE: any action other than order or cancel is refused before anything is signed", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const spy = spyOn(account, "signTypedData");
    const refused: unknown[] = [
      { type: "withdraw3", hyperliquidChain: "Mainnet", signatureChainId: "0xa4b1", amount: "1000", time: 0, destination: account.address },
      { type: "usdSend", hyperliquidChain: "Mainnet", signatureChainId: "0xa4b1", destination: account.address, amount: "1", time: 0 },
      { type: "spotSend", destination: account.address, token: "USDC", amount: "1", time: 0 },
      { type: "usdClassTransfer", amount: "1", toPerp: false, nonce: 0 },
      { type: "vaultTransfer", vaultAddress: account.address, isDeposit: false, usd: 1 },
      { type: "subAccountTransfer", subAccountUser: account.address, isDeposit: false, usd: 1 },
      { type: "approveAgent", agentAddress: account.address, agentName: "x", nonce: 0 },
      { type: "approveBuilderFee", maxFeeRate: "1%", builder: account.address, nonce: 0 },
      { type: "updateLeverage", asset: 0, isCross: true, leverage: 50 },
      { type: "dummy", num: 1 },
      { type: "ORDER", orders: [], grouping: "na" },
      { orders: [], grouping: "na" },
      null,
      "order",
      // order or cancel with smuggled fields
      { type: "order", orders: [], grouping: "na", builder: { b: account.address, f: 10 } },
      { type: "cancel", cancels: [], destination: account.address },
    ];
    for (const action of refused) {
      await expect(signL1Action(account, action, 1, false)).rejects.toBeInstanceOf(ActionRefused);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
