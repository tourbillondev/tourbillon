// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MainspringPool, IEquityFeed} from "../src/MainspringPool.sol";
import {Engine} from "../src/Engine.sol";
import {EnginePricing} from "../src/EnginePricing.sol";
import {PathFundingBook, IMarkRouter, IVolSource} from "../src/PathFundingBook.sol";
import {TempoBlend} from "../src/TempoBlend.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockMarks, MockVols} from "./Engine.t.sol";
import {QuorumBoard} from "../src/QuorumBoard.sol";

/// Shared setup: mock mark/vol, a real book and Engine, a real QuorumBoard as the EQUITY feed.
abstract contract MainspringPoolBase is Test {
    uint256 constant T0 = 1_794_182_400;
    bytes32 constant BTC = "BTC";
    bytes32 constant ETH = "ETH";
    address constant PROTO = address(0x9907);
    address constant A = address(0xA);
    address constant B = address(0xB);
    address constant TRADER = address(0x7A);
    address constant ATTACKER = address(0xBAD);
    uint256 constant ALL = type(uint256).max;

    MockUSDC usdc;
    MockMarks marks;
    MockVols vols;
    MainspringPool pool;
    PathFundingBook book;
    Engine engine;
    QuorumBoard board; // the EQUITY feed (a real board: 3 signers, 50% step clamp, 2 h heartbeat)
    address constant S1 = address(0x51);
    address constant S2 = address(0x52);
    address constant S3 = address(0x53);
    address constant TREASURY = address(0x7EA5);
    uint256 equityRound;
    uint256 nowT;

    function _set(uint256 t) internal {
        nowT = t;
        vm.warp(t);
    }

    function setUp() public virtual {
        _set(T0);
        usdc = new MockUSDC();
        marks = new MockMarks();
        vols = new MockVols();
        address[] memory sg = new address[](3);
        (sg[0], sg[1], sg[2]) = (S1, S2, S3);
        board = new QuorumBoard(address(this), sg, 2, 30);
        // pool → book → engine, each address predicted for the one before
        uint256 n = vm.getNonce(address(this));
        address bookAt = vm.computeCreateAddress(address(this), n + 1);
        address engineAt = vm.computeCreateAddress(address(this), n + 2);
        pool = new MainspringPool(
            address(this), usdc, PathFundingBook(bookAt), marks, vols, IEquityFeed(address(board)), PROTO
        );
        book = new PathFundingBook(engineAt, address(this), marks, vols);
        engine = new Engine(address(this), book, pool, marks, vols);
        assertEq(address(book), bookAt);
        assertEq(address(engine), engineAt);
        pool.setEngine(address(engine));
        board.setFeed(pool.equityKey(), 5000, 2 hours);
        pool.listMarket(BTC, 2000);
        pool.listMarket(ETH, 2500);
        // caps high enough not to bind in these tests (the risk tests set their own); the hedger delta cap first
        pool.setHedgerDeltaCap(BTC, 1e16);
        pool.setHedgerDeltaCap(ETH, 1e16);
        pool.setCaps(BTC, 1e15, 1e15);
        pool.setCaps(ETH, 1e15, 1e15);
        engine.setMarket(BTC, 100e18, 200);
        engine.setMarket(ETH, 5e18, 200);
        marks.set(BTC, 70_000e18);
        vols.set(BTC, 4500);
        marks.set(ETH, 2_000e18);
        vols.set(ETH, 6000);
        book.record(BTC, 70_000e18, 4500);
        book.record(ETH, 2_000e18, 6000);
        for (uint256 i; i < 4; ++i) {
            address who = [A, B, TRADER, ATTACKER][i];
            usdc.mint(who, 100_000_000e6);
            vm.startPrank(who);
            usdc.approve(address(pool), type(uint256).max);
            usdc.approve(address(engine), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _epochAndSettle() internal {
        pool.startEpoch();
        while (!pool.markChunk(100)) {}
        pool.settle();
    }

    function _lp(address who, uint256 assets) internal {
        vm.prank(who);
        pool.deposit(assets);
    }

    function _buy(bytes32 m, bool isCall, uint128 k, uint256 units) internal returns (uint256 id, uint256 cost) {
        vm.prank(TRADER);
        return engine.buy(m, isCall, k, TempoBlend.single(1 days), units, ALL, nowT);
    }

    function _sell(uint256 id, uint256 units) internal returns (uint256 net) {
        vm.prank(TRADER);
        (, net) = engine.sell(id, units, 0, nowT);
    }

    /// One LP round of `assets` at T0, settled, so the pool has capital.
    function _seed(uint256 assets) internal {
        _lp(A, assets);
        _epochAndSettle();
        vm.prank(A);
        pool.claimShares(0);
    }

    /// The three signers post a P&L-only EQUITY value (signed USDC, 6 decimals) with the fixed offset.
    function _postEquity(int256 pnlUsdc) internal {
        uint256 v = uint256(int256(pool.EQUITY_OFFSET()) + pnlUsdc * 1e12);
        bytes32 key = pool.equityKey();
        ++equityRound;
        vm.prank(S1);
        board.vote(key, uint80(equityRound), v);
        vm.prank(S2);
        board.vote(key, uint80(equityRound), v);
        vm.prank(S3);
        board.vote(key, uint80(equityRound), v);
    }
}

contract MainspringPoolTest is MainspringPoolBase {
    // ---------------------------------------------------------------- shares and rounds

    function test_firstRoundMintsAtPar() public {
        _lp(A, 1_000_000e6);
        assertEq(pool.queuedDeposits(), 1_000_000e6);
        assertEq(pool.navNow(), 0, "queued deposits are not in NAV");
        _epochAndSettle();
        (,,,, uint256 minted,,, uint256 nav, uint256 nps,) = pool.rounds(0);
        assertEq(minted, 1_000_000e6 * 1e12, "par: 1 USDC = 1e18 shares (virtual offset)");
        assertEq(nav, 1_000_000e6);
        assertEq(nps, 1e6, "NAV per share at par: 1 USDC per 1e18 shares");
        vm.prank(A);
        pool.claimShares(0);
        assertEq(pool.balanceOf(A), 1_000_000e18);
        assertEq(pool.queuedDeposits(), 0);
        assertEq(pool.round(), 1);
    }

    function test_feesSplitNinetyTen() public {
        _seed(1_000_000e6);
        uint256 poolBefore = usdc.balanceOf(address(pool));
        (uint256 id, uint256 cost) = _buy(BTC, true, 70_000e18, 1e18);
        uint256 v = EnginePricing.unitValue(true, 70_000e18, 70_000e18, 4500, TempoBlend.single(1 days));
        (uint256 premium, uint256 fee) = EnginePricing.buyQuote(v, 1e18, 70_000e18, 200);
        assertEq(cost, premium + fee);
        assertEq(usdc.balanceOf(PROTO), fee / 10, "10% of the buy fee to protocol");
        assertEq(usdc.balanceOf(address(pool)), poolBefore + premium + fee - fee / 10);

        uint256 protoBefore = usdc.balanceOf(PROTO);
        uint256 traderBefore = usdc.balanceOf(TRADER);
        (uint256 gross, uint256 sellFee) = EnginePricing.sellQuote(v, 1e18, 70_000e18, 200);
        uint256 net = _sell(id, ALL);
        assertEq(net, gross - sellFee);
        assertEq(usdc.balanceOf(TRADER) - traderBefore, net);
        assertEq(usdc.balanceOf(PROTO) - protoBefore, sellFee / 10, "10% of the sell fee to protocol");
        assertEq(usdc.balanceOf(address(engine)), 0);
    }

    /// Two LPs over several rounds while trading moves NAV: nobody entering or leaving is favoured by rounding.
    function testFuzz_shareMathNeverFavoursEntryOrExit(uint256 d1, uint256 d2, uint256 move, uint256 wFrac) public {
        d1 = bound(d1, 1e6, 5_000_000e6);
        d2 = bound(d2, 1e6, 5_000_000e6);
        move = bound(move, 9000, 11_000); // mark ±10%
        wFrac = bound(wFrac, 1, 10_000);
        _seed(10_000_000e6);
        (uint256 id,) = _buy(BTC, true, 70_000e18, 5e18);
        _set(nowT + 1 hours);
        marks.set(BTC, 70_000e18 * move / 10_000);
        book.record(BTC, 70_000e18 * move / 10_000, 4500);
        _lp(B, d1);
        _epochAndSettle();
        (,,,,,,,, uint256 nps,) = pool.rounds(1);
        vm.prank(B);
        pool.claimShares(1);
        uint256 sharesB = pool.balanceOf(B);
        assertLe(Math.mulDiv(sharesB, nps, 1e18), d1, "a depositor never gets more than they put in");

        // B withdraws part, A deposits more, after another hour
        _sell(id, 1e18);
        _set(nowT + 1 hours);
        uint256 w = sharesB * wFrac / 10_000;
        if (w == 0) w = 1;
        vm.prank(B);
        pool.requestWithdraw(w);
        _lp(A, d2);
        _epochAndSettle();
        (,,,,,, uint256 paid,, uint256 nps2,) = pool.rounds(2);
        assertLe(paid, Math.mulDiv(w, nps2 + 1, 1e18), "a withdrawer never gets more than the shares are worth");
        vm.prank(B);
        pool.withdraw(2);
        vm.prank(A);
        pool.claimShares(2);
        assertLe(Math.mulDiv(pool.balanceOf(A) - 10_000_000e18, nps2, 1e18), d2);
        assertGe(usdc.balanceOf(address(pool)), pool.owed(), "owed USDC is always held");
    }

    /// The classic first-depositor attack (deposit 1 unit, donate to inflate the price) cannot take a later
    /// depositor's money.
    function test_donationCannotSkewTheSharePrice() public {
        _lp(ATTACKER, 1);
        _epochAndSettle();
        vm.prank(ATTACKER);
        pool.claimShares(0);
        vm.prank(ATTACKER);
        usdc.transfer(address(pool), 1_000_000e6); // donation
        _set(nowT + 1 hours);
        _lp(A, 1_000_000e6);
        _epochAndSettle();
        vm.prank(A);
        pool.claimShares(1);
        uint256 nav = pool.navNow();
        uint256 supply = pool.totalSupply();
        uint256 aValue = Math.mulDiv(pool.balanceOf(A), nav + 1, supply + 1e12);
        uint256 attackerValue = Math.mulDiv(pool.balanceOf(ATTACKER), nav + 1, supply + 1e12);
        assertGe(aValue, 1_000_000e6 * 999 / 1000, "the later depositor keeps at least 99.9%");
        assertLt(attackerValue, 1_000_000e6, "the attacker loses most of the donation");
    }

    // ---------------------------------------------------------------- what NAV and sells may use

    function test_queuedAndOwedAreNeitherNavNorSellMoney() public {
        _seed(200_000e6);
        (uint256 id,) = _buy(BTC, true, 70_000e18, 2e18);
        marks.set(BTC, 210_000e18); // the call is now worth far more than the pool's own USDC
        _lp(B, 10_000_000e6); // queued: not the pool's money yet
        uint256 avail = pool.available();
        vm.prank(TRADER);
        vm.expectRevert(); // Insolvent: queued deposits are not used to pay sells
        engine.sell(id, ALL, 0, nowT);
        assertEq(pool.available(), avail);
        assertEq(pool.queuedDeposits(), 10_000_000e6);
    }

    function test_withdrawalsWaitBehindStressedLiabilityProRata() public {
        _lp(A, 1_000_000e6);
        _lp(B, 1_000_000e6);
        _epochAndSettle();
        vm.prank(A);
        pool.claimShares(0);
        vm.prank(B);
        pool.claimShares(0);
        _buy(BTC, true, 70_000e18, 20e18); // stressed liability takes a good part of the pool
        uint256 free = pool.freeForWithdrawals();
        assertLt(free, pool.available());
        _set(nowT + 1 hours);
        uint256 shA = pool.balanceOf(A); // read first: a call in the arguments would take the prank
        vm.prank(A);
        pool.requestWithdraw(shA);
        uint256 shB = pool.balanceOf(B); // read first: a call in the arguments would take the prank
        vm.prank(B);
        pool.requestWithdraw(shB);
        pool.startEpoch();
        while (!pool.markChunk(100)) {}
        uint256 freeAtSettle = pool.freeForWithdrawals(); // after the new epoch, as settle sees it
        pool.settle();
        (,,,,, uint256 filled, uint256 paid,,,) = pool.rounds(1);
        assertLt(filled, 2_000_000e18, "only part of the request is filled");
        assertLe(paid, freeAtSettle);
        vm.prank(A);
        pool.withdraw(1);
        vm.prank(B);
        pool.withdraw(1);
        assertEq(pool.balanceOf(A), pool.balanceOf(B), "pro rata: the same unfilled shares back to each");
        assertGt(pool.balanceOf(A), 0);
        assertApproxEqAbs(usdc.balanceOf(A), usdc.balanceOf(B), 1);
        assertGe(pool.available(), pool.stressedLiability(), "sells stay covered after withdrawals");
    }

    function test_navNotPositiveRefundsDepositsAndFillsNoWithdrawal() public {
        _seed(300_000e6); // covers the stressed liability of the buy below (coverage rule)
        _buy(BTC, true, 70_000e18, 10e18);
        _set(nowT + 1 hours);
        marks.set(BTC, 130_000e18); // +86%, far beyond the stress band: liability now above the pool's USDC
        book.record(BTC, 130_000e18, 4500);
        _lp(B, 50_000e6);
        uint256 shA = pool.balanceOf(A); // read first: a call in the arguments would take the prank
        vm.prank(A);
        pool.requestWithdraw(shA);
        _epochAndSettle();
        (,, bool settled, bool refunded,, uint256 filled,,,,) = pool.rounds(1);
        assertTrue(settled && refunded);
        assertEq(filled, 0);
        uint256 before = usdc.balanceOf(B);
        vm.prank(B);
        pool.claimShares(1);
        assertEq(usdc.balanceOf(B) - before, 50_000e6, "deposit refunded in full");
        vm.prank(A);
        pool.withdraw(1);
        assertEq(pool.balanceOf(A), 300_000e18, "shares returned");
    }

    function test_cancelClaimOnceAndTiming() public {
        _lp(A, 1_000e6);
        vm.prank(A);
        pool.cancelDeposit();
        assertEq(pool.queuedDeposits(), 0);
        vm.prank(A);
        vm.expectRevert(MainspringPool.NothingQueued.selector);
        pool.cancelDeposit();

        _lp(A, 1_000e6);
        vm.expectRevert(MainspringPool.NothingToSettle.selector); // no finalized epoch yet
        pool.settle();
        vm.prank(A);
        vm.expectRevert(abi.encodeWithSelector(MainspringPool.RoundNotSettled.selector, 0));
        pool.claimShares(0);
        pool.startEpoch();
        vm.expectRevert(MainspringPool.NothingToSettle.selector); // while marking
        pool.settle();
        while (!pool.markChunk(100)) {}
        pool.settle();
        vm.expectRevert(MainspringPool.NothingToSettle.selector); // once per epoch
        pool.settle();
        vm.prank(A);
        pool.claimShares(0);
        vm.prank(A);
        vm.expectRevert(MainspringPool.NothingQueued.selector);
        pool.claimShares(0);

        vm.prank(A);
        pool.requestWithdraw(500e18);
        vm.prank(A);
        pool.cancelWithdraw();
        assertEq(pool.balanceOf(A), 1_000e18);
    }

    function test_epochTimesForTheKeeper() public {
        (uint64 start0, uint64 final0) = pool.epochTimes();
        assertEq(start0, 0);
        assertEq(final0, 0);
        pool.startEpoch();
        (uint64 start1,) = pool.epochTimes();
        assertEq(start1, nowT);
        _set(nowT + 5);
        while (!pool.markChunk(100)) {}
        (, uint64 final1) = pool.epochTimes();
        assertEq(final1, nowT);
    }

    function test_protocolFeeBounds() public {
        vm.expectRevert(abi.encodeWithSelector(MainspringPool.FeeTooHigh.selector, 2001));
        pool.setProtocolFee(2001, PROTO);
        pool.setProtocolFee(2000, PROTO);
        assertEq(pool.protocolFeeBps(), 2000);
    }

    // ---------------------------------------------------------------- NAV is accurate across sells

    /// Sells between the epoch and settlement give the same NAV per share as settling right after a fresh epoch that
    /// already saw those sells (same block, same S and σ): neither depositors nor those staying are favoured.
    function test_sellsBeforeSettlementGiveTheSameNavAsAFreshEpoch() public {
        _seed(5_000_000e6);
        _set(nowT + 1 hours);
        (uint256 c1,) = _buy(BTC, true, 70_000e18, 10e18);
        (uint256 p1,) = _buy(BTC, false, 68_000e18, 8e18);
        (uint256 e1,) = _buy(ETH, true, 2_100e18, 50e18);
        _lp(B, 1_000_000e6);
        uint256 snap = vm.snapshotState();

        // X: epoch first, then the sells, then settle
        pool.startEpoch();
        while (!pool.markChunk(100)) {}
        _sell(c1, 4e18);
        _sell(e1, ALL);
        _sell(p1, 1e18);
        pool.settle();
        (,,,,,,, uint256 navX, uint256 npsX,) = pool.rounds(1);

        // Y: the same sells first, then a fresh epoch, then settle
        vm.revertToState(snap);
        _sell(c1, 4e18);
        _sell(e1, ALL);
        _sell(p1, 1e18);
        pool.startEpoch();
        while (!pool.markChunk(100)) {}
        pool.settle();
        (,,,,,,, uint256 navY, uint256 npsY,) = pool.rounds(1);

        assertApproxEqAbs(npsX, npsY, 2, "same NAV per share within rounding");
        assertApproxEqAbs(navX, navY, 10, "same NAV within rounding (micro-USDC)");
    }

    /// The conservative stressed bound is not lowered by sells before the next epoch; the NAV base is.
    function test_sellsLowerNavBaseAtOnceButNotTheStressedBound() public {
        _seed(5_000_000e6);
        (uint256 id,) = _buy(BTC, true, 70_000e18, 10e18);
        _set(nowT + 1 hours);
        pool.startEpoch();
        while (!pool.markChunk(100)) {}
        uint256 baseBefore = pool.navBase(BTC);
        uint256 stressedBefore = pool.liveStressed(BTC);
        _sell(id, 5e18);
        assertLt(pool.navBase(BTC), baseBefore);
        assertEq(pool.liveStressed(BTC), stressedBefore);
    }

    /// Several withdrawers in one partially filled round can all claim: the USDC paid and the shares returned never
    /// add up to more than the round set aside.
    function testFuzz_partialFillClaimsAddUp(uint256 seed, uint256 units) public {
        units = bound(units, 5e18, 25e18);
        address[5] memory lps = [address(0x101), address(0x102), address(0x103), address(0x104), address(0x105)];
        for (uint256 i; i < 5; ++i) {
            usdc.mint(lps[i], 10_000_000e6);
            vm.prank(lps[i]);
            usdc.approve(address(pool), type(uint256).max);
            _lp(lps[i], bound(uint256(keccak256(abi.encode(seed, i))), 200_000e6, 1_000_000e6));
        }
        _epochAndSettle();
        for (uint256 i; i < 5; ++i) {
            vm.prank(lps[i]);
            pool.claimShares(0);
        }
        _buy(BTC, true, 70_000e18, units); // stressed liability limits the withdrawals
        _set(nowT + 1 hours);
        for (uint256 i; i < 5; ++i) {
            uint256 sh = pool.balanceOf(lps[i]);
            uint256 part = sh * (1 + uint256(keccak256(abi.encode(seed, i, "w"))) % 100) / 100;
            if (part == 0) continue;
            vm.prank(lps[i]);
            pool.requestWithdraw(part);
        }
        _epochAndSettle();
        uint256 owedBefore = pool.owed();
        for (uint256 i; i < 5; ++i) {
            if (pool.withdrawOf(1, lps[i]) == 0) continue;
            vm.prank(lps[i]);
            pool.withdraw(1);
        }
        assertLe(owedBefore - pool.owed(), owedBefore);
        assertGe(usdc.balanceOf(address(pool)), pool.owed() + pool.queuedDeposits());
    }

    // ---------------------------------------------------------------- EQUITY and treasury

    function test_equityCountsZeroUntilTwoFinalsAndWhenStale() public {
        _seed(1_000_000e6);
        assertEq(pool.equityTerm(), 0, "no final");
        _postEquity(100_000e6);
        assertEq(pool.equityTerm(), 0, "one final: still 0");
        assertFalse(pool.equityReady());
        _set(nowT + 1 hours);
        _postEquity(100_000e6);
        assertEq(pool.equityTerm(), 95_000e6, "two finals: a gain counts at 95%");
        assertTrue(pool.equityReady());
        _set(nowT + 2 hours - 1);
        assertEq(pool.equityTerm(), 95_000e6, "under 2 h old: counts");
        _set(nowT + 1);
        assertEq(pool.equityTerm(), 0, "2 h old: 0");
        assertFalse(pool.equityReady());
    }

    function test_pnlDropShowsWithinOneRound() public {
        _seed(1_000_000e6);
        _postEquity(100_000e6);
        _set(nowT + 1 hours);
        _postEquity(100_000e6);
        uint256 navBefore = pool.navNow();
        _set(nowT + 1 hours);
        _postEquity(60_000e6); // 40% drop
        assertEq(pool.equityTerm(), 57_000e6, "the drop counts at once (the lower of the two)");
        assertEq(navBefore - pool.navNow(), 38_000e6);
    }

    function test_pnlGainShowsOnlyAfterTheNextRound() public {
        _seed(1_000_000e6);
        _postEquity(100_000e6);
        _set(nowT + 1 hours);
        _postEquity(100_000e6);
        _set(nowT + 1 hours);
        _postEquity(140_000e6); // 40% gain
        assertEq(pool.equityTerm(), 95_000e6, "the gain does not count yet");
        _set(nowT + 1 hours);
        _postEquity(140_000e6);
        assertEq(pool.equityTerm(), 133_000e6, "after the next round it does");
    }

    function test_negativePnlCountsInFullAndFloorsAtZero() public {
        _seed(1_000_000e6);
        pool.setTreasury(TREASURY);
        _postEquity(0);
        _set(nowT + 1 hours);
        _postEquity(0);
        pool.sendToTreasury(100_000e6);
        _set(nowT + 1 hours);
        _postEquity(-30_000e6);
        assertEq(pool.equityTerm(), 70_000e6, "100,000 at par minus the 30,000 loss in full");
        _set(nowT + 1 hours);
        _postEquity(-150_000e6); // more lost than was sent: floored at 0
        assertEq(pool.equityTerm(), 0);
    }

    /// Capital in transit or on HyperCore counts at par: a send, a landing and a return each leave NAV exactly
    /// unchanged.
    function test_navAcrossSendLandingAndReturn() public {
        _seed(1_000_000e6);
        pool.setTreasury(TREASURY);
        _postEquity(0);
        _set(nowT + 1 hours);
        _postEquity(0);
        uint256 nav0 = pool.navNow();

        pool.sendToTreasury(100_000e6);
        assertEq(pool.navNow(), nav0, "send: NAV unchanged");

        // landing on Hyperliquid: account value +100,000 and deposits credited +100,000, so the P&L-only EQUITY
        // the signers post is unchanged
        _set(nowT + 1 hours);
        _postEquity(0);
        assertEq(pool.navNow(), nav0, "landing: NAV unchanged");

        // return: withdrawn from Hyperliquid and received back by the pool
        vm.prank(TREASURY);
        usdc.approve(address(pool), 100_000e6);
        pool.receiveFromTreasury(100_000e6);
        assertEq(pool.navNow(), nav0, "return: NAV unchanged");
        _set(nowT + 1 hours);
        _postEquity(0); // withdrawals sent home +100,000 balance the account value −100,000
        assertEq(pool.navNow(), nav0, "after the next EQUITY round: still unchanged");
    }

    function test_treasuryLimitsAndEvents() public {
        _seed(1_000_000e6);
        vm.expectRevert(MainspringPool.NoTreasury.selector);
        pool.sendToTreasury(1);
        pool.setTreasury(TREASURY);
        _postEquity(0);
        _set(nowT + 1 hours);
        _postEquity(0);

        // non-admin refused
        vm.prank(ATTACKER);
        vm.expectRevert();
        pool.sendToTreasury(1);

        // the daily cap: 20% of NAV (NAV is unchanged by sends, so 200,000 today)
        uint256 nav = pool.navNow();
        vm.expectEmit(true, false, false, true, address(pool));
        emit MainspringPool.TreasurySent(TREASURY, 150_000e6, 150_000e6, 150_000e6, nav);
        pool.sendToTreasury(150_000e6);
        vm.expectRevert(abi.encodeWithSelector(MainspringPool.AboveDailyCap.selector, 60_000e6, 50_000e6));
        pool.sendToTreasury(60_000e6);
        pool.sendToTreasury(50_000e6);
        assertEq(pool.sentOut(), 200_000e6);
        assertEq(usdc.balanceOf(TREASURY), 200_000e6);
        // the next UTC day has a fresh allowance (once EQUITY is fresh again)
        _set(nowT + 1 days);
        _postEquity(0);
        _set(nowT + 1 hours);
        _postEquity(0);
        pool.sendToTreasury(10_000e6);

        // only free USDC above the stressed liability
        _buy(BTC, true, 70_000e18, 10e18);
        uint256 free = pool.freeForWithdrawals();
        pool.setTreasuryDailyCap(10_000);
        vm.expectRevert(abi.encodeWithSelector(MainspringPool.AboveFree.selector, free + 1, free));
        pool.sendToTreasury(free + 1);

        // returns: treasury or admin only, with an event
        vm.prank(TREASURY);
        usdc.approve(address(pool), type(uint256).max);
        vm.prank(ATTACKER);
        vm.expectRevert(MainspringPool.NotTreasury.selector);
        pool.receiveFromTreasury(1);
        vm.expectEmit(true, false, false, true, address(pool));
        emit MainspringPool.TreasuryReturned(TREASURY, 50_000e6, 50_000e6);
        vm.prank(TREASURY);
        pool.receiveFromTreasury(50_000e6);
        assertEq(pool.receivedBack(), 50_000e6);
        vm.expectRevert(abi.encodeWithSelector(MainspringPool.CapTooHigh.selector, 10_001));
        pool.setTreasuryDailyCap(10_001);
    }

    /// A send needs two EQUITY finals with the latest under 2 h old, so transit money is never uncounted.
    function test_sendRequiresFreshEquity() public {
        _seed(1_000_000e6);
        pool.setTreasury(TREASURY);
        vm.expectRevert(MainspringPool.EquityNotReady.selector);
        pool.sendToTreasury(1_000e6); // no final
        _postEquity(0);
        vm.expectRevert(MainspringPool.EquityNotReady.selector);
        pool.sendToTreasury(1_000e6); // one final
        _set(nowT + 1 hours);
        _postEquity(0);
        pool.sendToTreasury(1_000e6); // two finals, fresh
        _set(nowT + 2 hours - 1);
        pool.sendToTreasury(1_000e6); // just under 2 h
        _set(nowT + 1);
        vm.expectRevert(MainspringPool.EquityNotReady.selector);
        pool.sendToTreasury(1_000e6); // 2 h old
        assertEq(pool.sentOut(), 2_000e6);
    }
}
