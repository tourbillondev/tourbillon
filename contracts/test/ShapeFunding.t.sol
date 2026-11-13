// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TempoMath} from "../src/TempoMath.sol";
import {TempoBlend} from "../src/TempoBlend.sol";
import {PathFunding} from "../src/PathFunding.sol";
import {StrategyMath} from "../src/StrategyMath.sol";
import {ShapeFunding} from "../src/ShapeFunding.sol";

/// Exposes PathFunding and ShapeFunding over one history per market.
contract ShapeHarness {
    mapping(bytes32 => PathFunding.History) internal _h;

    function record(bytes32 m, uint256 t, uint256 s, uint256 sigmaBps) external returns (bool, bool, bool) {
        return PathFunding.record(_h[m], t, s, sigmaBps);
    }

    function open(bytes32 m, uint256 at) external view returns (PathFunding.Cursor memory) {
        return PathFunding.open(_h[m], at);
    }

    function walkLeg(bytes32 m, PathFunding.Cursor memory cur, PathFunding.Terms memory terms, uint256 maxSteps)
        external
        view
        returns (PathFunding.Cursor memory, uint256)
    {
        return PathFunding.walk(_h[m], cur, terms, maxSteps);
    }

    function walkShape(bytes32 m, PathFunding.Cursor memory cur, ShapeFunding.Terms memory terms, uint256 maxSteps)
        external
        view
        returns (PathFunding.Cursor memory, uint256)
    {
        return ShapeFunding.walk(_h[m], cur, terms, maxSteps);
    }

    function rate(StrategyMath.Leg[] memory legs, uint256 s, uint256 sigmaBps, TempoBlend.Part[] memory m)
        external
        pure
        returns (uint256)
    {
        return ShapeFunding.rateE36(legs, s, sigmaBps, m, TempoMath.defaultBounds());
    }
}

