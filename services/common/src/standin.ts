/// LOCAL ONLY: a stand-in for the signers' off-chain feeds on this machine (exchange tickers, Pyth, an equity
/// reference), answering in each provider's own reply shape. Used by the signer's anvil test, the local soak and the
/// local end-to-end run (poker/scripts/local-m7-run.ts).
/// Never used against a real chain: the feeds file allows plain http to this machine on a local anvil only.

export type StandIn = {
  url: string;
  /// Sets every source of `market` to `px` (a decimal string); `pythPx` and `refPx` override those two.
  set(market: string, px: string, over?: { pythPx?: string; refPx?: string }): void;
  /// Makes one source fail with HTTP 503 (`"pyth"`, `"equity"`, or an exchange name), or heals it.
  down(source: string, isDown: boolean): void;
  stop(): void;
};

export function startStandIn(port = 0): StandIn {
  const px = new Map<string, { ex: string; pyth: string; ref: string }>();
  const pythIds = new Map<string, string>(); // id (no 0x, lower case) → market
  const isDown = new Set<string>();
  const now = () => Date.now();
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      const [, source, symbolRaw] = u.pathname.split("/");
      const symbol = decodeURIComponent(symbolRaw ?? "");
      if (isDown.has(source ?? "")) return new Response("down", { status: 503 });
      const marketOf = (s: string) => s.split(/[-/]/)[0]!.replace(/^XBT/, "BTC").replace(/USD.*$/, "");
      if (source === "coinbase") {
        const p = px.get(marketOf(symbol));
        return p ? Response.json({ price: p.ex, time: new Date(now()).toISOString() }) : new Response("no", { status: 404 });
      }
      if (source === "kraken") {
        const p = px.get(marketOf(symbol));
        return p ? Response.json({ error: [], result: { [symbol]: { c: [p.ex, "0.01"] } } }) : Response.json({ error: ["EQuery:Unknown asset pair"] });
      }
      if (source === "okx") {
        const p = px.get(marketOf(symbol));
        return p ? Response.json({ code: "0", data: [{ last: p.ex, ts: String(now()) }] }) : Response.json({ code: "51001", data: [] });
      }
      if (source === "v2") {
        if (isDown.has("pyth")) return new Response("down", { status: 503 });
        const id = (u.searchParams.get("ids[]") ?? "").toLowerCase().replace(/^0x/, "");
        const m = pythIds.get(id);
        const p = m ? px.get(m) : undefined;
        if (!p) return Response.json({ parsed: [] });
        const [int, frac = ""] = p.pyth.split(".");
        const raw = `${int}${frac.padEnd(8, "0").slice(0, 8)}`.replace(/^0+(?=\d)/, "");
        return Response.json({ parsed: [{ id, price: { price: raw, conf: "1", expo: -8, publish_time: Math.floor(now() / 1000) } }] });
      }
      if (source === "equity") {
        const p = px.get(symbol);
        return p ? Response.json({ price: p.ref, t: Math.floor(now() / 1000) }) : new Response("no", { status: 404 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    set(market, p, over = {}) {
      px.set(market, { ex: p, pyth: over.pythPx ?? p, ref: over.refPx ?? p });
      pythIds.set(pythIdFor(market), market);
    },
    down(source, d) {
      if (d) isDown.add(source);
      else isDown.delete(source);
    },
    stop: () => server.stop(true),
  };
}

/// A made-up, stable Pyth id per market for the stand-in (32 bytes of hex, no 0x).
export function pythIdFor(market: string): string {
  const h = new Bun.CryptoHasher("sha256").update(`standin:${market}`).digest("hex");
  return h;
}

/// A feeds file for the stand-in: crypto markets read three exchanges and Pyth; stock markets read `adapter`.
export function standInFeeds(url: string, markets: { name: string; kind: "stock" | "crypto"; adapter?: string; assetId?: string }[]) {
  const out: Record<string, unknown> = {};
  for (const m of markets) {
    out[m.name] =
      m.kind === "crypto"
        ? {
            kind: "crypto",
            exchanges: [
              { exchange: "coinbase", symbol: `${m.name}-USD`, url },
              { exchange: "kraken", symbol: `${m.name === "BTC" ? "XBT" : m.name}USD`, url },
              { exchange: "okx", symbol: `${m.name}-USDC`, url },
            ],
            pyth: { id: `0x${pythIdFor(m.name)}`, url },
          }
        : { kind: "stock", onchain: { adapter: m.adapter, assetId: m.assetId }, reference: { url: `${url}/equity/${m.name}`, price: "price", time: "t", timeUnit: "s" } };
  }
  return { markets: out };
}
