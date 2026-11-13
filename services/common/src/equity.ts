import { encodeAbiParameters, keccak256, type Address } from "viem";
import { decimalToWad, HL_API, TIMEOUT_MS } from "./hyperliquid.ts";
import { log } from "./log.ts";

type Reading = { value: bigint; at: number } | null;

/// The EQUITY board key (M3 step 4). Each signer posts the pool's Hyperliquid P&L only:
///
///   EQUITY = account value − deposits credited + withdrawals sent home (net of Hyperliquid's withdrawal fee)
///
/// plus a fixed offset (P&L can be negative; board values cannot). Transfers between the pool and Hyperliquid
/// cancel out of this value, so they never pass through the board; the pool adds the in-transit part on-chain from
/// its own counters (sentOut − receivedBack). Read from Hyperliquid's public info API only: `clearinghouseState`
/// (perp account value) and `userNonFundingLedgerUpdates` (deposits and withdrawals).
///
/// (U) to confirm on Hyperliquid testnet: the ledger field names and that a withdrawal's `usdc` includes its `fee`;
/// that the hedger keeps all capital in the perp account (spot balances and internal transfers are not counted).

/// Must equal MainspringPool.EQUITY_OFFSET: 10^12 USDC in WAD.
export const EQUITY_OFFSET = 10n ** 30n;

/// The pool's EQUITY key: keccak256(abi.encode("EQUITY", pool)), as MainspringPool.equityKey().
export function equityKey(pool: Address): `0x${string}` {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "address" }], ["EQUITY", pool]));
}

type LedgerEntry = { time?: number; delta?: { type?: string; usdc?: string; fee?: string } };

/// Deposits credited and withdrawals sent home (net of fee), WAD, from a userNonFundingLedgerUpdates reply.
export function transfersFromLedger(body: unknown): { deposits: bigint; withdrawalsNet: bigint } {
  if (!Array.isArray(body)) throw new Error("ledger: reply is not a list");
  let deposits = 0n;
  let withdrawalsNet = 0n;
  for (const e of body as LedgerEntry[]) {
    const d = e?.delta;
    if (!d || typeof d.type !== "string") continue;
    if (d.type === "deposit") deposits += decimalToWad(d.usdc);
    else if (d.type === "withdraw") {
      const gross = decimalToWad(d.usdc);
      const fee = d.fee === undefined || d.fee === "0" || d.fee === "0.0" ? 0n : decimalToWad(d.fee);
      withdrawalsNet += gross > fee ? gross - fee : 0n;
    }
  }
  return { deposits, withdrawalsNet };
}

/// Perp account value, WAD, from a clearinghouseState reply.
export function accountValueFrom(body: unknown): bigint {
  const v = (body as { marginSummary?: { accountValue?: unknown } })?.marginSummary?.accountValue;
  if (v === "0" || v === "0.0") return 0n;
  return decimalToWad(v);
}

/// The value to vote: P&L only, plus the offset. Never below 1 (a broken read gives no reading instead).
export function equityVote(accountValue: bigint, deposits: bigint, withdrawalsNet: bigint): bigint {
  const v = EQUITY_OFFSET + accountValue - deposits + withdrawalsNet;
  if (v <= 0n) throw new Error("equity: value below the offset range");
  return v;
}

async function info(base: string, body: object, timeoutMs: number): Promise<unknown> {
  const res = await fetch(new URL("/info", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/// Reads the pool's Hyperliquid account once per call. A failed read gives no reading (no vote).
export class EquitySource {
  constructor(
    private readonly hlUser: Address,
    private readonly base = HL_API,
    private readonly timeoutMs = TIMEOUT_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  async read(now: number): Promise<Reading> {
    const startedMs = this.clock();
    try {
      const [state, ledger] = await Promise.all([
        info(this.base, { type: "clearinghouseState", user: this.hlUser }, this.timeoutMs),
        info(this.base, { type: "userNonFundingLedgerUpdates", user: this.hlUser, startTime: 0 }, this.timeoutMs),
      ]);
      const { deposits, withdrawalsNet } = transfersFromLedger(ledger);
      const value = equityVote(accountValueFrom(state), deposits, withdrawalsNet);
      const ageS = Math.max(0, Math.ceil((this.clock() - startedMs) / 1000));
      return { value, at: now - ageS };
    } catch (e) {
      log("warn", "equity read failed", { error: (e as Error).message });
      return null;
    }
  }
}
