# Security

Tourbillon is a no-expiry options venue being built for Robinhood Chain. **Nothing is deployed on any mainnet.** The
contracts run on local chains and testnets only, and mainnet waits for an external review and the owners' approval.

## Reporting a problem

Please report privately through GitHub's private vulnerability reporting on the public repository:
https://github.com/tourbillondev/tourbillon/security (Security tab → "Report a vulnerability"). Do not open a public issue. Include what you found, how to reproduce it, and which contract or service
it affects. We confirm receipt, work in a private fork of the advisory, and publish only after the fix and your re-test.

## Scope

- `contracts/src/`: every contract and library.
- `services/`: the signer, poker, hedger, risk monitor, receipts, indexer, API, MCP, maker gateway, alert bot and
  release job.
- `scripts/` and `tools/`: the publish script and the words gate.

Out of scope: third-party libraries in `contracts/lib/` (report those upstream), Robinhood Chain itself, the settlement
token, the tokenized stocks, Uniswap v4 and Binance.

The full role list (every privileged function and who holds it) is in [docs/architecture.md](docs/architecture.md); the
threat model in [docs/threat-model.md](docs/threat-model.md); the invariants and their tests in
[docs/invariants.md](docs/invariants.md).

## The rules the code must never break

1. A buyer never loses more than they paid. No margin, no liquidation.
2. No price without a fresh, cross-checked mark. If none, opens on that market close.
3. Sells always work. Pauses stop new opens only.
4. Every writer's collateral covers the exact worst case of what they sold.
5. Funding follows the recorded price path. No caller supplies a price.
6. No single key can set a price, a vol or an admin action.

A report that breaks any of these is the most serious kind.

## Roles

| Who | Can | Cannot |
|---|---|---|
| Owner multisig (Safe 3-of-5) | Propose admin actions through a 48 h timelock (listings, caps, fees, signer set, mark routes, covering-asset listings, hedge router and limits); unpause; move pool settlement token to and from the treasury within a daily cap | Skip the timelock; set a price or a vol |
| Timelock | Execute a queued action after its delay (anyone may trigger it) | Act without a queued, delayed operation |
| Guardian (2-of-3) | Pause buys, a market's opens, or pool deposits | Unpause; pause sells or withdrawals; change any setting |
| Risk monitor key | Pause opens on one market at a time | Unpause; touch sells, withdrawals or settings |
| Signers (m of n) | Each casts one vote per round on a mark or a vol; the board publishes the median, step-clamped | Publish a value alone |
| Receipts poster | Post the hourly receipts root | Change any trade or balance; hide a wrong root (anyone can rebuild it) |
| Hedge keeper (the key behind the gate) | Swap the pool's stock hedge through `HedgeKeeperGate` and the listed router, at most the listed slippage from the router mark, within the inventory and daily caps, while the gate is not frozen | Choose a price; hold tokens; spend money that pays sells or is set aside; move money anywhere else; reach the pool around the gate |
| `HedgeKeeperGate` | Hold the pool's hedge keeper role and forward the listed key's swaps unchanged | Hold tokens, pick a price, or act while frozen; the guardian freezes it, only the Safe unfreezes, only the timelock changes its key |
| Keepers and pokers | Record samples and walk accruals (permissionless) | Choose what price is recorded |

## Accepted risks (waiting for the owners' acceptance before mainnet)

| Risk | Reason | What limits it | Still open |
|---|---|---|---|
| The risk monitor's automated pause key | Pauses opens fast when a venue is down or a split shows, without waiting for the guardian | It can only pause one market's opens; only the Safe unpauses; every use raises an alert | Owner acceptance before mainnet |
| Pool shortfall in an extreme move | The pool backstops every trade | Stress budget, caps per market, coverage check before each open, drawdown pause | Owner acceptance of the parameters before mainnet |
| Prices come from the signer quorum | Robinhood Chain has no published first-party mark yet | Median of independent operators, step clamp, staleness, two sources inside each signer, the out-of-session band | Until a first-party mark is live and cross-checked |
| A colluding signer majority can walk a mark by steps | The quorum is the price source | Step clamp per round, the session band, caps, independent operators and providers | Until a second, independent source is in the router |
| Capital at the crypto hedge exchange (Binance) | BTC and ETH are hedged with perpetuals | The treasury's daily cap; NAV counts it only through fresh signer-voted EQUITY with a haircut; trade-only keys, withdrawals disabled, IP allowlist | The exchange's own failure is not covered; the margin asset is counted at par with the settlement token (U) |
| A stolen hedge keeper key | The stock hedge needs a key that can swap | The key holds no role: it calls `HedgeKeeperGate`, which the guardian freezes at once (only the Safe unfreezes); each swap at most the listed slippage (at most 3%) from the router mark, inventory and daily caps, free money only | Replacing the key waits the timelock; the gate stays frozen meanwhile, so the stock hedge stops until then |
| Issuer controls on the settlement token and the tokenized stocks | Both are issuer tokens | Stuck covering tokens are kept owed and opens on that market pause; listings check every holder pair | A freeze of the settlement token at the pool's address cannot be prevented |

## Open issues

- Items marked (U) in the specs and in [docs/backend/honest-limits.md](docs/backend/honest-limits.md): the settlement
  token's address and behaviour on Robinhood Chain, the native mark interface, the sequencer model, the exchange account's
  margin asset, the Uniswap v4 pools. Each is confirmed before mainnet.

## Audit history

No external review yet. An automated pre-audit grade and its fixes come before mainnet, then an external review and a
compliance review. Only an approved review report is ever committed here.
