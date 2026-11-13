import { decodeFunctionData, getAddress, hexToString, parseAbi, type Address, type Hex } from "viem";
import type { Alarm } from "./alarm.ts";

/// M7 (governance and receipts). Pure: logs in, alarm lines out.
/// - Every timelock operation is announced when queued (a public notice for the whole delay: target, function,
///   arguments, when it becomes executable), and again when executed or cancelled.
/// - Every role change on a governed contract is announced (after the handover, each one went through the timelock).
/// - Every pause and unpause is announced with who did it (the guardian, the Safe, the automated key E1, or other).
/// - Receipts: an alarm when no root has been posted for too long (vol finals land every few minutes while the signers
///   run, so every hour holds receipts).

export const m7Abi = parseAbi([
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  "event Cancelled(bytes32 indexed id)",
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  "event BuysPaused(address by)",
  "event BuysUnpaused(address by)",
  "event MarketPaused(bytes32 indexed market, address by)",
  "event MarketUnpaused(bytes32 indexed market, address by)",
  "event DepositsPaused(address by)",
  "event DepositsUnpaused(address by)",
  "event OpensResumed(address by, uint256 navPerShare)",
]);

/// The governed functions, to name what a queued operation will do.
export const governedAbi = parseAbi([
  "function setCaps(bytes32 market, uint256 notionalCap, uint256 directionalCap)",
  "function setShock(bytes32 market, uint16 shockBps)",
  "function setVolMult(uint16 volMultBps)",
  "function listMarket(bytes32 market, uint16 shockBps)",
  "function setHedgerDeltaCap(bytes32 market, uint256 deltaCap)",
  "function setOpenBookCap(bytes32 market, uint256 cap)",
  "function setProtocolFee(uint16 bps, address recipient)",
  "function setTreasury(address treasury)",
  "function setTreasuryDailyCap(uint16 bps)",
  "function setMarket(bytes32 market, uint128 strikeStepWad, uint16 spreadBps)",
  "function setSigner(address signer, bool active)",
  "function setQuorum(uint256 quorum)",
  "function setWindow(uint256 window)",
  "function setFeed(bytes32 key, uint16 stepBps, uint32 heartbeat)",
  "function setAnchor(bytes32 key, uint16 bandBps)",
  "function clearAnchor(bytes32 key)",
  "function queueRoute(bytes32 market, (address primary, address secondary, uint32 maxAge, uint16 maxDevBps) r)",
  "function cancelRoute(bytes32 market)",
  "function grantRole(bytes32 role, address account)",
  "function revokeRole(bytes32 role, address account)",
  "function updateDelay(uint256 newDelay)",
]);

export type M7Addresses = {
  timelock: Address | null;
  receipts: Address | null;
  safe: Address | null;
  guardian: Address | null;
  riskPauser: Address | null;
  deployer: Address | null; // role changes it made are the deploy's handover, not announced
  names: Map<string, string>;
};
export type M7Event = { eventName: string; args: Record<string, unknown>; address: Address; transactionHash: Hex | null; blockTimestamp: number };

const market = (h: unknown) => hexToString(h as Hex, { size: 32 }).replace(/\0+$/, "");

/// A queued call in words: the target contract's name and the function with its arguments.
export function describeCall(target: Address, data: Hex, names: Map<string, string>): { contract: string; call: string } {
  const contract = names.get(target.toLowerCase()) ?? target;
  try {
    const { functionName, args } = decodeFunctionData({ abi: governedAbi, data });
    const shown = (args ?? []).map((x) => (typeof x === "string" && x.length === 66 && x.startsWith("0x") && /^0x[0-9a-f]+0+$/i.test(x) ? market(x) || x : typeof x === "bigint" ? x.toString() : JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v))));
    return { contract, call: `${functionName}(${shown.join(", ")})` };
  } catch {
    return { contract, call: `unknown call ${data.slice(0, 10)}` };
  }
}

