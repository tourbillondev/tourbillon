// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {WriterBookBase} from "./WriterBook.t.sol";
import {MainspringPool} from "../src/MainspringPool.sol";
import {EnginePricing} from "../src/EnginePricing.sol";
import {TempoBlend} from "../src/TempoBlend.sol";
import {StrategyMath} from "../src/StrategyMath.sol";

/// M4 step 7b: the pool counts written shapes (NAV at value; coverage 0; the directional cap includes them) and its
/// WHYPE (NAV at the HYPE mark × 95%; coverage and withdrawals 0).
contract WriterPoolTest is WriterBookBase {
    function _cut(uint256 fee) internal view returns (uint256) {
        return fee * pool.protocolFeeBps() / 10_000;
    }

    /// The buyer's side of the written spread: the same series.
    function _bSpread() internal pure returns (StrategyMath.Leg[] memory) {
        return _l2(_leg(true, 70_000e18, 1e18), _leg(true, 75_000e18, -1e18));
    }

    function _buySpread(uint256 units) internal returns (uint256 id) {
        vm.prank(TRADER);
        (id,) = engine.buyShape(BTC, _bSpread(), _day(), units, ALL, nowT);
    }

    // ---------------------------------------------------------------- 1. a write adds to NAV only the fee share

    /// Owner's test: right after a write, NAV changes only by the pool's share of the fee (the spread around the
    /// value), never by minus the credit: the pool pays the credit and holds a shape worth the same.
    function test_aWriteChangesNavOnlyByThePoolsShareOfTheFee() public {
        // a written call spread: the pool pays a positive credit
        uint256 nav0 = pool.navNow();
        (int256 credit, uint256 fee) = _expectedCredit(BTC, _wSpread(), S, SIG, 3e18);
        assertGt(credit, int256(1_000e6), "a real credit");
        _write(W, BTC, _wSpread(), 3e18, false);
        int256 d = int256(pool.navNow()) - int256(nav0);
        assertApproxEqAbs(d, int256(fee - _cut(fee)), 1, "only the pool's share of the fee");
        assertGt(d, 0);

        // a covered HYPE Rise
        nav0 = pool.navNow();
        (, fee) = _expectedCredit(HYPE, _wCovered(), H, HSIG, 20e18);
        _write(W, HYPE, _wCovered(), 20e18, true);
        d = int256(pool.navNow()) - int256(nav0);
        assertApproxEqAbs(d, int256(fee - _cut(fee)), 1);

        // a Guard written for a net debit: the pool receives the debit and holds a shape worth less than 0
        marks.set(HYPE, 36e18);
        nav0 = pool.navNow();
        (credit, fee) = _expectedCredit(HYPE, _wGuard(), 36e18, HSIG, 10e18);
        assertLt(credit, 0);
        _write(W, HYPE, _wGuard(), 10e18, true);
        d = int256(pool.navNow()) - int256(nav0);
        assertApproxEqAbs(d, int256(fee - _cut(fee)), 1);
        assertLt(pool.writtenNavBase(HYPE), int256(0), "the Guard's pool side is worth less than 0 here");
    }

    // ---------------------------------------------------------------- 2. unwrites

    function test_anUnwriteChangesNavOnlyByThePoolsShareOfTheFee() public {
        (uint256 wid,) = _write(W, BTC, _wSpread(), 3e18, false);
        uint256 nav0 = pool.navNow();
        vm.prank(W);
        (uint256 paid, int256 cost) = wb.unwrite(wid, type(uint256).max, type(int256).max, nowT);
        int256 v = EnginePricing.shapeValue(_neg(_wSpread()), S, SIG, _day(), true);
        (, uint256 fee) = EnginePricing.shapeUnwriteQuote(v, paid, _neg(_wSpread()), S, 200);
        int256 d = int256(pool.navNow()) - int256(nav0);
        // the pool receives the ask and gives up the shape at its value: the fee share, plus at most a couple of
        // units from rounding the ask up and the shape's value down
        assertGe(d, int256(fee - _cut(fee)));
        assertLe(d, int256(fee - _cut(fee)) + 2);
        assertGt(cost, 0);
        assertEq(pool.writtenNavBase(BTC) / 1e12, 0, "nothing written left (wei-level rounding only)");
    }

    /// A covered writer's buyback paid in WHYPE: NAV counts the WHYPE at the mark × 95%, so it changes by the fee share
    /// less 5% of the buyback.
    function test_aBuybackPaidInWhypeCountsAtNinetyFivePercent() public {
        usdc.mint(BROKE, 100e6); // a 1-day covered Rise this far out is a small net debit at the write
        (uint256 wid,) = _write(BROKE, HYPE, _wCovered(), 10e18, true);
        // an hour later HYPE is at 55; an epoch marks the written shape there
        _set(nowT + 1 hours);
        marks.set(HYPE, 55e18);
        book.record(HYPE, 55e18, HSIG);
        pool.startEpoch();
        while (!pool.markChunk(50)) {}
        uint256 nav0 = pool.navNow();
        uint256 poolWhype0 = whype.balanceOf(address(pool));
        vm.prank(BROKE);
        (uint256 paid, int256 cost) = wb.unwrite(wid, type(uint256).max, type(int256).max, nowT);
        uint256 got = whype.balanceOf(address(pool)) - poolWhype0;
        assertGt(got, 0, "paid in WHYPE");
        assertEq(pool.whypeTerm(), Math.mulDiv(got, 55e18 * 9500, 1e18 * 10_000) / 1e12);
        int256 v = EnginePricing.shapeValue(_neg(_wCovered()), 55e18, HSIG, _day(), true);
        (, uint256 fee) = EnginePricing.shapeUnwriteQuote(v, paid, _neg(_wCovered()), 55e18, 200);
        int256 d = int256(pool.navNow()) - int256(nav0);
        int256 expected = int256(fee - _cut(fee)) - cost * 5 / 100;
        assertApproxEqAbs(d, expected, 3);
    }

    // ---------------------------------------------------------------- 3. WHYPE in NAV, never in coverage

    function test_whypeCountsInNavAtNinetyFivePercentAndNeverInCoverage() public {
        uint256 nav0 = pool.navNow();
        uint256 avail0 = pool.available();
        uint256 free0 = pool.freeForWithdrawals();
        uint256 stressed0 = pool.stressedLiability();
        whype.mint(address(pool), 10e18);
        assertEq(pool.whypeTerm(), 380e6, "10 x 40 x 95%");
        assertEq(pool.navNow(), nav0 + 380e6);
        assertEq(pool.available(), avail0, "not USDC: no help to sells");
        assertEq(pool.freeForWithdrawals(), free0, "nor to withdrawals");
        assertEq(pool.stressedLiability(), stressed0);
        // a stale mark: WHYPE counts 0 until it is fresh again
        marks.setStale(true);
        assertEq(pool.whypeTerm(), 0);
        marks.setStale(false);
        // set once
        vm.expectRevert(MainspringPool.WhypeAlreadySet.selector);
        pool.setWhype(whype, HYPE);
    }

    // ---------------------------------------------------------------- 4. bought and written in one series

    function test_aSeriesWithBoughtAndWrittenRaw() public {
        uint256 stressed0 = pool.stressedLiability();
        uint256 id = _buySpread(5e18);
        uint256 stressedAfterBuy = pool.stressedLiability();
        assertGt(stressedAfterBuy, stressed0);
        (uint256 wid,) = _write(W, BTC, _wSpread(), 5e18, false);
        assertEq(book.idOfShape(BTC, _neg(_wSpread()), _day()), id, "the writer's pool side is the buyer's shape");
        assertEq(pool.openSeries(BTC).length, 1);
        assertEq(pool.seriesRaw(id), 5e18);
        assertEq(pool.writtenRaw(id), 5e18);
        // coverage counts the write 0: the stressed liability is exactly what the buy made it
        assertEq(pool.stressedLiability(), stressedAfterBuy);
        // NAV: what the pool owes the buyer and what it holds from the writer net to about zero
        int256 net = int256(pool.navBase(BTC)) - pool.writtenNavBase(BTC);
        assertGe(net, 0);
        assertLe(net, 1e13, "a wei-level rounding difference");

        // an hour later, an epoch marks both sides at the same units
        _set(nowT + 1 hours);
        pool.startEpoch();
        while (!pool.markChunk(1)) {}
        net = int256(pool.navBase(BTC)) - pool.writtenNavBase(BTC);
        assertGe(net, 0);
        assertLe(net, 1e13);

        // the buyer sells everything: the series stays open for the write; law 3 holds with writes present
        vm.prank(TRADER);
        (, uint256 netOut) = engine.sell(id, ALL, 0, nowT);
        assertGt(netOut, 0);
        assertEq(pool.seriesRaw(id), 0);
        assertEq(pool.openSeries(BTC).length, 1);
        // the writer closes: the series leaves the registry
        vm.prank(W);
        wb.unwrite(wid, type(uint256).max, type(int256).max, nowT);
        assertEq(pool.writtenRaw(id), 0);
        assertEq(pool.openSeries(BTC).length, 0);
    }

    // ---------------------------------------------------------------- 5. the directional cap includes writes

    function test_directionalCapIncludesWrites() public {
        uint256 id = _buySpread(5e18);
        uint256 dirBought = pool.directional(BTC);
        assertGt(dirBought, 0);
        // the offsetting write brings directional exposure to about zero; allowed even under a tight cap
        pool.setCaps(BTC, 1e15, 1e6);
        _write(W, BTC, _wSpread(), 5e18, false);
        assertLe(pool.directional(BTC), 1, "offset");
        assertEq(pool.writtenRaw(id), 5e18);
        // a further write is one-sided again: refused above the cap
        vm.prank(W);
        vm.expectPartialRevert(MainspringPool.DirectionalCapExceeded.selector);
        wb.write(BTC, _wSpread(), _day(), 5e18, false, type(int256).min, nowT);
    }

    // ---------------------------------------------------------------- 6. marking with writes, in chunks

    function test_markingWrittenSeriesInChunks() public {
        _buySpread(2e18);
        _write(W, BTC, _wSpread(), 3e18, false);
        _write(W, BTC, _wBand(), 2e18, false);
        uint256 idS = book.idOfShape(BTC, _neg(_wSpread()), _day());
        uint256 idB = book.idOfShape(BTC, _neg(_wBand()), _day());
        _set(nowT + 1 hours);
        marks.set(BTC, 71_000e18);
        // expected: each written series at floor(written raw × norm now), valued down at the new mark
        int256 expected;
        uint256[2] memory ids = [idS, idB];
        StrategyMath.Leg[][2] memory shapes = [_neg(_wSpread()), _neg(_wBand())];
        for (uint256 i; i < 2; ++i) {
            uint256 u = Math.mulDiv(pool.writtenRaw(ids[i]), book.normNow(ids[i]), 1e18);
            int256 v = EnginePricing.shapeValue(shapes[i], 71_000e18, SIG, _day(), false);
            expected += v >= 0
                ? int256(Math.mulDiv(u, uint256(v), 1e18))
                : -int256(Math.mulDiv(u, uint256(-v), 1e18, Math.Rounding.Ceil));
        }
        pool.startEpoch();
        while (!pool.markChunk(1)) {}
        assertEq(pool.writtenNavBase(BTC), expected);
        assertEq(pool.openSeries(BTC).length, 2);
    }
}
