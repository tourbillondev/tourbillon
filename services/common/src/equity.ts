import { encodeAbiParameters, keccak256, type Address } from "viem";
import type { ExchangeRead } from "./exchange.ts";
import { log } from "./log.ts";

type Reading = { value: bigint; at: number } | null;

/// The EQUITY board key (M3 step 4; RH6: the crypto hedge exchange, Backend §6). Each signer posts the pool's
/// exchange-account P&L only:
///
///   EQUITY = account value − deposits credited + withdrawals sent home (net of the exchange's withdrawal fee)
///
/// plus a fixed offset (P&L can be negative; board values cannot). Transfers between the pool and the exchange cancel
/// out of this value, so they never pass through the board; the pool adds the in-transit part on-chain from its own
/// counters (sentOut − receivedBack). Read with a read-only key (ExchangeRead): the account value and the transfer
/// history. Checked hourly against the exchange's own reply by the risk-monitor (equity-mismatch).

/// Must equal MainspringPool.EQUITY_OFFSET: 10^12 USDC in WAD.
export const EQUITY_OFFSET = 10n ** 30n;

/// The pool's EQUITY key: keccak256(abi.encode("EQUITY", pool)), as MainspringPool.equityKey().
export function equityKey(pool: Address): `0x${string}` {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "address" }], ["EQUITY", pool]));
}

/// The value to vote: P&L only, plus the offset. Never below 1 (a broken read gives no reading instead).
export function equityVote(accountValue: bigint, deposits: bigint, withdrawalsNet: bigint): bigint {
  const v = EQUITY_OFFSET + accountValue - deposits + withdrawalsNet;
  if (v <= 0n) throw new Error("equity: value below the offset range");
  return v;
}

/// Reads the pool's exchange account once per call. A failed read gives no reading (no vote).
export class EquitySource {
  constructor(
    private readonly exchange: ExchangeRead,
    private readonly clock: () => number = Date.now,
  ) {}

  async read(now: number): Promise<Reading> {
    const startedMs = this.clock();
    try {
      const [value, { deposits, withdrawalsNet }] = await Promise.all([this.exchange.accountValue(), this.exchange.transfers()]);
      const v = equityVote(value, deposits, withdrawalsNet);
      const ageS = Math.max(0, Math.ceil((this.clock() - startedMs) / 1000));
      return { value: v, at: now - ageS };
    } catch (e) {
      log("warn", "equity read failed", { error: (e as Error).message });
      return null;
    }
  }
}
