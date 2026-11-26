# Invariants

What must always hold, and the test that checks it. Stateful invariant suites drive random sequences of every action
against the real contracts and check after every call. Every push runs them at a shorter depth (`forge test`); the
playbook's depth, **100,000 calls per suite**, runs with the `deep` profile, weekly in CI and before every release:

    cd contracts && FOUNDRY_PROFILE=deep forge test --match-path 'test/invariant/*'

Fuzz tests run 1,000 inputs each (fixed seed). Paths below are under `contracts/test/`.

## The six laws

### 1. A buyer never loses more than they paid. No margin, no liquidation.
| Check | Test |
|---|---|
| No buyer ever ends below what it paid, across random buys, sells, price moves and pauses | [`invariant/EngineInvariant.t.sol`](../contracts/test/invariant/EngineInvariant.t.sol) `invariant_buyersLoseOnlyWhatTheyPaid` |
| An immediate round trip never gives back more than was paid | [`EngineSell.t.sol`](../contracts/test/EngineSell.t.sol) `testFuzz_immediateRoundTripNeverProfits` |
| A shape round trip loses at most what was paid | [`EngineShapes.t.sol`](../contracts/test/EngineShapes.t.sol) `testFuzz_shapeRoundTripLosesAtMostWhatWasPaid` |
| A routed round trip (pool, maker or offer) loses at most what was paid | [`OpenBook.t.sol`](../contracts/test/OpenBook.t.sol) `testFuzz_routedRoundTripLosesAtMostWhatWasPaid` |
| An owner whose agent trades loses at most what was paid | [`AgentRouter.t.sol`](../contracts/test/AgentRouter.t.sol) `testFuzz_law1OwnerLosesAtMostWhatWasPaid` |
| Rounding always favours the counterparty | [`EnginePricing.t.sol`](../contracts/test/EnginePricing.t.sol) `testFuzz_roundingFavoursTheCounterparty`, `testFuzz_roundTripNeverReturnsMoreThanPaid`; [`ShapePricing.t.sol`](../contracts/test/ShapePricing.t.sol) `testFuzz_roundingFavoursTheCounterparty` |

### 2. No price without a fresh, cross-checked mark. If none, opens on that market close.
| Check | Test |
|---|---|
| No buy goes through without a fresh mark and vol | [`invariant/EngineInvariant.t.sol`](../contracts/test/invariant/EngineInvariant.t.sol) `invariant_noBuyWithoutFreshMarkAndVol` |
| The router refuses a stale, disagreeing or missing route; the native source passes the chain's values through | [`MarkSources.t.sol`](../contracts/test/MarkSources.t.sol) (all), `testFuzz_nativeSourcePassesTheChainsValuesThrough` |
| A stock mark outside the session always stays inside its band | [`QuorumBoardSession.t.sol`](../contracts/test/QuorumBoardSession.t.sol) `testFuzz_outOfSessionAlwaysInsideTheBand` |
| No hedge swap without a fresh mark | [`WriterPool.t.sol`](../contracts/test/WriterPool.t.sol) `test_hedgeRefusals` |

### 3. Sells always work. Pauses stop new opens only.
| Check | Test |
|---|---|
| Every sell of a real holding succeeds, through pauses, price moves and LP rounds | [`invariant/EngineInvariant.t.sol`](../contracts/test/invariant/EngineInvariant.t.sol) `invariant_sellsAlwaysWork`; [`invariant/PoolInvariant.t.sol`](../contracts/test/invariant/PoolInvariant.t.sol) `invariant_sellsAlwaysWork`; [`invariant/OpenBookInvariant.t.sol`](../contracts/test/invariant/OpenBookInvariant.t.sol) `invariant_sellsAlwaysWorkAndNoUnexpectedFailure` |
| Any sell is payable within the stress band | [`MainspringPoolRisk.t.sol`](../contracts/test/MainspringPoolRisk.t.sol) `testFuzz_everySellPayableWithinTheStressBand`; [`EngineSell.t.sol`](../contracts/test/EngineSell.t.sol) `testFuzz_sellAlwaysWorks` |
| Writers can always close; the obligation only shrinks | [`invariant/WriterInvariant.t.sol`](../contracts/test/invariant/WriterInvariant.t.sol) `invariant_obligationShrinksAndEveryoneCanClose` |
| A hedge buy never spends the settlement token that pays sells, nor money set aside | [`invariant/PoolInvariant.t.sol`](../contracts/test/invariant/PoolInvariant.t.sol) `invariant_hedgeKeepsNavAndCoverage`, `invariant_setAsideIsHeld`; [`WriterPool.t.sol`](../contracts/test/WriterPool.t.sol) `test_aHedgeBuyNeverSpendsTheSettlementThatPaysSells` |
| A frozen covering token never blocks a sell or a close: kept owed, opens on that market pause | [`WriterBook.t.sol`](../contracts/test/WriterBook.t.sol) `test_aFrozenCoverAtUnwriteIsOwedPausesOpensAndSettlesLater`; [`MatchBook.t.sol`](../contracts/test/MatchBook.t.sol) `test_aFrozenCoverAtABuybackIsOwedPausesOpensAndSettlesLater` |

