// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TempoMath} from "./TempoMath.sol";

/// @title TempoBlend
/// @notice Movements: one option made of up to four tempos.
/// @dev For parts (tempoᵢ, wᵢ) with Σwᵢ = 1:
///        value    V = Σ wᵢ·V(σ, tempoᵢ)
///        funding  F = Σ wᵢ·TVᵢ/tempoᵢ          (price per second)
///        rate     r = F / V                    (fraction of units per second)
///      Units shrink in kind at rate r. A single tempo is a Movement with one part,
///      where r = TV/(V·tempo). Weights in WAD, tempos in seconds, results in WAD.
library TempoBlend {
    uint256 internal constant MAX_PARTS = 4;
    uint256 internal constant ONE = 1e18;
    uint256 internal constant E36 = 1e36;

    struct Part {
        uint256 tempo;
        uint256 weight;
    }

    error EmptyMovement();
    error TooManyParts(uint256 count);
    error ZeroWeight(uint256 index);
    error RepeatedTempo(uint256 tempo);
    error WeightsNotOne(uint256 sum);

    /// @notice Reverts unless the Movement is well formed. Tempo range is checked by TempoMath.
    function validate(Part[] memory m) internal pure {
        uint256 n = m.length;
        if (n == 0) revert EmptyMovement();
        if (n > MAX_PARTS) revert TooManyParts(n);
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            if (m[i].weight == 0) revert ZeroWeight(i);
            for (uint256 j; j < i; ++j) {
                if (m[j].tempo == m[i].tempo) revert RepeatedTempo(m[i].tempo);
            }
            sum += m[i].weight;
        }
        if (sum != ONE) revert WeightsNotOne(sum);
    }

    /// @notice Value, funding per second and shrink rate per second of a Movement.
    /// @return v       Σ wᵢ·Vᵢ, WAD price.
    /// @return funding Σ wᵢ·TVᵢ/tempoᵢ, WAD price per second.
    /// @return rate    funding / v, WAD fraction per second. When v rounds to zero
    ///                 (deep out of the money), the limit 1/max(tempoᵢ) is used.
    function quote(bool isCall, uint256 s, uint256 k, uint256 sigmaBps, Part[] memory m, TempoMath.SigmaBounds memory b)
        internal
        pure
        returns (uint256 v, uint256 funding, uint256 rate)
    {
        (uint256 vScaled, uint256 fundingScaled, uint256 maxTempo) = _sums(isCall, s, k, sigmaBps, m, b);
        v = vScaled / ONE;
        funding = fundingScaled / ONE;
        rate = vScaled == 0 ? ONE / maxTempo : Math.mulDiv(fundingScaled, ONE, vScaled);
    }

    /// @notice Shrink rate per second at 36 decimals, for walking long paths without
    ///         per-second truncation. Same limit 1/max(tempoᵢ) when the value is zero.
    ///         Rounded up, so a non-zero rate never truncates to a free interval.
    function rateE36(
        bool isCall,
        uint256 s,
        uint256 k,
        uint256 sigmaBps,
        Part[] memory m,
        TempoMath.SigmaBounds memory b
    ) internal pure returns (uint256) {
        (uint256 vScaled, uint256 fundingScaled, uint256 maxTempo) = _sums(isCall, s, k, sigmaBps, m, b);
        return vScaled == 0 ? Math.ceilDiv(E36, maxTempo) : Math.mulDiv(fundingScaled, E36, vScaled, Math.Rounding.Ceil);
    }

    /// @dev Σ wᵢ·Vᵢ and Σ wᵢ·TVᵢ/tempoᵢ, both at 1e36 scale, and the longest tempo.
    function _sums(bool isCall, uint256 s, uint256 k, uint256 sigmaBps, Part[] memory m, TempoMath.SigmaBounds memory b)
        private
        pure
        returns (uint256 vScaled, uint256 fundingScaled, uint256 maxTempo)
    {
        validate(m);
        for (uint256 i; i < m.length; ++i) {
            (uint256 vi, uint256 tvi) = TempoMath.valueAndTimeValue(isCall, s, k, sigmaBps, m[i].tempo, b);
            vScaled += m[i].weight * vi;
            fundingScaled += (m[i].weight * tvi) / m[i].tempo;
            if (m[i].tempo > maxTempo) maxTempo = m[i].tempo;
        }
    }

    /// @notice Value only, with the default σ bounds.
    function value(bool isCall, uint256 s, uint256 k, uint256 sigmaBps, Part[] memory m)
        internal
        pure
        returns (uint256 v)
    {
        (v,,) = quote(isCall, s, k, sigmaBps, m, TempoMath.defaultBounds());
    }

    /// @notice A one-part Movement for a single tempo.
    function single(uint256 tempo) internal pure returns (Part[] memory m) {
        m = new Part[](1);
        m[0] = Part(tempo, ONE);
    }
}