contract ShapeFundingTest is Test {
    uint256 constant T0 = 1_800_000_000 - (1_800_000_000 % 1 days);
    uint256 constant REL_1E12 = 1e6;
    uint256 constant ALL = type(uint256).max;
    ShapeHarness h;

    function setUp() public {
        h = new ShapeHarness();
    }

    // ---------------------------------------------------------------- helpers

    function _b() internal pure returns (TempoMath.SigmaBounds memory) {
        return TempoMath.defaultBounds();
    }

    function _leg(bool isCall, uint256 k, int256 q) internal pure returns (StrategyMath.Leg memory) {
        return StrategyMath.Leg(isCall, uint128(k), int128(q));
    }

    function _one(bool isCall, uint256 k, int256 q) internal pure returns (StrategyMath.Leg[] memory legs) {
        legs = new StrategyMath.Leg[](1);
        legs[0] = _leg(isCall, k, q);
    }

    function _two(StrategyMath.Leg memory a, StrategyMath.Leg memory b)
        internal
        pure
        returns (StrategyMath.Leg[] memory legs)
    {
        legs = new StrategyMath.Leg[](2);
        (legs[0], legs[1]) = (a, b);
    }

    function _callSpread() internal pure returns (StrategyMath.Leg[] memory) {
        return _two(_leg(true, 100e18, 1e18), _leg(true, 110e18, -1e18));
    }

    function _condor() internal pure returns (StrategyMath.Leg[] memory legs) {
        legs = new StrategyMath.Leg[](4);
        legs[0] = _leg(true, 90e18, 1e18);
        legs[1] = _leg(true, 100e18, -1e18);
        legs[2] = _leg(true, 110e18, -1e18);
        legs[3] = _leg(true, 120e18, 1e18);
    }

    function _move4() internal pure returns (TempoBlend.Part[] memory mv) {
        mv = new TempoBlend.Part[](4);
        mv[0] = TempoBlend.Part(1 hours, 0.1e18);
        mv[1] = TempoBlend.Part(1 days, 0.4e18);
        mv[2] = TempoBlend.Part(7 days, 0.3e18);
        mv[3] = TempoBlend.Part(30 days, 0.2e18);
    }

    function _rate(StrategyMath.Leg[] memory legs, uint256 s, uint256 sig, TempoBlend.Part[] memory m)
        internal
        pure
        returns (uint256)
    {
        return ShapeFunding.rateE36(legs, s, sig, m, _b());
    }

    function _neg(StrategyMath.Leg[] memory legs) internal pure returns (StrategyMath.Leg[] memory out) {
        out = new StrategyMath.Leg[](legs.length);
        for (uint256 j; j < legs.length; ++j) {
            out[j] = _leg(legs[j].isCall, legs[j].kWad, -int256(legs[j].qty));
        }
    }

    /// Random shape: 1–4 legs, strikes 60..160 on a $5 step, amounts ±0.5..±3.
    function _randomLegs(uint256 seed) internal pure returns (StrategyMath.Leg[] memory legs) {
        uint256 n = 1 + seed % 4;
        legs = new StrategyMath.Leg[](n);
        for (uint256 j; j < n; ++j) {
            uint256 r = uint256(keccak256(abi.encode(seed, j)));
            int256 q = int256(0.5e18 + (r >> 8) % 2.5e18);
            legs[j] = _leg(r % 2 == 0, (60 + ((r >> 4) % 21) * 5) * 1e18, (r >> 128) % 2 == 0 ? q : -q);
        }
    }

    // ---------------------------------------------------------------- 1. one leg is today's rate, exactly

    function test_oneLegIsTodaysRateExactly() public pure {
        TempoBlend.Part[][3] memory mvs = [TempoBlend.single(1 hours), TempoBlend.single(7 days), _move4()];
        int256[4] memory qs = [int256(1e18), -1e18, 2.5e18, -100e18];
        uint256[6] memory ss = [uint256(40e18), 90e18, 100e18, 110e18, 200e18, 1e18];
        uint256[2] memory sigs = [uint256(2000), 8000];
        uint256 checked;
        for (uint256 c; c < 2; ++c) {
            for (uint256 a; a < 3; ++a) {
                for (uint256 b; b < 4; ++b) {
                    for (uint256 i; i < 6; ++i) {
                        for (uint256 g; g < 2; ++g) {
                            bool isCall = c == 0;
                            uint256 today = TempoBlend.rateE36(isCall, ss[i], 100e18, sigs[g], mvs[a], _b());
                            assertEq(_rate(_one(isCall, 100e18, qs[b]), ss[i], sigs[g], mvs[a]), today);
                            ++checked;
                        }
                    }
                }
            }
        }
        assertEq(checked, 288);
    }

    function testFuzz_oneLegIsTodaysRateExactly(
        bool isCall,
        uint256 s,
        uint256 kRatio,
        uint256 sig,
        uint256 tempo,
        int256 q
    ) public pure {
        s = bound(s, 1e15, 1e24);
        uint256 k = s * bound(kRatio, 25, 400) / 100; // strike within 0.25×–4× of the price
        sig = bound(sig, 500, 50_000);
        tempo = bound(tempo, 1 hours, 30 days);
        q = bound(q, -100e18, 100e18);
        if (q == 0) q = 1;
        TempoBlend.Part[] memory m = TempoBlend.single(tempo);
        assertEq(_rate(_one(isCall, k, q), s, sig, m), TempoBlend.rateE36(isCall, s, k, sig, m, _b()));
    }

    // ---------------------------------------------------------------- 2. mirror and linearity

    function testFuzz_mirrorAndLinearity(uint256 seed, uint256 s, uint256 sig) public pure {
        s = bound(s, 40e18, 200e18);
        sig = bound(sig, 1000, 15_000);
        StrategyMath.Leg[] memory legs = _randomLegs(seed);
        TempoBlend.Part[] memory m = seed % 3 == 0 ? _move4() : TempoBlend.single(1 days + seed % 6 days);
        uint256 r = _rate(legs, s, sig, m);
        // a position and its mirror decay identically
        assertEq(_rate(_neg(legs), s, sig, m), r);
        // splitting a leg into two equal-strike legs changes nothing (sums are exact integers)
        if (legs.length < 4) {
            StrategyMath.Leg[] memory split = new StrategyMath.Leg[](legs.length + 1);
            for (uint256 j; j < legs.length; ++j) {
                split[j] = legs[j];
            }
            int128 q = legs[0].qty;
            split[0].qty = q / 3;
            split[legs.length] = _leg(legs[0].isCall, legs[0].kWad, q - q / 3);
            if (split[0].qty != 0) assertEq(_rate(split, s, sig, m), r);
        }
    }

    // ---------------------------------------------------------------- 3. the floor: negative time value pays nothing

    function test_callSpreadFloorsAtZeroNearAndAboveTheTopStrike() public pure {
        TempoBlend.Part[] memory week = TempoBlend.single(7 days);
        StrategyMath.Leg[] memory spread = _callSpread();

        // Below the lower strike both legs are out of the money: positive value and funding, a positive rate
        (int256 v, int256 f,) = ShapeFunding.sums(spread, 80e18, 5000, week, _b());
        assertGt(v, 0);
        assertGt(f, 0);
        assertGt(_rate(spread, 80e18, 5000, week), 0);

        // At and above the upper strike the spread is worth less than its payoff: time value < 0, rate 0
        uint256[3] memory above = [uint256(110e18), 130e18, 200e18];
        for (uint256 i; i < 3; ++i) {
            (v, f,) = ShapeFunding.sums(spread, above[i], 5000, week, _b());
            assertGt(v, 0, "the spread is still worth something");
            assertLt(f, 0, "negative time value");
            assertEq(_rate(spread, above[i], 5000, week), 0);
        }
        // The mirror (a written spread) is floored at the same prices
        assertEq(_rate(_neg(spread), 130e18, 5000, week), 0);
    }

    function test_straddleRateLiesBetweenItsLegs() public pure {
        TempoBlend.Part[] memory day = TempoBlend.single(1 days);
        uint256[3] memory ss = [uint256(90e18), 100e18, 115e18];
        for (uint256 i; i < 3; ++i) {
            uint256 rc = _rate(_one(true, 100e18, 1e18), ss[i], 6000, day);
            uint256 rp = _rate(_one(false, 100e18, 1e18), ss[i], 6000, day);
            uint256 rs = _rate(_two(_leg(true, 100e18, 1e18), _leg(false, 100e18, 1e18)), ss[i], 6000, day);
            uint256 lo = rc < rp ? rc : rp;
            uint256 hi = rc < rp ? rp : rc;
            assertGe(rs + 1, lo);
            assertLe(rs, hi + 1);
        }
    }

    function test_condorRateInsideAndOutside() public pure {
        TempoBlend.Part[] memory week = TempoBlend.single(7 days);
        StrategyMath.Leg[] memory condor = _condor();
        // Far below every strike: all legs out of the money, a positive finite rate
        uint256 low = _rate(condor, 60e18, 5000, week);
        assertGt(low, 0);
        assertLt(low, 1e36); // under 1 per second
        // In the middle of the body the condor is worth less than its payoff (10): time value < 0, rate 0
        (int256 v, int256 f,) = ShapeFunding.sums(condor, 105e18, 5000, week, _b());
        assertGt(v, 0);
        assertLt(f, 0);
        assertEq(_rate(condor, 105e18, 5000, week), 0);
    }

    // ---------------------------------------------------------------- 4. zero value and validation

    function test_zeroValueAndSignCases() public pure {
        assertEq(ShapeFunding.combine(0, 0, 7 days), Math.ceilDiv(1e36, 7 days), "worthless: 1/max tempo");
        assertEq(ShapeFunding.combine(0, 5, 7 days), 0);
        assertEq(ShapeFunding.combine(0, -5, 7 days), 0);
        assertEq(ShapeFunding.combine(5, 0, 7 days), 0);
        assertEq(ShapeFunding.combine(5, -1, 7 days), 0);
        assertEq(ShapeFunding.combine(-5, 1, 7 days), 0);
        assertEq(ShapeFunding.combine(-5, -1, 7 days), 0.2e36);
        assertEq(ShapeFunding.combine(3, 1, 7 days), Math.ceilDiv(1e36, 3), "rounded up");
        // Two legs that cancel exactly: value and funding 0, the worthless limit
        StrategyMath.Leg[] memory none = _two(_leg(true, 100e18, 1e18), _leg(true, 100e18, -1e18));
        assertEq(_rate(none, 100e18, 5000, _move4()), Math.ceilDiv(1e36, 30 days));
    }

    function test_validateLegs() public {
        TempoBlend.Part[] memory day = TempoBlend.single(1 days);
        vm.expectRevert(ShapeFunding.NoLegs.selector);
        h.rate(new StrategyMath.Leg[](0), 100e18, 5000, day);

        StrategyMath.Leg[] memory five = new StrategyMath.Leg[](5);
        for (uint256 j; j < 5; ++j) {
            five[j] = _leg(true, (90 + 5 * j) * 1e18, 1e18);
        }
        vm.expectRevert(abi.encodeWithSelector(ShapeFunding.TooManyLegs.selector, 5));
        h.rate(five, 100e18, 5000, day);

        StrategyMath.Leg[] memory zero = _two(_leg(true, 100e18, 1e18), _leg(false, 90e18, 0));
        vm.expectRevert(abi.encodeWithSelector(ShapeFunding.ZeroQty.selector, 1));
        h.rate(zero, 100e18, 5000, day);

        vm.expectRevert(abi.encodeWithSelector(ShapeFunding.QtyTooLarge.selector, 0, int256(100e18 + 1)));
        h.rate(_one(true, 100e18, 100e18 + 1), 100e18, 5000, day);
        vm.expectRevert(abi.encodeWithSelector(ShapeFunding.QtyTooLarge.selector, 0, -int256(100e18 + 1)));
        h.rate(_one(true, 100e18, -(100e18 + 1)), 100e18, 5000, day);

        // the limits themselves are allowed
        assertGt(h.rate(_one(true, 100e18, -100e18), 100e18, 5000, day), 0);
        assertGt(h.rate(_condor(), 60e18, 5000, day), 0);
    }

    // ---------------------------------------------------------------- 5. the walk

    struct Path {
        uint256[] ts;
        uint256[] ss;
        uint256[] sigs;
        uint256 openAt;
        PathFunding.Cursor start; // opened between the first two samples
    }

    /// Records a varying path of `n` samples (one per 5-minute bucket, ±3% moves, σ 30%–120%) and opens a cursor
    /// between the first two samples.
    function _path(bytes32 m, uint256 n, uint256 seed) internal returns (Path memory p) {
        p.ts = new uint256[](n);
        p.ss = new uint256[](n);
        p.sigs = new uint256[](n);
        uint256 s = 100e18;
        for (uint256 i; i < n; ++i) {
            uint256 rnd = uint256(keccak256(abi.encode(seed, i)));
            p.ts[i] = T0 + i * 5 minutes + (rnd % 300);
            s = s * (97_000 + (rnd >> 16) % 6_001) / 100_000;
            p.ss[i] = s;
            p.sigs[i] = 3000 + (rnd >> 64) % 9001;
        }
        p.openAt = p.ts[0] + (p.ts[1] - p.ts[0]) / 2;
        h.record(m, p.ts[0], p.ss[0], p.sigs[0]);
        p.start = h.open(m, p.openAt); // the first sample is in effect at the open
        for (uint256 i = 1; i < n; ++i) {
            h.record(m, p.ts[i], p.ss[i], p.sigs[i]);
        }
    }

    function _terms(StrategyMath.Leg[] memory legs, TempoBlend.Part[] memory m)
        internal
        pure
        returns (ShapeFunding.Terms memory)
    {
        return ShapeFunding.Terms(legs, m, _b());
    }

    /// Brute force over every sample: X = Σ ceil(rate·Δt / 1e18), and the product of the per-step factors.
    function _reference(Path memory p, ShapeFunding.Terms memory terms)
        internal
        pure
        returns (uint256 xRef, uint256 prod)
    {
        prod = 1e18;
        for (uint256 i; i + 1 < p.ts.length; ++i) {
            uint256 from = p.ts[i] > p.openAt ? p.ts[i] : p.openAt;
            uint256 dx =
                Math.ceilDiv(_rate(terms.legs, p.ss[i], p.sigs[i], terms.movement) * (p.ts[i + 1] - from), 1e18);
            xRef += dx;
            prod = prod * PathFunding.factor(dx) / 1e18;
        }
    }

    function test_oneLegShapeWalksExactlyLikeTheSingleLegWalk() public {
        Path memory p = _path("ONE", 60, 7);
        TempoBlend.Part[] memory mv = _move4();
        PathFunding.Cursor memory start = p.start;
        (PathFunding.Cursor memory a,) = h.walkLeg("ONE", start, PathFunding.Terms(false, 103e18, mv, _b()), ALL);
        (PathFunding.Cursor memory b,) = h.walkShape("ONE", start, _terms(_one(false, 103e18, -2e18), mv), ALL);
        assertEq(b.x, a.x);
        assertEq(b.at, a.at);
        assertEq(b.eff, a.eff);
        assertGt(a.x, 0);
    }

    function test_exactVaryingPathTwoAndFourLegs() public {
        _exactPath("SPREAD", _terms(_callSpread(), TempoBlend.single(1 days)), 11);
        _exactPath("PUTSPREAD", _terms(_two(_leg(false, 100e18, 1e18), _leg(false, 92e18, -1e18)), _move4()), 12);
        _exactPath("CONDOR", _terms(_condor(), TempoBlend.single(3 days)), 13);
        _exactPath("MIXED", _terms(_randomLegs(4 * 1000 + 3), _move4()), 14);
    }

    function _exactPath(bytes32 m, ShapeFunding.Terms memory terms, uint256 seed) internal {
        Path memory p = _path(m, 60, seed);
        PathFunding.Cursor memory cur = p.start;
        uint256 steps;
        (cur, steps) = h.walkShape(m, cur, terms, ALL);
        assertEq(steps, 59);
        assertEq(cur.at, p.ts[59]);
        (uint256 xRef, uint256 prod) = _reference(p, terms);
        assertEq(cur.x, xRef);
        assertApproxEqRel(PathFunding.factor(cur.x), prod, REL_1E12);
    }

    function test_resumableAndToucherIndependent() public {
        Path memory p = _path("CHUNK", 60, 21);
        ShapeFunding.Terms memory terms = _terms(_condor(), _move4());
        PathFunding.Cursor memory start = p.start;
        (PathFunding.Cursor memory whole,) = h.walkShape("CHUNK", start, terms, ALL);
        PathFunding.Cursor memory cur = start;
        uint256 walked;
        while (cur.at < p.ts[59]) {
            uint256 steps;
            (cur, steps) = h.walkShape("CHUNK", cur, terms, 7); // anyone, any chunk size
            walked += steps;
        }
        assertEq(walked, 59);
        assertEq(cur.x, whole.x);
        assertEq(cur.at, whole.at);
    }

    /// 6. Fuzz: on any path, step by step, X never falls and the factor never rises; a step adds nothing exactly when
    ///    the shape's value and funding have opposite signs (or funding is 0) at the sample in effect.
    function testFuzz_factorNeverRises(uint256 seed) public {
        bytes32 m = keccak256(abi.encode("FUZZ", seed));
        Path memory p = _path(m, 30, seed);
        ShapeFunding.Terms memory terms =
            _terms(_randomLegs(seed >> 3), seed % 2 == 0 ? TempoBlend.single(1 hours + seed % 10 days) : _move4());
        PathFunding.Cursor memory cur = p.start;
        uint256 lastFactor = 1e18;
        for (uint256 i; i + 1 < p.ts.length; ++i) {
            uint256 xBefore = cur.x;
            (cur,) = h.walkShape(m, cur, terms, 1);
            assertGe(cur.x, xBefore);
            uint256 fct = PathFunding.factor(cur.x);
            assertLe(fct, lastFactor);
            lastFactor = fct;
            (int256 v, int256 f,) = ShapeFunding.sums(terms.legs, p.ss[i], p.sigs[i], terms.movement, _b());
            bool floored = v == 0 ? f != 0 : (f == 0 || (v > 0) != (f > 0));
            if (floored) assertEq(cur.x, xBefore, "floored: nothing added");
            else assertGt(cur.x, xBefore, "a positive rate always adds");
        }
    }

    // ---------------------------------------------------------------- 7. gas

    function test_rateGas() public view {
        TempoBlend.Part[] memory one = TempoBlend.single(7 days);
        TempoBlend.Part[] memory four = _move4();
        StrategyMath.Leg[] memory l1 = _one(true, 100e18, 1e18);
        StrategyMath.Leg[] memory l2 = _callSpread();
        StrategyMath.Leg[] memory l4 = _condor();
        uint256 g;
        g = gasleft();
        TempoBlend.rateE36(true, 104e18, 100e18, 6000, one, _b());
        console2.log("single leg today, 1 tempo   ", g - gasleft());
        g = gasleft();
        _rate(l1, 104e18, 6000, one);
        console2.log("shape 1 leg, 1 tempo        ", g - gasleft());
        g = gasleft();
        _rate(l2, 104e18, 6000, one);
        console2.log("shape 2 legs, 1 tempo       ", g - gasleft());
        g = gasleft();
        _rate(l4, 104e18, 6000, one);
        console2.log("shape 4 legs, 1 tempo       ", g - gasleft());
        g = gasleft();
        TempoBlend.rateE36(true, 104e18, 100e18, 6000, four, _b());
        console2.log("single leg today, 4 tempos  ", g - gasleft());
        g = gasleft();
        _rate(l2, 104e18, 6000, four);
        console2.log("shape 2 legs, 4 tempos      ", g - gasleft());
        g = gasleft();
        _rate(l4, 104e18, 6000, four);
        console2.log("shape 4 legs, 4 tempos      ", g - gasleft());
    }
}
