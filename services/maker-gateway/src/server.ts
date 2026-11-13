import type { Address, Hex } from "viem";
import { parseOrder, parseQuote, parseSig, signedByMaker, termsProblem, toJson } from "./quote.ts";
import { QuoteStore, type QuoteState } from "./store.ts";

/// The gateway's HTTP side (M6 decision D14): accepts signed quotes and serves the best ones for an order. No keys, no
/// custody, no transactions: it reads the chain and passes signatures on.
///
///   POST /quotes  { quote, sig }                 → 200 { accepted: true } | 400 { error }
///   POST /best    { name, legs, movement, units } → 200 { quotes: [{ quote, sig }], mark } | 400 { error }
///   GET  /health                                 → 200 { quotes, chainId, quoteBook }
///
/// A quote is accepted when: its terms are sound, it is signed by its maker for this chain and VolQuoteBook, it has not
/// expired (chain time), its nonce is not cancelled and has room left, and the maker's vault holds some free USDC.

export type Chain = QuoteState & {
  chainId: number;
  quoteBook: Address;
  now(): Promise<bigint>; // the latest block's timestamp
  markOf(name: Hex): Promise<number | null>; // the router's fresh mark, null when stale (law 2: nothing fills)
};

export function makeHandler(chain: Chain, store = new QuoteStore()) {
  const json = (body: unknown, status = 200) => new Response(toJson(body), { status, headers: { "content-type": "application/json" } });
  const bad = (error: string) => json({ error }, 400);

  async function accept(body: Record<string, unknown>): Promise<Response> {
    const quote = parseQuote(body.quote);
    const sig = parseSig(body.sig);
    const problem = termsProblem(quote);
    if (problem) return bad(problem);
    if (!(await signedByMaker(quote, sig, chain.chainId, chain.quoteBook))) return bad("not signed by the maker for this chain and quote book");
    if (quote.validUntil < (await chain.now())) return bad("expired");
    const [filled, cancelled, free] = await Promise.all([chain.filled(quote.maker, quote.nonce), chain.cancelled(quote.maker, quote.nonce), chain.freeUsdc(quote.maker)]);
    if (cancelled) return bad("nonce cancelled");
    if (filled >= quote.maxUnits) return bad("fully filled");
    if (free === 0n) return bad("the maker's vault has no free USDC");
    store.add({ quote, sig, receivedAt: Date.now() });
    return json({ accepted: true });
  }

  async function best(body: Record<string, unknown>): Promise<Response> {
    const order = parseOrder(body);
    const mark = await chain.markOf(order.name);
    if (mark === null) return json({ quotes: [], mark: null, reason: "no fresh mark: nothing fills on this market (law 2)" });
    const quotes = await store.best(order, mark, await chain.now(), chain);
    return json({ quotes: quotes.map((s) => ({ quote: s.quote, sig: s.sig })), mark });
  }

  return {
    store,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      try {
        if (req.method === "GET" && url.pathname === "/health") return json({ quotes: store.size, chainId: chain.chainId, quoteBook: chain.quoteBook });
        if (req.method === "POST" && (url.pathname === "/quotes" || url.pathname === "/best")) {
          const body = (await req.json()) as Record<string, unknown>;
          return url.pathname === "/quotes" ? await accept(body) : await best(body);
        }
        return json({ error: "not found" }, 404);
      } catch (e) {
        return bad((e as Error).message.split("\n")[0] ?? "bad request");
      }
    },
  };
}
