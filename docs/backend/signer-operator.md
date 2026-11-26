# Running a Tourbillon signer

Tourbillon's marks and vols come from a quorum of independent signers until Robinhood Chain publishes a first-party
mark. Each signer reads two sources per market and votes on the `QuorumBoard` contract on Robinhood Chain only when they
agree; the board publishes the median of the votes, clamps each step and refuses values older than a heartbeat. No
single signer can set a price or a vol: the board needs a quorum (2 of 3 at launch) and the median ignores one outlier.

This guide is for an operator who runs one signer. Tourbillon needs three operators on separate infrastructure.

## What your signer does
- **MARK, tokenized stocks** (a new round at least every 20 s): the token's on-chain price on Robinhood Chain, read from
  an on-chain price adapter. During the regular US session (09:30–16:00 New York, US holidays and early closes) it must
  be within **1%** of the off-chain equity reference you configure, or you do not vote. Stock Tokens trade around the
  clock; outside the session the reference is closed, so the token price is voted alone and the board holds it within
  ±10% of the last session value.
- **MARK, crypto:** the median of at least two exchanges (Coinbase, Kraken, OKX public tickers), within **1%** of Pyth.
  No Pyth, or Pyth too old: no vote.
- A voted price is at most 10 s old, a cross-check reference at most 60 s; every feed times out after 3 s. A refusal is
  not a vote: if enough signers refuse, the mark goes stale and opens on that market close.
- **VOL** (every 5 minutes): realised volatility on 5-minute log price changes of your own accepted marks, with a 1-day
  half-life, clipped to 5–500%. No VOL vote until one day of steps is in (after every start).
- **EQUITY** (optional, hourly): the P&L of the pool's account at the crypto hedge exchange (Binance USDⓈ-M futures),
  read with a **read-only** API key.
- It joins an open round it hasn't voted in, starts one when the last final value is old enough, and calls the board's
  permissionless `finalize` once a quorum is in, so two signers keep the feed alive when one is down.

## Independence (what makes the quorum worth having)
- Your own machine or cloud account, not shared with another operator.
- Your own Robinhood Chain RPC endpoint from a provider no other operator uses. Public RPCs are rate-limited and are not
  for production.
- Your own equity reference provider and exchange list in your feeds file, so the signers do not share one point of
  failure. You pay for your own reference feed licence if it needs one.
- Your own key, created by you, never shared, never sent to anyone.
- Your own monitoring: you are the one who restarts your signer.

## Requirements
- [Bun](https://bun.sh) 1.4 and git.
- A Robinhood Chain address that the board lists as a signer (the Tourbillon Safe adds it through the 48 h timelock on
  mainnet; you send the team your address, never a key).
- Gas in ETH on Robinhood Chain. The signer warns when its balance runs low and pauses votes if the network fee rises
  above 1 gwei.

## Key
Create the key in a Foundry keystore on your machine:

    cast wallet import tourbillon-signer --interactive

At start the signer asks for the keystore password at a hidden prompt and decrypts the key in memory only. Nothing is
written to disk; the key and the password are never logged. For EQUITY votes it also asks for a Binance read-only API
key and secret at hidden prompts (withdrawals disabled, IP allowlist on Binance's side).

## Install

    git clone <the Tourbillon repository> && cd tourbillon/services
    bun install --frozen-lockfile

## Your feeds file

```json
{ "markets": {
    "STK1": { "kind": "stock",
              "onchain":   { "adapter": "0x…", "assetId": "0x…(32 bytes)" },
              "reference": { "url": "https://…", "price": "results.0.price", "time": "results.0.t", "timeUnit": "s" } },
    "BTC":  { "kind": "crypto",
              "exchanges": [{ "exchange": "coinbase", "symbol": "BTC-USD" }, { "exchange": "kraken", "symbol": "XBTUSD" }],
              "pyth": { "id": "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43" } } } }
```
Every market on the board needs an entry; a market not on the board is refused. Crypto needs two different exchanges.
URLs are https only.

## Run

    cd quorum-signer
    bun src/main.ts --deployment <deployment file> --keystore tourbillon-signer --feeds feeds.json --rpc <your RPC>

With EQUITY votes (if the team asks you to run them):

    bun src/main.ts --deployment <file> --keystore tourbillon-signer --feeds feeds.json --rpc <your RPC> \
      --equity-pool <pool address> --exchange binance

Before your first live run, check everything without sending:

    bun src/main.ts --deployment <file> --watch <your signer address> --feeds feeds.json --rpc <your RPC> --dry-run --once

At start the signer refuses to run if the RPC is on another chain than the deployment file, if your address is not a
signer on the board, or if a market's feeds are not listed. Run exactly one instance per key: two instances with one
key race each other.

| Flag | Meaning |
|---|---|
| `--deployment <file>` | The deployment file the team publishes (board address, markets, chain id, settlement token) |
| `--rpc <url>` | Your RPC endpoint (required: there is no built-in default) |
| `--keystore <name>` | Your Foundry keystore account (`--keystore-dir` to override `~/.foundry/keystores`) |
| `--feeds <file.json>` | Your feeds file (above) |
| `--dry-run` | Decide and log `would vote`; send nothing |
| `--watch <address>` | With `--dry-run`: decide as that signer, without a key |
| `--once` | One pass, then exit |
| `--equity-pool <pool>` `--exchange binance` | Also vote the pool's EQUITY value from the exchange account (both together) |

## Watching your signer
- Logs are JSON lines on stdout: `voted`, `skip` (with a reason), `finalize`, and `alarm` lines (for example after 3
  refusals in a row for a market, or when votes pause on gas).
- `bun src/monitor.ts --deployment <file> --rpc <your RPC> [--minutes N]` reads the board (no key) and reports rounds,
  votes and staleness for every market.
- The team's risk monitor raises `mark-stale-<market>` when the published mark or vol goes stale and
  `key-balance-low-<name>` when a signer key runs low on gas.

## Updating
Stop the signer, `git pull`, `bun install --frozen-lockfile`, start it again. State is in memory: after every start the
VOL pipeline needs one day of its own marks before its first VOL vote; MARK votes start at once.

## Testnet first
Every operator runs on the Robinhood Chain testnet (chain 46630) before mainnet. Nothing touches mainnet before the
team's go.
