import { describe, expect, test } from "bun:test";
import { encodeFunctionData, getAddress, stringToHex, type Address } from "viem";
import { describeCall, governedAbi, m7Alarms, receiptsAgeHours, type M7Addresses, type M7Event } from "../src/m7.ts";

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`) as Address;
const addrs: M7Addresses = { timelock: A(1), receipts: A(2), safe: A(3), guardian: A(4), riskPauser: A(5), deployer: A(6), names: new Map([[A(10).toLowerCase(), "MainspringPool"], [A(11).toLowerCase(), "Engine"]]) };
const ev = (eventName: string, args: Record<string, unknown>, address = A(10)): M7Event => ({ eventName, args, address, transactionHash: "0x01", blockTimestamp: 1_000 });

describe("M7 alarms", () => {
  test("a queued action is named with its arguments and when it can run; executed and cancelled are announced", () => {
    const data = encodeFunctionData({ abi: governedAbi, functionName: "setCaps", args: [stringToHex("BTC", { size: 32 }), 4_000_000_000_000n, 1_000_000_000_000n] });
    const out = m7Alarms([ev("CallScheduled", { id: "0xaa", target: A(10), data, delay: 3600n }, A(1)), ev("CallExecuted", { id: "0xaa", target: A(10), data }, A(1)), ev("Cancelled", { id: "0xbb" }, A(1))], addrs);
    expect(out.map((a) => a.name)).toEqual(["TIMELOCK_QUEUED", "TIMELOCK_EXECUTED", "TIMELOCK_CANCELLED"]);
    expect(out[0]!.values.call).toBe("setCaps(BTC, 4000000000000, 1000000000000)");
    expect(out[0]!.values.contract).toBe("MainspringPool");
    expect(out[0]!.values.executableAt).toBe(4_600);
    expect(out[0]!.level).toBe("alarm");
    expect(describeCall(A(99), "0x12345678", addrs.names).call).toBe("unknown call 0x12345678");
  });

  test("pauses and unpauses say who; role changes by anyone but the deployer are announced", () => {
    const out = m7Alarms(
      [
        ev("BuysPaused", { by: A(4) }, A(11)),
        ev("MarketPaused", { market: stringToHex("ETH", { size: 32 }), by: A(5) }),
        ev("DepositsPaused", { by: A(4) }),
        ev("BuysUnpaused", { by: A(3) }, A(11)),
        ev("OpensResumed", { by: A(3), navPerShare: 1n }),
        ev("RoleGranted", { role: "0x00", account: A(7), sender: A(6) }), // the deploy's handover: skipped
        ev("RoleGranted", { role: "0x00", account: A(7), sender: A(1) }),
      ],
      addrs,
    );
    expect(out.map((a) => a.name)).toEqual(["PAUSED", "PAUSED", "PAUSED", "UNPAUSED", "UNPAUSED", "ROLE_CHANGED"]);
    expect(out[0]!.values.by).toBe("the guardian");
    expect(out[1]!.values.by).toBe("the automated risk key (E1)");
    expect(out[1]!.market).toBe("ETH");
    expect(out[3]!.values.by).toBe("the Safe");
    expect(out[5]!.values.by).toBe("the timelock");
    expect(out[5]!.what).toContain("MainspringPool");
  });

  test("receipts age: since the end of the last posted hour, or since the deploy", () => {
    expect(receiptsAgeHours(true, 10, 0, 11 * 3600 + 1800)).toBe(0.5);
    expect(receiptsAgeHours(false, 0, 7_200, 7_200 + 3 * 3600)).toBe(3);
  });
});
