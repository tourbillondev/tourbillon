# Tourbillon API v1

Read-only, open, no keys. Each IP may make 120 requests a minute (a `429` answer means wait a minute). Every answer is
JSON. The machine-readable description is `services/api/openapi.json`.

**Units.** USDC amounts are decimal strings with 6 decimals (`"1234.567891"`). Strikes, marks and units are decimal
strings. Times are Unix seconds. Markets at launch: `BTC`, `ETH`, `HYPE`.

**Prices.** `/v1/chains` values are indicative (the closed form at the board's vol, before the spread and fee).
`/v1/quote/buy` is the exact cost a buy would pay at the current block. A buy itself always sets a `maxCost`.

## GET /v1/status
Whether opens are running, the pool's state, and the freshness of each market's mark and vol.

```json
{
  "chainId": 99801, "block": "1234567", "blockTime": 1795000000,
  "opens": { "buysPaused": false, "drawdownPaused": false, "depositsPaused": false },
  "pool": { "nav": "5000000", "navPerShare": "1", "lastSettlement": 1794996400, "available": "4990000", "stressedLiability": "12000", "covered": true },
  "markets": [{ "market": "BTC", "markFresh": true, "volFresh": true, "opensPaused": false }],
  "receipts": { "lastEpoch": 498611 }
}
```
- `opens.buysPaused`: all opens paused (the guardian). `drawdownPaused`: opens paused after a 15% drawdown in 30 days.
  `depositsPaused`: new pool deposits paused. **Sells and withdrawals are never paused.**
- A market whose mark or vol is not fresh accepts no opens; sells use the last good sample.
- `pool.covered`: USDC on Elysium covers the stressed liability. NAV moves with the book and can fall.

## GET /v1/markets
Each market's listing, spread (basis points of the option price), strike step, mark, vol, caps and their use.

```json
{ "markets": [{ "market": "BTC", "listed": true, "spreadBps": 200, "strikeStep": "100", "mark": "74000", "volBps": 4500,
  "opensPaused": false, "caps": { "notional": "5000000", "notionalUsed": "120000", "directional": "1000000", "directionalUsed": "40000" } }] }
```

## GET /v1/chains/{market}?tempos=3600,86400&strikes=3
Indicative call and put values per unit around the mark, for each tempo (seconds, 3,600 to 2,592,000), at the board's
vol. `strikes` (1 to 10) is how many strikes on each side of the money.

```json
{ "market": "BTC", "mark": "74000", "volBps": 4500, "indicative": true,
  "chains": [{ "tempo": 86400, "rows": [{ "strike": 74000, "call": 1234.5678, "put": 1234.5678 }] }] }
```

## GET /v1/quote/buy?market=BTC&legs=call:74000:1,call:76000:-1&tempo=86400&units=2
The exact cost (premium plus fee, USDC) of buying `units` of a shape now, from the cheapest of the pool and the makers'
signed quotes. `legs` are the buyer's side, `call|put:strike:amount`, comma-separated, 1 to 4 legs. Only shapes a buyer
can hold (the payoff never goes below 0) can be quoted.

```json
{ "market": "BTC", "quoted": true, "cost": "1903.443120", "source": "pool", "makerQuotesConsidered": 2 }
```
If the buy would not go through (a stale mark, a paused market, a shape a buyer cannot hold, a cap), the answer is
`{ "quoted": false, "reason": "…" }`.

## GET /v1/positions/{owner}
An owner's open positions: held directly, or in the AgentRouter sub-account when an agent bought for them under a
mandate. `units` are at the series' current norm (`raw × norm`).

```json
{ "owner": "0x…", "positions": [{ "id": "3830…", "held": "direct", "market": "BTC",
  "legs": [{ "isCall": true, "k": "74000", "qty": "1" }, { "isCall": true, "k": "76000", "qty": "-1" }],
  "movement": [{ "tempo": "86400", "weight": "1" }], "raw": "2000000000000000000", "units": "1998123456789012345", "unitsDecimal": "1.998123" }] }
```

## GET /v1/receipts/proof?tx=0x…&logIndex=N
The Merkle proof of a receipt: a trade, a vol final or a NAV snapshot. Every hour's receipts are committed in one root
on Elysium (`ReceiptRoots`); anyone can check a receipt with `ReceiptRoots.verify(epoch, leaf, proof)` or rebuild the
root from the chain's events.

```json
{ "epoch": 498611, "kind": 1, "encoded": "0x…", "leaf": "0x…", "proof": ["0x…"], "root": "0x…", "posted": true }
```
`kind`: 1 trade, 2 vol final, 3 NAV snapshot. `posted` is false until the hour's root is on-chain. `404`: no receipt for
that log (yet).

## Errors
`400` with `{ "error": "…" }` for bad input; `404` unknown path; `405` anything but GET; `429` over the rate limit;
`503` a part not configured on this server.
