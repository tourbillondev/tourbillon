import { encode } from "@msgpack/msgpack";
import { concat, keccak256, numberToBytes, toBytes, type Address, type Hex, type LocalAccount } from "viem";

/// Hyperliquid L1-action signing for the hedger's agent (API) wallet, following Hyperliquid's Python SDK
/// (hyperliquid/utils/signing.py):
///   hash   = keccak256(msgpack(action) ‖ nonce as 8 bytes big-endian ‖ 0x00 (no vault) or 0x01 ‖ vault address)
///   typed  = EIP-712 Agent{source: "a" mainnet | "b" testnet, connectionId: hash},
///            domain {name "Exchange", version "1", chainId 1337, verifyingContract 0x0}
///
/// OWNER RULE (M3 step 8): only "order" and "cancel" actions are ever signed. Any other action type (withdraw,
/// usdSend, transfers, approveAgent, anything else) is refused here, before anything is hashed or signed. Order and
/// cancel actions with unexpected fields are refused too.

export const SIGNABLE_ACTIONS = new Set(["order", "cancel"]);

export class ActionRefused extends Error {
  constructor(reason: string) {
    super(`refused to sign: ${reason}`);
    this.name = "ActionRefused";
  }
}

export type Tif = "Ioc" | "Gtc" | "Alo";
export type OrderWire = { a: number; b: boolean; p: string; s: string; r: boolean; t: { limit: { tif: Tif } } };
export type OrderAction = { type: "order"; orders: OrderWire[]; grouping: "na" };
export type CancelAction = { type: "cancel"; cancels: { a: number; o: number }[] };
export type Signature = { r: Hex; s: Hex; v: number };

/// Hyperliquid's float_to_wire: at most 8 decimals, no rounding allowed, trailing zeros removed, "-0" → "0".
export function floatToWire(x: number): string {
  const rounded = x.toFixed(8);
  if (Math.abs(Number(rounded) - x) >= 1e-12) throw new Error(`float_to_wire causes rounding: ${x}`);
  let out = rounded.includes(".") ? rounded.replace(/0+$/, "").replace(/\.$/, "") : rounded;
  if (out === "-0") out = "0";
  return out;
}

export function orderWire(o: { asset: number; isBuy: boolean; px: number; sz: number; reduceOnly: boolean; tif: Tif }): OrderWire {
  return { a: o.asset, b: o.isBuy, p: floatToWire(o.px), s: floatToWire(o.sz), r: o.reduceOnly, t: { limit: { tif: o.tif } } };
}

export function orderAction(orders: OrderWire[]): OrderAction {
  return { type: "order", orders, grouping: "na" };
}

export function cancelAction(cancels: { a: number; o: number }[]): CancelAction {
  return { type: "cancel", cancels };
}

/// The action hash (works for any action; hashing is not signing).
export function actionHash(action: unknown, vault: Address | null, nonce: bigint | number): Hex {
  const parts: Uint8Array[] = [encode(action), numberToBytes(BigInt(nonce), { size: 8 })];
  parts.push(vault === null ? new Uint8Array([0]) : concat([new Uint8Array([1]), toBytes(vault)]));
  return keccak256(concat(parts));
}

export function l1TypedData(hash: Hex, isMainnet: boolean) {
  return {
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" as Address },
    types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    primaryType: "Agent" as const,
    message: { source: isMainnet ? "a" : "b", connectionId: hash },
  };
}

/// Throws ActionRefused unless `action` is exactly an order or a cancel action.
export function assertSignable(action: unknown): asserts action is OrderAction | CancelAction {
  if (typeof action !== "object" || action === null) throw new ActionRefused("not an action object");
  const a = action as Record<string, unknown>;
  const type = a.type;
  if (typeof type !== "string" || !SIGNABLE_ACTIONS.has(type)) throw new ActionRefused(`action type "${String(type)}" is not order or cancel`);
  const keys = Object.keys(a).sort().join(",");
  if (type === "order" && keys !== "grouping,orders,type") throw new ActionRefused(`order action with fields ${keys}`);
  if (type === "cancel" && keys !== "cancels,type") throw new ActionRefused(`cancel action with fields ${keys}`);
}

/// Signs an order or cancel action with the agent account. Refuses everything else before hashing.
export async function signL1Action(account: LocalAccount, action: unknown, nonce: bigint | number, isMainnet: boolean): Promise<Signature> {
  assertSignable(action);
  const hash = actionHash(action, null, nonce);
  const sig = await account.signTypedData(l1TypedData(hash, isMainnet));
  return { r: `0x${sig.slice(2, 66)}` as Hex, s: `0x${sig.slice(66, 130)}` as Hex, v: parseInt(sig.slice(130, 132), 16) };
}
