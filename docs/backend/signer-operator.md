# Running a Tourbillon signer

Tourbillon's marks and vols come from a quorum of independent signers until the HyperCore read precompile ships. Each
signer reads Hyperliquid's public data and votes on the `QuorumBoard` contract on Elysium; the board publishes the
median of the votes, clamps each step and refuses values older than a heartbeat. No single signer can set a price or a
vol: the board needs a quorum (2 of 3 at launch) and the median ignores one outlier.

This guide is for an operator who runs one signer. Tourbillon needs three operators on separate infrastructure.

## What your signer does
- **MARK** (every market, a new round at least every 20 s): Hyperliquid's mark price from its public info API. A
  reading more than 5% from Hyperliquid's oracle price, missing, or malformed is never voted.
- **VOL** (every 5 minutes): realised volatility on 5-minute returns with a 1-day half-life, clipped to 5–500%.
- **EQUITY** (optional, hourly): the pool's Hyperliquid P&L, read from the pool's public Hyperliquid account.
- It joins an open round it hasn't voted in, starts one when the last final value is old enough, and calls the board's
  permissionless `finalize` once a quorum is in, so two signers keep the feed alive when one is down.

## Independence (what makes the quorum worth having)
- Your own machine or cloud account, not shared with another operator.
- Your own Elysium RPC endpoint if you can; at least not the same provider as another operator.
- Your own key, created by you, never shared, never sent to anyone.
- Your own monitoring: you are the one who restarts your signer.

## Requirements
- [Bun](https://bun.sh) 1.4 and git.
- An Elysium address that the board lists as a signer (the Tourbillon Safe adds it through the 48 h timelock on mainnet;
  you send the team your address, never a key).
- Gas: a few HYPE on Elysium. The signer warns below 0.2 HYPE and pauses votes if the network fee rises above 1 gwei.

## Key
Create the key in a Foundry keystore on your machine:

    cast wallet import tourbillon-signer --interactive

At start the signer asks for the keystore password at a hidden prompt and decrypts the key in memory only. Nothing is
written to disk; the key and the password are never logged.

## Install

    git clone <the Tourbillon repository> && cd tourbillon/services
    bun install --frozen-lockfile

## Run

    cd quorum-signer
    bun src/main.ts --deployment <deployment file> --keystore tourbillon-signer [--rpc <your RPC>]

With EQUITY votes (if the team asks you to run them):

    bun src/main.ts --deployment <file> --keystore tourbillon-signer --equity-pool <pool address> --equity-hl-user <pool's Hyperliquid address>

Before your first live run, check everything without sending:

    bun src/main.ts --deployment <file> --watch <your signer address> --dry-run --once

At start the signer refuses to run if the RPC is on another chain than the deployment file, if your address is not a
signer on the board, or if a market's feeds are not listed. Run exactly one instance per key: two instances with one
key race each other.

| Flag | Meaning |
|---|---|
| `--deployment <file>` | The deployment file the team publishes (board address, markets, chain id) |
| `--rpc <url>` | Your RPC endpoint (default: the chain's public RPC) |
| `--keystore <name>` | Your Foundry keystore account (`--keystore-dir` to override `~/.foundry/keystores`) |
| `--dry-run` | Decide and log `would vote`; send nothing |
| `--watch <address>` | With `--dry-run`: decide as that signer, without a key |
| `--once` | One pass, then exit |
| `--equity-pool <pool>` `--equity-hl-user <address>` | Also vote the pool's EQUITY value (both together) |

## Watching your signer
- Logs are JSON lines on stdout: `voted`, `skip` (with a reason), `finalize`, and `alarm` lines (for example after 3
  failed reads in a row, or when votes pause on gas).
- `bun src/monitor.ts --deployment <file> [--minutes N]` reads the board (no key) and reports rounds, votes and
  staleness for every market.
- The team's risk-monitor raises `MARK_STALE` when the published mark or vol goes stale and `KEY_BALANCE_LOW` when a
  signer key runs low on gas.

## Updating
Stop the signer, `git pull`, `bun install --frozen-lockfile`, start it again. State is in memory: at every start the
VOL pipeline rebuilds from 7 days of 5-minute candles (it needs at least 1 day before its first VOL vote).

## Testnet first
Every operator runs on the Elysium testnet before mainnet. Nothing touches mainnet before the team's go.
