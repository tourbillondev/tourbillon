import type { Address, LocalAccount } from "viem";
import { fetchMetaAndAssetCtxs, parseMarks, TIMEOUT_MS } from "@tourbillon/common/hyperliquid.ts";
import { orderAction, orderWire, signL1Action } from "./hlsign.ts";
import type { Fill, IocOrder, Venue, VenueMarket } from "./venue.ts";
import { formatEther } from "viem";

/// Hyperliquid (and the simulated venue, which speaks the same API).
/// GUARD: orders may be sent only to Hyperliquid's TESTNET or to a local URL (the simulated venue). The mainnet
/// exchange is refused here; lifting that needs a new owner decision. Signatures use source "b" (testnet).

export const HL_TESTNET = "https://api.hyperliquid-testnet.xyz";
export const HL_MAINNET = "https://api.hyperliquid.xyz";

export function assertOrderUrlAllowed(base: string): void {
  const u = new URL(base);
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (local) return;
  if (u.origin === new URL(HL_TESTNET).origin) return;
  throw new Error(`orders refused: ${u.origin} is not Hyperliquid testnet or a local simulated venue (mainnet is never allowed in M3)`);
}

async function post(base: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(new URL(path, base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  return res.json();
}

export class HyperliquidVenue implements Venue {
  private lastNonce = 0;

  constructor(
    private readonly base: string,
    private readonly user: Address, // the pool's Hyperliquid account
    private readonly agent: LocalAccount | null, // null: read-only
    private readonly marketNames: string[],
  ) {
    if (agent) assertOrderUrlAllowed(base);
  }

  async markets(): Promise<Map<string, VenueMarket>> {
    const body = await fetchMetaAndAssetCtxs(this.base);
    const marks = parseMarks(body, this.marketNames);
    const universe = (body as [{ universe: { name: string }[] }])[0].universe;
    const out = new Map<string, VenueMarket>();
    for (const [name, r] of marks) {
      if (!r.ok) continue;
      const mark = Number(formatEther(r.mark));
      out.set(name, { name, asset: universe.findIndex((u) => u.name === name), szDecimals: r.szDecimals, mark, mid: r.mid !== null ? Number(formatEther(r.mid)) : mark });
    }
    return out;
  }

  private async state(): Promise<{ marginSummary?: { accountValue?: string }; assetPositions?: { position?: { coin?: string; szi?: string } }[] }> {
    return (await post(this.base, "/info", { type: "clearinghouseState", user: this.user })) as never;
  }

  async positions(): Promise<Map<string, number>> {
    const s = await this.state();
    const out = new Map<string, number>();
    for (const ap of s.assetPositions ?? []) if (ap.position?.coin && ap.position.szi !== undefined) out.set(ap.position.coin, Number(ap.position.szi));
    return out;
  }

  async accountValue(): Promise<number> {
    return Number((await this.state()).marginSummary?.accountValue ?? 0);
  }

  async placeIoc(orders: IocOrder[], markets: Map<string, VenueMarket>): Promise<Fill[]> {
    if (!this.agent) throw new Error("read-only venue: no agent key");
    if (orders.length === 0) return [];
    const wires = orders.map((o) => {
      const m = markets.get(o.market);
      if (!m) throw new Error(`unknown market ${o.market}`);
      return orderWire({ asset: m.asset, isBuy: o.side === "buy", px: o.limitPx, sz: o.sz, reduceOnly: o.reduceOnly, tif: "Ioc" });
    });
    const action = orderAction(wires);
    const nonce = Math.max(Date.now(), this.lastNonce + 1);
    this.lastNonce = nonce;
    const signature = await signL1Action(this.agent, action, nonce, false);
    const res = (await post(this.base, "/exchange", { action, nonce, signature, vaultAddress: null })) as {
      status: string;
      response?: { data?: { statuses?: ({ filled?: { totalSz: string; avgPx: string } } | { error?: string })[] } } | string;
    };
    if (res.status !== "ok" || typeof res.response !== "object") {
      return orders.map((o) => ({ market: o.market, side: o.side, requested: o.sz, filled: 0, avgPx: null, status: "error", error: String(res.response) }));
    }
    const statuses = res.response.data?.statuses ?? [];
    return orders.map((o, i) => {
      const st = statuses[i] as { filled?: { totalSz: string; avgPx: string }; error?: string } | undefined;
      if (st?.filled) {
        const filled = Number(st.filled.totalSz);
        return { market: o.market, side: o.side, requested: o.sz, filled, avgPx: Number(st.filled.avgPx), status: filled + 1e-12 >= o.sz ? "filled" : "partial" };
      }
      return { market: o.market, side: o.side, requested: o.sz, filled: 0, avgPx: null, status: "unfilled", error: st?.error };
    });
  }
}
