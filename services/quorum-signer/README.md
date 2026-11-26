# quorum-signer

Reads marks and vols and votes them on the `QuorumBoard`. Several independent signers run this; the board takes
the median of m-of-n votes, with a step clamp and a heartbeat.

Runs on the Robinhood Chain testnet (46630) and a local anvil (31337) only.

## Values

Each signer reads **two sources per market** and votes only when they agree (Backend §4: "dual-source inside the
quorum … disagreement → refuse"). A refusal is not a vote: if enough signers refuse, the board goes stale and opens on
that market close; sells keep the last good sample. Providers are listed in the signer's feeds file (`--feeds`).

- **MARK, tokenized stocks:** the vote is the on-chain token price on Robinhood Chain, read from an on-chain price
  adapter (`mark(assetId)` → price in WAD and its time). During the regular US session (09:30–16:00 New York, US
  market holidays and early closes; `common/src/session.ts`) it must be within **1%** of the off-chain equity
  reference (a provider-neutral JSON feed), or the signer does not vote. Outside the session the reference is closed,
  so the token price is voted alone and the board's anchor band caps it.
- **MARK, crypto:** the **median of at least two exchanges** (Coinbase, Kraken, OKX public tickers), within **1%** of
  Pyth (Hermes). No Pyth, or Pyth too old: no vote. No weekend rule.
- A voted price must be at most 10 s old; a cross-check reference at most 60 s. Every feed times out after 3 s.
  Three refusals in a row for one market log an alarm.
- **EQUITY** (optional): the P&L of the pool's account at the crypto hedge exchange, i.e. account value −
  deposits credited + withdrawals sent home (net of fee), plus a fixed offset of 10^12 settlement-token units (P&L can be negative).
  Read with a read-only exchange key (the account value and the transfer history). Voted hourly; a failed read gives
  no vote. The pool adds the money in transit from its own counters. The exchange is Binance USDⓈ-M futures
  (`--exchange binance`, its futures testnet; the key and secret at hidden prompts); `sim` is the local simulated
  exchange for tests.
- **VOL:** realised vol on 5-minute log price changes of this signer's own accepted marks, exponentially weighted with
  a 1-day half-life (λ = 2^(−1/288)), annualised by √(365·288), clipped to 5–500% and voted in whole bps.
  - No VOL vote until one day of 5-minute steps is in (from start, and after a restart).
  - A single 5-minute price change is capped at 25%. A gap of k steps counts as k steps. A gap over 1 h starts again,
    except for a tokenized stock when the gap holds no regular-session minute (a night, a weekend, a holiday): that
    counts as one step, so Monday keeps voting.
  - State is in memory only.

## The feeds file

```json
{ "markets": {
    "STK1": { "kind": "stock",
              "onchain":   { "adapter": "0x…", "assetId": "0x…(32 bytes)" },
              "reference": { "url": "https://…", "price": "results.0.price", "time": "results.0.t", "timeUnit": "s" } },
    "BTC":  { "kind": "crypto",
              "exchanges": [{ "exchange": "coinbase", "symbol": "BTC-USD" }, { "exchange": "kraken", "symbol": "XBTUSD" }],
              "pyth": { "id": "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43" } } } }
```

Every market on the board needs an entry, and a market not on the board is refused. Crypto needs two different
exchanges. URLs are https only (plain http to this machine on a local anvil only). Each operator picks its own
providers, so the signers do not share one point of failure.

## Requirements

[Bun](https://bun.sh) 1.4. This package is part of the Bun workspace in `services/` (shared code in `services/common/`): install with `cd services && bun install --frozen-lockfile`.

## Keys

The signer key lives in a Foundry keystore (`cast wallet import <name> --interactive`). At start the service asks
for the keystore password at a hidden prompt and decrypts the key in memory. Nothing is written to disk, and
neither the key nor the password is ever logged.

## Run

```
bun src/main.ts --deployment ../../contracts/deployments/46630.json --keystore <name> --feeds feeds.json --rpc <url>
```

| Flag | Meaning |
|---|---|
| `--deployment <file>` | Written by `contracts/script/DeployM1.s.sol`: board address, markets, chain id |
| `--rpc <url>` | RPC endpoint: required on the testnet (no built-in default); anvil's local endpoint otherwise |
| `--keystore <name>` | Foundry keystore account (`--keystore-dir` to override `~/.foundry/keystores`) |
| `--dry-run` | Decide and log `would vote`; send nothing |
| `--watch <address>` | With `--dry-run`: decide as that signer, without a key |
| `--local-unlocked <address>` | Anvil only: use the node's unlocked account |
| `--feeds <file.json>` | The market feeds (above); required unless test marks are given |
| `--test-marks STK1=400,BTC=100000` / `--test-vol 0.5` | Anvil only: fixed values instead of the feeds |
| `--once` | One pass, then exit |
| `--equity-pool <pool>` `--exchange binance` | Also vote the pool's EQUITY key, read from that exchange with a read-only key (both flags together) |
| `--exchange-url <url>` | With `--exchange sim` (anvil only): the local simulated exchange |

At start it refuses to run when the RPC's chain differs from the deployment file, the address isn't a signer on
the board, or a market's feeds aren't listed.

Every 20 s, for each MARK and VOL key it:
- **joins** an open round it hasn't voted in;
- **starts** a round when the last final is at least 20 s old (VOL: 5 min);
- otherwise skips.

A missing or stale reading is skipped, never voted. Once a round has at least m votes, including this signer's,
the signer calls the board's permissionless `finalize` after the window, so 2 of 3 keeps finalising when one
signer is down. Every transaction is simulated first (by its gas estimate), and sent with a gas limit of
max(2× estimate, 250k), since a vote that turns out to finalise needs more gas. Unused gas isn't charged.
A revert that only means another signer moved first (`NotReady`, `WrongRound`, `AlreadyVoted`) is skipped
quietly.

Gas: the max fee is capped at 1 gwei; above that, votes pause with an alarm. The balance is checked every pass,
with a warning below 0.2 of the gas token (to be set after fees are measured on Robinhood Chain).

Logs are JSON lines on stdout.

## Monitor and local soak

```
bun src/monitor.ts --deployment <file> [--rpc <url>] [--minutes N] [--out report.json]   # read-only, no key
bun scripts/local-soak.ts [--scale 0.1]   # anvil, 3 signers on live data, outages on a schedule (40 min at scale 1)
```

The monitor reads the board's events and polls the router's `markWad`. Per key it reports finals and the time
between them; per market, the router's fresh share and the oldest mark; per signer, votes, finalize calls, failed
transactions and gas.

## Test

```
bun test                 # offline: unit tests, plus an end-to-end run on a local anvil when anvil and forge are installed
bun run typecheck
```
