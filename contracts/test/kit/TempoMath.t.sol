// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Kit suite: TempoMath (4 tests), run against our TempoMath.
///
/// Changes from the kit file, and why:
///   1. Contracts renamed KitTempoHarness / KitTempoMathTest so names do not clash with our suite.
///   2. σ passed in basis points instead of WAD (our unit, decision Q2): 0.5e18 -> 5000, 0.4e18 -> 4000,
///      0.45e18 -> 4500; fuzz bound 0.05e18..5e18 -> 500..50_000.
///   3. test_domain expects our specific errors (TempoOutOfRange, SigmaOutOfBounds) instead of Domain().
///   Values, tolerances and assertions are otherwise unchanged.

import {Test} from "forge-std/Test.sol";
import {TempoMath} from "../../src/TempoMath.sol";

contract KitTempoHarness {
    function value(bool c, uint256 s, uint256 k, uint256 sigBps, uint256 t) external pure returns (uint256) {
        return TempoMath.value(c, s, k, sigBps, t);
    }
}

contract KitTempoMathTest is Test {
    KitTempoHarness h = new KitTempoHarness();

    function test_reference_values() public view {
        assertApproxEqRel(h.value(true, 100e18, 100e18, 5000, 1 days), 0.92525e18, 1e14, "ATM, 1-day tempo");
        assertApproxEqRel(h.value(true, 120e18, 100e18, 4000, 7 days), 20.0204e18, 1e13, "ITM, 7-day tempo");
    }

    function test_parity_and_continuity_at_strike() public view {
        uint256 c = h.value(true, 95e18, 100e18, 4500, 3 days);
        uint256 p = h.value(false, 95e18, 100e18, 4500, 3 days);
        assertApproxEqAbs(int256(c) - int256(p), -5e18, 1e3);
        uint256 below = h.value(true, 100e18 - 1, 100e18, 4500, 3 days);
        uint256 above = h.value(true, 100e18 + 1, 100e18, 4500, 3 days);
        assertApproxEqAbs(below, above, 1e6, "continuous at S = K");
    }

    function testFuzz_bounds_and_monotone(uint256 s, uint256 sig, uint256 t) public view {
        s = bound(s, 1e18, 1e24);
        sig = bound(sig, 500, 50_000);
        t = bound(t, 1 hours, 30 days);
        uint256 c = h.value(true, s, 100e18, sig, t);
        assertLe(c, s + 1, "call <= S");
        assertGe(c + 1, s > 100e18 ? s - 100e18 : 0, "call >= intrinsic");
        uint256 cLonger = h.value(true, s, 100e18, sig, t + 1 hours > 30 days ? t : t + 1 hours);
        assertGe(cLonger + 1, c, "longer tempo is worth at least as much");
    }

    function test_domain() public {
        vm.expectRevert(abi.encodeWithSelector(TempoMath.TempoOutOfRange.selector, 30 minutes));
        h.value(true, 100e18, 100e18, 5000, 30 minutes);
        vm.expectRevert(abi.encodeWithSelector(TempoMath.SigmaOutOfBounds.selector, 60_000, 500, 50_000));
        h.value(true, 100e18, 100e18, 60_000, 1 days);
    }
}
