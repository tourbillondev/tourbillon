// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TempoMath} from "./TempoMath.sol";
import {TempoBlend} from "./TempoBlend.sol";
import {PathFunding} from "./PathFunding.sol";
import {StrategyMath} from "./StrategyMath.sol";

/// @title ShapeFunding
/// @notice Funding along the recorded price path for a shape: up to four legs held as one position, with **one shared
///         decay factor** (M4 decision D2). For legs (isCallⱼ, Kⱼ, qⱼ) and the movement's parts (tempoᵢ, wᵢ):
///           vNet = Σⱼ qⱼ·Σᵢ wᵢ·Vᵢⱼ             (the shape's value)
///           fNet = Σⱼ qⱼ·Σᵢ wᵢ·TVᵢⱼ/tempoᵢ     (its funding per second)
///           rate = fNet / vNet, and 0 when the two have opposite signs.
///         The floor at 0 means the factor never rises, so a writer's obligation only shrinks (law 4 at every moment).
///         The holder of a shape whose time value is negative (a deep in-the-money spread) then pays nothing rather
///         than receiving funding.
/// @dev    - Negating every leg leaves the rate unchanged, so a position and its mirror decay identically.
///         - Leg amounts are ratios in WAD (|q| ≤ 100), multiplied into each leg's sums with no division, so a one-leg
///           shape gives exactly TempoBlend.rateE36, and equal legs add exactly.
///         - vNet = 0: the 1/max-tempo limit when fNet is 0 too (today's rule for a worthless leg), otherwise 0.
///         - Strike rules, distinct legs and which shapes a buyer may hold are checked by the caller (M4 step 5).
library ShapeFunding {
    uint256 internal constant MAX_LEGS = 4;
    int256 internal constant MAX_QTY = 100e18;
    uint256 internal constant E36 = 1e36;

    struct Terms {
        StrategyMath.Leg[] legs;
        TempoBlend.Part[] movement;
        TempoMath.SigmaBounds bounds;
    }

    error NoLegs();
    error TooManyLegs(uint256 count);
    error ZeroQty(uint256 index);
    error QtyTooLarge(uint256 index, int256 qty);

    /// @notice Reverts unless there are 1–4 legs, each with a non-zero amount of at most 100 in absolute value.
    function validate(StrategyMath.Leg[] memory legs) internal pure {
        uint256 n = legs.length;
        if (n == 0) revert NoLegs();
        if (n > MAX_LEGS) revert TooManyLegs(n);
        for (uint256 j; j < n; ++j) {
            int256 q = legs[j].qty;
            if (q == 0) revert ZeroQty(j);
            if (q > MAX_QTY || q < -MAX_QTY) revert QtyTooLarge(j, q);
        }
    }

    /// @notice The shape's value and funding sums (1e36 × WAD-ratio scale, signed) and the longest tempo.
    /// @dev Each leg's sums are computed exactly as TempoBlend does, then multiplied by its amount.
    function sums(
        StrategyMath.Leg[] memory legs,
        uint256 s,
        uint256 sigmaBps,
        TempoBlend.Part[] memory m,
        TempoMath.SigmaBounds memory b
    ) internal pure returns (int256 vNet, int256 fNet, uint256 maxTempo) {
        validate(legs);
        TempoBlend.validate(m);
        for (uint256 j; j < legs.length; ++j) {
            (uint256 vLeg, uint256 fLeg) = _legSums(legs[j], s, sigmaBps, m, b);
            // |q| ≤ 1e20 and each sum ≤ 1e54 (prices ≤ 1e36, Σw = 1e18): products and four-leg totals fit int256
            vNet += int256(legs[j].qty) * int256(vLeg);
            fNet += int256(legs[j].qty) * int256(fLeg);
        }
        maxTempo = _maxTempo(m);
    }

    /// @dev One leg's Σ wᵢ·Vᵢ and Σ wᵢ·TVᵢ/tempoᵢ at 1e36 scale, exactly as TempoBlend sums them.
    function _legSums(
        StrategyMath.Leg memory leg,
        uint256 s,
        uint256 sigmaBps,
        TempoBlend.Part[] memory m,
        TempoMath.SigmaBounds memory b
    ) private pure returns (uint256 vLeg, uint256 fLeg) {
        for (uint256 i; i < m.length; ++i) {
            (uint256 vi, uint256 tvi) = TempoMath.valueAndTimeValue(leg.isCall, s, leg.kWad, sigmaBps, m[i].tempo, b);
            vLeg += m[i].weight * vi;
            fLeg += (m[i].weight * tvi) / m[i].tempo;
        }
    }

    function _maxTempo(TempoBlend.Part[] memory m) private pure returns (uint256 maxTempo) {
        for (uint256 i; i < m.length; ++i) {
            if (m[i].tempo > maxTempo) maxTempo = m[i].tempo;
        }
    }

    /// @notice Shrink rate per second at 36 decimals from the sums, rounded up (a non-zero rate never truncates to a
    ///         free interval), floored at 0 when value and funding have opposite signs.
    function combine(int256 vNet, int256 fNet, uint256 maxTempo) internal pure returns (uint256) {
        if (vNet == 0) return fNet == 0 ? Math.ceilDiv(E36, maxTempo) : 0;
        if (fNet == 0 || (vNet > 0) != (fNet > 0)) return 0;
        return Math.mulDiv(_abs(fNet), E36, _abs(vNet), Math.Rounding.Ceil);
    }

    /// @notice The shape's shrink rate per second at 36 decimals at price `s` and vol `sigmaBps` (no σ clamp).
    function rateE36(
        StrategyMath.Leg[] memory legs,
        uint256 s,
        uint256 sigmaBps,
        TempoBlend.Part[] memory m,
        TempoMath.SigmaBounds memory b
    ) internal pure returns (uint256) {
        (int256 vNet, int256 fNet, uint256 maxTempo) = sums(legs, s, sigmaBps, m, b);
        return combine(vNet, fNet, maxTempo);
    }

    /// @notice The rate at a recorded sample, σ held inside the configured bounds (as PathFunding does).
    function rateAt(PathFunding.Sample memory smp, Terms memory terms) internal pure returns (uint256) {
        uint256 sigma = smp.sigmaBps;
        if (sigma < terms.bounds.minBps) sigma = terms.bounds.minBps;
        if (sigma > terms.bounds.maxBps) sigma = terms.bounds.maxBps;
        return rateE36(terms.legs, smp.s, sigma, terms.movement, terms.bounds);
    }

    /// @notice Walks `cur` towards the latest recorded sample, at most `maxSteps` intervals: PathFunding.walk with the
    ///         shape's rate. Same path, same per-step rounding, same resumability.
    function walk(PathFunding.History storage h, PathFunding.Cursor memory cur, Terms memory terms, uint256 maxSteps)
        internal
        view
        returns (PathFunding.Cursor memory, uint256 steps)
    {
        uint256 end = h.last[0];
        while (cur.at < end && steps < maxSteps) {
            PathFunding.Sample memory smp = PathFunding._inEffect(h, cur.eff);
            uint256 n = smp.next;
            if (n == 0 || n <= cur.at) revert PathFunding.Inconsistent();
            cur.x += Math.ceilDiv(rateAt(smp, terms) * (n - cur.at), 1e18);
            cur.at = uint40(n);
            cur.eff = uint40(n);
            ++steps;
        }
        return (cur, steps);
    }

    function _abs(int256 x) private pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }
}
