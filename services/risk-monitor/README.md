# risk-monitor

Watches the venue, the Mainspring pool's risk state and the services' liveness, and writes **alarm lines** in a stable
shape. Its only on-chain action: after 15 minutes of continuous venue outage on a market it pauses opens there with
the pause-only `RISK_PAUSER` key. It can never unpause (only the admin can).

## Every pass (60 s)
- **Venue outage, per market:** down while Hyperliquid's info API fails, the market is missing or has no mark, its
  mark differs from the router's by more than 1%, or the hedger's status file says hedging is failing there. After
  15 minutes continuous: `pauseMarket` (once), then `VENUE_RECOVERED` when healthy again.
- **Hourly equity check:** the board's EQUITY against an independent recompute from Hyperliquid's API; alarm above
  max(1% of the account value, $1,000). `EQUITY_NOT_READY` while capital is outside Elysium.
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
  --hl-user <pool's Hyperliquid address> [--hedger-status <hedger's --status-file>]
```
`--watch <address>` raises the same alarms without pausing. `--local-unlocked` and `--hl-api` are anvil only.
`--outage-minutes`, `--tick-seconds` and `--equity-every-seconds` change the defaults (15, 60, 3600).

## Test
`bun test`: units, plus an anvil run (DeployM1 + DeployM3, a simulated Hyperliquid venue) when anvil and forge are
installed.
