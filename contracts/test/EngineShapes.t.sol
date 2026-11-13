// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MainspringPoolBase} from "./MainspringPool.t.sol";
import {MainspringPool} from "../src/MainspringPool.sol";
import {Engine} from "../src/Engine.sol";
import {EnginePricing} from "../src/EnginePricing.sol";
import {PathFundingBook} from "../src/PathFundingBook.sol";
import {TempoBlend} from "../src/TempoBlend.sol";
import {StrategyMath} from "../src/StrategyMath.sol";
import {MockMarks, MockVols} from "./Engine.t.sol";

/// M4 step 6: shape buys and sells through the Engine, valued by the pool.
contract EngineShapesTest is MainspringPoolBase {
    uint256 constant S = 70_000e18;
    uint256 constant SIG = 4500;

    // ---------------------------------------------------------------- helpers

    function _leg(bool isCall, uint256 k, int256 q) internal pure returns (StrategyMath.Leg memory) {
        return StrategyMath.Leg(isCall, uint128(k), int128(q));
    }

    function _spread() internal pure returns (StrategyMath.Leg[] memory l) {
        l = new StrategyMath.Leg[](2);
        l[0] = _leg(true, 70_000e18, 1e18);
        l[1] = _leg(true, 75_000e18, -1e18);
    }

    function _swing() internal pure returns (StrategyMath.Leg[] memory l) {
        l = new StrategyMath.Leg[](2);
        l[0] = _leg(false, 70_000e18, 1e18);
        l[1] = _leg(true, 70_000e18, 1e18);
    }

    function _condor() internal pure returns (StrategyMath.Leg[] memory l) {
        l = new StrategyMath.Leg[](4);
        l[0] = _leg(true, 65_000e18, 1e18);
        l[1] = _leg(true, 70_000e18, -1e18);
        l[2] = _leg(true, 75_000e18, -1e18);
        l[3] = _leg(true, 80_000e18, 1e18);
    }

    function _day() internal pure returns (TempoBlend.Part[] memory) {
        return TempoBlend.single(1 days);
    }

    function _buyShape(StrategyMath.Leg[] memory legs, uint256 units) internal returns (uint256 id, uint256 cost) {
        vm.prank(TRADER);
        return engine.buyShape(BTC, legs, _day(), units, ALL, nowT);
    }

    /// Value of `units` at (s, σ), rounded up: what PoolLiability adds.
    function _val(StrategyMath.Leg[] memory legs, uint256 s, uint256 sig, uint256 units)
        internal
        pure
        returns (uint256)
    {
        int256 v = EnginePricing.shapeValue(legs, s, sig, TempoBlend.single(1 days), true);
        return v > 0 ? Math.mulDiv(units, uint256(v), 1e18, Math.Rounding.Ceil) : 0;
    }

    function _stressedSig() internal pure returns (uint256) {
        uint256 s = Math.mulDiv(SIG, 15_000, 10_000, Math.Rounding.Ceil);
        return s > 50_000 ? 50_000 : s;
    }

    // ---------------------------------------------------------------- 1. buys

    function test_shapeBuysPayTheQuoteAndMint() public {
        _seed(5_000_000e6);
        StrategyMath.Leg[][3] memory shapes = [_spread(), _swing(), _condor()];
        uint256[3] memory units = [uint256(2e18), 0.5e18, 3e18];
        for (uint256 i; i < 3; ++i) {
            int256 v = EnginePricing.shapeValue(shapes[i], S, SIG, _day(), true);
            (uint256 premium, uint256 fee) = EnginePricing.shapeBuyQuote(v, units[i], shapes[i], S, 200);
            uint256 traderBefore = usdc.balanceOf(TRADER);
            uint256 poolBefore = usdc.balanceOf(address(pool));
            uint256 protoBefore = usdc.balanceOf(PROTO);
            uint256 id = book.idOfShape(BTC, shapes[i], _day());
            vm.expectEmit(true, true, true, true, address(engine));
            emit Engine.ShapeBought(TRADER, id, BTC, units[i], units[i], S, SIG, v, premium, fee);
            (uint256 got, uint256 cost) = _buyShape(shapes[i], units[i]);
            assertEq(got, id);
            assertEq(cost, premium + fee);
            assertTrue(book.isShape(id));
            assertEq(traderBefore - usdc.balanceOf(TRADER), premium + fee, "the buyer pays exactly the quote");
            uint256 cut = fee * pool.protocolFeeBps() / 10_000;
            assertEq(usdc.balanceOf(PROTO) - protoBefore, cut);
            assertEq(usdc.balanceOf(address(pool)) - poolBefore, premium + fee - cut);
            assertEq(book.balanceOf(id, TRADER), units[i], "a fresh series: norm 1, raw = units");
            assertEq(usdc.balanceOf(address(engine)), 0);
        }
        // a second buy of the same shape joins its series
        (uint256 again,) = _buyShape(_spread(), 1e18);
        assertEq(again, book.idOfShape(BTC, _spread(), _day()));
        assertEq(book.balanceOf(again, TRADER), 3e18);
    }

    function test_shapeBuyRefusals() public {
        _seed(5_000_000e6);
        TempoBlend.Part[] memory day = _day();
        vm.startPrank(TRADER);

        vm.expectRevert(Engine.ZeroUnits.selector);
        engine.buyShape(BTC, _spread(), day, 0, ALL, nowT);
        vm.expectRevert(abi.encodeWithSelector(Engine.Expired.selector, nowT - 1));
        engine.buyShape(BTC, _spread(), day, 1e18, ALL, nowT - 1);
        vm.expectRevert(abi.encodeWithSelector(Engine.NotListed.selector, bytes32("SOL")));
        engine.buyShape("SOL", _spread(), day, 1e18, ALL, nowT);

        // law 1: a buyer shape that can owe (a risk reversal)
        StrategyMath.Leg[] memory rr = new StrategyMath.Leg[](2);
        rr[0] = _leg(false, 65_000e18, -1e18);
        rr[1] = _leg(true, 75_000e18, 1e18);
        vm.expectRevert(EnginePricing.ShapeCanOwe.selector);
        engine.buyShape(BTC, rr, day, 1e18, ALL, nowT);

        // every leg's strike is checked
        StrategyMath.Leg[] memory off = _spread();
        off[1].kWad = 75_050e18;
        vm.expectRevert(abi.encodeWithSelector(EnginePricing.StrikeOffStep.selector, 75_050e18, 100e18));
        engine.buyShape(BTC, off, day, 1e18, ALL, nowT);

        // the book's spelling and cap
        StrategyMath.Leg[] memory reversed = new StrategyMath.Leg[](2);
        (reversed[0], reversed[1]) = (_spread()[1], _spread()[0]);
        reversed[0].qty = 1e18; // first amount ±1, but out of order
        vm.expectRevert(abi.encodeWithSelector(PathFundingBook.LegsNotCanonical.selector, 1));
        engine.buyShape(BTC, reversed, day, 1e18, ALL, nowT);
        TempoBlend.Part[] memory two = new TempoBlend.Part[](2);
        two[0] = TempoBlend.Part(1 days, 0.5e18);
        two[1] = TempoBlend.Part(7 days, 0.5e18);
        vm.expectRevert(abi.encodeWithSelector(PathFundingBook.ShapeTooComplex.selector, 4, 2));
        engine.buyShape(BTC, _condor(), two, 1e18, ALL, nowT);

        // max cost
        int256 v = EnginePricing.shapeValue(_spread(), S, SIG, day, true);
        (uint256 premium, uint256 fee) = EnginePricing.shapeBuyQuote(v, 1e18, _spread(), S, 200);
        vm.expectRevert(abi.encodeWithSelector(Engine.CostAboveMax.selector, premium + fee, premium + fee - 1));
        engine.buyShape(BTC, _spread(), day, 1e18, premium + fee - 1, nowT);
        vm.stopPrank();

        // law 2: no buy without a fresh mark and vol
        marks.setStale(true);
        vm.prank(TRADER);
        vm.expectRevert(abi.encodeWithSelector(MockMarks.Stale.selector, BTC));
        engine.buyShape(BTC, _spread(), day, 1e18, ALL, nowT);
        marks.setStale(false);
        vols.setStale(true);
        vm.prank(TRADER);
        vm.expectRevert(abi.encodeWithSelector(MockVols.Stale.selector, BTC));
        engine.buyShape(BTC, _spread(), day, 1e18, ALL, nowT);
        vols.setStale(false);

        // paused buys; a paused market at the pool
        engine.grantRole(engine.PAUSER_ROLE(), address(this));
        engine.pauseBuys();
        vm.prank(TRADER);
        vm.expectRevert(Engine.BuysArePaused.selector);
        engine.buyShape(BTC, _spread(), day, 1e18, ALL, nowT);
        engine.unpauseBuys();
        pool.grantRole(pool.RISK_PAUSER_ROLE(), address(this));
        pool.pauseMarket(BTC);
        vm.prank(TRADER);
        vm.expectRevert(abi.encodeWithSelector(MainspringPool.MarketIsPaused.selector, BTC));
        engine.buyShape(BTC, _spread(), day, 1e18, ALL, nowT);
        pool.unpauseMarket(BTC);

        // not caught up: an open series 20 intervals behind
        (uint256 id,) = _buyShape(_spread(), 1e18);
        for (uint256 i = 1; i <= 20; ++i) {
            _set(nowT + 5 minutes);
            marks.set(BTC, S + i * 10e18);
            book.record(BTC, S + i * 10e18, SIG);
        }
        vm.prank(TRADER);
        vm.expectRevert(abi.encodeWithSelector(Engine.NotCaughtUp.selector, id));
        engine.buyShape(BTC, _spread(), day, 1e18, ALL, nowT);
    }

    // ---------------------------------------------------------------- 2. sells

    function test_shapeSellsPayTheQuoteAndNeverPause() public {
        _seed(5_000_000e6);
        (uint256 id,) = _buyShape(_condor(), 4e18);

        // everything paused: buys, the market, and opens after a drawdown would be the same (law 3)
        engine.grantRole(engine.PAUSER_ROLE(), address(this));
        engine.pauseBuys();
        pool.grantRole(pool.RISK_PAUSER_ROLE(), address(this));
        pool.pauseMarket(BTC);

        _set(nowT + 3 minutes);
        marks.set(BTC, 72_000e18);
        int256 v = EnginePricing.shapeValue(_condor(), 72_000e18, SIG, _day(), false);
        uint256 before = usdc.balanceOf(TRADER);
        vm.prank(TRADER);
        (uint256 paidUnits, uint256 net) = engine.sell(id, 1e18, 0, nowT);
        (uint256 gross, uint256 fee) = EnginePricing.shapeSellQuote(v, paidUnits, _condor(), 72_000e18, 200);
        assertEq(net, gross - fee, "paid exactly the quote");
        assertEq(usdc.balanceOf(TRADER) - before, net);
        assertLe(paidUnits, 1e18);

        // stale mark and vol: the last recorded sample prices the sell
        marks.setStale(true);
        vols.setStale(true);
        (, uint256 sampleS, uint256 sampleSig) = book.latestSample(BTC);
        v = EnginePricing.shapeValue(_condor(), sampleS, sampleSig, _day(), false);
        vm.prank(TRADER);
        (paidUnits, net) = engine.sell(id, 1e18, 0, nowT);
        (gross, fee) = EnginePricing.shapeSellQuote(v, paidUnits, _condor(), sampleS, 200);
        assertEq(net, gross - fee);

        // the rest
        vm.prank(TRADER);
        engine.sell(id, ALL, 0, nowT);
        assertEq(book.balanceOf(id, TRADER), 0);
        assertEq(pool.seriesRaw(id), 0);
        assertEq(pool.openSeries(BTC).length, 0, "unregistered once empty");
        assertEq(pool.openNotional(BTC), 0, "notional released");
    }

    // ---------------------------------------------------------------- 3. the pool values shapes

    function test_poolValuesShapeSeries() public {
        _seed(5_000_000e6);
        (uint256 idC,) = _buyShape(_condor(), 3e18);
        (uint256 idS,) = _buyShape(_spread(), 5e18);
        (uint256 idW,) = _buyShape(_swing(), 2e18);
        StrategyMath.Leg[][3] memory shapes = [_condor(), _spread(), _swing()];
        uint256[3] memory units = [uint256(3e18), 5e18, 2e18];
        uint256 sigS = _stressedSig();
        uint256 up;
        uint256 base;
        uint256 sumUp;
        uint256 sumDown;
        uint256 perBuyStressed;
        for (uint256 i; i < 3; ++i) {
            base += _val(shapes[i], S, SIG, units[i]);
            up = _val(shapes[i], S * 12_000 / 10_000, sigS, units[i]);
            uint256 down = _val(shapes[i], S * 8_000 / 10_000, sigS, units[i]);
            sumUp += up;
            sumDown += down;
            perBuyStressed += up > down ? up : down;
        }
        // between epochs: each buy adds its base and the larger of its up and down values
        assertEq(pool.navBase(BTC), base);
        assertEq(pool.liveStressed(BTC), perBuyStressed);
        // a shape counts as one series; notional = units × S × max(long, short)
        assertEq(pool.openSeries(BTC).length, 3);
        assertEq(pool.seriesNotional(idC), 3 * 2 * 70_000e6);
        assertEq(pool.seriesNotional(idS), 5 * 70_000e6);
        assertEq(pool.seriesNotional(idW), 2 * 2 * 70_000e6);
        assertEq(pool.openNotional(BTC), (420_000 + 350_000 + 280_000) * 1e6);

        // an hour later an epoch marks shape series like single legs, at the units each series holds now (raw ×
        // norm, rounded up), one direction for the whole market
        _set(nowT + 1 hours);
        uint256[3] memory ids = [idC, idS, idW];
        (base, sumUp, sumDown) = (0, 0, 0);
        for (uint256 i; i < 3; ++i) {
            uint256 u = Math.mulDiv(pool.seriesRaw(ids[i]), book.normNow(ids[i]), 1e18, Math.Rounding.Ceil);
            // the condor sits inside its body at 70,000 (time value < 0): the floor, no decay; the others decay
            if (i == 0) assertEq(u, units[i], "condor: floored");
            else assertLt(u, units[i], "an hour of decay");
            base += _val(shapes[i], S, SIG, u);
            sumUp += _val(shapes[i], S * 12_000 / 10_000, sigS, u);
            sumDown += _val(shapes[i], S * 8_000 / 10_000, sigS, u);
        }
        pool.startEpoch();
        while (!pool.markChunk(1)) {} // one series per chunk
        assertEq(pool.navBase(BTC), base);
        assertEq(pool.liveStressed(BTC), sumUp > sumDown ? sumUp : sumDown);
        uint256 dir = sumUp > sumDown ? sumUp - sumDown : sumDown - sumUp;
        assertEq(pool.directional(BTC), Math.ceilDiv(dir, 1e12));
    }

    function test_capsAndCoverageWithShapes() public {
        _seed(5_000_000e6);
        // notional cap: a Swing counts 2 units of underlying per unit
        pool.setCaps(BTC, 150_000e6, 1e15);
        _buyShape(_swing(), 1e18); // 140,000
        vm.prank(TRADER);
        vm.expectRevert(abi.encodeWithSelector(MainspringPool.NotionalCapExceeded.selector, BTC, 280_000e6, 150_000e6));
        engine.buyShape(BTC, _swing(), _day(), 1e18, ALL, nowT);

        // directional cap: a call spread is one-sided
        pool.setCaps(BTC, 1e15, 1_000e6);
        vm.prank(TRADER);
        vm.expectPartialRevert(MainspringPool.DirectionalCapExceeded.selector);
        engine.buyShape(BTC, _spread(), _day(), 5e18, ALL, nowT);
        pool.setCaps(BTC, 1e15, 1e15);

        // coverage: a thin pool refuses the shape buy that would leave the stressed liability uncovered
        vm.prank(TRADER);
        vm.expectPartialRevert(MainspringPool.CoverageBreached.selector);
        engine.buyShape(BTC, _swing(), _day(), 1_000e18, ALL, nowT);
    }

    // ---------------------------------------------------------------- 4. law 1 round trip

    function testFuzz_shapeRoundTripLosesAtMostWhatWasPaid(uint256 which, uint256 units, uint256 move) public {
        _seed(5_000_000e6);
        units = bound(units, 1e15, 20e18);
        move = bound(move, 9_000, 11_000);
        StrategyMath.Leg[] memory legs = which % 3 == 0 ? _condor() : which % 3 == 1 ? _spread() : _swing();
        uint256 start = usdc.balanceOf(TRADER);
        (uint256 id, uint256 cost) = _buyShape(legs, units);
        _set(nowT + 4 minutes);
        marks.set(BTC, S * move / 10_000);
        vm.prank(TRADER);
        (, uint256 net) = engine.sell(id, ALL, 0, nowT);
        assertEq(usdc.balanceOf(TRADER), start - cost + net);
        assertGe(usdc.balanceOf(TRADER) + cost, start, "never loses more than paid");
        assertEq(usdc.balanceOf(address(engine)), 0);
    }

    // ---------------------------------------------------------------- 5. gas

    function test_shapeGas() public {
        _seed(5_000_000e6);
        _buyShape(_spread(), 1e18); // warm the market
        uint256 g = gasleft();
        (uint256 id2,) = _buyShape(_swing(), 1e18);
        console2.log("buy 2-leg shape, new series", g - gasleft());
        g = gasleft();
        (uint256 id4,) = _buyShape(_condor(), 1e18);
        console2.log("buy 4-leg shape, new series", g - gasleft());
        g = gasleft();
        _buyShape(_condor(), 1e18);
        console2.log("buy 4-leg shape, existing series", g - gasleft());
        g = gasleft();
        vm.prank(TRADER);
        engine.sell(id4, 1e18, 0, nowT);
        console2.log("sell 4-leg shape", g - gasleft());
        g = gasleft();
        vm.prank(TRADER);
        engine.sell(id2, ALL, 0, nowT);
        console2.log("sell 2-leg shape, all", g - gasleft());
        _set(nowT + 1 hours);
        pool.startEpoch();
        g = gasleft();
        pool.markChunk(120);
        console2.log("markChunk over 2 shape series", g - gasleft());
    }
}
