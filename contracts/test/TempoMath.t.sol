// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TempoMath} from "../src/TempoMath.sol";

/// External wrapper so reverts happen one call deep.
contract TempoMathHarness {
    function value(bool isCall, uint256 s, uint256 k, uint256 sigmaBps, uint256 tempo) external pure returns (uint256) {
        return TempoMath.value(isCall, s, k, sigmaBps, tempo);
    }

    function valueWithBounds(
        bool isCall,
        uint256 s,
        uint256 k,
        uint256 sigmaBps,
        uint256 tempo,
        uint256 minBps,
        uint256 maxBps
    ) external pure returns (uint256 v) {
        (v,) = TempoMath.valueAndTimeValue(isCall, s, k, sigmaBps, tempo, TempoMath.SigmaBounds(minBps, maxBps));
    }
}

contract TempoMathTest is Test {
    uint256 constant REL_1E5 = 1e13; // 1e-5 relative, in WAD
    TempoMathHarness h;

    function setUp() public {
        h = new TempoMathHarness();
    }

    function _call(uint256 s, uint256 k, uint256 sig, uint256 t) internal pure returns (uint256) {
        return TempoMath.value(true, s, k, sig, t);
    }

    function _put(uint256 s, uint256 k, uint256 sig, uint256 t) internal pure returns (uint256) {
        return TempoMath.value(false, s, k, sig, t);
    }

    /// Spec reference values, Overview examples, and put-call parity.
    function test_referenceValuesAndParity() public pure {
        // 0.92525: at the money, S = K = 100, σ 50%, 1-day tempo
        assertApproxEqRel(_call(100e18, 100e18, 5000, 1 days), 0.92525e18, REL_1E5);
        // 20.0204: call S 120 / K 100, σ 40%, 7-day tempo, and the mirror put S 100 / K 120
        assertApproxEqRel(_call(120e18, 100e18, 4000, 7 days), 20.0204e18, REL_1E5);
        assertApproxEqRel(_put(100e18, 120e18, 4000, 7 days), 20.0204e18, REL_1E5);

        // Overview section 2 examples (underlying 100, σ 50%)
        assertApproxEqRel(_call(100e18, 100e18, 5000, 3 days), 1.602446e18, REL_1E5); // Rise, 3-day
        uint256 atmWeek = _call(100e18, 100e18, 5000, 7 days);
        assertApproxEqRel(atmWeek + _put(100e18, 100e18, 5000, 7 days), 4.894716e18, REL_1E5); // Swing
        assertApproxEqRel(atmWeek - _call(100e18, 110e18, 5000, 7 days), 2.081145e18, REL_1E5); // 100/110 spread
        assertApproxEqRel(_put(100e18, 90e18, 5000, 7 days), 0.269764e18, REL_1E5); // Fall 90
        assertApproxEqRel(_call(100e18, 110e18, 5000, 7 days), 0.366213e18, REL_1E5); // Rise 110

        // Parity: call − put = S − K, exactly up to rounding, across moneyness
        uint256[5] memory spots = [uint256(50e18), 90e18, 100e18, 110e18, 200e18];
        for (uint256 i; i < spots.length; ++i) {
            uint256 s = spots[i];
            int256 c = int256(_call(s, 100e18, 6000, 2 days));
            int256 p = int256(_put(s, 100e18, 6000, 2 days));
            assertApproxEqAbs(c - p, int256(s) - 100e18, 2);
        }
    }

    /// Value is continuous at the strike, and so is its slope (the two branches meet smoothly).
    function test_continuityAtStrike() public pure {
        uint256[3] memory sigmas = [uint256(500), 5000, 50_000];
        uint256[3] memory tempos = [uint256(1 hours), 1 days, 30 days];
        uint256 k = 100e18;
        uint256 delta = 1e12; // 1e-8 of the strike
        for (uint256 i; i < 3; ++i) {
            for (uint256 j; j < 3; ++j) {
                for (uint256 c; c < 2; ++c) {
                    bool isCall = c == 0;
                    uint256 lo = TempoMath.value(isCall, k - delta, k, sigmas[i], tempos[j]);
                    uint256 mid = TempoMath.value(isCall, k, k, sigmas[i], tempos[j]);
                    uint256 hi = TempoMath.value(isCall, k + delta, k, sigmas[i], tempos[j]);
                    // |ΔV| ≤ |ΔS| since |delta| ≤ 1 for both calls and puts (plus rounding)
                    assertLe(_absDiff(mid, lo), delta + 10);
                    assertLe(_absDiff(hi, mid), delta + 10);
                    // one-sided slopes agree: no kink at the strike
                    int256 left = (int256(mid) - int256(lo)) * 1e18 / int256(delta);
                    int256 right = (int256(hi) - int256(mid)) * 1e18 / int256(delta);
                    assertApproxEqAbs(left, right, 1e15);
                }
            }
        }
    }

    /// Fuzz: intrinsic ≤ V ≤ S (call) or K (put), and V does not fall as the tempo lengthens.
    function testFuzz_boundsAndMonotonicity(uint256 s, uint256 k, uint256 sig, uint256 t1, uint256 t2) public pure {
        s = bound(s, 1e15, 1e24);
        k = bound(k, 1e15, 1e24);
        sig = bound(sig, TempoMath.DEFAULT_MIN_SIGMA_BPS, TempoMath.DEFAULT_MAX_SIGMA_BPS);
        t1 = bound(t1, TempoMath.MIN_TEMPO, TempoMath.MAX_TEMPO);
        t2 = bound(t2, t1, TempoMath.MAX_TEMPO);

        uint256 c1 = _call(s, k, sig, t1);
        uint256 p1 = _put(s, k, sig, t1);
        assertGe(c1, s > k ? s - k : 0);
        assertLe(c1, s);
        assertGe(p1, k > s ? k - s : 0);
        assertLe(p1, k);

        // Longer tempo, more time value. Allow 1e-12 relative for pow rounding.
        uint256 c2 = _call(s, k, sig, t2);
        uint256 p2 = _put(s, k, sig, t2);
        assertGe(c2 + c1 / 1e12 + 1, c1);
        assertGe(p2 + p1 / 1e12 + 1, p1);
    }

    /// Every input the spec rejects reverts with its own error.
    function test_domainErrors() public {
        vm.expectRevert(TempoMath.ZeroSpot.selector);
        h.value(true, 0, 100e18, 5000, 1 days);

        vm.expectRevert(TempoMath.ZeroStrike.selector);
        h.value(true, 100e18, 0, 5000, 1 days);

        vm.expectRevert(TempoMath.ZeroSigma.selector);
        h.value(false, 100e18, 100e18, 0, 1 days);

        vm.expectRevert(abi.encodeWithSelector(TempoMath.TempoOutOfRange.selector, 1 hours - 1));
        h.value(true, 100e18, 100e18, 5000, 1 hours - 1);

        vm.expectRevert(abi.encodeWithSelector(TempoMath.TempoOutOfRange.selector, 30 days + 1));
        h.value(true, 100e18, 100e18, 5000, 30 days + 1);

        vm.expectRevert(abi.encodeWithSelector(TempoMath.SigmaOutOfBounds.selector, 499, 500, 50_000));
        h.value(true, 100e18, 100e18, 499, 1 days);

        vm.expectRevert(abi.encodeWithSelector(TempoMath.SigmaOutOfBounds.selector, 50_001, 500, 50_000));
        h.value(true, 100e18, 100e18, 50_001, 1 days);

        vm.expectRevert(abi.encodeWithSelector(TempoMath.PriceTooLarge.selector, 1e36 + 1));
        h.value(true, 1e36 + 1, 100e18, 5000, 1 days);

        // Bounds are configurable but must be sane
        vm.expectRevert(abi.encodeWithSelector(TempoMath.InvalidSigmaBounds.selector, 0, 1000));
        h.valueWithBounds(true, 100e18, 100e18, 500, 1 days, 0, 1000);
        vm.expectRevert(abi.encodeWithSelector(TempoMath.InvalidSigmaBounds.selector, 2000, 1000));
        h.valueWithBounds(true, 100e18, 100e18, 1500, 1 days, 2000, 1000);

        // Custom bounds widen or narrow the accepted range; edges are inclusive
        assertGt(h.valueWithBounds(true, 100e18, 100e18, 100, 1 days, 100, 1000), 0);
        assertGt(h.value(true, 100e18, 100e18, 500, 1 hours), 0);
        assertGt(h.value(true, 100e18, 100e18, 50_000, 30 days), 0);
    }

    function _absDiff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }
}
