// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EnginePricing} from "./EnginePricing.sol";
import {StrategyMath} from "./StrategyMath.sol";
import {TempoBlend} from "./TempoBlend.sol";
import {TempoMath} from "./TempoMath.sol";

/// @title ShapeGreeks
/// @notice Delta and vega of a shape, per unit, from the same closed form the pool prices with (EnginePricing), by
///         central differences: delta over S ± 0.1%, vega over σ ± 50 bps (one-sided at the σ bounds). For the agent
///         budgets (M7 G14): accumulated at open, so a few gas-heavy evaluations once per fill, never per block.
/// @dev    The value is smooth across a strike in TempoMath (left and right slopes agree), so a central difference is
///         accurate there too. Cross-checked against the analytic TypeScript delta and an independent numeric vega.
library ShapeGreeks {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant H_DIV = 1000; // S step: S / 1000
    uint256 internal constant DSIGMA = 50; // bps

    /// @notice Delta per unit (WAD units of underlying per shape unit), signed.
    function delta(StrategyMath.Leg[] memory legs, uint256 s, uint256 sigmaBps, TempoBlend.Part[] memory mv)
        internal
        pure
        returns (int256)
    {
        uint256 h = s / H_DIV;
        int256 up = EnginePricing.shapeValue(legs, s + h, sigmaBps, mv, false);
        int256 dn = EnginePricing.shapeValue(legs, s - h, sigmaBps, mv, false);
        return (up - dn) * int256(WAD) / int256(2 * h);
    }

    /// @notice Vega per unit (WAD USD per shape unit per vol point = 100 bps), signed.
    function vega(StrategyMath.Leg[] memory legs, uint256 s, uint256 sigmaBps, TempoBlend.Part[] memory mv)
        internal
        pure
        returns (int256)
    {
        uint256 lo = sigmaBps > TempoMath.DEFAULT_MIN_SIGMA_BPS + DSIGMA
            ? sigmaBps - DSIGMA
            : TempoMath.DEFAULT_MIN_SIGMA_BPS;
        uint256 hi =
            sigmaBps + DSIGMA < TempoMath.DEFAULT_MAX_SIGMA_BPS ? sigmaBps + DSIGMA : TempoMath.DEFAULT_MAX_SIGMA_BPS;
        int256 vHi = EnginePricing.shapeValue(legs, s, hi, mv, false);
        int256 vLo = EnginePricing.shapeValue(legs, s, lo, mv, false);
        return (vHi - vLo) * 100 / int256(hi - lo);
    }

    /// @notice |delta| × S × units in USDC (6 decimals): the position's dollar delta.
    function deltaUsd(int256 d, uint256 s, uint256 units) internal pure returns (uint256) {
        uint256 a = d < 0 ? uint256(-d) : uint256(d);
        return a * s / WAD * units / WAD / 1e12;
    }

    /// @notice |vega| × units in USDC (6 decimals) per vol point.
    function vegaUsd(int256 v, uint256 units) internal pure returns (uint256) {
        uint256 a = v < 0 ? uint256(-v) : uint256(v);
        return a * units / WAD / 1e12;
    }
}
