// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title StrategyMath
/// @notice Exact payoff bounds of a multi-leg position on one market, used to size the collateral a writer
///         must lock. A no-expiry option's value is an expectation of its payoff over a random exercise
///         time, so it always lies between the payoff's minimum and maximum over all prices. Locking
///         max(0, −min payoff) therefore covers the writer at any moment, not just at a date.
/// @dev    Legs are calls and puts with a signed quantity (WAD units; + long, − short), at most four.
///         A writer may also lock covering units: WHYPE, counted only on the HYPE market, worth S each.
///         Payoffs are piecewise linear in S with kinks at the strikes, so the bounds are exact: evaluate
///         at 0 and at every strike, plus the slope above the top strike, at WAD × WAD scale with no per-term
///         division; results are WAD USDC rounded against the writer (M4 step 8).
library StrategyMath {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant MAX_LEGS = 4;
    /// @dev The only market on which covering units (WHYPE) count. kHYPE waits for a rate source.
    bytes32 internal constant COVER_MARKET = "HYPE";

    struct Leg {
        bool isCall;
        uint128 kWad;
        int128 qty; // WAD units, + long, − short
    }

    error TooManyLegs();
    error Unbounded();
    error NegativeCover();
    error CoverNotAllowed(bytes32 market);

    /// @notice Payoff of the legs plus `coverQty` covering units worth S each, at price S, at WAD × WAD scale: exact,
    ///         with no per-term division (M4 step 8 fix: dividing each term truncated it towards zero, so a minimum
    ///         could sit a few wei above the true one).
    function payoffAtScaled(Leg[] memory legs, int256 coverQty, uint256 sWad) internal pure returns (int256 p) {
        p = coverQty * SafeCast.toInt256(sWad);
        for (uint256 i; i < legs.length; i++) {
            uint256 k = legs[i].kWad;
            uint256 intrinsic = legs[i].isCall ? (sWad > k ? sWad - k : 0) : (k > sWad ? k - sWad : 0);
            p += int256(legs[i].qty) * SafeCast.toInt256(intrinsic);
        }
    }

    /// @notice Payoff (WAD USDC) at price S, rounded towards −∞ (never above the true payoff).
    function payoffAt(Leg[] memory legs, int256 coverQty, uint256 sWad) internal pure returns (int256) {
        return _floorWad(payoffAtScaled(legs, coverQty, sWad));
    }

    /// @notice Minimum and maximum of the payoff over S in [0, ∞) (WAD USDC; the minimum rounded towards −∞ and the
    ///         maximum towards +∞, so each bound holds exactly). `minUnbounded` / `maxUnbounded` flag a non-zero slope
    ///         above the highest strike (calls and covering units have slope there; puts do not).
    function bounds(Leg[] memory legs, int256 coverQty)
        internal
        pure
        returns (int256 minP, int256 maxP, bool minUnbounded, bool maxUnbounded)
    {
        (int256 minS, int256 maxS, bool mnU, bool mxU) = _boundsScaled(legs, coverQty);
        return (_floorWad(minS), -_floorWad(-maxS), mnU, mxU);
    }

    /// @dev Exact bounds at WAD × WAD scale: the payoff is piecewise linear with kinks at the strikes, so its minimum
    ///      and maximum over [0, ∞) are at 0 or a strike unless the slope above the top strike is non-zero.
    function _boundsScaled(Leg[] memory legs, int256 coverQty)
        private
        pure
        returns (int256 minS, int256 maxS, bool minUnbounded, bool maxUnbounded)
    {
        if (legs.length > MAX_LEGS) revert TooManyLegs();
        minS = payoffAtScaled(legs, coverQty, 0);
        maxS = minS;
        for (uint256 i; i < legs.length; i++) {
            int256 v = payoffAtScaled(legs, coverQty, legs[i].kWad);
            if (v < minS) minS = v;
            if (v > maxS) maxS = v;
        }
        int256 slope = coverQty; // WAD-scaled slope per unit of S above the top strike
        for (uint256 i; i < legs.length; i++) {
            if (legs[i].isCall) slope += legs[i].qty;
        }
        if (slope < 0) minUnbounded = true;
        if (slope > 0) maxUnbounded = true;
    }

    /// @dev x / WAD rounded towards −∞.
    function _floorWad(int256 x) private pure returns (int256 q) {
        q = x / int256(WAD);
        if (x % int256(WAD) != 0 && x < 0) q -= 1;
    }

    /// @notice USDC a writer must lock for the legs they sell (legs from the writer's side: short = negative),
    ///         given `coverQty` WHYPE units locked alongside. Covering units count only on the HYPE market.
    ///         Reverts if the liability is unbounded (a naked short call).
    function writerCollateral(bytes32 market, Leg[] memory legs, int256 coverQty) internal pure returns (uint256) {
        if (coverQty < 0) revert NegativeCover();
        if (coverQty > 0 && market != COVER_MARKET) revert CoverNotAllowed(market);
        (int256 minS,, bool minUnbounded,) = _boundsScaled(legs, coverQty);
        if (minUnbounded) revert Unbounded();
        // Covering units are worth 0 at S = 0, so they never count as cash; they only offset the upside
        // of short calls. The exact minimum (WAD × WAD) is the cash the writer may owe, rounded up to a wei.
        return minS < 0 ? Math.ceilDiv(uint256(-minS), WAD) : 0;
    }
}
