// Source: Overview §§2–6, 9–10; Backend §§0, 3–7; Robinhood / USDG override.
// These describe the product design. The deployed interface remains a local demo.
export const featureGuides = {
 tempo: {
  number:'01', eyebrow:'Time, without a deadline', metric:['1h–30d','Decay pace'],
  tabs:[
   {label:'Decay', blocks:[
    {heading:'What a tempo changes',text:'Tempo sets how quickly an option pays its continuing cost. You can choose any pace from one hour to thirty days. Day and Week are convenient presets. A three-day tempo does not mean the option ends in three days: there is no expiry date to roll.'},
    {heading:'The cost comes out of your units',text:'The design pays funding in kind. Your position’s units shrink as funding accrues, while the option keeps its strike and payoff shape. The remaining units still respond to the market. A short tempo usually costs less to enter and decays faster; a longer tempo carries more value up front.'},
    {heading:'A source example',text:'With the underlying at 100 USDG, a strike of 100 and volatility of 50%, the brief values one three-day Rise at about 1.60 USDG. Its daily cost at that moment is about 0.53 USDG per unit. Those are model illustrations before trading fees, not today’s quotes or a fixed daily charge.'},
   ]},
   {label:'Movement', blocks:[
    {heading:'Several tempos, one option',text:'A Movement combines up to four tempos. Each gets a positive weight, and the weights must add up to 100%. You keep one position while spreading its decay profile across several paces. The brief compares this with a ladder of dated options that does not need rolling.'},
    {heading:'How the blend is valued',text:'The value is the weighted sum of its components. Each component uses its own tempo and applicable volatility. Funding is also weighted, using each component’s time value divided by its tempo. A Movement does not remove funding or turn its cost into a constant.'},
    {heading:'A 25 / 75 mix',text:'For an illustrative mix of 25% Day and 75% Week, the model combines one quarter of the Day value with three quarters of the Week value. The same weights apply to their funding contributions. The dashboard lets you edit the weights and refuses a review until the total is exactly 100%.'},
   ]},
   {label:'Costs', blocks:[
    {heading:'The path matters',text:'Funding follows recorded marks over time. The design samples each market every five minutes, then accrues through that history. A position’s cost depends on where the market travelled, as well as its tempo. A snapshot of today’s daily cost cannot tell you the total cost of holding it for a week.'},
    {heading:'What you can lose',text:'A buyer can lose the full amount paid. There is no holder margin or liquidation in the specified option design, but declining option value and shrinking units can still consume the purchase. A move in the direction you expected does not, by itself, mean you get back more than you paid once funding and fees are counted.'},
    {heading:'What the preview calculates',text:'The demo quotes an illustrative 2% spread, with a 0.01 USDG minimum, plus three basis points of underlying notional. It shows an instantaneous daily-cost estimate. It does not accrue the historical funding path or submit a trade. Connecting a wallet does not change these limits. Production fees must come from the executable quote.'},
   ]},
  ],
 },
 shape: {
  number:'02', eyebrow:'Build the payoff you mean', metric:['One','Combined position'],
  tabs:[
   {label:'Payoffs', blocks:[
    {heading:'Rise and Fall',text:'A Rise is a call: its payoff increases above the strike. A Fall is a put: its payoff increases below the strike. The strike is the reference level for the payoff, not a liquidation threshold. Both are no-expiry options whose remaining units shrink with funding.'},
    {heading:'A direction with a limit',text:'A Rise Spread buys a call at the lower strike and sells one at the higher strike. The sold leg caps the payoff at the gap between strikes. The legs are held as one position, so the combined shape is the thing you buy, value and close.'},
    {heading:'A move either way',text:'A Swing combines a Rise and a Fall at the same strike. Its gross payoff grows as the mark moves away from that strike in either direction. The purchase price, funding and fees still matter. A small move can leave the buyer with a loss even when the payoff has increased.'},
   ]},
   {label:'Examples', blocks:[
    {heading:'A 100 / 110 Rise Spread',text:'For one remaining unit, the gross payoff is zero at or below 100 USDG, rises between the two strikes, and reaches its 10 USDG cap at 110 or above. At a mark of 105, the payoff shape gives 5 USDG. These are payoff amounts before funding and fees, not quoted sale proceeds.'},
    {heading:'Payoff and price are different',text:'The no-expiry model includes time value as well as current payoff. In the brief’s example, a 100 / 110 Rise Spread at Week tempo costs about 2.08 USDG when the underlying is 100 and volatility is 50%. Under the same assumptions, a Week Swing at the 100 strike costs about 4.89 USDG.'},
    {heading:'Keep the whole position in view',text:'Changing a strike changes both the payoff and its price. Changing a spread’s width changes its cap. The dashboard exposes the legs and lets you edit the width, so you can compare the structure with the displayed model value. All examples use sample inputs; they are not available market prices.'},
   ]},
   {label:'Limits', blocks:[
    {heading:'Guard trades upside for protection',text:'A Guard combines covered SPY, a protective Fall and a written Rise at a higher strike. The written call helps pay for the put and caps the holder’s upside. The capped upside is what pays for the Fall. Guard remains planned until SPY collateral, its valuation and its redemption risks are verified on Robinhood Chain.'},
    {heading:'Band is a bounded condor',text:'The brief describes a four-leg condor with the writer’s maximum loss locked up front. The demo uses a symmetric four-call arrangement with equal wings. That is one illustrative structure. Its wing width bounds the gross payoff; other leg arrangements need their own collateral calculation.'},
    {heading:'One position still has several risks',text:'Grouping legs makes the structure easier to hold, but does not remove market, funding or execution risk. Buyers can lose their paid amount. Writers can lose locked collateral. Covered assets from another chain cannot simply be treated as valid collateral here, and a short call without sufficient cover is refused.'},
   ]},
  ],
 },
 write: {
  number:'03', eyebrow:'The obligation comes first', metric:['Exact','Worst-case collateral'],
  tabs:[
   {label:'Collateral', blocks:[
    {heading:'Set aside what you could owe',text:'When you write an option, you agree to cover its payout. The planned contract works out the most your whole position could owe, then locks that amount in USDG for a bounded cash-settled shape. That money is the collateral.'},
    {heading:'Why a spread locks its width',text:'A written 100 / 110 Rise Spread can owe at most 10 USDG per unit. Below 100 its gross obligation is zero; between 100 and 110 it increases; above 110 it stays at 10. An illustrative write of ten units therefore requires 100 USDG against that payoff. Funding and fees are separate accounting items.'},
    {heading:'Check every place the payoff can turn',text:'The backend specification evaluates the payoff at zero, at every strike, and from its slope above the highest strike. This finds the worst case for the piecewise-linear option shapes. The dashboard’s floating-point preview illustrates that calculation; production enforcement belongs in the contracts.'},
   ]},
   {label:'Funding', blocks:[
    {heading:'What a writer receives',text:'Writers receive funding paid by their buyers as the position continues. The brief allocates 10% of that funding to protocol fees. Funding received is not a promised result: it must be considered alongside the written obligation, changes in the option’s value and any costs of closing the position.'},
    {heading:'Three possible sources for a buy',text:'The planned engine compares signed maker quotes, users’ written offers and the Mainspring pool. It selects the cheapest eligible buy. Makers quote volatility across a band of strikes and tempos; the engine uses those signed terms to price the trade. The preview does not connect an executable writer or maker book.'},
    {heading:'Where Mainspring fits',text:'Mainspring is the proposed pool backstop and hedges its delta on Robinhood Chain. Its NAV reflects the book and can fall. Pool withdrawals are queued and paid at NAV. The Robinhood Chain design needs separate hedge and treasury services; it does not assume an atomic connection to Robinhood Chain.'},
   ]},
   {label:'Risks', blocks:[
    {heading:'An uncovered Rise has no finite cap',text:'A short call can owe more as the underlying price rises, without a finite upper limit. The design refuses a naked short Rise. The demo also blocks writing Swing without cover because its call leg leaves that same unbounded obligation. A bounded spread or condor is assessed as a complete payoff.'},
    {heading:'Covered SPY needs verified collateral',text:'The original brief described covered writing with a tokenized SPY representation. Those old chain assumptions do not carry over automatically. A Robinhood Chain implementation needs a verified SPY representation and an explicit valuation and redemption model before covered Rise or Guard can be offered.'},
    {heading:'Locked collateral is at risk',text:'A writer can lose the collateral committed to the position. Exact collateral limits an obligation only when the implementation, accounting and collateral assumptions hold. The current interface is a collateral preview: it sends no write, locks no money and issues no funding receipt. The backend and contract risk checks are still required.'},
   ]},
  ],
 },
 market: {
  number:'04', eyebrow:'One market, a checked mark', metric:['5 min','Funding samples'],
  tabs:[
   {label:'Prices', blocks:[
    {heading:'Start with the Robinhood Chain mark',text:'The specified underlying is each market’s Robinhood Chain mark. TOURBILLON plans to relay that mark to Robinhood Chain through independent signers. Settlement is denominated in USDG, with ETH for network gas. Tourbillon is an independent project; Robinhood Chain is used as a network only.'},
    {heading:'Volatility is another input',text:'The quorum also posts volatility for each market and tempo. Maker quotes and fills are intended to improve those values as the market develops. Volatility remains partly a model input; the mark alone does not determine an option’s price. Strike, shape and tempo also affect its value.'},
    {heading:'Record the path',text:'Funding samples are designed to be taken every five minutes. Anyone may trigger sampling, but the contract reads the accepted mark itself. A caller does not choose the price being recorded. Funding accrual then follows those samples, with older history retained at coarser intervals.'},
   ]},
   {label:'Hours', blocks:[
    {heading:'No expiry-day deadline',text:'The product is designed around Robinhood Chain markets that trade around the clock. A TOURBILLON option has no scheduled expiry, so there is no expiry date that forces a roll. Its units continue to shrink with funding for as long as the position remains open.'},
    {heading:'Openings depend on valid data',text:'Continuous market hours do not mean every new trade must always be accepted. New opens require a fresh, checked mark and the applicable risk gates. The specification pauses opens when those conditions fail. Sells are designed to remain available using the last good sample; network or venue outages can still disrupt transaction execution.'},
    {heading:'Markets enter in stages',text:'BTC, ETH and SPY come first in the rollout. More tokenized stocks and crypto majors are later additions, each subject to its mark and volatility gates. The brief treats weekend tokenized stock marks as band-capped estimates and applies tighter opening limits. Those later markets are not live in this preview.'},
   ]},
   {label:'Integrity', blocks:[
    {heading:'Several operators, explicit checks',text:'The design uses a signer quorum rather than a single price-setting key. It calls for median aggregation, limits on abrupt steps and freshness checks. A fresh secondary source, when configured, must agree within the allowed deviation. The Robinhood Chain adaptation also requires sequencer availability and recovery checks.'},
    {heading:'A record of what happened',text:'Trades, finalized volatility and pool NAV snapshots are intended to be grouped into an hourly Merkle root on Robinhood Chain. That root commits to a batch of records so individual records can later be checked against it. It does not, by itself, prove that every input or valuation was correct.'},
    {heading:'What you are seeing here',text:'The dashboard uses deterministic sample candles, depth and prices. There is no live oracle, executable quote feed or settlement adapter connected. Wallet connection only shares your address and network. Market eligibility and regional restrictions still apply to a production service. This preview does not establish launch, audit or availability status.'},
   ]},
  ],
 },
};
