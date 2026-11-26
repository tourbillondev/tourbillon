// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EnginePricing} from "./EnginePricing.sol";
import {StrategyMath} from "./StrategyMath.sol";
import {TempoBlend} from "./TempoBlend.sol";

/// @title ShapeQuote
/// @notice The pool's ask for buying back a written shape (an early close), as a linked library: the pricing maths is
///         deployed once here instead of inside MatchBook, which keeps MatchBook under the 24 KB contract size limit.
///         Same maths as EnginePricing (value at the ask side, then the unwrite quote).
library ShapeQuote {
    function unwriteQuote(
        StrategyMath.Leg[] memory poolLegs,
        uint256 s,
        uint256 sigma,
        TempoBlend.Part[] memory movement,
        uint256 units,
        uint16 spreadBps
    ) public pure returns (int256 cost, uint256 fee) {
        int256 v = EnginePricing.shapeValue(poolLegs, s, sigma, movement, true);
        return EnginePricing.shapeUnwriteQuote(v, units, poolLegs, s, spreadBps);
    }
}
