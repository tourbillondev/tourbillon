import { formatEther, stringToHex, type PublicClient } from "viem";
import { LOCAL_CHAIN_ID } from "@tourbillon/common/chain.ts";
import { openExchange, type ExchangeTrade, type ExMarket } from "@tourbillon/common/exchange.ts";
import { log } from "@tourbillon/common/log.ts";
import { readPositions, sourcesAbi, stockToken } from "./book.ts";
import { checkCexForChain, MAX_MARK_MISMATCH, parseCexArgs, type CexConfig, type Dep } from "./config.ts";
import { targetHedge } from "./delta.ts";
import { plan } from "./policy.ts";
import { connect, fatal, loadDeployment, loop, StatusBook } from "./run.ts";

/// hedger-cex (Backend §6, §7): the pool's net delta on each crypto market (no covering token) and the perpetual
/// orders at the crypto hedge exchange that bring the hedge to target, through a trade-only key with withdrawals off.
/// With --positions, or --dry-run, it only logs them. The exchange is the owner's choice (Q5): until then only the
/// local simulated exchange exists, so no real order can be sent from this code.

/// Size and price decimals for a dry run without an exchange (the exchange's own values are used otherwise).
const DRY_DECIMALS: Record<string, { sz: number; px: number }> = { BTC: { sz: 5, px: 1 }, ETH: { sz: 4, px: 2 } };

async function cryptoMarkets(client: PublicClient, dep: Dep): Promise<string[]> {
  const out: string[] = [];
  for (const m of dep.markets) if ((await stockToken(client, dep.pool, m)) === null) out.push(m);
  return out;
}

async function tick(cfg: CexConfig, client: PublicClient, dep: Dep, markets: string[], ex: ExchangeTrade | null, st: StatusBook): Promise<void> {
  const exMarkets: Map<string, ExMarket> | null = ex ? await ex.markets() : null;
  const positions = cfg.positions ?? (await ex!.positions());
  for (const market of markets) {
    const at = { market };
    const name = stringToHex(market, { size: 32 });
    let routerMark: number;
    let sigmaBps: number;
    try {
      routerMark = Number(formatEther(await client.readContract({ address: dep.router, abi: sourcesAbi, functionName: "markWad", args: [name] })));
      sigmaBps = Number(await client.readContract({ address: dep.board, abi: sourcesAbi, functionName: "volBps", args: [name] }));
    } catch {
      log("warn", "router mark or board vol stale: market not hedged this pass", at);
      continue;
    }
    let mid = routerMark;
    let szDecimals = DRY_DECIMALS[market]?.sz ?? 3;
    let pxDecimals = DRY_DECIMALS[market]?.px ?? 2;
    if (exMarkets) {
      const m = exMarkets.get(market);
      if (!m) {
        log("warn", "no exchange price: market not hedged this pass", at);
        continue;
      }
      if (Math.abs(m.mark - routerMark) / routerMark > MAX_MARK_MISMATCH) {
        log("warn", "exchange mark and router mark differ by more than 1%: market not hedged this pass", { ...at, exchange: m.mark, router: routerMark });
        continue;
      }
      ({ mid, szDecimals, pxDecimals } = m);
    }
    const book = await readPositions(client, dep.pool, dep.book, market);
    const wanted = targetHedge(book, routerMark, sigmaBps, 0);
    const cap = cfg.deltaCapUsd[market];
    if (cap === undefined) {
      log("warn", "no delta cap configured: market not hedged", at);
      continue;
    }
    const p = plan(market, wanted, positions.get(market) ?? 0, mid, szDecimals, pxDecimals, cap);
    if (p.unhedged > 0) {
      log("alarm", "target hedge above the hard position limit: remainder unhedged", { ...at, wanted: p.wanted, hardLimit: p.hardLimit, unhedgedCoins: p.unhedged, unhedgedUsd: p.unhedged * mid });
    }
    log("info", "plan", { ...at, venue: "cex", s: routerMark, sigmaBps, series: book.length, target: p.target, current: p.current, band: p.band, reason: p.reason, orders: p.orders });
    if (cfg.dryRun || !ex) {
      for (const o of p.orders) log("info", "would send", { ...o, dryRun: true });
      st.set(market, true);
      continue;
    }
    if (p.orders.length === 0) {
      st.set(market, true);
      continue;
    }
    const sentAt = new Date().toISOString();
    const fills = await ex.placeIoc(p.orders);
    const after = await ex.positions();
    const reconciledAt = new Date().toISOString();
    fills.forEach((f, i) => {
      // a row shaped like the spec's hedges table (Backend §8)
      log(f.status === "error" ? "warn" : "info", "hedge", {
        id: `${Date.parse(sentAt)}-${market}-${i}`,
        market,
        side: f.side,
        sz: f.requested,
        px: f.avgPx,
        sent_at: sentAt,
        reconciled_at: reconciledAt,
        filled_sz: f.filled,
        status: f.status,
        error: f.error,
        position_after: after.get(market) ?? 0,
        via: "cex_api",
      });
    });
    if (fills.some((f) => f.status === "error")) {
      st.set(market, false, "exchange refused orders");
      throw new Error(`exchange refused orders on ${market}`);
    }
    st.set(market, true);
  }
}

async function main(): Promise<void> {
  const cfg = parseCexArgs(process.argv.slice(2));
  const dep = loadDeployment(cfg.deployment);
  const client = await connect(cfg.rpc, dep);
  checkCexForChain(cfg, dep.chainId);
  const ex = cfg.exchange ? await openExchange(cfg.exchange, cfg.exchangeUrl, "trade", dep.chainId === LOCAL_CHAIN_ID) : null;
  const markets = await cryptoMarkets(client, dep);
  const st = new StatusBook(cfg.statusFile, "cex");
  log("info", "started", { venue: "cex", exchange: ex?.name ?? null, pool: dep.pool, markets, dryRun: cfg.dryRun || !ex, deltaCapUsd: cfg.deltaCapUsd });
  await loop(markets, st, cfg.once, cfg.tickSeconds, () => tick(cfg, client, dep, markets, ex, st));
}

if (import.meta.main) main().catch(fatal);
