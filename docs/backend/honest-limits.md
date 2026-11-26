# Honest limits (backend)

What Tourbillon's backend does not do, or does not do yet. Read this before you rely on it. Items marked (U) are not
yet confirmed on Robinhood Chain.

## Prices and vols
- **Prices come from Tourbillon's signer quorum** until Robinhood Chain publishes a first-party mark. Independent
  operators each read two sources per market and vote only when they agree; the board publishes the median of a
  quorum, clamps each step and goes stale after a heartbeat. Stale means opens close on that market; sells keep
  working on the last good sample.
- **Tokenized stocks:** the vote is the token's on-chain price on Robinhood Chain, which must agree with an off-chain
  equity reference within 1% during the regular US session. Stock Tokens trade around the clock, but the equity
  reference is closed outside US hours, so outside the session the mark is held within ±10% of the last session value,
  and on weekends and US market holidays opens on stock markets are capped at a quarter of their normal size. Sells are
  never capped.
- **Crypto:** the median of at least two exchanges, within 1% of Pyth.
- **The native mark interface is not published (U).** Its adapter is a stub behind the mark router's timelocked switch.
  Chainlink publishes feeds on Robinhood Chain, including Stock Token feeds, which are an option for that adapter.
- **Vol is partly a model** (realised vol from each signer's own accepted marks) until makers carry real share. The
  open book's fills are published in an on-chain vol feed; they do not change the pool's price.
- **A stock split or other corporate action** can make the signers' price jump by a split ratio. The risk monitor then
  pauses new positions on that market until the change is reviewed; sells are unaffected.

## Money
- **Buyers can lose 100% of what they paid.** A position can never owe more than that.
- **Writers and makers can lose their locked collateral**, which is always the exact worst case of what they sold.
- **The Mainspring pool's NAV moves with the book and can fall.** Opens pause automatically after a 15% drawdown in 30
  days; sells and withdrawals stay open.
- **Settlement is USDG** on Robinhood Chain (a deploy setting; a USDC configuration is possible). Its address, code and
  approval behaviour are re-verified before deployment (U). The settlement token must have 6 decimals; the deploy
  refuses any other.
- **Part of the pool's capital sits at a crypto exchange (Binance) for hedging BTC and ETH.** It counts in NAV only
  through the signers' EQUITY value: gains at 95% and one round late, losses at once, nothing once the value is two
  hours old. The exchange account's margin asset is counted at par with the settlement token (U).
- **The pool holds tokenized stock as its stock hedge**, counted at the router mark (nothing when the mark is stale).
- **A tokenized stock's issuer can pause or freeze transfers.** If a covering token cannot move during a sell or a
  close, the seller is still paid in the settlement token, the stock is kept owed and settled once it moves, and new
  positions on that market pause.

## Chain and operations
- **Robinhood Chain is an Arbitrum Orbit chain;** its sequencer model is to be confirmed (U). Its canonical bridge has a
  7-day withdrawal challenge. Public RPCs are rate-limited and not used for production services.
- **Admin actions wait 48 hours on mainnet** (1 hour on testnet) in a timelock behind a 3-of-5 Safe. A 2-of-3 guardian
  can pause opens and deposits at once; it cannot change anything else. One automated key can pause opens on one
  market (a venue down for 15 minutes, or a split); it can do nothing else. The pool's stock hedge is swapped through a gate that
  the guardian can freeze at once; the key behind it can only swap within governance limits and never chooses a
  price.
- **Sells are never paused**, by anyone.
- **Hedging:** stock markets on Robinhood Chain liquidity (Uniswap v4) through the pool's own swap, at most the listed
  slippage from the router mark; crypto markets at Binance USDⓈ-M futures through a trade-only key that cannot
  withdraw. The exchange hedge runs on the futures testnet until the owners approve mainnet.
- **Receipts:** every hour's trades, vol finals and NAV snapshots are committed in one Merkle root on Robinhood Chain.
  Anyone can rebuild a root from the chain's events and check a receipt against it.

## Access
- **Not offered** where Robinhood Chain's own tokenized-stock access does not reach, or where options are restricted.
  Availability follows the host chain's map, not ours. A compliance review comes before mainnet.
