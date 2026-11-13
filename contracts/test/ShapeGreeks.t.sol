// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ShapeGreeks} from "../src/ShapeGreeks.sol";
import {StrategyMath} from "../src/StrategyMath.sol";
import {TempoBlend} from "../src/TempoBlend.sol";

contract GreeksHarness {
    function greeks(StrategyMath.Leg[] memory legs, uint256 s, uint256 sigma, TempoBlend.Part[] memory mv)
        external
        pure
        returns (int256 d, int256 v)
    {
        return (ShapeGreeks.delta(legs, s, sigma, mv), ShapeGreeks.vega(legs, s, sigma, mv));
    }
}

/// M7 step 8: on-chain Greeks against an independent reference: the analytic delta of the TypeScript port
/// (services/common/src/tempo.ts, `blendDelta`) and a numeric vega from its floating-point values (± 1 bp), computed
/// off-chain and pinned here.
contract ShapeGreeksTest is Test {
    GreeksHarness h;

    function setUp() public {
        h = new GreeksHarness();
    }

    function _legs2(bool c0, uint128 k0, int128 q0, bool c1, uint128 k1, int128 q1)
        internal
        pure
        returns (StrategyMath.Leg[] memory l)
    {
        l = new StrategyMath.Leg[](2);
        l[0] = StrategyMath.Leg(c0, k0, q0);
        l[1] = StrategyMath.Leg(c1, k1, q1);
    }

    function _close(int256 got, int256 want, uint256 relBps, int256 absWad, string memory what) internal pure {
        int256 diff = got > want ? got - want : want - got;
        int256 mag = want < 0 ? -want : want;
        assertTrue(diff <= absWad || uint256(diff) * 10_000 <= uint256(mag) * relBps, what);
    }

    function test_greeksMatchTheIndependentReference() public view {
        // reference (TypeScript): delta, vega per vol point
        (int256 d, int256 v) =
            h.greeks(_legs2(true, 70_000e18, 1e18, true, 75_000e18, -1e18), 70_000e18, 4500, TempoBlend.single(1 days));
        _close(d, 0.495875e18, 20, 0.0005e18, "call spread delta");
        _close(v, 11.857685e18, 50, 0.01e18, "call spread vega");

        (d, v) = h.greeks(
            _legs2(false, 65_000e18, -1e18, false, 70_000e18, 1e18), 70_000e18, 4500, TempoBlend.single(7 days)
        );
        _close(d, -0.401358e18, 20, 0.0005e18, "put spread delta (negative)");
        _close(v, 17.786588e18, 50, 0.01e18, "put spread vega");

        StrategyMath.Leg[] memory call = new StrategyMath.Leg[](1);
        call[0] = StrategyMath.Leg(true, 72_000e18, 1e18);
        (d, v) = h.greeks(call, 70_000e18, 6000, TempoBlend.single(7 days));
        _close(d, 0.323099e18, 20, 0.0005e18, "call delta");
        _close(v, 31.794848e18, 50, 0.01e18, "call vega");

        (d, v) =
            h.greeks(_legs2(false, 70_000e18, 1e18, true, 70_000e18, 1e18), 70_000e18, 4500, TempoBlend.single(1 days));
        _close(d, 0.008327e18, 0, 0.0005e18, "swing delta near zero");
        _close(v, 25.905468e18, 50, 0.01e18, "swing vega");
    }

    function test_usdConversions() public pure {
        // 0.5 delta × $70,000 × 2 units = $70,000; vega 11.86 × 2 = $23.72 per vol point
        assertEq(ShapeGreeks.deltaUsd(0.5e18, 70_000e18, 2e18), 70_000e6);
        assertEq(ShapeGreeks.deltaUsd(-0.5e18, 70_000e18, 2e18), 70_000e6);
        assertEq(ShapeGreeks.vegaUsd(11.86e18, 2e18), 23.72e6);
    }

    function test_vegaAtTheSigmaBoundsIsOneSided() public view {
        StrategyMath.Leg[] memory call = new StrategyMath.Leg[](1);
        call[0] = StrategyMath.Leg(true, 70_000e18, 1e18);
        (, int256 lo) = h.greeks(call, 70_000e18, 500, TempoBlend.single(1 days));
        (, int256 hi) = h.greeks(call, 70_000e18, 50_000, TempoBlend.single(1 days));
        assertGt(lo, 0);
        assertGt(hi, 0);
    }
}
