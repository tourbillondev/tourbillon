// Public product explanations, not a deployment or availability assertion.
// Claim map: evidence/PRODUCT-GUIDE.md. Network and currency follow the user override.
const s = (id, title, paragraphs, extra = {}) => ({ id, title, paragraphs, ...extra });
export const guideChapters = [
 {
  id:'overview', label:'Start here', group:'GETTING STARTED', title:'Understand the position\nbefore you open it.',
  summary:'What TOURBILLON does, what you pay for, and what the preview can show you.',
  lead:'TOURBILLON is designed for options on Robinhood Chain markets with no expiry date. Choose a payoff shape and a decay pace, pay for the position, then decide when to sell.',
  sections:[
   s('the-basics','A view, a shape, a tempo.',[
    'A Rise expresses a view that the market will move up. A Fall responds to a move down. A Swing combines the two, while spreads and Bands put boundaries around the payoff. The underlying price is the Robinhood Chain mark for the selected market.',
    'Tempo sets how quickly the position pays its continuing cost. A one-day tempo does not expire tomorrow. Instead, the number of units you own gradually shrinks as funding accrues. The remaining units keep the same strikes and payoff shape.',
    'The planned settlement currency is USDG on Robinhood Chain. ETH pays network gas. Robinhood Chain supplies the underlying markets and is the proposed hedge venue; it is separate from the settlement network.'
   ],{visual:'overview'}),
   s('buyer-basics','What buying means.',[
    'You pay a premium: the price of the option. The design does not require holder margin or liquidate your position. Your purchase can still lose its entire value through changes in the market and the continuing cost of holding it.',
    'There is no scheduled expiry that forces you to roll into a new contract. You close by selling the remaining position. Its sale value depends on the market, volatility, tempo, remaining units and execution costs.'
   ]),
   s('preview','What works in this preview.',[],{table:{headers:['Available here','What that means'],rows:[
    ['Explore the dashboard','Sample candles, depth and model quotes. Buy and close demo positions stored in this browser.'],
    ['Build a strategy','Rise, Fall, Rise Spread, Swing and a symmetric Band. Choose one tempo or a Movement of up to four.'],
    ['Preview writing','Inspect the legs and calculated worst-case collateral. No write is submitted and no money is locked.'],
    ['Connect a wallet','MetaMask or Phantom can share an address and network. Connecting does not turn demo orders into real trades.'],
    ['Still planned','Live trading, path-funding accrual, executable maker quotes, pool deposits, withdrawals, Guard and agents.']
   ]}}),
   s('reading','Choose where to begin.',[
    'New to the product? Read Buying & closing, then Tempo & Movement. If you want to understand the obligation behind a trade, start with Writing & collateral. The glossary is available whenever a term gets in the way.'
   ],{links:[['trading','Walk through a position'],['writing','Understand collateral'],['glossary','Look up a term']]})
  ]
 },
 {
  id:'trading',label:'Buying & closing',group:'GETTING STARTED',title:'From a view\nto a position.',summary:'Read the ticket, compare the costs, and understand what closing pays back.',
  lead:'The ticket starts with the market you want exposure to. The shape defines how the option responds; the tempo defines its continuing cost.',
  sections:[
   s('build','Build the position in order.',[],{steps:[
    ['Choose a market','BTC, ETH and SPY are the initial markets in the plan. In the preview their charts and prices are sample data.'],
    ['Choose the shape and strikes','Rise and Fall use one strike. A spread uses two. Check the displayed legs: they define the payoff you are buying.'],
    ['Set tempo and size','Choose from one hour to thirty days, or blend up to four tempos. Size is the number of units; a unit is not a dollar.'],
    ['Review the whole cost','Compare the premium, trading fee, estimated daily cost and total. Review the payoff limits and remember that the daily estimate can change.'],
    ['Open a demo position','The preview records a local position. A production buy would need an executable quote, a maximum cost and a wallet transaction; those are not connected here.']
   ]}),
   s('ticket','Read the numbers without mixing them up.',[],{table:{headers:['Ticket number','Meaning'],rows:[
    ['Mark','The reference price of the underlying market. It is not the option price.'],['Strike','The reference level where a call or put payoff changes. It is not a liquidation price.'],['Premium','The option value multiplied by the number of units you buy, before the displayed trading fee.'],['Daily cost','An estimate at the current inputs. Actual funding in the design follows the recorded market path.'],['Total','Premium plus the displayed opening fee. Future funding and network gas are separate.']
   ]}}),
   s('close','Closing sells what remains.',[
    'In the design, selling some or all of a position pays its current sale value for those remaining units. The engine accepts a minimum amount out, so the sale has a limit on what you are willing to receive. There is no expiry payout to wait for.',
    'To judge the result, compare the amount paid with the net amount received on sale. A rising mark does not automatically make a Rise worth more than it cost: funding reduces units, volatility changes the option price, and fees affect the result.',
    'The dashboard lets you close a demo position. Its displayed result uses sample market values and does not include a full historical funding walk. It cannot establish what a real trade would have paid back.'
   ]),
   s('pause','What happens if new trades pause?',[
    'The backend design pauses new opens when price checks or risk limits fail. Sells are designed to stay available and use the last good sample when a fresh mark is unavailable. A chain or venue outage can still prevent a transaction from executing; an unpaused sell function does not mean instant access.'
   ],{links:[['fees','See the costs'],['risks','Read the failure cases']]})
  ]
 },
 {
  id:'tempo',label:'Tempo & Movement',group:'YOUR POSITION',title:'Choose a pace.\nThere is no deadline.',summary:'Why a three-day tempo does not expire in three days, and how a Movement blends paces.',
  lead:'Tempo controls decay. You can choose any pace from one hour to thirty days; Day and Week are shortcuts for two points on that range.',
  sections:[
   s('decay','The cost comes out of your units.',[
    'The product pays funding in kind. Rather than asking the holder to top up a margin account, it reduces the position’s units as funding accrues. Fewer units means less exposure to the payoff, even though the strike and shape stay the same.',
    'For example, if an illustrative position went from 10 units to 9.8 units, its payoff exposure would be 2% smaller. That is an arithmetic example, not a promised daily decay rate. The actual rate depends on the recorded marks, volatility and tempo.'
   ]),
   s('pace','A shorter tempo changes the trade-off.',[
    'At otherwise comparable inputs, a shorter tempo has less time value and a faster decay pace. A longer tempo carries more value up front. Neither makes a trade automatically better: both the entry price and the cost of holding it matter.',
    'The brief’s example uses an underlying at 100, a strike of 100 and volatility of 50%. One three-day Rise is valued at about 1.60 USDG, with a daily cost of about 0.53 USDG at those inputs. These are rounded model illustrations before trading fees. The daily figure is not fixed for the next three days.'
   ]),
   s('blend','A Movement combines up to four tempos.',[
    'Give each tempo a positive weight, with the weights adding up to 100%. You hold one position, while its value and funding combine the components according to those weights. It is a way to spread the decay profile across several paces without rolling dated contracts.',
    'For a 25% Day / 75% Week Movement, the model takes one quarter of the Day value plus three quarters of the Week value. Funding uses those same weights, applied to each component’s time value divided by its own tempo. Each component can have its own applicable volatility.',
    'The preview validates one to four components and refuses a review if the weights do not total 100%. A Movement still pays funding. Mixing tempos does not make its cost constant.'
   ],{note:['Keep the distinction','Tempo is a pricing and decay parameter. It is not a holding-period recommendation, a lock-up period or an expiry date.']}),
   s('path','Why today’s estimate is not a weekly bill.',[
    'The design charges funding along the recorded price path. If the market moves during the week, the cost changes with it. Multiplying today’s daily estimate by seven gives a rough snapshot calculation, not the actual amount that a week of holding would cost.'
   ],{links:[['funding','Follow the funding path']]})
  ]
 },
 {
  id:'shapes',label:'Shapes & payoffs',group:'YOUR POSITION',title:'Give your view\na payoff shape.',summary:'Rise, Fall, spreads, Swing, Band and planned Guard, with concrete payoff examples.',
  lead:'A shape is a set of option legs held as one position. A payoff diagram describes how that structure responds to the underlying price; it does not show your net result.',
  sections:[
   s('rise-fall','Rise and Fall start with one strike.',[
    'A Rise is a call. For one remaining unit, its gross payoff is the amount the mark is above the strike, or zero if it is below. With a 100 strike and a mark of 108, that payoff is 8 USDG.',
    'A Fall is a put. Its gross payoff is the amount the mark is below the strike, or zero if it is above. A 100-strike Fall has an 8 USDG payoff at a mark of 92. The option can still have time value when its current payoff is zero.'
   ]),
   s('spread','A spread puts a cap on the payoff.',[
    'A 100 / 110 Rise Spread buys the 100 Rise and sells the 110 Rise as one position. The payoff starts above 100, grows between the strikes, and stops growing at 110. The 10-point gap is its maximum gross payoff per remaining unit.',
    'A Fall Spread uses puts to express a bounded downward move. The current ticket implements the Rise Spread example; it does not yet offer a separate Fall Spread selector.'
   ],{visual:'spread',note:['Payoff is not the sale price','The model also includes time value. The chart below shows only gross payoff for one remaining unit, before the premium, funding and fees.']}),
   s('swing','A Swing responds in either direction.',[
    'A Swing buys a Rise and a Fall at the same strike. At a 100 strike, a mark of either 90 or 110 gives a gross payoff of 10 USDG per remaining unit. At 100 the gross payoff is zero.',
    'Buying both legs costs more than buying either leg alone at the same inputs. A small move can leave the buyer with a loss after the premium, funding and fees. The brief’s 100-mark, 50%-volatility Week example values a Swing at about 4.89 USDG before fees.'
   ]),
   s('band','A Band defines a bounded range.',[
    'Band is a four-leg condor. The brief frames it from the writer’s side: funding is received while the position continues, with the maximum obligation locked up front. The exact strikes and long/short directions determine that obligation.',
    'The demo uses equal wings around a central range. With center 100 and width 5, its call legs are +1 at 90, −1 at 95, −1 at 105 and +1 at 110. The long structure’s gross payoff rises from zero to 5 across the lower wing, stays at 5 from 95 to 105, then falls to zero across the upper wing. A writer of that structure locks at most 5 USDG per unit.',
    'That is one specific condor construction. The word “Band” alone does not identify which side of the trade you hold or where it gains and loses. Read the legs and payoff before relying on a strategy name.'
   ]),
   s('guard','Guard exchanges some upside for protection.',[
    'The planned Guard pairs covered SPY with a protective Fall and a written Rise at a higher strike. The written Rise helps pay for the Fall, but caps the holder’s upside. The protection still has a cost, set by the actual quotes.',
    'Guard and covered SPY writing are gated on a verified collateral representation on Robinhood Chain, including valuation and redemption risks. Token addresses and collateral assumptions from another chain cannot simply be reused. The preview labels Guard as planned.'
   ],{links:[['writing','See what a writer must lock']]})
  ]
 },
 {
  id:'writing',label:'Writing & collateral',group:'YOUR POSITION',title:'Set aside what\nyou could owe.',summary:'Understand the writer’s obligation, exact collateral and why an uncovered Rise is refused.',
  lead:'Writing means taking responsibility for an option’s payout. The design calculates the largest amount that the whole shape could owe, then locks collateral to cover it.',
  sections:[
   s('width','A 100 / 110 spread makes it concrete.',[
    'A written Rise Spread with strikes of 100 and 110 can owe at most 10 USDG for each unit. A writer selling 10 units therefore locks 100 USDG against that payoff. The obligation does not keep growing above the upper strike.'
   ],{table:{headers:['Underlying mark','Owed per unit','Owed on 10 units'],rows:[['95','0 USDG','0 USDG'],['105','5 USDG','50 USDG'],['115','10 USDG','100 USDG']]},note:['Separate amounts','This table describes the gross written payoff. Premium, funding received and fees are separate accounting items; they do not change the spread’s 10 USDG payoff cap.']}),
   s('exact','Why the calculation checks the whole shape.',[
    'The backend evaluates the combined payoff at zero, at every strike, and along its slope above the highest strike. For these piecewise-linear shapes, those checks find the worst case. The amount locked reflects the whole position, including offsets between legs.',
    'A written Fall is bounded because the underlying cannot fall below zero in the specified model. Its maximum gross obligation is the strike multiplied by size. A bounded spread locks its width; a condor uses the relevant wing bound. Changing the legs requires recalculating collateral.'
   ]),
   s('unbounded','Some obligations have no finite cash limit.',[
    'An uncovered written Rise can owe more for as long as the underlying rises. There is no finite USDG amount that covers every possible price, so the design refuses a naked short Rise. The demo also refuses an uncovered written Swing because its call leg has that unbounded upside obligation.',
    'Covering a SPY Rise with an accepted SPY asset is part of the future design. It needs verified collateral on Robinhood Chain first. A token with a familiar name is not enough to establish suitable cover.'
   ]),
   s('funding-received','Funding received is not a promised result.',[
    'Writers receive the funding their buyers pay, with 10% allocated to protocol fees in the brief. Their written obligation can still increase in value, and they can lose their locked collateral. Funding receipts need to be considered alongside that obligation and the cost of closing it.',
    'The specification includes unwriting a position, but the complete executable writer book and release accounting are not connected to this frontend. The Write tab is a collateral preview only: it does not accept a write, release collateral or pay funding.'
   ],{links:[['fees','Understand writer fees'],['risks','Understand the remaining risks']]})
  ]
 },
 {
  id:'funding',label:'Funding over time',group:'YOUR POSITION',title:'The route the market takes\nchanges the cost.',summary:'Five-minute samples, shrinking units, keepers and the limits of a daily estimate.',
  lead:'Funding is the continuing cost of holding the no-expiry option. It is paid through a reduction in units and follows recorded market history.',
  sections:[
   s('sample','First, record an accepted mark.',[
    'The planned sampling interval is five minutes for each market. Anyone can trigger a sample, but the contract reads the mark router and volatility board itself. The caller chooses when to make the request; they cannot supply their own price.',
    'The system retains recent five-minute samples, then hourly and daily history for older intervals. It uses the finest stored history that covers an interval when it works through the accrued funding.'
   ]),
   s('accrue','Then apply the cost along that history.',[
    'Time value is the part of an option’s value above its current payoff. For a single-tempo snapshot, divide that time value by the tempo in days to estimate the daily cost per unit. For example, 1.60 USDG of time value at a three-day tempo gives about 0.53 USDG per day at those inputs. As marks and volatility change, the cost can change too.',
    'The position’s units shrink as the recorded costs are applied. The intended result is independent of who updates the position and when they do it. Leaving a position untouched does not make its funding disappear.',
    'For a Movement, the contributions are weighted across its components. A quoted daily estimate shows a point in time; the realized accrual must follow the stored path.'
   ]),
   s('keepers','Keepers catch up long histories.',[
    'A keeper is a service that submits maintenance transactions. If a position needs a long history of funding applied, the work can be resumed in chunks. The backend limits the work performed inside a trade and uses keepers to finish longer walks.',
    'This requires working services and gas. The specification describes the accounting method, but this preview does not run the sampler or accrual walker and does not shrink your stored demo units over time.'
   ],{links:[['tempo','Return to tempo'],['mechanics','See where marks come from']]})
  ]
 },
 {
  id:'mechanics',label:'Prices, fills & receipts',group:'BEHIND THE TRADE',title:'From a market mark\nto a checked trade.',summary:'How signers, volatility, competing liquidity and receipts fit together.',
  lead:'The planned protocol needs both a trusted price path and a way to find the best eligible quote. These are separate jobs.',
  sections:[
   s('price','Price: relay the Robinhood Chain mark.',[
    'Several independent signers relay the underlying market’s Robinhood Chain mark to Robinhood Chain. A quorum means enough of those signers must agree; one key cannot set a price on its own. The design uses median aggregation, freshness limits and clamps on abrupt changes.',
    'An independently configured cross-check must agree within its allowed deviation when fresh. A missing, stale or disagreeing source prevents new opens on the affected market. The Robinhood Chain adaptation also needs sequencer availability and recovery checks.',
    'Robinhood Chain settlement does not create native access to Robinhood Chain’s Robinhood Chain native state. This version requires relayers and independently operated checks; it does not assume an Robinhood Chain precompile or cross-chain writer.'
   ]),
   s('vol','Volatility: another input to the option price.',[
    'Volatility describes the scale of price changes used by the model. The quorum posts it for each market and tempo. The design uses maker quotes and fills to tighten those values as independent liquidity develops.',
    'The same mark can produce different option prices at different volatilities. Strike, shape and tempo matter too. Volatility remains partly a model input; publishing it on-chain does not make it certain or predictive.'
   ]),
   s('fill','Fill: compare three sources.',[],{steps:[
    ['Signed maker quotes','A market maker signs volatility terms covering a range of strikes and tempos, with size and validity limits. The engine prices eligible trades from those terms.'],
    ['Users’ written offers','Writers offer positions backed by their required collateral. Their offers can compete for the same buy.'],
    ['The Mainspring pool','The pool is the proposed backstop. The engine chooses the cheapest eligible buy among these three sources, subject to limits and valid data.']
   ],note:['In this dashboard','Quote sources and depth are illustrations. No signed maker quote, executable writer order or live pool is connected.']}),
   s('receipts','Receipts: a record that can be checked.',[
    'The design groups trades, finalized volatility and pool NAV snapshots into an hourly Merkle root on Robinhood Chain. A Merkle root is a compact commitment to a batch of records. With a proof, someone can check that a particular record belongs to that batch.',
    'That proves inclusion, not that every input or valuation was correct. The receipt service and on-chain publication are planned components, not live features of the preview.'
   ]),
   s('controls','Who can change or pause the system?',[
    'The specification calls for a 3-of-5 Safe followed by a 48-hour timelock for administrative changes such as listings, caps, fees, signer sets and price routes. A separate 2-of-3 guardian can pause opens and deposits. It cannot use that pause power to stop sells.',
    'These are intended controls. Deployed addresses, signer operators, audits and operational procedures still need verification before a production launch.'
   ])
  ]
 },
 {
  id:'pool',label:'Mainspring & hedging',group:'BEHIND THE TRADE',title:'A pool behind the book.\nA risk book behind the pool.',summary:'The backstop, hedges, NAV and why a withdrawal is not an instant fixed-value redemption.',
  lead:'Mainspring is the planned liquidity pool that backs trades alongside independent writers and makers. Its value moves with the positions and hedges it carries.',
  sections:[
   s('nav','NAV is what the pool is worth after obligations.',[
    'NAV means net asset value. The design combines the pool’s settlement assets and hedge equity, then subtracts the marked value of what it owes on its option book. If that net value falls, the value represented by pool shares can fall with it.',
    'Depositors are exposed to the option book, hedge results, execution costs and operational failures. Funding and spread are part of the NAV accounting; nothing about a deposit is promised.'
   ]),
   s('hedge','Hedges address part of the market risk.',[
    'The proposed hedger trades Robinhood Chain liquidity to offset the book’s delta: its immediate sensitivity to a change in the underlying price. Volatility exposure, called vega, goes first to makers and writers, with a weekly risk auction in a later phase.',
    'Hedges can lag, cost money or fail during outages. They do not remove all risk. The Robinhood Chain design uses a separately operated, trade-only CEX API wallet, with treasury reconciliation between the two venues.',
    'USDG settlement on Robinhood Chain does not mean the exchange account that hedges BTC and ETH holds USDG. Its margin asset, transfers, custody and reconciliation are verified separately. Tokenized stocks are hedged on Robinhood Chain itself; there is no assumed atomic hedge between the chain and the exchange.'
   ]),
   s('withdrawals','Pool withdrawals are queued at NAV.',[
    'The pool specification separates requesting a withdrawal from receiving it. Requests enter a queue and are paid at NAV. Queue timing and the amount returned depend on the pool’s implemented accounting and available assets.',
    'The preview has no pool deposit or withdrawal integration. The brief’s risk controls can pause new opens; they do not establish immediate liquidity for every withdrawal or remove chain and bridge delays.'
   ],{links:[['fees','Read the pool fee'],['risks','Review pool and infrastructure risks']]})
  ]
 },
 {
  id:'fees',label:'Fees & costs',group:'BEHIND THE TRADE',title:'Read the costs\nas separate amounts.',summary:'Trading spread, notional fee, funding and network gas, with a worked calculation.',
  lead:'The entry price is only one part of holding an option. Trading fees apply when buying or selling; funding changes the position while it stays open.',
  sections:[
   s('trading-fee','The fee schedule in the brief.',[],{table:{headers:['Cost','Specified treatment'],rows:[
    ['Buy / sell spread','1.5–4% of the option price, with a 0.01 USDG minimum.'],['Underlying notional fee','An additional 3 basis points: 0.03% of underlying notional.'],['Funding','Paid in kind as units shrink. The actual accrual follows the recorded path.'],['Network gas','Paid in ETH on Robinhood Chain. Separate from the USDG option price and trading fee.']
   ]},note:['Preview assumption','The demo uses a 2% spread within the brief’s range. A production fee must come from the actual executable quote; the preview is not a published live tariff.']}),
   s('example','A 20 USDG premium on 1,000 USDG notional.',[
    'Suppose the option premium is 20 USDG and the underlying notional is 1,000 USDG. At the demo’s 2% spread, the spread amount is 0.40 USDG. The notional fee is 1,000 × 0.0003 = 0.30 USDG. Together, the displayed fee is 0.70 USDG and the opening total is 20.70 USDG.',
    'The 0.01 USDG minimum applies to the spread component. Funding during the holding period, the eventual sale fee and any network gas are additional. This example illustrates the calculation; it is not an available quote.'
   ],{formula:['20.00 premium','+ 0.70 fee','20.70 USDG']}),
   s('other-fees','Writers, makers and the pool.',[
    'Writers and makers receive the funding their buyers pay; 10% of that funding goes to protocol fees. For Mainspring, the brief allocates 10% of net funding and spread to protocol fees. Pool NAV can still fall.',
    'The proposed public volatility feed is free to read on-chain. Historical data and API access are a separate planned service billed in USDG; this preview does not sell access or publish an API price.'
   ]),
   s('allocation','Where protocol fees are intended to go.',[
    'The specified split is 80% to participants doing the work, 10% to the treasury, 5% to a later first-loss staking tranche and 5% to buy-and-burn. Working participants include writers, makers, keepers, hedgers and signers.',
    '$TRBN is planned for utility such as fee tiers, agent seats and first-loss staking. It is not presented as a claim on revenue. Neither the token nor its staking and fee distribution systems are implemented by this frontend.'
   ])
  ]
 },
 {
  id:'wallets',label:'Wallets & network',group:'BEHIND THE TRADE',title:'Connect in the browser\nyou actually use.',summary:'Desktop extension setup, explicit mobile links, network details and common connection problems.',
  lead:'On desktop, Connect wallet uses the MetaMask or Phantom extension installed in Chrome. Mobile is a separate choice in the wallet window.',
  sections:[
   s('desktop','Connect a Chrome extension.',[],{steps:[
    ['Open the site in Chrome','Enable your chosen wallet extension for this browser profile. A wallet installed in Chrome is not injected into an embedded preview browser.'],
    ['Choose Connect wallet → Browser extension','Select MetaMask or Phantom. When detected, the row says Extension detected. If both are installed, choose the one you intend to use.'],
    ['Finish the request in your wallet','Unlock it if necessary and review the account access request there. The site reads the approved public address and asks to switch to Robinhood Chain.'],
    ['Check the network state','The connected state confirms Robinhood Chain only after the provider reports the correct network. A rejected or incomplete switch leaves a separate network-switch action.']
   ]}),
   s('mobile','Use the wallet’s own mobile browser.',[
    'Choose Mobile app explicitly, then MetaMask or Phantom. The app link or QR opens the hosted site in that wallet’s browser. Tap Connect wallet there to connect the provider in that browser.',
    'This opens a separate mobile session; it does not pair a phone wallet to your desktop tab. The hosted preview currently requires its owner’s site access, including when opened on a phone.'
   ]),
   s('network','The network used by this preview.',[],{table:{headers:['Setting','Value'],rows:[['Network','Robinhood Chain mainnet'],['Chain ID','4663 (0x1237)'],['Gas currency','ETH'],['Planned option settlement','USDG'],['Public RPC','https://rpc.mainnet.chain.robinhood.com']]},sources:[['Network configuration (Robinhood Chain docs)','https://docs.robinhood.com/chain/connecting/'],['Phantom EVM network support','https://docs.phantom.com/ethereum-monad-testnet-base-and-polygon/getting-started']]}),
   s('troubleshooting','If the connection does not finish.',[],{table:{headers:['What you see','What to check'],rows:[
    ['Extension not available','Use Chrome with the extension enabled in the current profile. The desktop flow stays here instead of redirecting to mobile.'],['Waiting for your wallet','Look for an open permission request in the extension. Complete or reject that request before starting another.'],['Wrong network','Use Switch to Robinhood Chain. MetaMask can be asked to add the network if missing; Phantom needs a version that supports it.'],['Connection rejected','The request has ended. Reopen Connect wallet when you want to try again.'],['Disconnected here','The frontend has cleared its session. To revoke the wallet’s site permission too, remove the site from the wallet’s connected apps.']
   ]}}),
   s('permissions','What connecting authorizes here.',[
    'This implementation requests your public account and network. It does not request a message signature, token approval or transaction. Demo trades remain local even when a wallet is connected, and the site does not automatically reconnect after a reload.'
   ],{links:[['privacy','Read the data and privacy details']]})
  ]
 },
 {
  id:'risks',label:'Risks & availability',group:'REFERENCE',title:'Understand what\ncan still go wrong.',summary:'Buyer and writer losses, model and infrastructure risks, access restrictions and launch limits.',
  lead:'No expiry and exact collateral address specific parts of the design. They do not eliminate market loss, implementation failures or dependence on other systems.',
  sections:[
   s('position-risks','The position can lose value.',[],{table:{headers:['Participant','Loss to understand'],rows:[['Buyer','Can lose the full purchase amount. Funding shrinks units; market and volatility changes alter value. Fees and gas add costs.'],['Writer','Can lose the collateral committed to the written obligation. Funding received may not cover what the written obligation costs.'],['Pool depositor','NAV can fall because of the option book, hedge losses, costs or failures. Withdrawals are queued.'],['Future first-loss staker','The proposed tranche is intended to absorb losses. Staking and token functions remain planned.']]}}),
   s('systems','Collateral depends on the system enforcing it.',[
    'Exact collateral is a mathematical property of the specified payoff and its assumptions. Contract bugs, rounding, accounting errors or a collateral asset losing value can undermine the protection. Covered SPY also needs a verified valuation and redemption model.',
    'The signer quorum, mark router and volatility model are additional dependencies. Freshness checks and multiple operators reduce particular failure modes; they cannot prove that every accepted input is correct.',
    'Hedges can fail or arrive late. A chain sequencer, RPC, bridge or Robinhood Chain outage can affect access and execution. USDG introduces its own asset and transfer risks. The canonical Robinhood Chain withdrawal route to Ethereum includes a seven-day challenge period; that is separate from closing an option or requesting a pool withdrawal.'
   ],{sources:[['Robinhood Chain bridge documentation','https://docs.robinhood.com/chain/bridging/']]}),
   s('markets','24/7 markets still have opening limits.',[
    'New opens depend on valid marks, available liquidity and risk limits. The specification preserves sells during an administrative opening pause, using the last good sample when needed. No transaction executes while the underlying chain is unavailable.',
    'More tokenized stocks and crypto majors are later additions. Weekend tokenized stock marks are treated as band-capped estimates in the brief, with tighter caps on new opens. A tokenized stock mark is not a claim to own the underlying stock.'
   ]),
   s('eligibility','Availability has not been established by this preview.',[
    'The product brief excludes locations restricted by Robinhood Chain, explicitly including the US and Ontario, and places where options are restricted. A launch needs current eligibility checks and finalized terms. Connecting a wallet or viewing this preview does not establish that you are eligible to trade.',
    'The site does not establish a live protocol deployment, a completed audit, a pool with deposits, or any relationship with Robinhood or Robinhood Chain: Tourbillon is an independent project, and Robinhood Chain is used as a network only. It illustrates the proposed product and its current frontend behavior.'
   ],{links:[['roadmap','See the launch gates']]})
  ]
 },
 {
  id:'roadmap',label:'Status & rollout',group:'REFERENCE',title:'Planned in stages.\nGated by evidence.',summary:'What each phase adds and what must be verified before it can ship.',
  lead:'These are product stages, not release dates. The current website is a frontend preview; the backend brief’s module descriptions do not establish production deployment.',
  sections:[
   s('phases','What the rollout calls for.',[],{steps:[
    ['T0 · Core','Rise and Fall on BTC, ETH and SPY, path funding, quorum marks and Mainspring. Gate: Robinhood Chain fork tests, a core audit and three independent signer operators.'],
    ['T1 · Shapes and writing','Spreads, Swing, Band and bounded USDG writing. Gate: collateral fuzz tests showing that a written position cannot owe more than its collateral. Guard requires verified covered-SPY support separately.'],
    ['T2 · Oracle and hedge hardening','Independent mark checks, resilient relayers and a reconciled off-chain Robinhood Chain hedger. Gate: verified network adapters, staleness and sequencer tests, plus cross-chain treasury reconciliation.'],
    ['T3 · Open book and volatility feed','Signed maker quotes, best-of-three fills, a weekly risk auction and the public vol feed. Gate: two independent makers live.'],
    ['T4 · More markets and agents','The broader tokenized-stock shelf, owner-signed agent mandates and MCP access. Gate: the additional markets’ marks remain inside the quorum band for four weeks.']
   ]}),
   s('agents','An agent would have limits set by its owner.',[
    'The proposed mandate specifies allowed markets and shapes, premium caps, delta and vega budgets, an expiry and a close-only mode. An agent seat is not permission to trade without boundaries. Agent routing, mandates and MCP are not connected to this preview.'
   ]),
   s('current','A clear line between the demo and the protocol.',[
    'This frontend implements model illustrations, strategy construction, local demo positions and wallet connection. The original engineering brief describes additional modules as built, tested or specified in a separate kit. That kit’s test claims are not a fresh audit or proof that contracts are deployed on Robinhood Chain.',
    'Production requires verified contract addresses, settlement-asset configuration, independent services, executable liquidity, security review, operational procedures and eligibility controls. The network change also removed assumptions about Robinhood Chain’s native Robinhood Chain native access.'
   ],{links:[['overview','Return to what works today']]})
  ]
 },
 {
  id:'glossary',label:'Plain-language glossary',group:'REFERENCE',title:'The terms,\nwithout the shorthand.',summary:'Quick definitions for the terms used in the ticket, guides and backend design.',
  lead:'Use this as a reference while reading the guide. The examples in other chapters show how the terms work together.',
  sections:[
   s('position-terms','Your position.',[],{definitions:[
    ['Underlying / mark','The market the option refers to, and its accepted reference price. TOURBILLON’s specified reference is the Robinhood Chain mark.'],['Strike','The price level where an option’s payoff changes. A Rise pays above its strike; a Fall pays below.'],['Leg','One call or put within a strategy, with its own strike and long or short direction.'],['Premium','The amount paid for the option itself, before separately quoted fees.'],['Payoff','The amount described by a shape at a given underlying price. It is not the net result or necessarily the current sale price.'],['Time value','The part of option value above its current payoff. It affects the funding calculation.'],['Unit','A quantity of the option position. Funding reduces the units remaining.'],['Tempo','The decay pace, from one hour to thirty days. It is not an expiry date.'],['Movement','One position combining up to four weighted tempos.'],['Funding','The continuing cost paid in kind by the holder and received by the writer or liquidity source, subject to fees.'],['Notional','The underlying reference exposure used for calculations such as the notional fee. In the preview, mark × size.']
   ]}),
   s('risk-terms','Risk and liquidity.',[],{definitions:[
    ['Collateral','Assets locked to cover the obligation of a written position.'],['Naked short Rise','A written call without sufficient cover. Its obligation has no finite upper cash bound, so it is refused.'],['Volatility / vol','The scale of price variation used by the pricing model. It is an input, not a promise about future moves.'],['Delta','How sensitively a position’s value responds to a small change in the underlying price.'],['Vega','How sensitively a position’s value responds to a change in volatility.'],['Market maker','A participant quoting trade terms. In this design, makers sign volatility quotes for ranges of strikes and tempos.'],['Mainspring / NAV','The proposed pool, and its net asset value after accounting for assets, hedge equity and marked obligations.'],['Basis point / bp','One hundredth of a percentage point. Three basis points is 0.03%, or a multiplier of 0.0003.']
   ]}),
   s('network-terms','Network and records.',[],{definitions:[
    ['Signer quorum','A required number of independent signers whose submissions are combined before data is accepted.'],['Keeper','A service or participant that submits maintenance transactions, such as sampling or catching up funding.'],['Sequencer','The service ordering transactions on the layer-2 chain. Its availability matters to execution.'],['Merkle root','A compact commitment to a batch of records, used with proofs to verify inclusion.'],['Timelock','A required delay between scheduling an administrative change and applying it.'],['USDG / ETH','The planned option settlement denomination and the separate gas currency on Robinhood Chain.']
   ]})
  ]
 },
 {
  id:'privacy',label:'Demo privacy',group:'REFERENCE',title:'What this preview\nstores and requests.',summary:'Local positions, public wallet access, mobile sessions and the current privacy boundaries.',
  lead:'You can use the trading demo without connecting a wallet. Connecting and simulated trading are separate features.',
  sections:[
   s('local-data','Demo positions stay in this browser.',[
    'Demo positions are stored in local storage for this site and browser. They can remain after a reload. The dashboard provides a demo reset; clearing the site’s browser data also removes that local state.',
    'There is no account sync or backend position record connected. A different device, browser profile or site address has its own local state. This is why a phone opened through a wallet link does not inherit desktop demo positions.'
   ]),
   s('wallet-data','A connection shares public account information.',[
    'The wallet exposes the account address you approve and the active network to this frontend. The current session is held in memory. Reloading the site does not automatically request a new connection.',
    'The site does not request a seed phrase, private key, message signature, token approval or transaction. Your wallet controls its own permission prompts. Disconnecting here clears the frontend session; revoke the site in your wallet’s connected-app settings to remove its permission too.'
   ]),
   s('services','Other services can see connection metadata.',[
    'Hosting, wallet providers and the network RPC may process ordinary request metadata such as IP addresses. Mobile links open the hosted URL inside the selected wallet app. QR images are generated locally in the page, not by an external QR-image service.',
    'This preview includes no analytics, live market feed or email collection. It is not a complete production privacy policy. Production terms, retention rules and privacy disclosures must be completed for the services actually launched.'
   ],{links:[['wallets','Return to connection help']]})
  ]
 }
];
export const guideHref = id => '#/docs/' + id;
export function findGuideChapters(query) {
 const words=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
 return guideChapters.filter(chapter=>{const text=JSON.stringify(chapter).toLocaleLowerCase();return words.every(word=>text.includes(word))});
}
