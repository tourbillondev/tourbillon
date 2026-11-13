// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SD59x18, sd} from "@prb/math/src/SD59x18.sol";

/// @title TempoMath
/// @notice Value of a no-expiry option whose time value decays at a chosen tempo.
/// @dev V solves (σ²S²/2)·V'' = (V − payoff)/tempo. With x = S/K and
///      p± = 1/2 ± √(1/4 + 2/(σ²·tempo)), so that p+ − p− = 2·√(1/4 + 2/(σ²·tempo)):
///        call, S ≤ K:  K·x^{p+}/(p+ − p−)
///        call, S ≥ K:  (S − K) + K·x^{p−}/(p+ − p−)
///        put:          call − (S − K)
///      The term K·x^{p}/(p+ − p−) is the time value. It is computed directly, so the
///      put is evaluated as intrinsic + time value, with no subtraction.
///      Units: prices in WAD, σ in basis points, tempo in seconds, 365-day year.
library TempoMath {
    uint256 internal constant YEAR = 365 days;
    uint256 internal constant MIN_TEMPO = 1 hours;
    uint256 internal constant MAX_TEMPO = 30 days;
    uint256 internal constant DEFAULT_MIN_SIGMA_BPS = 500; // 5%
    uint256 internal constant DEFAULT_MAX_SIGMA_BPS = 50_000; // 500%
    /// @dev Sanity ceiling so prices stay inside the signed fixed-point range.
    uint256 internal constant MAX_PRICE = 1e36;

    struct SigmaBounds {
        uint256 minBps;
        uint256 maxBps;
    }

    error ZeroSpot();
    error ZeroStrike();
    error ZeroSigma();
    error PriceTooLarge(uint256 price);
    error TempoOutOfRange(uint256 tempo);
    error SigmaOutOfBounds(uint256 sigmaBps, uint256 minBps, uint256 maxBps);
    error InvalidSigmaBounds(uint256 minBps, uint256 maxBps);

    function defaultBounds() internal pure returns (SigmaBounds memory) {
        return SigmaBounds(DEFAULT_MIN_SIGMA_BPS, DEFAULT_MAX_SIGMA_BPS);
    }

    /// @notice Option value with the default σ bounds.
    function value(bool isCall, uint256 s, uint256 k, uint256 sigmaBps, uint256 tempo) internal pure returns (uint256) {
        (uint256 v,) = valueAndTimeValue(isCall, s, k, sigmaBps, tempo, defaultBounds());
        return v;
    }

    /// @notice Option value and its time value (value − intrinsic).
    function valueAndTimeValue(bool isCall, uint256 s, uint256 k, uint256 sigmaBps, uint256 tempo, SigmaBounds memory b)
        internal
        pure
        returns (uint256 v, uint256 tv)
    {
        _check(s, k, sigmaBps, tempo, b);
        tv = _timeValue(s, k, sigmaBps, tempo);
        uint256 intrinsic;
        if (isCall) intrinsic = s > k ? s - k : 0;
        else intrinsic = k > s ? k - s : 0;
        v = intrinsic + tv;
    }

    function _check(uint256 s, uint256 k, uint256 sigmaBps, uint256 tempo, SigmaBounds memory b) private pure {
        if (b.minBps == 0 || b.minBps > b.maxBps) revert InvalidSigmaBounds(b.minBps, b.maxBps);
        if (s == 0) revert ZeroSpot();
        if (k == 0) revert ZeroStrike();
        if (sigmaBps == 0) revert ZeroSigma();
        if (s > MAX_PRICE) revert PriceTooLarge(s);
        if (k > MAX_PRICE) revert PriceTooLarge(k);
        if (tempo < MIN_TEMPO || tempo > MAX_TEMPO) revert TempoOutOfRange(tempo);
        if (sigmaBps < b.minBps || sigmaBps > b.maxBps) revert SigmaOutOfBounds(sigmaBps, b.minBps, b.maxBps);
    }

    /// @dev K·x^{p}/(p+ − p−), with p = p+ when S ≤ K and p = p− when S > K.
    ///      Inputs are already checked, so every cast below is in range.
    function _timeValue(uint256 s, uint256 k, uint256 sigmaBps, uint256 tempo) private pure returns (uint256) {
        // a = 2/(σ²·τ) in WAD, from integers: σ = bps/1e4, τ = tempo/YEAR.
        uint256 a = (2e18 * 1e8 * YEAR) / (sigmaBps * sigmaBps * tempo);
        SD59x18 d = sd(int256(a + 0.25e18)).sqrt(); // √(1/4 + a)
        SD59x18 half = sd(0.5e18);
        SD59x18 p = s <= k ? half.add(d) : half.sub(d);
        SD59x18 x = sd(int256(s)).div(sd(int256(k)));
        SD59x18 kSd = sd(int256(k));
        return uint256(kSd.mul(x.pow(p)).div(d.add(d)).unwrap());
    }
}
