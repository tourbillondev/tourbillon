import { formatUnits, getAddress, type Address } from "viem";

/// The settlement token as every service sees it (owner D1: USDG on Robinhood Chain, a USDC configuration possible).
/// The deploy reads its symbol and decimals from the token itself and writes them to the deployment file
/// (SettlementToken, settlementSymbol, settlementDecimals); every text, API field, alert and post takes them from here,
/// never from a hard-coded name or decimal count.

export type Settlement = { token: Address; symbol: string; decimals: number };

export function settlementOf(d: Record<string, unknown>): Settlement {
  if (typeof d.SettlementToken !== "string") throw new Error("deployment: missing SettlementToken");
  const symbol = d.settlementSymbol;
  const decimals = d.settlementDecimals;
  if (typeof symbol !== "string" || !/^[A-Za-z0-9.]{1,12}$/.test(symbol)) throw new Error("deployment: settlementSymbol missing or odd");
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("deployment: settlementDecimals missing");
  return { token: getAddress(d.SettlementToken), symbol, decimals };
}

/// A settlement amount (base units) as a plain number of tokens.
export function amountOf(v: bigint, s: Pick<Settlement, "decimals">): number {
  return Number(formatUnits(v, s.decimals));
}

/// "1,234.50 USDG": a settlement amount for a sentence.
export function money(v: bigint, s: Pick<Settlement, "decimals" | "symbol">): string {
  return `${amountOf(v, s).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${s.symbol}`;
}
