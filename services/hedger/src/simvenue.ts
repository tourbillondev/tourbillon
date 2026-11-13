import { recoverTypedDataAddress, serializeSignature, type Address, type Hex } from "viem";
import { actionHash, l1TypedData, type OrderAction } from "./hlsign.ts";

/// A simulated Hyperliquid venue: a local HTTP server speaking the parts of /info and /exchange the hedger and the
/// signers use. It checks every order's signature (it must come from the agent approved for the account, with a fresh
/// nonce); IOC orders fill at mid ± slippage, or not at all when the limit is not reached; reduce-only orders never
/// grow or flip a position; partial fills, outages and price moves are scripted by the test or run that owns it.
/// Local use only (tests and the step 11 run).

type Market = { name: string; szDecimals: number; mid: number };
type Pos = { szi: number; entry: number };

export class SimVenue {
  readonly markets: Market[];
  slippageBps = 2;
  partialFraction = 1; // 1 = full fills
  outage: "none" | "http500" | "timeout" = "none";
  cash = 0; // USDC on the account (deposits − withdrawals + realised P&L)
  readonly ledger: { type: "deposit" | "withdraw"; usdc: number; fee: number }[] = [];
  readonly positions = new Map<string, Pos>();
  readonly requests: { path: string; type: string }[] = [];
  readonly rejected: string[] = [];
  private agents = new Map<string, string>(); // user (lowercase) → agent (lowercase)
  private lastNonce = new Map<string, number>();
  private server: ReturnType<typeof Bun.serve>;

  constructor(markets: Market[], port = 0) {
    this.markets = markets;
    this.server = Bun.serve({ port, fetch: (req) => this.handle(req) });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    this.server.stop(true);
  }

  setMid(name: string, mid: number): void {
    const m = this.markets.find((x) => x.name === name);
    if (!m) throw new Error(`no market ${name}`);
    m.mid = mid;
  }

  deposit(amount: number): void {
    this.cash += amount;
    this.ledger.push({ type: "deposit", usdc: amount, fee: 0 });
  }

  /// A withdrawal home: `amount` leaves the account; `amount − fee` arrives (Hyperliquid charges a fee).
  withdraw(amount: number, fee = 1): void {
    this.cash -= amount;
    this.ledger.push({ type: "withdraw", usdc: amount, fee });
  }

  accountValue(): number {
    let v = this.cash;
    for (const [coin, p] of this.positions) v += p.szi * (this.markets.find((m) => m.name === coin)!.mid - p.entry);
    return v;
  }

  private async handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    this.requests.push({ path, type: String((body.action as { type?: string } | undefined)?.type ?? body.type ?? "") });
    if (path === "/sim/approve") {
      // local admin call: the account approves an agent (the real venue does this with approveAgent from the owner)
      this.agents.set(String(body.user).toLowerCase(), String(body.agent).toLowerCase());
      return Response.json({ status: "ok" });
    }
    if (this.outage === "http500") return new Response("down", { status: 500 });
    if (this.outage === "timeout") {
      await Bun.sleep(10_000);
      return new Response("late", { status: 504 });
    }
    if (path === "/info") return this.info(body);
    if (path === "/exchange") return this.exchange(body);
    return new Response("not found", { status: 404 });
  }

  private info(b: Record<string, unknown>): Response {
    if (b.type === "metaAndAssetCtxs") {
      return Response.json([
        { universe: this.markets.map((m) => ({ name: m.name, szDecimals: m.szDecimals })) },
        this.markets.map((m) => ({ markPx: String(m.mid), oraclePx: String(m.mid), midPx: String(m.mid) })),
      ]);
    }
    if (b.type === "clearinghouseState") {
      return Response.json({
        marginSummary: { accountValue: String(this.accountValue()) },
        assetPositions: [...this.positions].filter(([, p]) => p.szi !== 0).map(([coin, p]) => ({ position: { coin, szi: String(p.szi), entryPx: String(p.entry) } })),
      });
    }
    if (b.type === "userNonFundingLedgerUpdates") {
      return Response.json(
        this.ledger.map((e, i) => ({ time: i + 1, delta: e.type === "deposit" ? { type: "deposit", usdc: String(e.usdc) } : { type: "withdraw", usdc: String(e.usdc), fee: String(e.fee) } })),
      );
    }
    return new Response("unknown info type", { status: 400 });
  }

  private async exchange(b: Record<string, unknown>): Promise<Response> {
    const reject = (why: string) => {
      this.rejected.push(why);
      return Response.json({ status: "err", response: why });
    };
    const action = b.action as OrderAction;
    const nonce = Number(b.nonce);
    const sig = b.signature as { r: Hex; s: Hex; v: number };
    if (action?.type !== "order") return reject(`unsupported action ${String((action as { type?: string })?.type)}`);
    let signer: string;
    try {
      const signature = serializeSignature({ r: sig.r, s: sig.s, v: BigInt(sig.v) });
      signer = (await recoverTypedDataAddress({ ...l1TypedData(actionHash(action, null, nonce), false), signature })).toLowerCase();
    } catch {
      return reject("bad signature");
    }
    const user = [...this.agents].find(([, agent]) => agent === signer)?.[0];
    if (!user) return reject(`signer ${signer} is not an approved agent`);
    if (nonce <= (this.lastNonce.get(signer) ?? 0)) return reject("nonce already used");
    this.lastNonce.set(signer, nonce);

    const statuses = action.orders.map((o) => {
      const m = this.markets[o.a];
      if (!m) return { error: "unknown asset" };
      const isBuy = o.b;
      const limit = Number(o.p);
      const fillPx = m.mid * (1 + ((isBuy ? 1 : -1) * this.slippageBps) / 10_000);
      if ((isBuy && limit < fillPx) || (!isBuy && limit > fillPx)) return { error: "Order could not immediately match against any resting orders." };
      const pos = this.positions.get(m.name) ?? { szi: 0, entry: m.mid };
      let sz = Number(o.s) * this.partialFraction;
      if (o.r) {
        const room = isBuy ? Math.max(0, -pos.szi) : Math.max(0, pos.szi); // reduce-only: never grow or flip
        sz = Math.min(sz, room);
      }
      const f = 10 ** m.szDecimals;
      sz = Math.floor(sz * f + 1e-9) / f;
      if (sz <= 0) return { error: "Reduce only order would increase position." };
      const signed = isBuy ? sz : -sz;
      // realise P&L on the part that closes, average the entry on the part that opens
      const closing = Math.sign(signed) !== Math.sign(pos.szi) && pos.szi !== 0 ? Math.min(Math.abs(signed), Math.abs(pos.szi)) : 0;
      if (closing > 0) this.cash += closing * (fillPx - pos.entry) * Math.sign(pos.szi);
      const next = pos.szi + signed;
      const opening = Math.abs(signed) - closing;
      const entry = opening > 0 ? (Math.abs(next) === opening ? fillPx : (Math.abs(pos.szi) * pos.entry + opening * fillPx) / Math.abs(next)) : pos.entry;
      this.positions.set(m.name, { szi: Number(next.toFixed(8)), entry });
      return { filled: { totalSz: String(sz), avgPx: String(fillPx), oid: nonce } };
    });
    return Response.json({ status: "ok", response: { type: "order", data: { statuses } } });
  }
}
