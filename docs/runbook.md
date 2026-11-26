# Runbook

How to run Tourbillon day to day and what to do when something goes wrong. Roles are in
[architecture.md](architecture.md); limits in [backend/honest-limits.md](backend/honest-limits.md). Testnet first:
nothing touches mainnet without the owners' explicit yes.

## Services and their keys

| Service | Key | Started with |
|---|---|---|
| `quorum-signer` (each operator) | its signer key (Foundry keystore, hidden password prompt); for EQUITY a Binance read-only key (hidden prompts) | `--deployment`, `--feeds`, `--rpc`, `--keystore` |
| `poker` (primary and backup) | a gas-only key | `--role primary` / `--role backup` |
| `hedger-onchain` | the keeper key (keystore): the hedger listed on `HedgeKeeperGate`, which holds the pool's keeper role | `bun src/onchain.ts --keystore …` |
| `hedger-cex` | a Binance trade-only key (hidden prompts) | `bun src/cex.ts --exchange binance` |
| `risk-monitor` | E1, the pool's risk pauser (keystore) | `--hedger-status <cex status>,<onchain status>`, `--exchange binance` |
| `receipts` | the poster key (keystore) | `--deployment`, `--rpc` |
| `maker-gateway`, `indexer`, `api`, `mcp` | none | read-only |
| `alert-bot` | the alert bot's token (kept in the server's secrets file, never in the repo) | alarms to the alert group only, send-only |
| `teambot` | the same bot token (same secrets file) | the launch posts in the staff group; release emergencies in the alert group; reads staff commands |
| `release` | the release token, the deploy key, the outside-check address (mode 600 files) | pushes only to the public repo; never posts |

Every key is typed at a hidden prompt on the server and kept in memory only; no key is ever written to a file in the
repo, a command line or a message. Binance keys: withdrawals disabled, IP allowlist to the server, read-only for the
signers and the risk monitor, trade-only for hedger-cex. A restart asks again.

## Every day
- The alert group is quiet, or every open alarm has someone on it.
- `/v1/status`: opens running, `pool.covered` true, every market's mark and vol fresh.
- Receipt roots posted every hour (`receipts-stale` otherwise).
- Service keys above their gas floor (`key-balance-low-<name>` otherwise).

## Alarms and what to do

Sells and withdrawals are never paused by any of these.

