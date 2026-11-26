// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Engine} from "../../src/Engine.sol";
import {EnginePricing} from "../../src/EnginePricing.sol";
import {MainspringPool, IEquityFeed} from "../../src/MainspringPool.sol";
import {PathFundingBook} from "../../src/PathFundingBook.sol";
import {QuorumBoard} from "../../src/QuorumBoard.sol";
import {TempoBlend} from "../../src/TempoBlend.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockMarks, MockVols} from "../Engine.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CoveringAssets, ICoverMarks} from "../../src/CoveringAssets.sol";
import {HedgeSwap} from "../../src/HedgeSwap.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {MockHedgeRouter} from "../mocks/MockHedgeRouter.sol";

/// Drives the whole M3 pool system with random sequences: LP deposits, withdrawal requests, cancels and claims; hourly
/// epochs, marking and settlement; buys and sells; price moves with samples; EQUITY posts; treasury sends out and back;
/// market pauses; on-chain stock hedge swaps (RH6, G7) through a router at the mark less a 0.3% fee. It owns every
/// contract and keeps ghost counters for the invariants. Every failed action is caught and classified.
contract PoolHandler is Test {
    bytes32 public constant BTC = "BTC";
    address public constant PROTO = address(0x9907);
    address public constant TREASURY = address(0x7EA5);
    uint256 public constant START = 50_000_000e6;
    uint256 public constant N_SERIES = 4;

    MockUSDC public settlement;
    MockMarks public marks;
    MockVols public vols;
    QuorumBoard public board;
    MainspringPool public pool;
    PathFundingBook public book;
    Engine public engine;
    bytes32 public constant STK1 = "STK1";
    MockStockToken public stock;
    MockHedgeRouter public router;
    uint256 public hedgesOk;
    uint256 public hedgeNavJumps; // a swap moved NAV by more than the venue's fee
    uint256 public coverageAfterHedge; // a hedge buy accepted that left coverage breached

    address[3] public lps = [address(0x1A1), address(0x1A2), address(0x1A3)];
    address[2] public traders = [address(0x7A1), address(0x7A2)];
    address[3] internal signers = [address(0x51), address(0x52), address(0x53)];
    uint256 public nowT = 1_794_182_400;
    uint256 public s = 70_000e18;
    uint256 internal equityRound;
    int256 public pnl; // the P&L the signers post for the pool's exchange account (settlement token, 6 decimals)

    uint128[N_SERIES] internal strikes = [70_000e18, 72_000e18, 68_000e18, 70_000e18];
    bool[N_SERIES] internal isCall = [true, true, false, false];
    uint256[N_SERIES] public ids;

    // ghosts
    mapping(address => uint256) public expectedSettlement; // LPs and traders: exact USDC balance
    uint256 public buysOk;
    uint256 public sellsOk;
    uint256 public settlesOk;
    uint256 public sellFailures; // law 3: never, except a true Insolvent
    uint256 public falseInsolvent; // Insolvent although available USDC could pay
    uint256 public priceMismatches; // law 5
    uint256 public coverageAfterBuy; // a buy accepted that left coverage breached
    uint256 public reserveAfterSettle; // withdrawals filled into the stressed reserve
    uint256 public unfairDeposits; // a depositor received more than deposited (at the round's NAV)
    uint256 public unfairWithdrawals; // a withdrawer received more than the shares were worth
    uint256 public unexpectedFailures; // any other refusal that should not happen
    bytes public lastError;
    mapping(uint256 => mapping(address => bool)) public claimed;

    constructor() {
        vm.warp(nowT);
        settlement = new MockUSDC();
        marks = new MockMarks();
        vols = new MockVols();
        address[] memory sg = new address[](3);
        (sg[0], sg[1], sg[2]) = (signers[0], signers[1], signers[2]);
        board = new QuorumBoard(address(this), sg, 2, 30);
        uint256 n = vm.getNonce(address(this));
        address bookAt = vm.computeCreateAddress(address(this), n + 1);
        address engineAt = vm.computeCreateAddress(address(this), n + 2);
        pool = new MainspringPool(
            address(this), settlement, PathFundingBook(bookAt), marks, vols, IEquityFeed(address(board)), PROTO
        );
        book = new PathFundingBook(engineAt, address(this), marks, vols);
        engine = new Engine(address(this), book, pool, marks, vols);
        require(address(book) == bookAt && address(engine) == engineAt, "prediction");
        pool.setEngine(address(engine));
        pool.listMarket(BTC, 2000);
        pool.setHedgerDeltaCap(BTC, 1e16);
        pool.setCaps(BTC, 1e15, 1e15);
        pool.setTreasury(TREASURY);
        pool.grantRole(pool.RISK_PAUSER_ROLE(), address(this));
        engine.setMarket(BTC, 100e18, 200);
        // RH6: a stock market for the on-chain hedge (no options on it here: the invariant is about USDC and NAV)
        stock = new MockStockToken("STK1", "STK1", 18);
        CoveringAssets covers = new CoveringAssets(address(this), ICoverMarks(address(marks)));
        covers.list(STK1, IERC20(address(stock)), new address[](0));
        pool.setCoverAssets(covers);
        marks.set(STK1, 40e18);
        router = new MockHedgeRouter(settlement, IERC20(address(stock)), 1, 40e18);
        router.set(40e18, 30, 0, false);
        pool.setHedge(address(router), 100, STK1, 100_000e18, 2_000_000e6);
        pool.grantRole(pool.HEDGER_ROLE(), address(this));
        board.setFeed(pool.equityKey(), 5000, 2 hours);
        marks.set(BTC, s);
        vols.set(BTC, 4500);
        book.record(BTC, s, 4500);
        for (uint256 i; i < 3; ++i) {
            _fund(lps[i], address(pool));
        }
        for (uint256 i; i < 2; ++i) {
            _fund(traders[i], address(engine));
        }
        vm.prank(TREASURY);
        settlement.approve(address(pool), type(uint256).max);
        for (uint256 i; i < N_SERIES; ++i) {
            ids[i] = book.idOf(BTC, isCall[i], strikes[i], TempoBlend.single(1 days));
        }
        // a first LP round so trading can start
        vm.prank(lps[0]);
        pool.deposit(5_000_000e6);
        expectedSettlement[lps[0]] -= 5_000_000e6;
        _epochAndSettle();
        _postEquity();
        _postEquity();
    }

    function _fund(address who, address spender) internal {
        settlement.mint(who, START);
        expectedSettlement[who] = START;
        vm.prank(who);
        settlement.approve(spender, type(uint256).max);
    }

    function _postEquity() internal {
        uint256 v = uint256(int256(pool.EQUITY_OFFSET()) + pnl * 1e12);
        bytes32 key = pool.equityKey();
        ++equityRound;
        for (uint256 i; i < 3; ++i) {
            vm.prank(signers[i]);
            board.vote(key, uint80(equityRound), v);
        }
    }

    function _epochAndSettle() internal {
        pool.startEpoch();
        while (!pool.markChunk(100)) {}
        uint256 r = pool.round();
        (uint256 deposits, uint256 wShares,,,,,,,,) = pool.rounds(r);
        uint256 stressed = pool.stressedLiability();
        pool.settle();
        settlesOk++;
        (,,,, uint256 minted, uint256 filled, uint256 paid,, uint256 nps,) = pool.rounds(r);
        if (paid > 0 && pool.available() + 1 < stressed) reserveAfterSettle++;
        // fairness at the round's price, checked per LP as they claim
        for (uint256 i; i < 3; ++i) {
            address lp = lps[i];
            uint256 d = pool.depositOf(r, lp);
            if (d > 0) {
                uint256 before = pool.balanceOf(lp);
                uint256 settlementBefore = settlement.balanceOf(lp);
                vm.prank(lp);
                pool.claimShares(r);
                uint256 got = pool.balanceOf(lp) - before;
                if (Math.mulDiv(got, nps, 1e18) > d) unfairDeposits++;
                expectedSettlement[lp] += settlement.balanceOf(lp) - settlementBefore; // a refunded round
            }
            uint256 w = pool.withdrawOf(r, lp);
            if (w > 0) {
                uint256 settlementBefore = settlement.balanceOf(lp);
                vm.prank(lp);
                pool.withdraw(r);
                uint256 gotSettlement = settlement.balanceOf(lp) - settlementBefore;
                if (gotSettlement > Math.mulDiv(w, nps + 1, 1e18)) unfairWithdrawals++;
                expectedSettlement[lp] += gotSettlement;
            }
        }
        deposits;
        wShares;
        minted;
        filled;
    }

    // ---------------------------------------------------------------- LP actions

    function lpDeposit(uint256 who, uint256 amt) external {
        address lp = lps[who % 3];
        amt = bound(amt, 1e6, 3_000_000e6);
        vm.prank(lp);
        pool.deposit(amt);
        expectedSettlement[lp] -= amt;
    }

    function lpRequestWithdraw(uint256 who, uint256 frac) external {
        address lp = lps[who % 3];
        uint256 sh = pool.balanceOf(lp) * bound(frac, 1, 100) / 100;
        if (sh == 0) return;
        vm.prank(lp);
        pool.requestWithdraw(sh);
    }

    function lpCancel(uint256 who, bool deposit) external {
        address lp = lps[who % 3];
        uint256 r = pool.round();
        if (deposit) {
            uint256 d = pool.depositOf(r, lp);
            if (d == 0) return;
            vm.prank(lp);
            pool.cancelDeposit();
            expectedSettlement[lp] += d;
        } else {
            if (pool.withdrawOf(r, lp) == 0) return;
            vm.prank(lp);
            pool.cancelWithdraw();
        }
    }

    /// An hour passes with a sample, EQUITY is reposted, and the round settles.
    function hour(uint256 moveSeed, int256 pnlSeed) external {
        nowT += 1 hours;
        vm.warp(nowT);
        s = s * (9_800 + bound(moveSeed, 0, 400)) / 10_000; // ±2%
        if (s < 40_000e18) s = 40_000e18;
        if (s > 110_000e18) s = 110_000e18;
        marks.set(BTC, s);
        book.record(BTC, s, 4500);
        pnl = bound(pnlSeed, -200_000e6, 200_000e6);
        _postEquity();
        try this.settleExternal() {}
        catch (bytes memory err) {
            unexpectedFailures++;
            lastError = err;
        }
    }

    function settleExternal() external {
        require(msg.sender == address(this));
        _epochAndSettle();
    }

    // ---------------------------------------------------------------- trading

    function buy(uint256 who, uint256 seriesSeed, uint256 units) external {
        address t = traders[who % 2];
        uint256 j = seriesSeed % N_SERIES;
        units = bound(units, 1e16, 5e18);
        uint256 v = EnginePricing.unitValue(isCall[j], s, strikes[j], 4500, TempoBlend.single(1 days));
        (uint256 premium, uint256 fee) = EnginePricing.buyQuote(v, units, s, 200);
        uint256 before = settlement.balanceOf(t);
        vm.prank(t);
        try engine.buy(BTC, isCall[j], strikes[j], TempoBlend.single(1 days), units, type(uint256).max, nowT) returns (
            uint256, uint256 cost
        ) {
            buysOk++;
            if (cost != premium + fee || before - settlement.balanceOf(t) != cost) priceMismatches++;
            if (pool.available() < pool.stressedLiability()) coverageAfterBuy++;
            expectedSettlement[t] -= cost;
        } catch (bytes memory err) {
            bytes4 sel = bytes4(err);
            // expected refusals: coverage, caps, pauses, strike band after a move, not caught up
            if (
                sel != MainspringPool.CoverageBreached.selector && sel != MainspringPool.MarketIsPaused.selector
                    && sel != MainspringPool.OpensArePaused.selector && sel != EnginePricing.StrikeOutOfBand.selector
                    && sel != Engine.NotCaughtUp.selector && sel != MainspringPool.DirectionalCapExceeded.selector
                    && sel != MainspringPool.NotionalCapExceeded.selector
            ) {
                unexpectedFailures++;
                lastError = err;
            }
        }
    }

    function sell(uint256 who, uint256 seriesSeed, bool all) external {
        address t = traders[who % 2];
        uint256 id = ids[seriesSeed % N_SERIES];
        if (!book.exists(id) || book.balanceOf(id, t) == 0) return;
        uint256 before = settlement.balanceOf(t);
        vm.prank(t);
        try engine.sell(id, all ? type(uint256).max : 5e17, 0, nowT) returns (uint256, uint256 net) {
            sellsOk++;
            if (settlement.balanceOf(t) - before != net) priceMismatches++;
            expectedSettlement[t] += net;
        } catch (bytes memory err) {
            if (bytes4(err) == MainspringPool.Insolvent.selector) {
                (uint256 needed, uint256 avail) = abi.decode(_args(err), (uint256, uint256));
                if (avail >= needed) falseInsolvent++;
            } else {
                sellFailures++;
                lastError = err;
            }
        }
    }

    function _args(bytes memory err) internal pure returns (bytes memory out) {
        out = new bytes(err.length - 4);
        for (uint256 i; i < out.length; ++i) {
            out[i] = err[i + 4];
        }
    }

    // ---------------------------------------------------------------- treasury and pauses

    function treasurySend(uint256 amt) external {
        if (!pool.equityReady()) return;
        uint256 free = pool.freeForWithdrawals();
        if (free == 0) return;
        amt = bound(amt, 1, free);
        try pool.sendToTreasury(amt) {}
        catch (bytes memory err) {
            if (bytes4(err) != MainspringPool.AboveDailyCap.selector) {
                unexpectedFailures++;
                lastError = err;
            }
        }
    }

    function treasuryReturn(uint256 amt) external {
        uint256 held = settlement.balanceOf(TREASURY);
        if (held == 0) return;
        amt = bound(amt, 1, held);
        vm.prank(TREASURY);
        pool.receiveFromTreasury(amt);
    }

    /// The keeper's swap at the mark (which moves within ±5%); the router fills at the mark less 0.3%.
    function hedge(bool buy, uint256 amt, uint256 moveSeed) external {
        uint256 px = 38e18 + (moveSeed % 5e18);
        marks.set(STK1, px);
        router.set(px, 30, 0, false);
        uint256 held = stock.balanceOf(address(pool));
        if (buy) amt = bound(amt, 10e6, 200_000e6);
        else {
            if (held == 0) return;
            amt = bound(amt, 1, held);
        }
        uint256 minOut = HedgeSwap.floorOut(buy, amt, px, 1, 100);
        if (minOut == 0) return;
        uint256 nav0 = pool.navNow();
        try pool.hedgeSwap(STK1, buy, amt, minOut) returns (uint256 out) {
            hedgesOk++;
            if (buy && pool.available() < pool.stressedLiability()) coverageAfterHedge++;
            // the fee: 0.3% of the settlement side, plus rounding. Up to five base units: the router floors its
            // conversion and its fee, this estimate floors once, and the pool's stock value floors before and after
            // (found by the 100,000-call run: a 79,000-unit sale was 3 base units past a +2 allowance)
            uint256 settlementSide = buy ? amt : out;
            uint256 fee = settlementSide * 30 / 9970 + 5;
            uint256 nav1 = pool.navNow();
            if (nav1 + fee < nav0 || nav1 > nav0 + 2) hedgeNavJumps++;
        } catch (bytes memory err) {
            bytes4 sel = bytes4(err);
            if (
                sel != MainspringPool.AboveFree.selector && sel != HedgeSwap.DailyCapExceeded.selector
                    && sel != HedgeSwap.InventoryCapExceeded.selector
            ) {
                unexpectedFailures++;
                lastError = err;
            }
        }
    }

    function togglePause() external {
        if (pool.marketPaused(BTC)) pool.unpauseMarket(BTC);
        else pool.pauseMarket(BTC);
    }

    function resumeIfPaused() external {
        if (pool.opensPaused()) pool.resumeOpens();
    }

    function lp(uint256 i) external view returns (address) {
        return lps[i];
    }

    function trader(uint256 i) external view returns (address) {
        return traders[i];
    }

    function series(uint256 i) external view returns (uint256) {
        return ids[i];
    }
}

