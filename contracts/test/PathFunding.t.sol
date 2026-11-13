// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TempoMath} from "../src/TempoMath.sol";
import {TempoBlend} from "../src/TempoBlend.sol";
import {PathFunding} from "../src/PathFunding.sol";

/// Exposes the library over one history per market.
contract PathFundingHarness {
    mapping(bytes32 => PathFunding.History) internal _h;

    function record(bytes32 m, uint256 t, uint256 s, uint256 sigmaBps) external returns (bool, bool, bool) {
        return PathFunding.record(_h[m], t, s, sigmaBps);
    }

    function open(bytes32 m, uint256 at) external view returns (PathFunding.Cursor memory) {
        return PathFunding.open(_h[m], at);
    }

    function walk(bytes32 m, PathFunding.Cursor memory cur, PathFunding.Terms memory terms, uint256 maxSteps)
        external
        view
        returns (PathFunding.Cursor memory, uint256)
    {
        return PathFunding.walk(_h[m], cur, terms, maxSteps);
    }
}

contract PathFundingTest is Test {
    uint256 constant T0 = 1_800_000_000 - (1_800_000_000 % 1 days); // a day boundary
    uint256 constant REL_1E12 = 1e6; // 1e-12 relative, in WAD
    uint256 constant ALL = type(uint256).max;
    PathFundingHarness h;

    function setUp() public {
        h = new PathFundingHarness();
    }

    function _terms(bool isCall, uint256 k, TempoBlend.Part[] memory m)
        internal
        pure
        returns (PathFunding.Terms memory)
    {
        return PathFunding.Terms(isCall, k, m, TempoMath.defaultBounds());
    }

    /// Shrink rate per second at 36 decimals, straight from TempoBlend.
    function _rateE36(PathFunding.Terms memory terms, uint256 s, uint256 sig) internal pure returns (uint256) {
        return TempoBlend.rateE36(terms.isCall, s, terms.strike, sig, terms.movement, terms.bounds);
    }

    /// Walks a constant path of `n` equal samples spanning `span` seconds from T0; returns X.
    function _constantPath(bytes32 m, PathFunding.Terms memory terms, uint256 s, uint256 sig, uint256 span, uint256 n)
        internal
        returns (uint256)
    {
        h.record(m, T0, s, sig);
        PathFunding.Cursor memory cur = h.open(m, T0);
        for (uint256 i = 1; i <= n; ++i) {
            h.record(m, T0 + span * i / n, s, sig);
        }
        uint256 steps;
        (cur, steps) = h.walk(m, cur, terms, ALL);
        assertEq(steps, n);
        assertEq(cur.at, T0 + span);
        return cur.x;
    }

    /// 1. Closed-form step: over a constant sample, units shrink by exactly exp(−r·Δt).
    function test_closedFormStep() public {
        TempoMath.SigmaBounds memory b = TempoMath.defaultBounds();

        // At the money, 1-day tempo, one day: r = 1/tempo, so X = 1 and the factor is 1/e
        uint256 x = _constantPath("ATM", _terms(true, 100e18, TempoBlend.single(1 days)), 100e18, 5000, 1 days, 1);
        assertApproxEqRel(x, 1e18, REL_1E12);
        assertApproxEqRel(PathFunding.factor(x), 0.367879441171442321e18, REL_1E12);

        // In the money: X = TV/V over one tempo, straight from TempoMath
        (uint256 v, uint256 tv) = TempoMath.valueAndTimeValue(true, 120e18, 100e18, 5000, 1 days, b);
        x = _constantPath("ITM", _terms(true, 100e18, TempoBlend.single(1 days)), 120e18, 5000, 1 days, 1);
        assertApproxEqRel(x, tv * 1e18 / v, REL_1E12);

        // A Movement (50% Day, 50% Week) over 12 hours: X = (Σ w·TV/tempo ÷ Σ w·V)·Δt
        TempoBlend.Part[] memory mv = new TempoBlend.Part[](2);
        mv[0] = TempoBlend.Part(1 days, 0.5e18);
        mv[1] = TempoBlend.Part(7 days, 0.5e18);
        (uint256 v1, uint256 tv1) = TempoMath.valueAndTimeValue(false, 95e18, 100e18, 7000, 1 days, b);
        (uint256 v7, uint256 tv7) = TempoMath.valueAndTimeValue(false, 95e18, 100e18, 7000, 7 days, b);
        uint256 expected = (tv1 * 1e18 / 1 days + tv7 * 1e18 / 7 days) * 12 hours / (v1 + v7);
        x = _constantPath("MOVE", _terms(false, 100e18, mv), 95e18, 7000, 12 hours, 1);
        assertApproxEqRel(x, expected, REL_1E12);

        // Splitting a constant stretch into many samples changes nothing beyond rounding: 1 step vs 12
        // steps differ by at most 1 wei per extra step, since each step rounds up
        uint256 one = _constantPath("ONE", _terms(true, 100e18, TempoBlend.single(3 days)), 104e18, 6000, 1 hours, 1);
        uint256 twelve =
            _constantPath("TWELVE", _terms(true, 100e18, TempoBlend.single(3 days)), 104e18, 6000, 1 hours, 12);
        assertGe(twelve, one);
        assertLe(twelve - one, 11);

        // A second sample in the latest 5-minute bucket is ignored quietly: no level takes it,
        // and the stretch is still charged at the first price
        PathFunding.Terms memory day = _terms(true, 100e18, TempoBlend.single(1 days));
        h.record("EARLY", T0, 100e18, 5000);
        PathFunding.Cursor memory cur = h.open("EARLY", T0);
        (bool w0, bool w1, bool w2) = h.record("EARLY", T0 + 1 minutes, 150e18, 5000);
        assertFalse(w0 || w1 || w2);
        (w0, w1, w2) = h.record("EARLY", T0 + 1 hours, 100e18, 5000);
        assertTrue(w0 && w1 && !w2); // new bucket and new hour, same day
        (cur,) = h.walk("EARLY", cur, day, ALL);
        x = _constantPath("EARLYREF", day, 100e18, 5000, 1 hours, 1);
        assertEq(cur.x, x);

        // A sample for an earlier bucket would rewrite history: refused
        vm.expectRevert(abi.encodeWithSelector(PathFunding.NotIncreasing.selector, T0 + 1 hours, T0 + 30 minutes));
        h.record("EARLY", T0 + 30 minutes, 100e18, 5000);
    }

    /// 2. A varying path: the walk matches a brute-force reference over every sample (1e-12).
    function test_exactVaryingPath() public {
        TempoBlend.Part[] memory mv = new TempoBlend.Part[](3);
        mv[0] = TempoBlend.Part(1 hours, 0.2e18);
        mv[1] = TempoBlend.Part(1 days, 0.5e18);
        mv[2] = TempoBlend.Part(30 days, 0.3e18);
        _varyingPath("CALL", _terms(true, 100e18, TempoBlend.single(1 days)), 1);
        _varyingPath("PUT", _terms(false, 105e18, TempoBlend.single(4 hours)), 2);
        _varyingPath("MOVE", _terms(true, 98e18, mv), 3);
    }

    function _varyingPath(bytes32 m, PathFunding.Terms memory terms, uint256 seed) internal {
        uint256 n = 60; // one per 5-minute bucket, all still held at level 0
        uint256[] memory ts = new uint256[](n);
        uint256[] memory ss = new uint256[](n);
        uint256[] memory sigs = new uint256[](n);
        uint256 s = 100e18;
        for (uint256 i; i < n; ++i) {
            uint256 rnd = uint256(keccak256(abi.encode(seed, i)));
            ts[i] = T0 + i * 5 minutes + (rnd % 300); // anywhere inside its bucket
            // price moves up to ±3% per sample; σ between 30% and 120%
            s = s * (97_000 + (rnd >> 16) % 6_001) / 100_000;
            ss[i] = s;
            sigs[i] = 3000 + (rnd >> 64) % 9001;
        }

        // Open between the first two samples; the first sample is in effect at the open
        uint256 openAt = ts[0] + (ts[1] - ts[0]) / 2;
        h.record(m, ts[0], ss[0], sigs[0]);
        PathFunding.Cursor memory cur = h.open(m, openAt);
        for (uint256 i = 1; i < n; ++i) {
            h.record(m, ts[i], ss[i], sigs[i]);
        }
        uint256 steps;
        (cur, steps) = h.walk(m, cur, terms, ALL);
        assertEq(steps, n - 1);
        assertEq(cur.at, ts[n - 1]);

        // Brute force: every sample holds until the next; sum r·Δt, and separately multiply exps
        uint256 xRef;
        uint256 prodRef = 1e18;
        for (uint256 i; i + 1 < n; ++i) {
            uint256 from = ts[i] > openAt ? ts[i] : openAt;
            uint256 dx = Math.ceilDiv(_rateE36(terms, ss[i], sigs[i]) * (ts[i + 1] - from), 1e18);
            xRef += dx;
            prodRef = prodRef * PathFunding.factor(dx) / 1e18;
        }
        assertEq(cur.x, xRef);
        assertApproxEqRel(PathFunding.factor(cur.x), prodRef, REL_1E12);
        assertGt(cur.x, 0);
    }

    /// 3. ITM/OTM rates: out of the money units shrink at exactly 1/tempo; in the money slower,
    ///    the deeper the slower; deep out of the money with value 0 uses the 1/max-tempo limit.
    function test_itmOtmRates() public {
        uint256 e1 = 0.367879441171442321e18; // exp(−1)
        TempoBlend.Part[] memory day = TempoBlend.single(1 days);

        // OTM call and OTM put: X = Δt/tempo exactly, so one tempo gives 1/e
        uint256 xOtmCall = _constantPath("OTMC", _terms(true, 100e18, day), 80e18, 5000, 1 days, 4);
        uint256 xOtmPut = _constantPath("OTMP", _terms(false, 100e18, day), 125e18, 5000, 1 days, 4);
        assertApproxEqRel(xOtmCall, 1e18, REL_1E12);
        assertApproxEqRel(xOtmPut, 1e18, REL_1E12);
        assertApproxEqRel(PathFunding.factor(xOtmCall), e1, REL_1E12);

        // ITM call: slower than 1/tempo, and slower still deeper in the money
        uint256 xItm = _constantPath("ITM", _terms(true, 100e18, day), 110e18, 5000, 1 days, 4);
        uint256 xDeep = _constantPath("DEEP", _terms(true, 100e18, day), 150e18, 5000, 1 days, 4);
        assertLt(xItm, 1e18);
        assertLt(xDeep, xItm);
        assertGt(PathFunding.factor(xDeep), PathFunding.factor(xItm));
        assertGt(PathFunding.factor(xItm), e1);

        // ITM put mirrors it
        uint256 xItmPut = _constantPath("ITMP", _terms(false, 100e18, day), 90e18, 5000, 1 days, 4);
        assertLt(xItmPut, 1e18);

        // Deep OTM, value rounds to 0: the rate is the 1/max-tempo limit
        TempoBlend.Part[] memory mv = new TempoBlend.Part[](2);
        mv[0] = TempoBlend.Part(1 hours, 0.5e18);
        mv[1] = TempoBlend.Part(2 hours, 0.5e18);
        assertEq(TempoBlend.value(true, 1e18, 1000e18, 500, mv), 0);
        uint256 xZero = _constantPath("ZERO", _terms(true, 1000e18, mv), 1e18, 500, 2 hours, 2);
        assertEq(xZero, Math.ceilDiv(Math.ceilDiv(1e36, 2 hours) * 1 hours, 1e18) * 2); // rounded up
    }
}
