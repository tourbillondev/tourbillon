# quorum-signer

Reads marks and vols and votes them on the `QuorumBoard`. Several independent signers run this; the board takes
the median of m-of-n votes, with a step clamp and a heartbeat.

Runs on Elysium testnet (99801) and a local anvil (31337) only.

## Values

- **MARK:** Hyperliquid's `markPx` (the HyperCore mark), from the mainnet public info API. It is read-only:
  one `POST /info {"type":"metaAndAssetCtxs"}` per pass covers every market, and the code can't call any other
  path. Prices are converted to WAD exactly. A missing or delisted market, a malformed price, or a mark more
  than 5% from `oraclePx` gives no reading. Requests time out after 3 s; after 3 failed passes in a row it logs
  an alarm. The age of a reading is measured on the local clock.
- **EQUITY** (optional): the pool's Hyperliquid P&L only, i.e. account value − deposits credited + withdrawals
  sent home (net of fee), plus a fixed offset of 10^12 USDC (P&L can be negative). Read from `clearinghouseState`
  and `userNonFundingLedgerUpdates` for the pool's Hyperliquid address. Voted hourly; a failed read gives no vote.
  The pool adds the USDC in transit from its own counters.
- **VOL:** realised vol on 5-minute log returns, exponentially weighted with a 1-day half-life
  (λ = 2^(−1/288)), annualised by √(365·288), clipped to 5–500% and voted in whole bps.
  - At start it fetches 7 days of 5-minute candles (`candleSnapshot`, `/info` only); at least 1 day is required
    before any VOL vote. After that, the first mark of each 5-minute boundary is added.
  - A single 5-minute return is capped at 25%. A gap of k steps counts as k steps; a gap over 1 h starts again
    from candles. A failed start is retried at most once a minute.
  - State is in memory only: every start begins from candles.

## Requirements

[Bun](https://bun.sh) 1.4. This package is part of the Bun workspace in `services/` (shared code in `services/common/`): install with `cd services && bun install --frozen-lockfile`.

## Keys

The signer key lives in a Foundry keystore (`cast wallet import <name> --interactive`). At start the service asks
for the keystore password at a hidden prompt and decrypts the key in memory. Nothing is written to disk, and
neither the key nor the password is ever logged.

## Run

```
bun src/main.ts --deployment ../../contracts/deployments/99801.json --keystore <name>
```

| Flag | Meaning |
|---|---|
| `--deployment <file>` | Written by `contracts/script/DeployM1.s.sol`: board address, markets, chain id |
| `--rpc <url>` | RPC endpoint (default: the chain's public RPC) |
| `--keystore <name>` | Foundry keystore account (`--keystore-dir` to override `~/.foundry/keystores`) |
| `--dry-run` | Decide and log `would vote`; send nothing |
| `--watch <address>` | With `--dry-run`: decide as that signer, without a key |
| `--local-unlocked <address>` | Anvil only: use the node's unlocked account |
| `--test-marks BTC=100000,...` / `--test-vol 0.5` | Anvil only: fixed values instead of a live source |
| `--once` | One pass, then exit |
| `--equity-pool <pool>` `--equity-hl-user <address>` | Also vote the pool's EQUITY key (both flags together) |
| `--hl-api <url>` | Anvil only: a local fake of Hyperliquid's info API |

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
with a warning below 0.2 HYPE.

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
HL_LIVE=1 bun test       # adds live Hyperliquid reads (marks, vol) and an anvil dry run on live data
bun run typecheck
```
