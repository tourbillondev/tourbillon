# Changelog

Every notable change, newest first. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Sections:
Mainnet, Contracts, Security, Added, Changed, Fixed. Review finding ids are named where a change fixes one.

## [Unreleased]

### Mainnet
- Nothing is deployed on any mainnet. Robinhood Chain mainnet waits for the review, the compliance review and the
  owners' approval.

### Contracts
- Settlement is USDG on Robinhood Chain, set at deployment (a USDC configuration stays possible). `SettlementAdapter`
  reads the token's symbol and decimals; the token must have 6 decimals and the deploy refuses any other. Contract and
  API names say "settlement" instead of a token name (for example `settlementLocked`, `AgentRouter.settlement()`).
- Stock markets are hedged on-chain: the pool holds the tokenized stock and swaps through a governance-listed router
  (Uniswap v4 on Robinhood Chain: one listed pool per pair, no hooks) at the router mark, within slippage, inventory
  and daily caps, spending only money that no sell or withdrawal needs. NAV counts the pool's tokenized stock at the
  router mark.
- Covering assets: a tokenized stock can cover Rises on its own market only, listed once per market in a covering-asset
  table set through governance. A covering token that cannot move during a buyback, an unwrite or a claim no longer
  stops anything: it is kept owed and settled later by anyone, the seller is paid in the settlement token, and new
  positions on that market pause. Covering deposits must arrive exactly. WHYPE and the HYPE market are gone; STK1
  stands in for the launch stocks.
- Tokenized-stock marks follow the regular US session: outside it, every published mark stays within ±10% of the last
  mark published during the session, and on weekends and holidays new positions on stock markets get a quarter of the
  normal caps. Selling is never capped. Crypto markets have no session rule. One calendar file feeds the signers and the
  on-chain calendar.
- `NativeMarkSource` reads one small adapter in front of Robinhood Chain's first-party mark once that is published,
  with a capped call and strict reply checks.
- The testnet is the Robinhood Chain testnet (chain 46630). Deploy scripts refuse every other chain, Robinhood Chain
  mainnet included, and the governance delay can be 1 hour only on anvil and the testnet (48 hours anywhere else). The
  chain probe is `RobinhoodProbe` and also reports the block gas limit.

### Security
- `SECURITY.md`: private reporting on the public repository, the scope, the roles, the accepted risks with their
  reasons and limits, open issues and the audit history.
- The public docs set: [architecture and roles matrix](docs/architecture.md), [invariants and their tests](docs/invariants.md),
  [threat model](docs/threat-model.md) and [runbook](docs/runbook.md).
- Every stateful invariant suite also runs at 100,000 calls (the `deep` profile, weekly in CI).
- CI: contracts build and tests, services typecheck and tests, the words gate, a secret scan, and static analysis
  (Slither on the contracts, CodeQL on the services), with every action pinned to a commit.
- The exact Bun version is pinned, package install scripts are off, and package versions younger than three days are
  never installed.

### Added
- The website in the repo, its design unchanged, with licensed fonts (Inter and Instrument Serif): a labelled demo mode
  and a live mode on the API and contracts (buy, sell and write, each reviewed at its exact amount before the wallet
  signs; a live build never shows sample data).
- The launch kit in Tourbillon's own design: the announcement, four how-it-works slides, a one-page fact sheet (image
  and A4 PDF), the roadmap and day sheets, every update poster on one sheet and in two zips, with a fingerprint list.
  Every text is checked against the words list and every claim against the code before the kit is built.
- The tech-update queue rebuilt on the Robinhood Chain core, with its texts and posters drawn ahead in Tourbillon's own
  design; the release system checks every poster's text and commands before anything is posted.
- One words list for every published text, checked in CI on everything that is published, with each allowed use named
  and explained (an allowed use can be limited to one file).
- Crypto hedging through Binance USDⓈ-M futures: the futures testnet only for now, trade-only and read-only keys typed
  at hidden prompts, no withdrawal call. EQUITY is read from that account.
- New alerts: stock splits (which pause new positions on that market), stuck tokenized-stock transfers, closed-day caps,
  the on-chain hedge holding, and venue trouble per market.
- The indexer keeps a marks audit trail and the pool's on-chain hedge swaps; the markets API says whether a market is a
  stock or crypto, and the status names the settlement token.
- The API answers `/healthz`, for the release system's live checks.
- A team bot for the launch: the hourly tech-update posts, every release status, the pinned board, the board poster,
  a daily "Shipped today" at 23:55 UTC, staff commands, and release emergencies that repeat until acknowledged.

### Changed
- The README is written for anyone checking the code: the six laws, exact commands, the documents and CI status.
- Every text, API field and alert shows the settlement token's symbol from the deployment.
- The release system follows the standard path: each update is built, tested, deployed to testnet then mainnet, checked
  live and published, then the team bot posts it; heartbeats both ways and an outside check. The alert bot now posts
  risk and ops alarms only.
- Alerts use lower-dash names with the market joined (for example `mark-stale-STK1`).
- Marks come from two sources inside every signer, and a signer does not vote when they disagree: for tokenized stocks
  the on-chain token price, within 1% of an equity reference during the regular US session (alone outside it, capped by
  the board's anchor band); for BTC and ETH the median of at least two exchanges, within 1% of Pyth. The Hyperliquid
  mark source and hedger are gone.
- Vol is the signer's own realised vol from its accepted marks, after one day of warm-up; for tokenized stocks a closed
  night, weekend or holiday counts as a single step.
- Services take their RPC from their own settings only: there is no built-in default endpoint.
- The reference maker bot's flag that tops up its vault is now `--deposit`.

### Fixed
- Publishing mirrors the public tree exactly: files no longer in the project are deleted from the public repo, and a
  published file is never skipped because a .gitignore rule matches it.
- Local-chain and database test setup and teardown fail fast, naming the test file, instead of hanging the suite.
- Old chain and venue names left in test comments and names now describe Robinhood Chain and the exchange.
- A hedge buy could have spent money set aside for queued deposits and owed withdrawals when the pool had no
  liability; it now spends only money above everything set aside and the stressed liability (found by the pool
  invariant before any deploy).

## Tech updates

The hourly updates after launch, each with its release time.
