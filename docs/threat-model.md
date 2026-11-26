# Threat model

What Tourbillon protects, what each kind of attacker can and cannot do (and why), and what is not protected. The six
laws are in [invariants.md](invariants.md) with the tests that check them; the roles in
[architecture.md](architecture.md).

## What is protected
- **Buyers' money:** a buyer can lose at most what it paid; a position can never owe more (law 1).
- **Exits:** sells and LP withdrawals are never paused by anyone (law 3).
- **Writers' and makers' counterparties:** every sold position is backed by the exact worst case, locked up front
  (law 4).
- **Prices:** no trade without a fresh, cross-checked mark; no caller supplies a price (laws 2 and 5).
- **Governance:** no single key can set a price, a vol or an admin action (law 6); admin actions wait a public timelock.
- **The pool's set-aside money:** queued deposits and money owed to withdrawals are never spent on anything else.

## Attackers

| Attacker | Can | Cannot | Because |
|---|---|---|---|
| A trader | Buy and sell at the published price, bounded by its own `maxCost` or `minOut` and deadline | Choose a price; lose more than it paid; get back more than it paid from an immediate round trip | The Engine prices from the router and the board at the current block; rounding favours the counterparty; tests in invariants.md, law 1 |
| A front-runner (MEV) | Reorder transactions within a block | Make a trade fill beyond the trader's own bounds | Every buy and sell carries the trader's cost or proceeds bound and a deadline |
| One signer, or a minority | Vote a wrong value, or stop voting | Move the published mark or vol | The board publishes the median of a quorum; one outlier is ignored; a stale feed closes opens instead of guessing |
| A majority of signers | Move the published mark by at most the step clamp per round | Jump the mark; move a stock mark outside the session beyond ±10% of the last session value | Step clamp and session band; independent operators, each with two sources. **Not fully protected:** a colluding majority can walk a mark by steps (see below) |
| Someone pushing a tokenized stock's on-chain price (thin liquidity) | Move the token's on-chain price | Get it voted in session when it is more than 1% from the equity reference; move it beyond the band outside the session | The signers' cross-check and the board's band; caps are a quarter on weekends and holidays |
| A writer or maker | Sell options against locked collateral; walk away | Owe more than it locked; escape a buyback | Exact worst-case collateral; buybacks are paid from the locked balance, then slashed from the vault |
| An LP | Deposit and withdraw in hourly rounds | Enter or leave at a stale NAV in its favour; take money set aside for others | Rounds settle at that hour's NAV with a virtual share offset; tests `invariant_settlementFair`, `invariant_setAsideIsHeld` |
| A manipulated Uniswap v4 pool | Offer a bad price to the pool's hedge swap | Fill the pool's hedge below the router mark less the listed slippage | The pool sets the floor from the router mark and measures what arrived; the listed pool has no hooks |
| A stolen hedge keeper key | Swap the pool's stock hedge through the gate, within the slippage bound (at most 3%), the inventory cap and the daily swap cap, until the guardian freezes the gate | Choose a price, hold tokens, move money elsewhere, spend money that pays sells, or reach the pool around the gate | The pool's keeper role sits on `HedgeKeeperGate`, never on the key; the guardian (2 of 3) freezes it at once and only the Safe unfreezes; the key behind it changes through the timelock; `hedgeSwap` checks the floor at the router mark, the caps and free money only |
| A stolen risk key (E1) | Pause opens on a market | Unpause; touch sells, withdrawals or settings | Its only role is the pool's risk pauser; the Safe unpauses directly |
| A stolen receipts key | Post a wrong root | Hide it: anyone can rebuild every root from the chain's events | Roots are public and checkable; the API's proofs fail against a wrong root |
| The guardian (2 of 3) | Pause buys, a market's opens, or deposits | Unpause; pause sells or withdrawals; change a setting | Pause-only roles |
| The Safe (3 of 5) | Queue any admin action (visible for 48 hours before it runs); unpause; move pool money to the treasury within the daily cap | Act without the delay; set a price or a vol; send treasury money anywhere but the configured treasury | Timelock as admin; every queued call raises `timelock-queued`; users can exit during the delay |
| An agent under a mandate | Trade for its owner within the mandate | Exceed the markets, families, premium caps, delta and vega budgets, or expiry; keep the owner from selling | The AgentRouter checks every limit on-chain; the owner sells directly at any time |
| A visitor to the API or MCP | Read public data at the rate limit | Change anything; read anything private | Read-only services with no keys |
| A malicious dependency or CI action | Run in a build | Run at install, or ship without review | Exact pins, no install scripts, a 3-day package age, SHA-pinned actions, secret scanning, the words and publish gates |

## What is not protected
- **A colluding majority of signers** can walk a mark by one step clamp per round. Independent operators, two sources
  each, the anchor band and the caps limit the damage; Robinhood Chain's first-party mark will add a cross-check once
  it is published.
- **The crypto hedge exchange** (Binance) holding part of the pool's capital: an exchange failure loses that capital.
  The treasury's daily cap limits how much moves there, and NAV counts it only through the signers' EQUITY with a
  haircut.
- **The settlement token's issuer** (USDG) can freeze or block an address, including the pool's. Nothing in the
  contracts can prevent that.
- **A tokenized stock's issuer** can pause or freeze its token. Sells still pay in the settlement token; the stock is
  kept owed and opens on that market pause until it moves.
- **Robinhood Chain itself:** sequencer downtime or censorship delays every transaction, sells included; a stale mark
  closes opens. The canonical bridge's 7-day challenge applies to anyone bridging out.
- **Stock splits and corporate actions** are detected by the signers' price moving by a split ratio, after which opens
  on that market pause; a corporate action that does not show as a ratio is reviewed by the team.