| Alarm | What to do |
|---|---|
| `mark-stale-<M>` | Check the signers' logs (refusals, gas, RPC). Opens on that market reopen by themselves when a quorum votes again |
| `sample-stale-<M>` | Restart the primary poker; the backup takes over meanwhile |
| `settlement-stale` | Check the keeper (poker); anyone may start an epoch, mark chunks and settle |
| `equity-not-ready` / `equity-mismatch` | Check the signers' EQUITY votes and the Binance account; NAV leaves the exchange capital out until EQUITY is fresh again |
| `coverage-low` / `coverage-breached` | Add capital, or bring capital back from the exchange (`receiveFromTreasury`); opens are refused on-chain while breached |
| `cap-high-<M>` / `quarter-cap-high-<M>` | Decide whether to raise the cap (a timelocked `setCaps`); a quarter cap lifts by itself when the US session reopens |
| `drawdown-paused` | Review the book; the Safe calls `resumeOpens` when satisfied |
| `dex-down-<M>` / `cex-down-<M>` | Check the hedger's status file and the venue; after 15 minutes E1 pauses opens on that market (`venue-down-paused-<M>`) |
| `venue-down-paused-<M>` / `venue-recovered-<M>` | When the venue is healthy, the Safe calls `unpauseMarket` |
| `pause-failed-<M>` | The guardian pauses that market now (`pauseMarket`), then check E1's gas and key |
| `hedger-silent-<venue>` | Restart that hedger; check its RPC and, for cex, the Binance keys |
| `inventory-mismatch-<M>` | The on-chain hedge cannot reach its target: check the listed router, the inventory and daily caps, free money |
| `transfer-stuck-<M>` | A tokenized stock could not move: check the issuer (pause, freeze, whitelist). Once it moves, anyone calls `settleCover(token, to)` on the book that holds it; then the Safe unpauses the market |
| `split-mismatch-<M>` | Opens on that market are paused. Confirm the corporate action, then fix the listing (the board's anchor and the calendar through the timelock) before the Safe unpauses |
| `session-anchored-<M>` | Information only: outside the session the mark was held in its band |
| `treasury-sent` / `treasury-returned` | Confirm the move was planned |
| `buyback-failed` / `matched-uncovered` / `buyback-shortfall` | Review the source; the pool carries the raw and it counts in its stress |
| `auction-settle-due` | Anyone calls `settle(lotId)` on the risk auction |
| `timelock-queued` | Everyone reviews the queued call; the Safe can cancel it before it runs |
| `role-changed` | Confirm it was a queued and announced timelock action; if not, tell the owner and the dev at once |
| `paused` / `unpaused` | Confirm who paused and why |
| `receipts-stale` | Restart the receipts service; check the poster key's gas |
| `key-balance-low-<name>` | Top up that key |
| `monitor-error` | Restart the risk monitor; check its RPC |

## Procedures

### A timelocked admin action
1. Encode the call; the Safe (3 of 5) schedules it on the timelock with the delay (48 h on mainnet, 1 h on testnet).
2. The risk monitor posts `timelock-queued` with the contract, the call and the time it can run.
3. After the delay anyone executes it. Re-run the read-only deploy check (`check-deploy`, built at the testnet
   milestone) after every admin change.

### Listing a tokenized stock market
1. The issuer whitelists the pool, the writer book, the match book and the maker vault (G8).
2. Through the timelock: `CoveringAssets.list(market, token, holders)` (once, checks every holder pair),
   `SessionCalendar.setStockMarket`, the board's feeds and session key, the router's route, the pool's `listMarket`,
   caps and hedger delta cap, `setHedge` limits, and `UniswapV4HedgeRouter.listPool` for the stock's pool (no hooks).
3. The signers add the market to their feeds files; the hedgers and the risk monitor pick it up at restart.

### Signers
Adding or removing a signer is a timelocked `setSigner`; the quorum stays a majority of active signers.

### The treasury route to the crypto exchange
`sendToTreasury` (the Safe; only free money, at most the daily cap of NAV) to the configured treasury address, which
moves it to the Binance futures account; `receiveFromTreasury` brings it back. EQUITY must be fresh before a send.

### Binance keys
Create a read-only key (signers, risk monitor) and a trade-only key (hedger-cex) with withdrawals disabled and the
server's IP allowlisted. To rotate: create the new key, restart the service and type it at the prompt, then delete the
old key on Binance.

### Freeze hedging
1. The guardian (2 of 3) calls `freeze()` on `HedgeKeeperGate`: every hedge swap is refused from that block. The risk
   monitor posts `paused` (on-chain stock hedging, by the guardian); hedger-onchain logs "hedging frozen" and reports the
   stock markets failing, so after 15 minutes E1 pauses stock opens (`venue-down-paused-<M>`). Sells and withdrawals go
   on.
2. Fix the cause (a stolen key: see below; a broken router: queue `setHedge(0x0, …)` or a new router).
3. The Safe (3 of 5) calls `unfreeze()`, then unpauses the stock markets.

### A stolen or misbehaving key
- **Keeper:** freeze hedging at once (above), then queue `setHedger(<new key>)` on the gate through the timelock and
  unfreeze once it has run. The stolen key holds no role of its own.
- **E1:** the Safe unpauses what it paused; queue a revoke of `RISK_PAUSER_ROLE` and grant a new key.
- **Poster:** queue a revoke of `POSTER_ROLE`; anyone can rebuild the roots to see what was wrong.
- **A signer:** queue `setSigner(signer, false)`; the median ignores one outlier meanwhile.

## Deploys
- **Testnet** (Robinhood Chain 46630): `DeployM7` with `SETTLEMENT_TOKEN` (or `MOCK_SETTLEMENT=1` for a rehearsal) and,
  when the venue exists, `UNISWAP_V4_POOL_MANAGER`; the deploy refuses mainnet and the old chain.
- **Mainnet** (4663), only on the owners' explicit yes: a keyless dry run first, the deployer key typed at a hidden
  prompt and used once, the hand-off to the Safe, guardian and timelock, then the read-only `check-deploy` against the
  live chain.
