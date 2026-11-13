// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TempoBlend} from "./TempoBlend.sol";
import {TempoMath} from "./TempoMath.sol";
import {ShapeFunding} from "./ShapeFunding.sol";
import {StrategyMath} from "./StrategyMath.sol";

/// @title EnginePricing
/// @notice Every amount the Engine charges or pays on a single-leg trade. Pure: no storage, no tokens.
/// @dev    Amounts are computed in WAD (18 decimals) and converted to USDC (6 decimals) once, at the end.
///         Every rounding favours the counterparty:
///         - a buyer pays the premium and the fee rounded up;
///         - a seller's gross is rounded down and the fee rounded up, the fee capped at the gross, so a sell of
///           an almost worthless option pays 0 and never reverts (law 3);
///         - units to raw: a buy mints raw rounded down; a sell burns raw rounded up, capped at the balance.
///         Fees (Overview §5): a spread of 1.5–4% of the option price, at least $0.01, plus 3 bps of the underlying
///         notional (units × S), on buy and sell. The S is the one used for the price: the fresh mark on a buy,
///         the last recorded sample on a sell when the mark is stale.
///
///         Shapes (M4 decision D6): legs are the holder's side. The value per shape unit is Σ q·V at one mark, vol and
///         movement, from the exact sums, rounded once: up where the counterparty receives (buy, unwrite), down where
///         it pays (sell, write). Fee = max(2% × |value|, $0.01) + 3 bps × S × max(long units, short units). A buyer
///         may hold only a shape whose payoff can never go below 0 (D5, law 1).
library EnginePricing {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MIN_SPREAD_BPS = 150;
    uint256 internal constant MAX_SPREAD_BPS = 400;
    uint256 internal constant DEFAULT_SPREAD_BPS = 200;
    uint256 internal constant NOTIONAL_FEE_BPS = 3;
    uint256 internal constant MIN_FEE = 1e16; // $0.01 in WAD
    uint8 internal constant USDC_DECIMALS = 6;
    uint256 internal constant WAD_PER_USDC_UNIT = 1e12; // 10^(18 − 6)

    error SpreadOutOfRange(uint256 spreadBps);
    error ZeroUnits();
    error ZeroStep();
    error StrikeOffStep(uint256 kWad, uint256 stepWad);
    error StrikeOutOfBand(uint256 kWad, uint256 sWad);
    error ShapeCanOwe();

    /// @notice Value of one option unit, WAD. A single tempo is a one-part Movement.
    function unitValue(bool isCall, uint256 sWad, uint256 kWad, uint256 sigmaBps, TempoBlend.Part[] memory movement)
        internal
        pure
        returns (uint256)
    {
        return TempoBlend.value(isCall, sWad, kWad, sigmaBps, movement);
    }

    /// @notice Fee on a trade, WAD: max(spread × price, $0.01) + 3 bps × units × S, rounded up.
    function fee(uint256 priceWad, uint256 units, uint256 sWad, uint256 spreadBps) internal pure returns (uint256) {
        checkSpread(spreadBps);
        uint256 spread = Math.mulDiv(priceWad, spreadBps, BPS, Math.Rounding.Ceil);
        if (spread < MIN_FEE) spread = MIN_FEE;
        uint256 notional = Math.mulDiv(units, sWad, WAD, Math.Rounding.Ceil);
        return spread + Math.mulDiv(notional, NOTIONAL_FEE_BPS, BPS, Math.Rounding.Ceil);
    }

    /// @notice What a buyer of `units` pays, in USDC (6 decimals): `premium` to the counterparty and `feeAmt` to the
    ///         fee recipient, both rounded up.
    function buyQuote(uint256 unitValueWad, uint256 units, uint256 sWad, uint256 spreadBps)
        internal
        pure
        returns (uint256 premium, uint256 feeAmt)
    {
        if (units == 0) revert ZeroUnits();
        uint256 p = Math.mulDiv(units, unitValueWad, WAD, Math.Rounding.Ceil);
        premium = Math.ceilDiv(p, WAD_PER_USDC_UNIT);
        feeAmt = Math.ceilDiv(fee(p, units, sWad, spreadBps), WAD_PER_USDC_UNIT);
    }

    /// @notice What a seller of `units` receives, in USDC (6 decimals). The counterparty pays `gross` (rounded
    ///         down): `gross − feeAmt` to the seller and `feeAmt` (rounded up, at most `gross`) to the fee recipient.
    function sellQuote(uint256 unitValueWad, uint256 units, uint256 sWad, uint256 spreadBps)
        internal
        pure
        returns (uint256 gross, uint256 feeAmt)
    {
        if (units == 0) revert ZeroUnits();
        uint256 g = Math.mulDiv(units, unitValueWad, WAD);
        gross = g / WAD_PER_USDC_UNIT;
        feeAmt = Math.ceilDiv(fee(g, units, sWad, spreadBps), WAD_PER_USDC_UNIT);
        if (feeAmt > gross) feeAmt = gross;
    }

    function checkSpread(uint256 spreadBps) internal pure {
        if (spreadBps < MIN_SPREAD_BPS || spreadBps > MAX_SPREAD_BPS) revert SpreadOutOfRange(spreadBps);
    }

    /// @notice Buys only: the strike is a multiple of the market's step and within 0.5× to 2× of the mark.
    function checkStrike(uint256 kWad, uint256 sWad, uint256 stepWad) internal pure {
        if (stepWad == 0) revert ZeroStep();
        if (kWad == 0 || kWad % stepWad != 0) revert StrikeOffStep(kWad, stepWad);
        if (2 * kWad < sWad || kWad > 2 * sWad) revert StrikeOutOfBand(kWad, sWad);
    }

    /// @notice Raw balance minted for `units` bought at `norm`: rounded down, so the buyer holds at most what was
    ///         paid for.
    function rawForBuy(uint256 units, uint256 norm) internal pure returns (uint256) {
        return Math.mulDiv(units, WAD, norm);
    }

    /// @notice Raw burned to sell `units` at `norm`, rounded up and capped at `balance`, and the units that raw is
    ///         paid for (never more than asked). `units == type(uint256).max` sells the whole balance.
    function rawForSell(uint256 units, uint256 norm, uint256 balance)
        internal
        pure
        returns (uint256 raw, uint256 paidUnits)
    {
        if (units == type(uint256).max) {
            raw = balance;
            paidUnits = unitsOf(balance, norm);
            return (raw, paidUnits);
        }
        raw = Math.mulDiv(units, WAD, norm, Math.Rounding.Ceil);
        if (raw > balance) raw = balance;
        paidUnits = Math.min(units, unitsOf(raw, norm));
    }

    /// @notice Units held for a raw balance at `norm`, rounded down.
    function unitsOf(uint256 raw, uint256 norm) internal pure returns (uint256) {
        return Math.mulDiv(raw, norm, WAD);
    }

    // ---------------------------------------------------------------- shapes

    /// @notice Value of one shape unit (WAD, signed): Σ q·V from the exact sums, rounded once, towards +∞ when `up`.
    function shapeValue(
        StrategyMath.Leg[] memory legs,
        uint256 sWad,
        uint256 sigmaBps,
        TempoBlend.Part[] memory movement,
        bool up
    ) internal pure returns (int256) {
        (int256 vNet,,) = ShapeFunding.sums(legs, sWad, sigmaBps, movement, TempoMath.defaultBounds());
        return _div(vNet, 1e36, up); // per-leg sums are at 1e36 × V, amounts in WAD
    }

    /// @notice Units of underlying per shape unit for the notional fee: max(Σ long amounts, Σ short amounts), WAD.
    function shapeNotionalPerUnit(StrategyMath.Leg[] memory legs) internal pure returns (uint256) {
        uint256 long;
        uint256 short;
        for (uint256 j; j < legs.length; ++j) {
            int256 q = legs[j].qty;
            if (q > 0) long += uint256(q);
            else short += uint256(-q);
        }
        return long > short ? long : short;
    }

    /// @notice Fee on a shape trade of `units`, WAD: the single-leg fee on |price| and the shape's notional units.
    function shapeFee(int256 priceWad, uint256 units, StrategyMath.Leg[] memory legs, uint256 sWad, uint256 spreadBps)
        internal
        pure
        returns (uint256)
    {
        uint256 notionalUnits = Math.mulDiv(units, shapeNotionalPerUnit(legs), WAD, Math.Rounding.Ceil);
        return fee(_abs(priceWad), notionalUnits, sWad, spreadBps);
    }

    /// @notice What a buyer of `units` shape units pays, in USDC, both rounded up. `valueUpWad` is shapeValue(up). A
    ///         buyer shape's payoff never goes below 0 (checkBuyerShape), so its true value is at least 0; a computed
    ///         value a few wei below 0 (TempoMath's rounding on deep out-of-the-money legs) counts as 0.
    function shapeBuyQuote(int256 valueUpWad, uint256 units, StrategyMath.Leg[] memory legs, uint256 sWad, uint256 spreadBps)
        internal
        pure
        returns (uint256 premium, uint256 feeAmt)
    {
        if (units == 0) revert ZeroUnits();
        uint256 v = valueUpWad > 0 ? uint256(valueUpWad) : 0;
        uint256 p = Math.mulDiv(units, v, WAD, Math.Rounding.Ceil);
        premium = Math.ceilDiv(p, WAD_PER_USDC_UNIT);
        feeAmt = Math.ceilDiv(shapeFee(int256(p), units, legs, sWad, spreadBps), WAD_PER_USDC_UNIT);
    }

    /// @notice What a seller of `units` shape units receives, in USDC: `gross` rounded down (a value below 0 counts as
    ///         0), the fee rounded up and capped at the gross, so a worthless shape sells for 0 and never reverts.
    function shapeSellQuote(
        int256 valueDownWad,
        uint256 units,
        StrategyMath.Leg[] memory legs,
        uint256 sWad,
        uint256 spreadBps
    ) internal pure returns (uint256 gross, uint256 feeAmt) {
        if (units == 0) revert ZeroUnits();
        uint256 v = valueDownWad > 0 ? uint256(valueDownWad) : 0;
        uint256 g = Math.mulDiv(units, v, WAD);
        gross = g / WAD_PER_USDC_UNIT;
        feeAmt = Math.ceilDiv(shapeFee(int256(g), units, legs, sWad, spreadBps), WAD_PER_USDC_UNIT);
        if (feeAmt > gross) feeAmt = gross;
    }

    /// @notice A write of `units` shape units (legs from the pool's side, the holder): the writer's signed credit in
    ///         USDC, value × units rounded towards −∞, less the fee (rounded up). Negative: the writer pays (a Guard
    ///         can be a net debit).
    function shapeWriteQuote(
        int256 valueDownWad,
        uint256 units,
        StrategyMath.Leg[] memory legs,
        uint256 sWad,
        uint256 spreadBps
    ) internal pure returns (int256 credit, uint256 feeAmt) {
        if (units == 0) revert ZeroUnits();
        int256 g = _mulWad(valueDownWad, units, false);
        feeAmt = Math.ceilDiv(shapeFee(g, units, legs, sWad, spreadBps), WAD_PER_USDC_UNIT);
        credit = _div(g, int256(WAD_PER_USDC_UNIT), false) - int256(feeAmt);
    }

    /// @notice An unwrite of `units` shape units: the writer's signed buyback cost in USDC, value × units rounded
    ///         towards +∞, plus the fee (rounded up). The cap at the locked collateral is the WriterBook's (D8).
    function shapeUnwriteQuote(
        int256 valueUpWad,
        uint256 units,
        StrategyMath.Leg[] memory legs,
        uint256 sWad,
        uint256 spreadBps
    ) internal pure returns (int256 cost, uint256 feeAmt) {
        if (units == 0) revert ZeroUnits();
        int256 g = _mulWad(valueUpWad, units, true);
        feeAmt = Math.ceilDiv(shapeFee(g, units, legs, sWad, spreadBps), WAD_PER_USDC_UNIT);
        cost = _div(g, int256(WAD_PER_USDC_UNIT), true) + int256(feeAmt);
    }

    /// @notice Buys only: a buyer may hold a shape only if its payoff can never go below 0 (law 1), checked with
    ///         StrategyMath's exact bounds.
    function checkBuyerShape(StrategyMath.Leg[] memory legs) internal pure {
        (int256 minP,, bool minUnbounded,) = StrategyMath.bounds(legs, 0);
        if (minUnbounded || minP < 0) revert ShapeCanOwe();
    }

    /// @notice Buys and writes: every leg's strike on the market's step and inside the band.
    function checkShapeStrikes(StrategyMath.Leg[] memory legs, uint256 sWad, uint256 stepWad) internal pure {
        for (uint256 j; j < legs.length; ++j) {
            checkStrike(legs[j].kWad, sWad, stepWad);
        }
    }

    /// @dev a × units / WAD with the sign of a, rounded towards +∞ when `up`, else towards −∞.
    function _mulWad(int256 a, uint256 units, bool up) private pure returns (int256) {
        bool neg = a < 0;
        // magnitude rounding: towards +∞ means up for positives and down for negatives
        Math.Rounding r = (up != neg) ? Math.Rounding.Ceil : Math.Rounding.Floor;
        uint256 m = Math.mulDiv(_abs(a), units, WAD, r);
        return neg ? -int256(m) : int256(m);
    }

    /// @dev a / d (d > 0) rounded towards +∞ when `up`, else towards −∞.
    function _div(int256 a, int256 d, bool up) private pure returns (int256 q) {
        q = a / d; // truncates towards 0
        if (a % d != 0) {
            if (up && a > 0) q += 1;
            if (!up && a < 0) q -= 1;
        }
    }

    function _abs(int256 x) private pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }
}
