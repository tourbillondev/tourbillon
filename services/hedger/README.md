# hedger

Two hedgers for the Mainspring pool (Backend §6, §7). A market is a **stock market** when the pool's covering-asset
table lists a token for it, and a **crypto market** otherwise.

- **hedger-onchain** (`src/onchain.ts`): stock markets. The pool holds the tokenized stock itself and swaps the
  settlement token for it, or back, through its own `hedgeSwap` and a router listed by governance (Uniswap v4 on
  Robinhood Chain). The keeper key may only call that function. It never holds tokens and never chooses a price: no
  fresh mark, no swap, and the pool refuses a `minOut` below the router mark less the listed slippage. A buy spends only money above
  queued deposits, money owed to withdrawals and the stressed liability.
- **hedger-cex** (`src/cex.ts`): BTC and ETH perpetuals at Binance USDⓈ-M futures (`--exchange binance`), through a
  trade-only key with withdrawals disabled, typed at a hidden prompt. Only Binance's futures testnet is allowed; mainnet
  is refused in code until the owners say yes. `--exchange sim` is the local simulated exchange for tests.

**Dry run by default** for both: without a key or exchange, or with `--dry-run`, they log plans and "would send" lines
only.

## What they do, every 30 s
1. Read the pool's open series per market from the chain (`pool.openSeries`, `pool.seriesRaw`, `book.seriesOf`). Units
   use a walked norm: `accrue` simulated with a read-only call.
2. Price with a TypeScript port of TempoMath (`src/tempo.ts`, analytic delta; cross-checked against the Engine's
   on-chain values). S = the router's mark; σ = the board's `volBps`. A market is skipped that pass if the router or
   board is stale; hedger-cex also skips a market whose exchange mark differs from the router's by more than 1%.
3. Target = Σ units × delta (the pool is short what holders own, long what it holds from writers).
4. Plan (`src/policy.ts`):
   - **onchain**: a holding, never a short. The target is clipped to [0, hard limit], where the hard limit is the
     smaller of the delta cap in shares and the pool's inventory cap. A negative target sells down to zero, and the
     rest is reported unhedged. Nothing trades inside the band (10% of the hard limit). A buy is clipped to the free
     money and to the day's swap room. `minOut` comes from the router mark less the hedger's slippage (default 0.5%, at
     most the pool's).
   - **cex**: nothing inside the band (10% of the delta cap); IOC limits at mid ± 0.5%, rounded to the market's own
     size and price decimals, at least $10; reduce-only when shrinking; a split when crossing zero.

   A target beyond the hard limit raises an **alarm** with the unhedged remainder.

Delta caps (USD, default = directional cap ÷ (2 × shock)): BTC 2,500,000; ETH 1,200,000; STK1 625,000 (placeholder,
Q13). Change them with `--delta-cap`.

## Status and alarms
After each pass each hedger writes a status file (`--status-file`, with its `venue`: `onchain` or `cex`). The
risk-monitor reads both files and pauses opens on a market after 15 minutes of failure there. For a stock market,
a missing router counts as a failure. After 3 failed passes in a row a hedger logs "hedging failing". Every trade
logs a `hedge` line shaped like the spec's `hedges` table, with `via`: `onchain_dex` or `cex_api`.

## Run
```
bun src/onchain.ts --deployment <file> --keystore <keeper>              # stock markets; hidden password prompt
bun src/onchain.ts --deployment <file> --dry-run --once                 # plans only
bun src/cex.ts --deployment <file> --positions BTC=0,ETH=0 --once       # crypto, fixed positions, plans only
bun src/cex.ts --deployment <file> --exchange sim --exchange-url http://127.0.0.1:<port>   # local simulated exchange
```
The simulated exchange (`src/simexchange.ts`) issues scoped keys: read keys cannot trade, and no key can withdraw.

## Test
`bun test`: maths, policy, config and the simulated exchange offline. When anvil and forge are installed, an anvil
run (DeployM1 + DeployM4, varied trades) drives both hedgers: hedger-cex against the simulated exchange, and
hedger-onchain through a mock router.