### 4. Every writer's collateral covers the exact worst case of what they sold.
| Check | Test |
|---|---|
| Locked collateral covers the exact worst case of every write, at every step | [`invariant/WriterInvariant.t.sol`](../contracts/test/invariant/WriterInvariant.t.sol) `invariant_law4LockedCoversTheExactWorstCase`, `invariant_noWriteOwesMoreThanItsCollateral` |
| Every matched maker entry covers its worst case | [`invariant/OpenBookInvariant.t.sol`](../contracts/test/invariant/OpenBookInvariant.t.sol) `invariant_law4EveryMatchedEntryCoversItsWorstCase`; [`MatchBook.t.sol`](../contracts/test/MatchBook.t.sol) `testFuzz_lockedCoversTheWorstCaseAndEverythingAddsUp` |
| No shape of up to four legs owes more than its collateral | [`StrategyQuote.t.sol`](../contracts/test/StrategyQuote.t.sol) `testFuzz_fourLegsNeverOweMoreThanCollateral`; [`WriterCollateralFuzz.t.sol`](../contracts/test/WriterCollateralFuzz.t.sol) `testFuzz_noWrittenPositionOwesMoreThanItsCollateral`; [`kit/StrategyQuote.t.sol`](../contracts/test/kit/StrategyQuote.t.sol) `testFuzz_value_never_exceeds_collateral` |
| Cover in a tokenized stock is exact for any token decimals | [`CoveringAssets.t.sol`](../contracts/test/CoveringAssets.t.sol) `testFuzz_scaleForAnyDecimals`; [`WriterBook.t.sol`](../contracts/test/WriterBook.t.sol) `test_aSixDecimalStockCoversExactlyInItsOwnUnits` |

### 5. Funding follows the recorded price path. No caller supplies a price.
| Check | Test |
|---|---|
| Funding never runs backwards; every price comes from the sources | [`invariant/EngineInvariant.t.sol`](../contracts/test/invariant/EngineInvariant.t.sol) `invariant_fundingNeverRunsBackwards`, `invariant_pricesComeFromTheSources` |
| The funding factor never rises; one leg is today's rate exactly; mirror and linearity | [`ShapeFunding.t.sol`](../contracts/test/ShapeFunding.t.sol) `testFuzz_factorNeverRises`, `testFuzz_oneLegIsTodaysRateExactly`, `testFuzz_mirrorAndLinearity` |
| Every charge prices at the router's mark | [`Engine.t.sol`](../contracts/test/Engine.t.sol) `testFuzz_chargeIsAlwaysPricingAtTheRouterMark` |
| The pool's liability marking is exact and independent of chunk size | [`PoolLiability.t.sol`](../contracts/test/PoolLiability.t.sol) `testFuzz_exactAndChunkIndependent` |