/// The pool's accounting and the laws, checked after every random call.
/// forge-config: default.invariant.runs = 48
/// forge-config: default.invariant.depth = 60
/// forge-config: deep.invariant.runs = 1000
/// forge-config: deep.invariant.depth = 100
/// forge-config: default.invariant.fail-on-revert = true
/// forge-config: deep.invariant.fail-on-revert = true
contract PoolInvariantTest is Test {
    PoolHandler h;

    function setUp() public {
        h = new PoolHandler();
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](11);
        sel[0] = PoolHandler.lpDeposit.selector;
        sel[1] = PoolHandler.lpRequestWithdraw.selector;
        sel[2] = PoolHandler.lpCancel.selector;
        sel[3] = PoolHandler.hour.selector;
        sel[4] = PoolHandler.buy.selector;
        sel[5] = PoolHandler.sell.selector;
        sel[6] = PoolHandler.treasurySend.selector;
        sel[7] = PoolHandler.treasuryReturn.selector;
        sel[8] = PoolHandler.togglePause.selector;
        sel[9] = PoolHandler.resumeIfPaused.selector;
        sel[10] = PoolHandler.hedge.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    /// The Engine never holds money.
    function invariant_engineHoldsNothing() public view {
        assertEq(h.settlement().balanceOf(address(h.engine())), 0);
    }

    /// USDC is conserved: LPs, traders, the pool, the protocol and the treasury hold all of it.
    function invariant_settlementConserved() public view {
        uint256 sum = h.settlement().balanceOf(address(h.pool())) + h.settlement().balanceOf(h.PROTO())
            + h.settlement().balanceOf(h.TREASURY()) + h.settlement().balanceOf(address(h.router()));
        for (uint256 i; i < 3; ++i) {
            sum += h.settlement().balanceOf(h.lp(i));
        }
        for (uint256 i; i < 2; ++i) {
            sum += h.settlement().balanceOf(h.trader(i));
        }
        assertEq(sum, h.settlement().totalSupply());
    }

    /// Law 1 and the LP side: every LP and trader holds exactly what the ghost ledger says.
    function invariant_exactBalances() public view {
        for (uint256 i; i < 3; ++i) {
            assertEq(h.settlement().balanceOf(h.lp(i)), h.expectedSettlement(h.lp(i)), "LP balance");
        }
        for (uint256 i; i < 2; ++i) {
            assertEq(h.settlement().balanceOf(h.trader(i)), h.expectedSettlement(h.trader(i)), "trader balance");
        }
    }

    /// Money set aside is always held: queued deposits and owed USDC never exceed the pool's balance.
    function invariant_setAsideIsHeld() public view {
        assertGe(h.settlement().balanceOf(address(h.pool())), h.pool().queuedDeposits() + h.pool().owed());
    }

    /// Shares add up: total supply = LPs' shares + the pool's own (escrowed and unclaimed).
    function invariant_sharesAddUp() public view {
        uint256 sum = h.pool().balanceOf(address(h.pool()));
        for (uint256 i; i < 3; ++i) {
            sum += h.pool().balanceOf(h.lp(i));
        }
        assertEq(sum, h.pool().totalSupply());
    }

    /// Law 3: every sell of a real holding succeeded, unless the pool truly could not pay (Insolvent with available <
    /// needed, the documented residual risk); pauses never stop a sell.
    function invariant_sellsAlwaysWork() public view {
        assertEq(h.sellFailures(), 0, string(h.lastError()));
        assertEq(h.falseInsolvent(), 0);
    }

    /// Law 5 and coverage: buys priced exactly at the source; no accepted buy left coverage breached; withdrawals
    /// never filled into the stressed reserve.
    function invariant_pricingCoverageAndReserve() public view {
        assertEq(h.priceMismatches(), 0);
        assertEq(h.coverageAfterBuy(), 0);
        assertEq(h.reserveAfterSettle(), 0);
    }

    /// Settlement is fair: no depositor received shares worth more than the deposit, no withdrawer more than the
    /// shares were worth, at the round's NAV per share.
    function invariant_settlementFair() public view {
        assertEq(h.unfairDeposits(), 0);
        assertEq(h.unfairWithdrawals(), 0);
    }

    /// Book, registry and notional agree: the pool's raw per series = what traders hold; a series is in the open list
    /// exactly when raw > 0; open notional = the sum of the series.
    function invariant_bookRegistryNotionalAgree() public view {
        uint256[] memory open = h.pool().openSeries(h.BTC());
        uint256 notional;
        for (uint256 i; i < h.N_SERIES(); ++i) {
            uint256 id = h.series(i);
            uint256 held = h.book().balanceOf(id, h.trader(0)) + h.book().balanceOf(id, h.trader(1));
            assertEq(h.pool().seriesRaw(id), held);
            bool listed;
            for (uint256 k; k < open.length; ++k) {
                if (open[k] == id) listed = true;
            }
            assertEq(listed, held > 0, "open list matches raw");
            notional += h.pool().seriesNotional(id);
        }
        assertEq(h.pool().openNotional(h.BTC()), notional);
    }

    /// RH6 (G7): a hedge swap moves NAV by the venue's fee only (the stock counts at the router mark), and a hedge buy
    /// never leaves available USDC below the stressed liability (sells first, law 3).
    function invariant_hedgeKeepsNavAndCoverage() public view {
        assertEq(h.hedgeNavJumps(), 0, "NAV moved by more than the fee");
        assertEq(h.coverageAfterHedge(), 0, "a hedge buy breached coverage");
    }

    /// Nothing else ever failed unexpectedly.
    function invariant_noUnexpectedFailure() public view {
        assertEq(h.unexpectedFailures(), 0, string(h.lastError()));
    }

    /// Coverage: the paths the invariants rely on are exercised.
    function test_handlerCoversEveryPath() public {
        h.buy(0, 0, 2e18);
        h.buy(1, 2, 1e18);
        h.lpDeposit(1, 1_000_000e6);
        h.lpRequestWithdraw(0, 10);
        h.treasurySend(100_000e6);
        h.togglePause(); // paused
        h.buy(0, 1, 1e18); // refused: paused
        h.sell(0, 0, false); // sell while paused
        h.togglePause();
        h.hour(200, 50_000e6); // settle: deposit and withdrawal processed, claims
        h.treasuryReturn(50_000e6);
        h.sell(1, 2, true);
        h.hour(300, -100_000e6);
        h.hedge(true, 50_000e6, 1e18);
        h.hedge(false, 1e30, 3e18); // sells everything held
        h.buy(0, 0, 1e18);
        h.sell(0, 0, true);
        assertGe(h.hedgesOk(), 2);
        assertGe(h.buysOk(), 2);
        assertGe(h.sellsOk(), 2);
        assertGe(h.settlesOk(), 3);
        assertEq(h.unexpectedFailures() + h.sellFailures() + h.priceMismatches(), 0, string(h.lastError()));
        invariant_settlementConserved();
        invariant_exactBalances();
        invariant_sharesAddUp();
        invariant_bookRegistryNotionalAgree();
    }
}
