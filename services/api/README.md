# api

The public API v1 (launch core; owner D4: open, read-only, no keys, per-IP rate limits). It reads the chain and the
indexer's Postgres; it holds no key and sends nothing. Endpoints and fields: `openapi.json`.

- `/v1/status`, `/v1/markets`, `/v1/chains/:market` (indicative), `/v1/quote/buy` (exact), `/v1/positions/:owner`,
  `/v1/receipts/proof`.
- **The exact quote** simulates the real `OpenBook.buy` from a dummy buyer whose USDC balance and allowance are set for
  that call only (a state override: nothing is sent). The token's storage slots are found once by probing; with an
  unusual token the endpoint answers `quoted: false` with the reason rather than guessing.
- Positions come from the indexer's `positions` table; their units use the book's current norm.

    DATABASE_URL=postgres://… bun src/main.ts --deployment ../../contracts/deployments/31337-m7.json [--port 8550] [--gateway URL] [--receipts URL] [--trust-proxy]

The database URL comes from the environment only and is never logged. Wording follows the spec's rules (Overview
section 9); the words lint checks `openapi.json`, keys included.
