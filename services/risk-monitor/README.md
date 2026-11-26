# risk-monitor

Watches the venue, the Mainspring pool's risk state and the services' liveness, and writes **alarm lines** in a stable
shape. Its only on-chain action: pausing opens on one market with the pause-only `RISK_PAUSER` key, after 15 minutes
of continuous venue outage there, or at once on a split. It can never unpause (only the Safe can). Alarm names are the
playbook's: lower-dash, posted with the market joined (`mark-stale-STK1`).

## Every pass (60 s)
- **Venue outage, per market** (Backend §6): a crypto market is down while the crypto hedge exchange fails, lists no
  mark for it, or its mark differs from the router's by more than 1%; any market is down while its hedger's status
  file says hedging is failing there (for a stock market: hedger-onchain, which also reports a missing router). After
  15 minutes continuous: `pauseMarket` (once), then `venue-recovered` when healthy again.
- **Hourly equity check:** the board's EQUITY against an independent recompute from the exchange account (read-only
  key); alarm above max(1% of the account value, $1,000). `equity-not-ready` while capital is at the exchange.
- **Stock markets** (`src/rh.ts`): `split-mismatch` (a stock MARK round whose quorum median is a split ratio away from
  the published value: opens on that market pause at once), `session-anchored` (information: outside the session the
  mark was held in its band), `transfer-stuck` (a covering token could not move; the pool paused that market),
  `quarter-cap-high` (a closed-day quarter cap nearly used), `inventory-mismatch` (the pool's stock holding off
  hedger-onchain's target by more than twice the band), `dex-down` / `cex-down` (a venue down 5 minutes, before the
  15-minute pause); `hedger-silent` per hedger.
- **Alarms only:** every treasury send and return; coverage headroom under 10% or breached; cap use over 90%; the
  drawdown pause; stale mark or vol (signers); no sample for 15 min (poker); no settlement for 2 h (keeper); hedger
  status older than 5 min.

## Alarm lines
JSON on stdout, one per event, in one shape:
```
{ "t", "level": "alarm" | "warn", "msg": "alarm", "name", "state": "raised" | "cleared" | "event",
  "what", "who", "market", "values" }
```
`name` is a fixed identifier (see `src/alarm.ts`); a condition is announced once when raised and once when cleared.
The shape is made for a staff alert bot (Telegram) to post later.

## Run
```
bun src/main.ts --deployment ../../contracts/deployments/<chainId>-m3.json --keystore <risk pauser> \
  [--exchange <name> [--exchange-url <url>]] [--hedger-status <cex status file>,<onchain status file>]
```
`--watch <address>` raises the same alarms without pausing. `--local-unlocked` and `--exchange sim` are anvil only;
any other exchange is refused until the owner picks it (Q5).
`--outage-minutes`, `--tick-seconds` and `--equity-every-seconds` change the defaults (15, 60, 3600).

## Test
`bun test`: units, plus an anvil run (DeployM1 + DeployM3, the simulated crypto hedge exchange) when anvil and forge
are installed.