function who(by: unknown, a: M7Addresses): string {
  const x = getAddress(String(by));
  if (a.guardian && x === a.guardian) return "the guardian";
  if (a.safe && x === a.safe) return "the Safe";
  if (a.timelock && x === a.timelock) return "the timelock";
  if (a.riskPauser && x === a.riskPauser) return "the automated risk key (E1)";
  return x;
}

export function m7Alarms(events: M7Event[], a: M7Addresses): Omit<Alarm, "state">[] {
  const out: Omit<Alarm, "state">[] = [];
  for (const e of events) {
    const v = e.args;
    const tx = e.transactionHash;
    switch (e.eventName) {
      case "CallScheduled": {
        const d = describeCall(getAddress(String(v.target)), v.data as Hex, a.names);
        const delay = Number(v.delay as bigint);
        out.push({ name: "TIMELOCK_QUEUED", level: "alarm", what: `An admin action was queued in the timelock: ${d.contract}.${d.call}. It can run once the delay has passed.`, who: "everyone: review it; the Safe can cancel it before it runs", market: null, values: { id: v.id, contract: d.contract, call: d.call, delaySeconds: delay, executableAt: e.blockTimestamp + delay, tx } });
        break;
      }
      case "CallExecuted": {
        const d = describeCall(getAddress(String(v.target)), v.data as Hex, a.names);
        out.push({ name: "TIMELOCK_EXECUTED", level: "warn", what: `A queued admin action ran: ${d.contract}.${d.call}.`, who: "nobody", market: null, values: { id: v.id, contract: d.contract, call: d.call, tx } });
        break;
      }
      case "Cancelled":
        out.push({ name: "TIMELOCK_CANCELLED", level: "warn", what: "A queued admin action was cancelled by the Safe.", who: "nobody", market: null, values: { id: v.id, tx } });
        break;
      case "RoleGranted":
      case "RoleRevoked":
        if (a.deployer && getAddress(String(v.sender)) === a.deployer) break; // the deploy's own handover
        out.push({ name: "ROLE_CHANGED", level: "alarm", what: `A role was ${e.eventName === "RoleGranted" ? "granted" : "revoked"} on ${a.names.get(e.address.toLowerCase()) ?? e.address}.`, who: "admin: confirm it was a queued and announced timelock action", market: null, values: { role: v.role, account: v.account, by: who(v.sender, a), tx } });
        break;
      case "BuysPaused":
      case "MarketPaused":
      case "DepositsPaused": {
        const kind = e.eventName === "BuysPaused" ? "all opens (buys, routed fills, writes)" : e.eventName === "MarketPaused" ? "opens on this market" : "new deposits";
        out.push({ name: "PAUSED", level: "alarm", what: `Paused: ${kind}. Sells and withdrawals are never paused.`, who: "the Safe: review, then unpause when safe", market: e.eventName === "MarketPaused" ? market(v.market) : null, values: { by: who(v.by, a), tx } });
        break;
      }
      case "BuysUnpaused":
      case "MarketUnpaused":
      case "DepositsUnpaused":
      case "OpensResumed": {
        const kind = e.eventName === "BuysUnpaused" ? "all opens" : e.eventName === "MarketUnpaused" ? "opens on this market" : e.eventName === "DepositsUnpaused" ? "deposits" : "opens after a drawdown pause";
        out.push({ name: "UNPAUSED", level: "warn", what: `Unpaused: ${kind}.`, who: "nobody", market: e.eventName === "MarketUnpaused" ? market(v.market) : null, values: { by: who(v.by, a), tx } });
        break;
      }
    }
  }
  return out;
}

/// Hours since the last posted receipt root (or since the deploy, with none), at `now`.
export function receiptsAgeHours(anyPosted: boolean, lastEpoch: number, deployTs: number, now: number): number {
  const lastHourEnd = anyPosted ? (lastEpoch + 1) * 3600 : deployTs;
  return (now - lastHourEnd) / 3600;
}
