# Honest limits (backend)

What Tourbillon's backend does not do, or does not do yet. Read this before you rely on it.

## Prices and vols
- **Until the HyperCore read precompile ships, prices come from Tourbillon's signer quorum,** not from Elysium itself:
  independent operators relay Hyperliquid's mark and vote; the board publishes the median of a quorum, clamps each step
  and goes stale after a heartbeat. Stale means opens close on that market; sells keep working on the last good sample.
- **The precompile's address and ABI are not published yet.** The adapter is built and waits behind the mark router's
  delayed switch.
- **Vol is partly a model** (realised vol from Hyperliquid's marks) until makers carry real share. The open book's fills
  are published in an on-chain vol feed; they do not change the pool's price.

## Money
- **Buyers can lose 100% of what they paid.** A position can never owe more than that.
- **Writers and makers can lose their locked collateral**, which is always the exact worst case of what they sold.
- **The Mainspring pool's NAV moves with the book and can fall.** Opens pause automatically after a 15% drawdown in 30
  days; sells and withdrawals stay open.
- **USDC on Elysium is the gateway-bridged token**, backed by USDC on HyperEVM.
- **Part of the pool's capital sits on Hyperliquid for hedging.** It is counted in NAV only through the signers'
  EQUITY value, with a haircut, and only while that value is fresh.

## Chain and operations
- **Elysium runs a single sequencer**, and its withdrawal challenge period is about 5.5 days.
- **Admin actions wait 48 hours on mainnet** (1 hour on testnet) in a timelock behind a 3-of-5 Safe. A 2-of-3 guardian can pause opens and deposits
  at once; it cannot change anything else. One automated key can pause opens on one market when the hedging venue is
  down; it can do nothing else.
- **Sells are never paused**, by anyone.
- **Hedging runs off-chain** through a trade-only Hyperliquid API wallet (it cannot withdraw), until on-chain hedging
  through the HyperCore writer is available.
- **Receipts:** every hour's trades, vol finals and NAV snapshots are committed in one Merkle root on Elysium. Anyone
  can rebuild a root from the chain's events and check a receipt against it.

## Access
- **Not offered** where Hyperliquid restricts access (including the US and Ontario) or where options are restricted.
