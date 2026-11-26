# Architecture

Tourbillon is an options venue with no expiry on Robinhood Chain: buyers hold calls, puts and shapes of up to four legs
that never expire, and pay funding along the recorded price path instead. Settlement is in one stablecoin (USDG on
Robinhood Chain, a deploy setting) counted in 6-decimal units. This page lists the components, how money and prices
move, and every privileged function with who holds it.

## Contracts (`contracts/src`)

| Contract | What it does |
|---|---|
| `QuorumBoard` | m-of-n signer votes per key (MARK, VOL, EQUITY): median, step clamp, heartbeat; anchor band; out-of-session band for stock marks |
| `QuorumMarkSource`, `NativeMarkSource` | Mark sources: the quorum (primary today) and Robinhood Chain's first-party mark (a stub until its interface is published) |
| `MarkRouter` | Per market: primary and cross-check source, freshness, maximum deviation; a route change waits its own delay |
| `SessionCalendar` | The US regular session, holidays and early closes per year; weekend and holiday open caps for stock markets |
| `PathFundingBook` | Price samples (5 min, hourly, daily) and each series' funding factor; anyone may `poke` and `accrue` |
| `TempoMath`, `TempoBlend`, `PathFunding`, `EnginePricing`, `ShapeQuote`, `ShapeGreeks`, `StrategyMath` | Pricing and funding maths, exact worst-case collateral for shapes |
| `Engine` | Buys and sells of single legs and shapes; the price comes from the router and the board, never from a caller |
| `OpenBook` | Routes a buy to the cheapest of the pool, signed maker quotes (`VolQuoteBook`) and writer offers (`MatchBook`) |
| `MainspringPool` | The pool that takes the other side: LP rounds at NAV, stressed liability and coverage, caps, pauses, the treasury route to the crypto hedge exchange, the on-chain stock hedge (`HedgeSwap`) |
| `PoolLiability`, `HedgeSwap` | Linked libraries of the pool: liability marking; hedge swaps and their limits |
| `WriterBook` | Writers sell shapes to the pool against exact collateral (settlement token, or the market's tokenized stock) |
| `MakerVault`, `MatchBook`, `VolQuoteBook`, `VolFeed` | The open book: maker collateral, matched entries and buybacks, signed vol quotes, the published fill vol |
| `RiskAuction` | The weekly sealed auction that moves pool risk to makers |
| `CoveringAssets`, `CoverLedger` | Which tokenized stock may cover which market (listed once); cover that cannot move is kept owed and settled later |
| `SettlementAdapter` | The settlement token's form: symbol and decimals read from the token (6 decimals required), approve or permit |
| `UniswapV4HedgeRouter` | The stock hedge's swap path through Uniswap v4 on Robinhood Chain (one listed pool per pair, no hooks) |
| `HedgeKeeperGate` | Holds the pool's hedge keeper role instead of a key: forwards only the listed hedger key's swaps; the guardian freezes it at once, only the Safe unfreezes |
| `ReceiptRoots` | One Merkle root per hour over trades, vol finals and NAV snapshots |
| `AgentRouter` | Owner-signed mandates for agents: markets, families, premium caps, delta and vega budgets, expiry, close-only |
| `Governance` | Deploys the 3-of-5 Safe, the 2-of-3 guardian and the timelock |

## Services (`services/`)

| Service | Job |
|---|---|
| `quorum-signer` (× n) | Reads two sources per market and votes MARK, VOL and (optionally) EQUITY on the board |
| `poker` | Pokes every market's price sample every 5 minutes; keeps the pool's hourly epochs and walks long series |
| `hedger` | `hedger-onchain`: the stock hedge through the pool's `hedgeSwap`. `hedger-cex`: BTC and ETH perpetuals at Binance USDⓈ-M futures (trade-only key) |
| `risk-monitor` | Alarms (lower-dash names) and the only automated action: pausing opens on one market |
| `maker-gateway` | Serves makers' signed vol quotes to buyers |
| `receipts` | Builds and posts the hourly receipt root; serves proofs |
| `indexer` | Postgres tables: samples, board votes and finals, the marks audit trail, positions, hedges |
| `api`, `mcp` | Read-only API v1; tools for agents (chains, quotes, unsigned transactions, mandates) |
| `alert-bot` | Posts risk and ops alarms to the alert group (send-only) |
| `release` | The hourly release system for the queued updates (gate, build, deploy testnet then mainnet, live checks, publish); tells the team bot what to post |
| `teambot` | The only poster of the launch (hourly set, status lines, pinned board, Shipped today, staff commands) and of release emergencies; the only Telegram reader |

## How a price reaches a trade
1. Each signer reads its two sources per market and votes only when they agree (stocks: the on-chain token price within
   1% of the equity reference in session; crypto: the exchange median within 1% of Pyth).
2. The board publishes the median once a quorum is in, clamped to a step from the last value and, for a stock outside the
   session, to ±10% of the last session value.
3. The router serves the primary source if it is fresh and within the cross-check; otherwise `markWad` reverts.
4. The Engine prices every buy and sell from the router's mark and the board's vol, at the current block. A stale mark
   means no open on that market (law 2); a sell uses the last good sample (law 3).

## How money moves
- A buyer pays premium and fee in the settlement token; the pool (or a matched maker or writer) takes the other side.
  A buyer can never owe more than it paid (law 1).
- Writers and makers lock the exact worst case of what they sell (law 4), in the settlement token or the market's
  tokenized stock.
- LPs deposit and withdraw in hourly rounds at NAV. NAV = available settlement token + the pool's tokenized stock at the
  router mark + the crypto hedge account's equity (signer-voted, with a haircut) − the marked liability.
- The pool hedges stock delta by holding the stock (swaps through the listed router) and crypto delta with perpetuals
  at the exchange (USDC or USDT margin moved through the treasury route).

## Roles matrix (after the M7 handover)

Holders: **Timelock** = the 3-of-5 Safe schedules, anyone executes after the delay (48 h on mainnet, 1 h on testnet);
**Safe** = 3-of-5 directly; **Guardian** = 2-of-3; **E1** = the automated risk key; **Poster** = the receipts service's
key; **Keeper** = hedger-onchain's key (it holds no role itself: it is the hedger listed on the gate); **Gate** = the
`HedgeKeeperGate` contract; **Deployer** = the one-time deploy key, which holds nothing after the handover.

| Contract | Function | Role | Held by |
|---|---|---|---|
| QuorumBoard | `setSigner`, `setQuorum`, `setWindow`, `setFeed`, `setAnchor`, `clearAnchor`, `setCalendar`, `setSessionKey` | admin | Timelock |
| QuorumBoard | `vote` | listed signer | each signer (one vote per round) |
| MarkRouter | `queueRoute`, `cancelRoute` | admin | Timelock (a queued route also waits the router's own delay) |
| NativeMarkSource | `setAdapter`, `setAsset`, `setCallGas` | admin | Timelock (not deployed until a first-party mark exists) |
| SessionCalendar | `setYear`, `setHours`, `setStockMarket` | admin | Timelock |
| CoveringAssets | `list` (each market once, never changed) | admin | Timelock |
| Engine | `setMarket`, `setOpenBook`, `setWriterBook` | admin | Timelock (the books are set once) |
| Engine | `pauseBuys` | pauser | Guardian |
| Engine | `unpauseBuys` | unpauser | Safe |
| MainspringPool | `listMarket`, `setShock`, `setVolMult`, `setCaps`, `setHedgerDeltaCap`, `setOpenBookCap`, `setProtocolFee`, `setSessionCalendar`, `setTreasury`, `setTreasuryDailyCap`, `setHedge` | admin | Timelock |
| MainspringPool | `setEngine`, `setWriterBook`, `setMatchBook`, `setAuction`, `setCoverAssets` | admin, once each | wired at deploy; cannot change |
| MainspringPool | `pauseDeposits` | pauser | Guardian |
| MainspringPool | `pauseMarket` | risk pauser | Guardian, E1 |
| MainspringPool | `resumeOpens`, `unpauseMarket`, `unpauseDeposits` | unpauser | Safe |
| MainspringPool | `sendToTreasury` (daily cap, free settlement token only) | treasurer | Safe |
| MainspringPool | `receiveFromTreasury` | treasurer or treasury | Safe, the treasury address |
| MainspringPool | `hedgeSwap` (router mark less slippage, inventory and daily caps, free settlement token only) | hedger | Gate only, from the deploy; never a key |
| HedgeKeeperGate | `hedgeSwap` (forwarded unchanged to the pool) | listed hedger | Keeper, while the gate is not frozen |
| HedgeKeeperGate | `freeze` | freezer | Guardian |
| HedgeKeeperGate | `unfreeze` | unfreezer | Safe |
| HedgeKeeperGate | `setHedger` (the key behind the gate) | admin | Timelock |
| MainspringPool | `onBuy`, `onSell`, `onMatchedOpen` / `onWrite`, `onUnwrite` / `onCoverStuck` | contract | Engine / WriterBook / the two books |
| MakerVault | `lock`, `unlock`, `pay`, `slash` | operator | MatchBook, RiskAuction |
| MakerVault, MatchBook, VolFeed, OpenBook | `setMatchBook`, `setAuction`, `setRouter`, `setPool`, `setRecorder`, `setVolFeed` | admin, once each | wired at deploy; cannot change |
| MatchBook | `matchMaker`, `fillOffer` / `buyback` | contract | OpenBook / the pool |
| PathFundingBook | `record` | recorder | nobody: the deploys set no recorder, so samples come only through the permissionless `poke`, which reads the router |
| ReceiptRoots | `post` | poster | Poster |
| ReceiptRoots | role admin | admin | Timelock |
| UniswapV4HedgeRouter | `listPool` | admin | Timelock |
| RiskAuction | `start`, `settle` | anyone | permissionless |
| AgentRouter | every function | owner or its mandated agent | no admin at all |

Nothing above sets a price or a vol on its own (law 6): prices and vols come only from the quorum through the router,
and a route change waits the timelock and the router's own delay.