### 6. No single key can set a price, a vol or an admin action.
| Check | Test |
|---|---|
| After the handover no externally owned account holds an admin role (rebuilt from every grant and revoke) | [`DeployM7.t.sol`](../contracts/test/DeployM7.t.sol) `test_law6RoleSweepFromEveryGrantAndRevoke` |
| Every listed admin action goes only through the timelock, after the delay | [`DeployM7.t.sol`](../contracts/test/DeployM7.t.sol) `test_everyListedAdminActionOnlyThroughTheTimelockAfterTheDelay` |
| The guardian only pauses; the Safe unpauses directly | [`DeployM7.t.sol`](../contracts/test/DeployM7.t.sol) `test_guardianPausesOnlyAndTheSafeUnpausesDirectly` |
| The hedge keeper never chooses a price (the floor at the router mark) | [`WriterPool.t.sol`](../contracts/test/WriterPool.t.sol) `test_hedgeRefusals`, `testFuzz_hedgeFloorAtTheMark` |
| The pool's keeper role sits on the gate, never a key; the guardian freezes it at once, only the Safe unfreezes, the key changes only through the timelock; the limits hold through it | [`DeployM7.t.sol`](../contracts/test/DeployM7.t.sol) `test_hedgeGateFreezeAndKeyThroughGovernance`; [`WriterPool.t.sol`](../contracts/test/WriterPool.t.sol) `test_theGateFreezesAndRefuses`, `test_theSwapLimitsHoldThroughTheGate`, `test_hedgeThroughTheGate` |
| On the whole running system: no key holds an admin role | the local end-to-end run, criterion 1 (`services/poker/scripts/local-m7-run.ts`) |

## Accounting

| Invariant | Test |
|---|---|
| The Engine never holds money | [`invariant/EngineInvariant.t.sol`](../contracts/test/invariant/EngineInvariant.t.sol) `invariant_engineHoldsNothing`; [`invariant/PoolInvariant.t.sol`](../contracts/test/invariant/PoolInvariant.t.sol) `invariant_engineHoldsNothing` |
| The settlement token is conserved: every holder adds up to the supply | `invariant_settlementIsConserved` (Engine), `invariant_settlementConserved` (Pool), `invariant_moneyIsConservedAndHeldWhereItBelongs` (OpenBook) |
| Every LP and trader holds exactly what the ghost ledger says | [`invariant/PoolInvariant.t.sol`](../contracts/test/invariant/PoolInvariant.t.sol) `invariant_exactBalances` |
| Money set aside (queued deposits, owed withdrawals) is always held | `invariant_setAsideIsHeld` (Pool) |
| Shares add up; settlement never favours entry or exit | `invariant_sharesAddUp`, `invariant_settlementFair` (Pool); [`MainspringPool.t.sol`](../contracts/test/MainspringPool.t.sol) `testFuzz_shareMathNeverFavoursEntryOrExit`, `testFuzz_partialFillClaimsAddUp` |
| Book, registry and notional agree | `invariant_bookRegistryNotionalAgree` (Pool), `invariant_bookPoolAndActorsAgree` (Engine), `invariant_accountingAgrees` (Writer) |
| The pool mirrors the match book; nothing is uncovered | `invariant_poolMirrorsTheMatchBookAndNothingIsUncovered` (OpenBook) |
| The writer book holds exactly what is locked plus what is owed | `invariant_writerBookHoldsExactlyWhatIsLocked` (Writer) |
| A hedge swap moves NAV by the venue's fee only | `invariant_hedgeKeepsNavAndCoverage` (Pool) |
| Agent budgets, caps and books hold | [`invariant/AgentInvariant.t.sol`](../contracts/test/invariant/AgentInvariant.t.sol) `invariant_budgetsCapsAndBooksHold` |
| Maker vault balances always add up | [`MakerVault.t.sol`](../contracts/test/MakerVault.t.sol) `testFuzz_balancesAlwaysAddUp` |

## Depth on record

Last deep run: 2026-11-25, `FOUNDRY_PROFILE=deep`, every suite 1,000 runs × 100 calls = 100,000 calls, 0 reverts,
every invariant passing.

| Suite | Calls | Time |
|---|---|---|
| `EngineInvariant` | 100,000 | 235 s |
| `OpenBookInvariant` | 100,000 | 250 s |
| `PoolInvariant` | 100,000 | 225 s |
| `AgentInvariant` | 100,000 | 333 s |
| `WriterInvariant` | 100,000 | 646 s |

The first deep run found that the pool suite's own allowance for rounding in a hedge swap's NAV check was too tight (a
79,000-unit sale was 3 base units past it); the contracts were right and the allowance is now 5 base units, with the
reason in the test.
