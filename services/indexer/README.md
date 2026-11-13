# indexer

Reads the chain's events into Postgres (Backend spec section 8; launch core). Read-only on the chain: no key.

| Table | From |
|---|---|
| `samples(market, level, t, s_wad, sigma_bps)` | the book's `Recorded` (level 0 = 5 min, 1 = hourly, 2 = daily) |
| `board_votes(key, round, signer, value, ts, dropped)` | the board's `Voted` / `VoteDropped` |
| `board_finals(key, round, median, published, votes, ts)` | the board's `Finalised` |
| `board_keys(key, market, kind)` | each market's MARK and VOL keys and the pool's EQUITY key |
| `positions(id, owner, held, market, legs_json, tempo_or_movement, raw, norm, last_accrual)` | the Engine's buys and sells (held `direct`) and the AgentRouter's `AgentBought` / `PositionSold` (held `agentRouter`) |
| `series(id, market, shape, legs_json, movement)` | each series' terms, read once from the book |

Every block range is written in one transaction with its cursor, so a restart never applies an event twice or skips
one. Units at any moment are `raw × norm`; the API reads the current norm from the chain.

    DATABASE_URL=postgres://… bun src/main.ts --deployment ../../contracts/deployments/31337-m7.json [--rpc URL] [--confirmations 0] [--once]

The database URL comes from the environment only (it may carry a password) and is never logged. Tests start a
throwaway local Postgres (`services/common/src/localPg.ts`) and an anvil with DeployM7.

Later updates add the remaining section 8 tables (`marks`, `quotes`, `writes`, `hedges`) and the open-book, auction
and receipts tables.
