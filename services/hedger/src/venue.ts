/// What the hedger needs from a perp venue. Two implementations: HyperliquidVenue (src/hlvenue.ts; the simulated venue
/// speaks the same HTTP API, so it is driven through the same adapter).

export type VenueMarket = { name: string; asset: number; szDecimals: number; mid: number; mark: number };
export type IocOrder = { market: string; side: "buy" | "sell"; sz: number; limitPx: number; reduceOnly: boolean };
export type Fill = { market: string; side: "buy" | "sell"; requested: number; filled: number; avgPx: number | null; status: "filled" | "partial" | "unfilled" | "error"; error?: string };

export interface Venue {
  markets(): Promise<Map<string, VenueMarket>>;
  positions(): Promise<Map<string, number>>; // coin → signed size
  accountValue(): Promise<number>;
  placeIoc(orders: IocOrder[], markets: Map<string, VenueMarket>): Promise<Fill[]>;
}
