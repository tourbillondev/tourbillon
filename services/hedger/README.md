# hedger

Works out the Mainspring pool's net delta per market and the Hyperliquid perp orders that bring its hedge to target.
**Dry run by default.** With `--venue sim` it trades on a local simulated venue. `--venue hl-testnet` is for M3
step 12 only, with the owner's explicit yes. **Mainnet orders are refused in code. Real funds never.**

## What it does, every 30 s
1. Reads the pool's open series per market from the chain (`pool.openSeries`, `pool.seriesRaw`, `book.seriesOf`).
   Units use a walked norm: `accrue` simulated with a read-only call.
2. Prices with a TypeScript port of TempoMath (`src/tempo.ts`, analytic delta; cross-checked against the Engine's
   on-chain values). S = Hyperliquid's markPx; σ = the board's `volBps`. A market is skipped that pass if the router
   or board is stale, or if Hyperliquid's mark and the router's differ by more than 1%.
3. Target perp position = Σ units × delta (the pool is short what holders own).
4. Plans orders (`src/policy.ts`):
   - nothing inside the band (10% of the delta cap);
   - IOC limits at mid ± 0.5%, Hyperliquid size and price rounding, at least $10;
   - reduce-only when shrinking; a split when crossing zero.

   The hard position limit equals the delta cap. A target beyond it is clipped and an **alarm** logs the unhedged
   remainder (coins and USD).

Delta caps (USD, default = directional cap ÷ (2 × shock)): BTC 2,500,000; ETH 1,200,000; HYPE 357,000
(`--delta-cap` to change).

## Venues and signing
- `src/venue.ts`: the interface. `src/hlvenue.ts`: the Hyperliquid adapter (public info reads; signed `/exchange`
  orders only to Hyperliquid testnet or a local URL). `src/simvenue.ts`: the simulated venue (a local HTTP server
  speaking the same API; it checks agent signatures and nonces; fills, partial fills, outages and price moves are
  scripted).
- `src/hlsign.ts`: Hyperliquid L1 signing (msgpack → phantom-agent hash → EIP-712 Agent), checked against
  Hyperliquid's published Python SDK test vectors. **It signs only `order` and `cancel` actions**; any other action type
  (withdrawals, transfers, approveAgent, anything else) and any order or cancel with extra fields is refused before
  anything is hashed or signed.
- After each order the hedger re-reads positions and logs a `hedge` line shaped like the spec's `hedges` table. After
  3 failed passes in a row it logs an alarm (the risk-monitor pauses opens after 15 minutes).
- The agent (API wallet) key: a fresh throwaway key per run on the simulated venue (it never leaves the process); a
  Foundry keystore with a hidden prompt (`--agent-keystore`) for testnet.

## Run
```
bun src/main.ts --deployment ../../contracts/deployments/<chainId>-m3.json --hl-user <pool's Hyperliquid address>
bun src/main.ts --deployment <file> --positions BTC=0,ETH=0,HYPE=0 --once   # fixed positions, one pass
bun src/main.ts --deployment <file> --hl-user <address> --venue sim --venue-url http://127.0.0.1:<port>   # local sim
```
`--hl-api <url>` (anvil only) points at a local fake of Hyperliquid's info API. Logs are JSON lines.

## Test
`bun test`: maths and policy offline, plus an anvil run (DeployM1 + DeployM3, varied trades) when anvil and forge are
installed.
