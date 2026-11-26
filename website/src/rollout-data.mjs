// Product Overview §6 + Backend §§2, 5–7; current network migration controls.
// These are release requirements, never a live completion feed.
export const rolloutWaves = [
  {
    id: 'T0', name: 'Core', short: 'The first markets', title: 'Start with the core.',
    intro: 'No-expiry Rise and Fall on BTC, ETH and SPY. Choose a tempo from 1 hour to 30 days, with settlement in USDG on Robinhood Chain.',
    scope: [
      ['Price & funding', 'Independent signers relay each tokenized asset’s price and an independent reference feed. Five-minute samples record the price path used to calculate funding.'],
      ['Mainspring pool', 'The pool backs the initial book, with an on-chain tokenized-stock hedger alongside a trade-only CEX wallet for crypto exposure.'],
      ['Administration', 'A Safe multisig and timelock govern changes. Emergency controls can pause new exposure.'],
    ],
    gates: [
      ['Fork tests pass', 'Exercise the core against Robinhood Chain state and the selected USDG contracts.'],
      ['Core audit', 'Complete the independent review required for the core release.'],
      ['Three signer operators', 'Three independent operators must be live to relay market data.'],
    ],
    outcome: 'The first planned release brings directional options and the settlement, funding and liquidity they need.',
    link: 'mechanics', linkText: 'How the core works',
  },
  {
    id: 'T1', name: 'Shapes', short: 'More ways to position', title: 'Build the view as one position.',
    intro: 'Add spreads, Swing and Band, plus user writing backed by USDG. Each shape keeps its legs together as one position.',
    scope: [
      ['Bounded strategies', 'Use a spread for a capped directional payoff, Swing for a move either way, or Band for a range.'],
      ['Writing', 'Lock the exact worst-case obligation before an offer can be filled. An uncovered short Rise is refused.'],
      ['Covered SPY', 'Guard remains planned until a supported SPY collateral route is verified on Robinhood Chain.'],
    ],
    gates: [
      ['Collateral invariant', 'Fuzz tests must show that a written position cannot owe more than its locked collateral.'],
      ['Covered route verified', 'Guard needs a verified collateral asset, valuation and redemption or bridge risk model.'],
    ],
    outcome: 'Express a more specific view, or write a bounded shape with its maximum obligation locked up front.',
    link: 'writing', linkText: 'Writing & collateral',
  },
  {
    id: 'T2', name: 'Resilience', short: 'Oracles & hedging', title: 'Test the system under stress.',
    intro: 'Harden the price relay and the separately operated hedger (on-chain stock hedging for tokenized stocks; CEX API wallet for BTC and ETH). Robinhood Chain settlement needs verified connections to both.',
    scope: [
      ['Independent price checks', 'Cross-check the tokenized-asset mark against an independent reference feed and reject stale or conflicting data before it opens new exposure.'],
      ['Resilient relayers', 'Test interruptions, sequencer failures and recovery across the configured Robinhood Chain adapters.'],
      ['Reconciled hedging', 'Reconcile the off-chain hedger, treasury transfers and reported equity with the pool’s accounting.'],
    ],
    gates: [
      ['Adapters verified', 'Confirm the deployed network interfaces and each configured route.'],
      ['Failure tests pass', 'Exercise stale-data, sequencer-outage and recovery paths.'],
      ['Books reconcile', 'Reconcile hedge positions and treasury movements across both venues.'],
    ],
    outcome: 'The release criteria cover how pricing and hedging behave when a connection or data source fails.',
    link: 'pool', linkText: 'Mainspring & hedging',
  },
  {
    id: 'T3', name: 'Open book', short: 'Makers & a public feed', title: 'Let liquidity compete.',
    intro: 'Bring outside makers into the book. A buy can fill from signed maker quotes, users’ written offers or the Mainspring pool.',
    scope: [
      ['Best-of-three fills', 'Compare eligible prices across all three sources and use the cheapest available fill.'],
      ['Risk auction', 'A weekly sealed auction gives the book another route for transferring volatility risk.'],
      ['Public volatility feed', 'Expose volatility by market and tempo, with maker quotes and fills helping to tighten the inputs.'],
    ],
    gates: [
      ['Two independent makers', 'At least two independent makers must be live for this wave.'],
    ],
    outcome: 'More sources can quote the same trade, while the public feed makes the market’s volatility inputs easier to inspect.',
    link: 'mechanics', linkText: 'Prices & competing fills',
  },
  {
    id: 'T4', name: 'Expansion', short: 'Markets & agents', title: 'Expand market by market.',
    intro: 'Add options on tokenized equity, index and ETF markets on Robinhood Chain, followed by tools for agents acting under an owner’s mandate.',
    scope: [
      ['More underlyings', 'Each market is cash-settled on its Robinhood Chain mark. Weekend stock marks need their own anchor bands and lower opening caps.'],
      ['Owner-set limits', 'Agent mandates specify allowed markets and shapes, premium and risk budgets, expiry and close-only permissions.'],
      ['Agent access', 'The planned MCP interface exposes the product to agents within those signed permissions.'],
    ],
    gates: [
      ['Four weeks of stable marks', 'Each proposed market must stay inside the quorum band for four weeks before it joins.'],
    ],
    outcome: 'Broader market coverage, with delegated actions bounded by the permissions an owner signs.',
    link: 'roadmap', linkText: 'Read the rollout details',
  },
];
