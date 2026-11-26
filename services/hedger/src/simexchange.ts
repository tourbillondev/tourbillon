/// A simulated crypto hedge exchange: a local HTTP server speaking the adapter's shape (common/src/exchange.ts).
/// Keys have a scope: a "read" key sees markets, the account and transfers; only a "trade" key may place orders; no key
/// can withdraw (there is no such endpoint; the test or run moves cash with the /sim/ controls). IOC orders fill at
/// mid ± slippage, or not at all when the limit is not reached; reduce-only orders never grow or flip a position;
/// partial fills, outages and price moves are scripted by the test or run that owns it. Local use only.

type Market = { name: string; szDecimals: number; pxDecimals: number; mid: number };
type Pos = { szi: number; entry: number };

export class SimExchange {
  readonly markets: Market[];
  slippageBps = 2;
  partialFraction = 1; // 1 = full fills
  outage: "none" | "http500" | "timeout" = "none";
  cash = 0; // USDC on the account (deposits − withdrawals + realised P&L)
  readonly ledger: { type: "deposit" | "withdraw"; amount: number; fee: number }[] = [];
  readonly positions = new Map<string, Pos>();
  readonly requests: { path: string; scope: string | null }[] = [];
  readonly rejected: string[] = [];
  private keys = new Map<string, "read" | "trade">();
  private server: ReturnType<typeof Bun.serve>;

  constructor(markets: (Omit<Market, "pxDecimals"> & { pxDecimals?: number })[], port = 0) {
    this.markets = markets.map((m) => ({ pxDecimals: 2, ...m }));
    this.server = Bun.serve({ port, hostname: "127.0.0.1", fetch: (req) => this.handle(req) });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    this.server.stop(true);
  }

  /// A throwaway key with a scope (local only; a real exchange issues keys to the owner).
  issueKey(scope: "read" | "trade"): string {
    const k = `sim-${scope}-${crypto.randomUUID()}`;
    this.keys.set(k, scope);
    return k;
  }

  setMid(name: string, mid: number): void {
    const m = this.markets.find((x) => x.name === name);
    if (!m) throw new Error(`no market ${name}`);
    m.mid = mid;
  }

  deposit(amount: number): void {
    this.cash += amount;
    this.ledger.push({ type: "deposit", amount, fee: 0 });
  }

  /// A withdrawal home: `amount` leaves the account; `amount − fee` arrives.
  withdraw(amount: number, fee = 1): void {
    this.cash -= amount;
    this.ledger.push({ type: "withdraw", amount, fee });
  }

  accountValue(): number {
    let v = this.cash;
    for (const [name, p] of this.positions) v += p.szi * (this.markets.find((m) => m.name === name)!.mid - p.entry);
    return v;
  }

  private async handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/sim/key") {
      const scope = new URL(req.url).searchParams.get("scope");
      if (scope !== "read" && scope !== "trade") return new Response("scope", { status: 400 });
      return Response.json({ key: this.issueKey(scope) });
    }
    const key = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const scope = this.keys.get(key) ?? null;
    this.requests.push({ path, scope });
    if (this.outage === "http500") return new Response("down", { status: 500 });
    if (this.outage === "timeout") {
      await Bun.sleep(10_000);
      return new Response("late", { status: 504 });
    }
    if (scope === null) {
      this.rejected.push(`unknown key on ${path}`);
      return new Response("unauthorised", { status: 401 });
    }
    if (req.method === "GET" && path === "/v1/markets") {
      return Response.json(this.markets.map((m) => ({ name: m.name, szDecimals: m.szDecimals, pxDecimals: m.pxDecimals, mid: String(m.mid), mark: String(m.mid) })));
    }
    if (req.method === "GET" && path === "/v1/account") {
      return Response.json({
        accountValue: String(this.accountValue()),
        positions: [...this.positions].filter(([, p]) => p.szi !== 0).map(([market, p]) => ({ market, size: String(p.szi), entryPx: String(p.entry) })),
      });
    }
    if (req.method === "GET" && path === "/v1/transfers") {
      return Response.json(this.ledger.map((e) => ({ type: e.type, amount: String(e.amount), fee: String(e.fee) })));
    }
    if (req.method === "POST" && path === "/v1/orders") {
      if (scope !== "trade") {
        this.rejected.push("a read key tried to trade");
        return new Response("forbidden: read-only key", { status: 403 });
      }
      const body = (await req.json().catch(() => ({}))) as { orders?: Record<string, unknown>[] };
      return Response.json({ fills: (body.orders ?? []).map((o) => this.fill(o)) });
    }
    return new Response("not found", { status: 404 });
  }

  private fill(o: Record<string, unknown>) {
    const market = String(o.market);
    const side = o.side === "buy" ? "buy" : "sell";
    const requested = Number(o.sz);
    const base = { market, side, requested } as const;
    const m = this.markets.find((x) => x.name === market);
    if (!m) return { ...base, filled: 0, avgPx: null, status: "error", error: "unknown market" };
    if (o.tif !== "IOC") return { ...base, filled: 0, avgPx: null, status: "error", error: "IOC only" };
    const isBuy = side === "buy";
    const limit = Number(o.limitPx);
    const fillPx = m.mid * (1 + ((isBuy ? 1 : -1) * this.slippageBps) / 10_000);
    if ((isBuy && limit < fillPx) || (!isBuy && limit > fillPx)) return { ...base, filled: 0, avgPx: null, status: "unfilled" };
    const pos = this.positions.get(m.name) ?? { szi: 0, entry: m.mid };
    let sz = requested * this.partialFraction;
    if (o.reduceOnly === true) sz = Math.min(sz, isBuy ? Math.max(0, -pos.szi) : Math.max(0, pos.szi)); // never grow or flip
    const f = 10 ** m.szDecimals;
    sz = Math.floor(sz * f + 1e-9) / f;
    if (sz <= 0) return { ...base, filled: 0, avgPx: null, status: "unfilled", error: "reduce-only would increase the position" };
    const signed = isBuy ? sz : -sz;
    // realise P&L on the part that closes, average the entry on the part that opens
    const closing = Math.sign(signed) !== Math.sign(pos.szi) && pos.szi !== 0 ? Math.min(Math.abs(signed), Math.abs(pos.szi)) : 0;
    if (closing > 0) this.cash += closing * (fillPx - pos.entry) * Math.sign(pos.szi);
    const next = pos.szi + signed;
    const opening = Math.abs(signed) - closing;
    const entry = opening > 0 ? (Math.abs(next) === opening ? fillPx : (Math.abs(pos.szi) * pos.entry + opening * fillPx) / Math.abs(next)) : pos.entry;
    this.positions.set(m.name, { szi: Number(next.toFixed(8)), entry });
    return { ...base, filled: sz, avgPx: fillPx, status: sz < requested - 1e-12 ? "partial" : "filled" };
  }
}
