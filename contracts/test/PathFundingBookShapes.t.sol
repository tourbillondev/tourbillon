// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PathFundingBook, IMarkRouter, IVolSource} from "../src/PathFundingBook.sol";
import {PathFunding} from "../src/PathFunding.sol";
import {TempoMath} from "../src/TempoMath.sol";
import {TempoBlend} from "../src/TempoBlend.sol";
import {StrategyMath} from "../src/StrategyMath.sol";
import {ShapeFunding} from "../src/ShapeFunding.sol";

/// M4 step 4: shape series in the book.
contract PathFundingBookShapesTest is Test {
    uint256 constant T0 = 1_794_182_400; // a day boundary
    uint256 constant BLOCK_GAS = 32_000_000;
    bytes32 constant BTC = "BTC";
    address constant HOLDER = address(0xA11CE);

    PathFundingBook book;
    uint256 nowT;

    function _set(uint256 t) internal {
        nowT = t;
        vm.warp(t);
    }

    function _adv(uint256 dt) internal {
        _set(nowT + dt);
    }

    function setUp() public {
        _set(T0);
        book = new PathFundingBook(address(this), address(this), IMarkRouter(address(0)), IVolSource(address(0)));
    }

    // ---------------------------------------------------------------- helpers

    function _leg(bool isCall, uint256 k, int256 q) internal pure returns (StrategyMath.Leg memory) {
        return StrategyMath.Leg(isCall, uint128(k), int128(q));
    }

    function _legs(StrategyMath.Leg memory a) internal pure returns (StrategyMath.Leg[] memory l) {
        l = new StrategyMath.Leg[](1);
        l[0] = a;
    }

    function _legs(StrategyMath.Leg memory a, StrategyMath.Leg memory b)
        internal
        pure
        returns (StrategyMath.Leg[] memory l)
    {
        l = new StrategyMath.Leg[](2);
        (l[0], l[1]) = (a, b);
    }

    function _condor() internal pure returns (StrategyMath.Leg[] memory l) {
        l = new StrategyMath.Leg[](4);
        l[0] = _leg(true, 90e18, 1e18);
        l[1] = _leg(true, 100e18, -1e18);
        l[2] = _leg(true, 110e18, -1e18);
        l[3] = _leg(true, 120e18, 1e18);
    }

    function _move4() internal pure returns (TempoBlend.Part[] memory mv) {
        mv = new TempoBlend.Part[](4);
        mv[0] = TempoBlend.Part(1 hours, 0.1e18);
        mv[1] = TempoBlend.Part(1 days, 0.4e18);
        mv[2] = TempoBlend.Part(7 days, 0.3e18);
        mv[3] = TempoBlend.Part(30 days, 0.2e18);
    }

    function _terms(StrategyMath.Leg[] memory legs, TempoBlend.Part[] memory mv)
        internal
        pure
        returns (ShapeFunding.Terms memory)
    {
        return ShapeFunding.Terms(legs, mv, TempoMath.defaultBounds());
    }

    function _rateAt(uint256 s, uint256 sig, StrategyMath.Leg[] memory legs, TempoBlend.Part[] memory mv)
        internal
        pure
        returns (uint256)
    {
        return ShapeFunding.rateAt(PathFunding.Sample(0, 0, uint32(sig), uint128(s)), _terms(legs, mv));
    }

    function _stepsFromLogs() internal returns (uint256 steps) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == PathFundingBook.Accrued.selector) {
                (,, steps) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            }
        }
    }

    function _price(uint256 i) internal pure returns (uint256) {
        uint256 r = uint256(keccak256(abi.encode("PX", i)));
        return 92e18 + (r % 17) * 1e18; // 92..108
    }

    function _sigma(uint256 i) internal pure returns (uint256) {
        return 3000 + uint256(keccak256(abi.encode("SG", i))) % 6000;
    }

    // ---------------------------------------------------------------- 1. opening a shape

    function test_openShapeRulesAndIds() public {
        // no history: a shape cannot be opened (no price, no open)
        vm.expectRevert(PathFunding.NoHistory.selector);
        book.openShape(BTC, _condor(), TempoBlend.single(1 days));
        book.record(BTC, 100e18, 5000);

        // engine only
        vm.prank(address(0xBAD));
        vm.expectRevert(PathFundingBook.NotEngine.selector);
        book.openShape(BTC, _condor(), TempoBlend.single(1 days));

        // opens once; the same terms return the same id
        StrategyMath.Leg[] memory spread = _legs(_leg(true, 100e18, 1e18), _leg(true, 110e18, -1e18));
        uint256 id = book.openShape(BTC, spread, TempoBlend.single(1 days));
        assertEq(id, book.idOfShape(BTC, spread, TempoBlend.single(1 days)));
        assertEq(book.openShape(BTC, spread, TempoBlend.single(1 days)), id);
        assertTrue(book.exists(id));
        assertTrue(book.isShape(id));
        (bytes32 name, StrategyMath.Leg[] memory legs, TempoBlend.Part[] memory mv) = book.shapeOf(id);
        assertEq(name, BTC);
        assertEq(legs.length, 2);
        assertEq(legs[1].kWad, 110e18);
        assertEq(legs[1].qty, -1e18);
        assertEq(mv[0].tempo, 1 days);
        vm.expectRevert(abi.encodeWithSelector(PathFundingBook.IsShape.selector, id));
        book.seriesOf(id);

        // a one-leg shape and the single-leg series of the same terms have different ids
        uint256 single = book.open(BTC, true, 100e18, TempoBlend.single(1 days));
        uint256 oneLeg = book.openShape(BTC, _legs(_leg(true, 100e18, 1e18)), TempoBlend.single(1 days));
        assertTrue(single != oneLeg);
        assertFalse(book.isShape(single));
        vm.expectRevert(abi.encodeWithSelector(PathFundingBook.NotShape.selector, single));
        book.shapeOf(single);
        vm.expectRevert(abi.encodeWithSelector(PathFundingBook.Unknown.selector, 7));
        book.shapeOf(7);

        // one spelling per shape: order (put before call, then strike), no repeats, first amount ±1
        TempoBlend.Part[] memory day = TempoBlend.single(1 days);
        vm.expectRevert(abi.encodeWithSelector(PathFundingBook.LegsNotCanonical.selector, 1));
        book.openShape(BTC, _legs(_leg(true, 110e18, 1e18), _leg(true, 100e18, -1e18)), day);
        vm.expectRevert(abi.encodeWithSelector(PathFundingBook.LegsNotCanonical.selector, 1));
        book.openShape(BTC, _legs(_leg(true, 100e18, 1e18), _leg(true, 100e18, -1e18)), day);
        vm.expectRevert(abi.encodeWithSelector(PathFundingBook.LegsNotCanonical.selector, 1));
        book.openShape(BTC, _legs(_leg(true, 100e18, 1e18), _leg(false, 100e18, 1e18)), day);
        vm.expectRevert(abi.encodeWithSelector(PathFundingBook.FirstQtyNotOne.selector, int256(2e18)));
        book.openShape(BTC, _legs(_leg(true, 100e18, 2e18), _leg(true, 110e18, -2e18)), day);
        // a put before a call at the same strike is the one spelling of a Swing
        book.openShape(BTC, _legs(_leg(false, 100e18, 1e18), _leg(true, 100e18, 1e18)), day);

        // ShapeFunding's own limits
        vm.expectRevert(ShapeFunding.NoLegs.selector);
        book.openShape(BTC, new StrategyMath.Leg[](0), day);
        StrategyMath.Leg[] memory five = new StrategyMath.Leg[](5);
        for (uint256 j; j < 5; ++j) {
            five[j] = _leg(true, (90 + 5 * j) * 1e18, 1e18);
        }
        vm.expectRevert(abi.encodeWithSelector(ShapeFunding.TooManyLegs.selector, 5));
        book.openShape(BTC, five, day);
        vm.expectRevert(abi.encodeWithSelector(ShapeFunding.QtyTooLarge.selector, 1, int256(101e18)));
        book.openShape(BTC, _legs(_leg(true, 100e18, 1e18), _leg(true, 110e18, 101e18)), day);

        // terms the maths would refuse are refused at open
        vm.expectRevert(TempoMath.ZeroStrike.selector);
        book.openShape(BTC, _legs(_leg(false, 0, 1e18)), day);
        TempoBlend.Part[] memory bad = new TempoBlend.Part[](1);
        bad[0] = TempoBlend.Part(1 days, 0.5e18);
        vm.expectRevert(abi.encodeWithSelector(TempoBlend.WeightsNotOne.selector, 0.5e18));
        book.openShape(BTC, spread, bad);
        bad[0] = TempoBlend.Part(10 minutes, 1e18);
        vm.expectRevert(abi.encodeWithSelector(TempoMath.TempoOutOfRange.selector, 10 minutes));
        book.openShape(BTC, spread, bad);
    }

    // ---------------------------------------------------------------- 2. a one-leg shape = the single-leg series

    function test_oneLegShapeMatchesTheSingleLegSeries() public {
        book.record(BTC, 100e18, 5000);
        TempoBlend.Part[] memory mv = _move4();
        uint256 single = book.open(BTC, false, 97e18, mv);
        uint256 shape = book.openShape(BTC, _legs(_leg(false, 97e18, -1e18)), mv);
        for (uint256 i = 1; i <= 50; ++i) {
            _adv(5 minutes + i % 3);
            book.record(BTC, _price(i), _sigma(i));
        }
        book.accrue(single, type(uint256).max);
        book.accrue(shape, type(uint256).max);
        assertEq(book.cursor(shape).x, book.cursor(single).x);
        assertGt(book.cursor(single).x, 0);
        _adv(3 minutes); // between samples: the partial interval at the latest sample
        assertEq(book.normNow(shape), book.normNow(single));
        assertLt(book.normNow(shape), 1e18);
    }

    // ---------------------------------------------------------------- 3. exact, any caller, any chunks

    function test_exactAgainstTheReferenceForAnyCallerAndChunks() public {
        book.record(BTC, 100e18, 5000);
        uint256[] memory ts = new uint256[](61);
        uint256[] memory ss = new uint256[](61);
        uint256[] memory sg = new uint256[](61);
        (ts[0], ss[0], sg[0]) = (nowT, 100e18, 5000);
        _adv(97); // open between the first two samples
        uint256 openAt = nowT;
        StrategyMath.Leg[] memory legs = _condor();
        TempoBlend.Part[] memory mv = TempoBlend.single(3 days); // 4 legs × 1 tempo: at the cap
        uint256 id = book.openShape(BTC, legs, mv);
        for (uint256 i = 1; i <= 60; ++i) {
            _set(T0 + i * 5 minutes + (i * 37) % 200);
            (ts[i], ss[i], sg[i]) = (nowT, _price(i), _sigma(i));
            book.record(BTC, ss[i], sg[i]);
        }
        // anyone walks, in uneven chunks
        address[3] memory who = [address(0x1), address(0x2), address(0x3)];
        uint256 k;
        bool done;
        while (!done) {
            vm.prank(who[k % 3]);
            (, done) = book.accrue(id, 3 + k % 5);
            ++k;
        }
        uint256 xRef;
        for (uint256 i; i < 60; ++i) {
            uint256 from = ts[i] > openAt ? ts[i] : openAt;
            xRef += Math.ceilDiv(_rateAt(ss[i], sg[i], legs, mv) * (ts[i + 1] - from), 1e18);
        }
        assertEq(book.cursor(id).x, xRef);
        assertEq(book.cursor(id).at, ts[60]);
    }

    // ---------------------------------------------------------------- 4. normNow and the floor

    function test_normNowBetweenSamplesAndTheFloor() public {
        book.record(BTC, 80e18, 5000);
        StrategyMath.Leg[] memory spread = _legs(_leg(true, 100e18, 1e18), _leg(true, 110e18, -1e18));
        TempoBlend.Part[] memory week = TempoBlend.single(7 days);
        uint256 id = book.openShape(BTC, spread, week);
        // below the lower strike: the norm falls between samples at the latest sample's rate
        _adv(4 minutes);
        uint256 r = _rateAt(80e18, 5000, spread, week);
        assertGt(r, 0);
        assertEq(book.normNow(id), PathFunding.factor(Math.ceilDiv(r * 4 minutes, 1e18)));

        // an hour above the upper strike: negative time value, the norm stays exactly where it was
        _adv(1 minutes);
        book.record(BTC, 130e18, 5000);
        book.accrue(id, type(uint256).max);
        uint256 x0 = book.cursor(id).x;
        uint256 n0 = book.normNow(id);
        for (uint256 i; i < 12; ++i) {
            _adv(5 minutes);
            book.record(BTC, 125e18 + (i % 4) * 5e18, 4000 + i * 100);
            assertEq(book.normNow(id), n0);
        }
        book.accrue(id, type(uint256).max);
        assertEq(book.cursor(id).x, x0, "nothing charged across the floored stretch");
        _adv(4 minutes);
        assertEq(book.normNow(id), n0);
    }

    // ---------------------------------------------------------------- 5. mint, burn, units

    function test_mintBurnCaughtUpAndUnits() public {
        book.record(BTC, 100e18, 5000);
        uint256 id = book.openShape(BTC, _condor(), TempoBlend.single(1 days));
        book.mint(id, HOLDER, 10e18);
        for (uint256 i = 1; i <= 20; ++i) {
            _adv(5 minutes);
            book.record(BTC, _price(i), 5000);
        }
        // 20 intervals behind: a buy may walk 16, so it is refused; a walk, then it goes through
        vm.expectRevert(abi.encodeWithSelector(PathFundingBook.NotCaughtUp.selector, id));
        book.mint(id, HOLDER, 1e18);
        vm.prank(address(0xCAFE));
        book.accrue(id, 0);
        book.mint(id, HOLDER, 1e18);
        assertEq(book.balanceOf(id, HOLDER), 11e18);
        _adv(2 minutes);
        assertEq(book.units(id, HOLDER), 11e18 * book.normNow(id) / 1e18);
        // engine only
        vm.prank(address(0xBAD));
        vm.expectRevert(PathFundingBook.NotEngine.selector);
        book.mint(id, HOLDER, 1e18);
        vm.prank(address(0xBAD));
        vm.expectRevert(PathFundingBook.NotEngine.selector);
        book.burn(id, HOLDER, 1e18);
        // a sell walks without limit
        for (uint256 i = 21; i <= 60; ++i) {
            _adv(5 minutes);
            book.record(BTC, _price(i), 5000);
        }
        book.burn(id, HOLDER, 11e18);
        assertEq(book.balanceOf(id, HOLDER), 0);
        assertEq(book.cursor(id).at, nowT);
    }

    // ---------------------------------------------------------------- 6. dormancy

    function _ringsFor60Days(uint256 tEnd) internal {
        uint256 hourlyFrom = tEnd - 96 hours;
        uint256 fiveFrom = tEnd - 64 * 5 minutes;
        uint256 i;
        for (uint256 t = T0 + 1 days; t < hourlyFrom; t += 1 days) {
            _set(t);
            book.record(BTC, _price(++i), 5000);
        }
        for (uint256 t = hourlyFrom; t < fiveFrom; t += 1 hours) {
            _set(t);
            book.record(BTC, _price(++i), 5000);
        }
        for (uint256 t = fiveFrom; t < tEnd; t += 5 minutes) {
            _set(t);
            book.record(BTC, _price(++i), 5000);
        }
        _set(tEnd);
    }

    function _sellAfter60Days(TempoBlend.Part[] memory mv) internal returns (uint256 steps, uint256 used) {
        book.record(BTC, 100e18, 5000);
        uint256 id = book.openShape(BTC, _condor(), mv);
        book.mint(id, HOLDER, 10e18);
        _ringsFor60Days(T0 + 60 days);
        vm.expectRevert(abi.encodeWithSelector(PathFundingBook.NotCaughtUp.selector, id));
        book.mint(id, address(0xB0B), 1e18);
        vm.recordLogs();
        uint256 g = gasleft();
        book.burn(id, HOLDER, 10e18);
        used = g - gasleft();
        steps = _stepsFromLogs();
        assertEq(book.balanceOf(id, HOLDER), 0);
        book.mint(id, address(0xB0B), 1e18); // caught up
    }

    function test_shapeSellAfter60DaysUntouchedNeedsNoKeeper() public {
        (uint256 steps, uint256 used) = _sellAfter60Days(TempoBlend.single(7 days));
        console2.log("4-leg shape, 1 tempo, sell after 60 days: intervals", steps, "gas", used);
        assertGt(steps, 200);
        assertLe(steps, 224);
        assertLt(used, BLOCK_GAS, "fits in a block");
    }

    /// The cap (owner, M4 step 5): legs × Movement parts ≤ 4. The 4-leg, 4-part shape that needed 48.3M gas to sell
    /// after 60 days (step 4 finding) can no longer be opened.
    function test_shapeComplexityCap() public {
        book.record(BTC, 100e18, 5000);
        assertEq(book.MAX_SHAPE_EVALS(), 4);
        vm.expectRevert(abi.encodeWithSelector(PathFundingBook.ShapeTooComplex.selector, 4, 4));
        book.openShape(BTC, _condor(), _move4());
        TempoBlend.Part[] memory two = new TempoBlend.Part[](2);
        two[0] = TempoBlend.Part(1 days, 0.5e18);
        two[1] = TempoBlend.Part(7 days, 0.5e18);
        StrategyMath.Leg[] memory three = new StrategyMath.Leg[](3);
        three[0] = _leg(true, 90e18, 1e18);
        three[1] = _leg(true, 100e18, -2e18);
        three[2] = _leg(true, 110e18, 1e18);
        vm.expectRevert(abi.encodeWithSelector(PathFundingBook.ShapeTooComplex.selector, 3, 2));
        book.openShape(BTC, three, two);
        // at the limit: 4 legs × 1 tempo, 2 legs × 2 parts, 1 leg × 4 parts; 3 legs × 1 tempo
        book.openShape(BTC, _condor(), TempoBlend.single(1 days));
        book.openShape(BTC, _legs(_leg(true, 100e18, 1e18), _leg(true, 110e18, -1e18)), two);
        book.openShape(BTC, _legs(_leg(false, 95e18, 1e18)), _move4());
        book.openShape(BTC, three, TempoBlend.single(1 days));
    }

    /// Lost history on a shape sell: the larger of 1/shortest tempo and the shape's rate at the oldest held sample.
    function test_shapeSellAfter70DaysChargesLostHistory() public {
        TempoBlend.Part[] memory mv = new TempoBlend.Part[](2);
        mv[0] = TempoBlend.Part(1 days, 0.5e18); // shortest tempo: 1 day
        mv[1] = TempoBlend.Part(7 days, 0.5e18);
        // (a) a deep in-the-money call spread: negative time value, rate 0 at the held sample, so 1/shortest wins
        StrategyMath.Leg[] memory deep = _legs(_leg(true, 60e18, 1e18), _leg(true, 70e18, -1e18));
        // (b) short a deep in-the-money put, long calls sized so the shape is worth about 0.1% of the put at the held
        //     sample: small value, large funding, so the held sample's rate is above 1/shortest
        uint256 sHeld = 100e18 + (7 % 9) * 1e18; // the day-7 sample, the oldest still held after 70 days
        (uint256 vp,,) = TempoBlend.quote(false, sHeld, 130e18, 5000, mv, TempoMath.defaultBounds());
        (uint256 vc,,) = TempoBlend.quote(true, sHeld, 100e18, 5000, mv, TempoMath.defaultBounds());
        int256 q = int256(Math.ceilDiv(vp * 1001e15 / vc, 1e12) * 1e12); // calls, worth 0.1% more than the put
        StrategyMath.Leg[] memory hot = _legs(_leg(false, 130e18, -1e18), _leg(true, 100e18, q));

        uint256 t0 = nowT;
        book.record(BTC, 100e18, 5000);
        uint256 idDeep = book.openShape(BTC, deep, mv);
        uint256 idHot = book.openShape(BTC, hot, mv);
        book.mint(idDeep, HOLDER, 1e18);
        book.mint(idHot, HOLDER, 1e18);
        for (uint256 d = 1; d <= 70; d++) {
            _adv(1 days);
            book.record(BTC, 100e18 + (d % 9) * 1e18, 5000);
        }
        uint256 horizon = book.horizon(BTC);
        assertEq(horizon, t0 + 7 days);
        uint256 byShortest = Math.ceilDiv((horizon - t0) * 1e18, 1 days);

        vm.expectRevert(abi.encodeWithSelector(PathFunding.HistoryGone.selector, t0));
        book.accrue(idDeep, type(uint256).max);

        // (a)
        assertEq(_rateAt(sHeld, 5000, deep, mv), 0);
        vm.expectEmit(true, false, false, true, address(book));
        emit PathFundingBook.HistoryFallback(idDeep, t0, horizon, byShortest);
        book.burn(idDeep, HOLDER, 1e18);

        // (b)
        uint256 rHeld = _rateAt(sHeld, 5000, hot, mv);
        uint256 byHeld = Math.ceilDiv(rHeld * (horizon - t0), 1e18);
        assertGt(byHeld, byShortest, "the held sample's rate is above 1/shortest");
        vm.expectEmit(true, false, false, true, address(book));
        emit PathFundingBook.HistoryFallback(idHot, t0, horizon, byHeld);
        book.burn(idHot, HOLDER, 1e18);
        assertGe(book.normNow(idHot), book.MIN_NORM());
    }

    // ---------------------------------------------------------------- 7. gas per walked interval (D13)

    function test_walkGasPerInterval() public {
        book.record(BTC, 100e18, 5000);
        TempoBlend.Part[] memory one = TempoBlend.single(7 days);
        TempoBlend.Part[] memory four = _move4();
        TempoBlend.Part[] memory twoParts = new TempoBlend.Part[](2);
        twoParts[0] = TempoBlend.Part(1 days, 0.5e18);
        twoParts[1] = TempoBlend.Part(7 days, 0.5e18);
        StrategyMath.Leg[] memory two = _legs(_leg(true, 100e18, 1e18), _leg(true, 110e18, -1e18));
        // every shape the cap allows at its limit (the 4-part shapes measured in step 4 are no longer allowed)
        uint256[6] memory ids = [
            book.open(BTC, true, 100e18, one),
            book.open(BTC, true, 100e18, four),
            book.openShape(BTC, two, one),
            book.openShape(BTC, two, twoParts),
            book.openShape(BTC, _condor(), one),
            book.openShape(BTC, _legs(_leg(true, 100e18, 1e18)), four)
        ];
        string[6] memory label = [
            "single leg, 1 tempo      ",
            "single leg, 4 tempos     ",
            "2-leg shape, 1 tempo     ",
            "2-leg shape, 2 parts     ",
            "4-leg shape, 1 tempo     ",
            "1-leg shape, 4 parts     "
        ];
        for (uint256 i = 1; i <= 16; ++i) {
            _adv(5 minutes);
            book.record(BTC, _price(i), _sigma(i));
        }
        for (uint256 j; j < 6; ++j) {
            uint256 g = gasleft();
            book.accrue(ids[j], 16);
            uint256 used = g - gasleft();
            console2.log(label[j], used, used / 16); // 16 intervals, per interval
        }
    }
}
