# Tourbillon website

The site and dashboard (React, Vite). The same build runs in one of two modes, fixed at build time:

| Mode | How | What it shows |
|---|---|---|
| Demo (default) | `bunx vite build` | Sample markets and simulated positions, labelled as such on every screen. No wallet transaction is ever requested. |
| Live | `VITE_TOURBILLON_MODE=live bunx vite build` | One deployment: markets, quotes, positions and the pool from the Tourbillon API v1 and the chain, and real transactions that the wallet confirms. A live build never shows sample data; when something is unavailable it says so. |

## Live mode

The live site reads one file, `/deployment.json`, served next to the build: the chain, its RPC, the API and the
contract addresses (`src/live/manifest.mjs` checks it; `scripts/manifest.ts` makes it from a deployment file). On load
it checks that the RPC, the contracts, the settlement token and the API all describe the same deployment, and refuses
to show anything as live otherwise. Mainnet is refused until the owners say otherwise.

- `src/live/codec.mjs`: exact amounts (decimal strings to base units, never through a JavaScript number), the book's
  one spelling of legs, tempos, Movement weights, strike steps and the writer's exact worst-case collateral.
- `src/live/tx.mjs`: the transaction lifecycle as a checked state machine (preparing, network, approval, review,
  wallet, submitted, confirming, confirmed, reconciled, and every other ending); success is shown only once the
  chain's events and the API agree.
- `src/live/chain.mjs`: buy (OpenBook), sell (Engine) and write (WriterBook), each simulated from the user's own
  account before the wallet is asked; bounds signed at 0.5% from the reviewed amount.
- `src/live/errors.mjs`: a contract refusal shown by name and meaning (for example, opens paused: selling still works).
- `src/live/abi.generated.mjs`: generated from the Foundry build by `bun scripts/abi.ts`; a test fails if it drifts.

## Commands

```
bun install --frozen-lockfile
bunx vite                                   the demo, at http://127.0.0.1:5173/#/
bun scripts/local.ts --wallet 0xYourAddress the live site against a local anvil, API and indexer (local only)
node --test tests/*.test.mjs                unit tests (codec, transaction machine, manifest, refusals, API, wallet)
bun test test-bun                           the generated interface, the manifest maker, and the live end-to-end test on anvil
bun scripts/manifest.ts --deployment <m7.json> --rpc <url> --api <url> --out dist/deployment.json
```

Only the built `dist/` is ever deployed.

## Fonts

Inter and Instrument Serif, both under the SIL Open Font License 1.1; each licence sits next to its font in
`public/assets/fonts/`.

Tourbillon is an independent project. Robinhood Chain is used as a network only.
