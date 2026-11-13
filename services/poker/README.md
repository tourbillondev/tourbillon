# poker

Calls `poke(market)` on the PathFundingBook for every market once per 5-minute window. The book reads the mark from
the router and the vol from the board itself, so the poker only chooses *when* a sample is taken, never *what* is
recorded. It also walks series with open positions that fall behind, so buys stay within the book's 16-interval
limit.

Runs on Elysium testnet (99801) and a local anvil (31337) only.

## Requirements

[Bun](https://bun.sh) 1.4. Part of the Bun workspace in `services/` (shared code in `services/common/`): install with
`cd services && bun install --frozen-lockfile`.

## Run

```
bun src/main.ts --deployment ../../contracts/deployments/<chainId>-m2.json --keystore <name> [--role primary|backup]
```

| Flag | Meaning |
|---|---|
| `--deployment <file>` | Written by `contracts/script/DeployM2.s.sol`: book, engine, markets, deploy block |
| `--rpc <url>` | RPC endpoint (default: the chain's public RPC) |
| `--keystore <name>` | Foundry keystore account; the password is asked at a hidden prompt and the key stays in memory |
| `--role primary\|backup` | Primary pokes from 5 s into each window, backup from 35 s; both only if the window has no sample yet |
| `--dry-run` | Decide and log `would poke` / `would walk`; send nothing |
| `--watch <address>` | With `--dry-run`: no key |
| `--local-unlocked <address>` | Anvil only: use the node's unlocked account |
| `--once` | One pass, then exit |

Every 20 s it:
- **pokes** each market whose latest sample is older than the current window, after its role's offset. A stale or
  disputed mark or vol means no sample (law 2): it logs `cannot poke` and sends nothing. After 3 whole windows in a
  row without a sample (15 minutes) it logs an alarm.
- **walks** (the walker module, the future accrual-walker): it finds series from the book's `Opened` events, tracks
  open positions from the Engine's `Bought` / `Sold` events, and walks each series with open positions that is 8 or
  more intervals behind, 64 intervals per transaction. A series nobody holds is not walked.

- **keeps the pool's hourly cycle** (the keeper module, when the deployment file has a MainspringPool): if an epoch
  is marking, it marks 120 series per transaction until final; then it settles the round; once an hour has passed
  since the last epoch started (primary +60 s, backup +10 min) it starts the next one. Every step is simulated first;
  "another poker got there first" is skipped quietly; a stale mark means no epoch (law 2), logged with the reason.

Gas: the max fee is capped at 1 gwei (above it, transactions pause with an alarm); the balance is checked every
pass, with a warning below 0.2 HYPE. Logs are JSON lines on stdout.

## Test

```
bun test   # unit tests, plus an end-to-end run on a local anvil when anvil and forge are installed
```
