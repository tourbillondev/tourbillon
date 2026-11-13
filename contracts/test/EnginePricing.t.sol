// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EnginePricing} from "../src/EnginePricing.sol";
import {TempoBlend} from "../src/TempoBlend.sol";
import {TempoMath} from "../src/TempoMath.sol";

/// External wrappers so reverts can be checked.
contract PricingHarness {
    function unitValue(bool isCall, uint256 s, uint256 k, uint256 sig, TempoBlend.Part[] memory m)
        external
        pure
        returns (uint256)
    {
        return EnginePricing.unitValue(isCall, s, k, sig, m);
    }

    function buyQuote(uint256 v, uint256 units, uint256 s, uint256 spread) external pure returns (uint256, uint256) {
        return EnginePricing.buyQuote(v, units, s, spread);
    }

    function sellQuote(uint256 v, uint256 units, uint256 s, uint256 spread) external pure returns (uint256, uint256) {
        return EnginePricing.sellQuote(v, units, s, spread);
    }

    function checkSpread(uint256 bps) external pure {
        EnginePricing.checkSpread(bps);
    }

    function checkStrike(uint256 k, uint256 s, uint256 step) external pure {
        EnginePricing.checkStrike(k, s, step);
    }
}

contract EnginePricingTest is Test {
    uint256 constant REL_1E5 = 1e13; // 1e-5 relative
    PricingHarness h;

    function setUp() public {
        h = new PricingHarness();
    }

    // ---------------------------------------------------------------- unit value

    function test_unitValueMatchesReferenceValues() public view {
        assertApproxEqRel(h.unitValue(true, 100e18, 100e18, 5000, TempoBlend.single(1 days)), 0.92525e18, REL_1E5);
        assertApproxEqRel(h.unitValue(true, 120e18, 100e18, 4000, TempoBlend.single(7 days)), 20.0204e18, REL_1E5);
        assertApproxEqRel(h.unitValue(false, 100e18, 120e18, 4000, TempoBlend.single(7 days)), 20.0204e18, REL_1E5);
        // Overview §2: Rise at $100, 3-day tempo ≈ $1.60
        assertApproxEqRel(h.unitValue(true, 100e18, 100e18, 5000, TempoBlend.single(3 days)), 1.602446e18, REL_1E5);
    }

    function test_movementValueIsTheWeightedSum() public view {
        TempoBlend.Part[] memory mv = new TempoBlend.Part[](2);
        mv[0] = TempoBlend.Part(1 days, 0.25e18);
        mv[1] = TempoBlend.Part(7 days, 0.75e18);
        uint256 v1 = TempoMath.value(true, 100e18, 105e18, 6000, 1 days);
        uint256 v7 = TempoMath.value(true, 100e18, 105e18, 6000, 7 days);
        assertApproxEqAbs(h.unitValue(true, 100e18, 105e18, 6000, mv), (v1 + 3 * v7) / 4, 2);
    }

    function test_unitValueKeepsTheMathsDomain() public {
        vm.expectRevert(abi.encodeWithSelector(TempoMath.TempoOutOfRange.selector, 59 minutes));
        h.unitValue(true, 100e18, 100e18, 5000, TempoBlend.single(59 minutes));
        vm.expectRevert(TempoMath.ZeroSpot.selector);
        h.unitValue(true, 0, 100e18, 5000, TempoBlend.single(1 days));
    }

    // ---------------------------------------------------------------- fees

    /// 10 units of a call worth $1.60, mark $100, 2% spread: premium $16.00, spread fee $0.32, notional fee
    /// 3 bps × $1,000 = $0.30. Buy costs $16.62; selling straight back pays $15.38.
    function test_workedExample() public view {
        (uint256 premium, uint256 fee) = h.buyQuote(1.6e18, 10e18, 100e18, 200);
        assertEq(premium, 16_000000);
        assertEq(fee, 620000);
        assertEq(premium + fee, 16_620000);
        (uint256 gross, uint256 sellFee) = h.sellQuote(1.6e18, 10e18, 100e18, 200);
        assertEq(gross, 16_000000);
        assertEq(sellFee, 620000);
        assertEq(gross - sellFee, 15_380000);
    }

    function test_minimumFeeAndNotionalFee() public view {
        // premium $0.10: 2% would be $0.002, so the $0.01 minimum applies; notional 1 × $1 × 3 bps = $0.0003
        (uint256 premium, uint256 fee) = h.buyQuote(0.1e18, 1e18, 1e18, 200);
        assertEq(premium, 100000);
        assertEq(fee, 10300);
        // the notional fee scales with S: same option, mark $50,000 → 3 bps × $50,000 = $15
        (, fee) = h.buyQuote(0.1e18, 1e18, 50_000e18, 200);
        assertEq(fee, 10000 + 15_000000);
        // 4% spread on a $100 premium: $4 + notional (1 unit × $100 × 3 bps = $0.03)
        (premium, fee) = h.buyQuote(100e18, 1e18, 100e18, 400);
        assertEq(fee, 4_030000);
    }

    /// A sell whose gross is below the fee pays the seller 0 and never reverts (law 3).
    function test_worthlessSellPaysZeroAndNeverReverts() public view {
        (uint256 gross, uint256 fee) = h.sellQuote(1e12, 1e18, 100e18, 200); // $0.000001 of value
        assertEq(gross, 1);
        assertEq(fee, 1);
        (gross, fee) = h.sellQuote(0, 5e18, 100e18, 200); // no value at all
        assertEq(gross, 0);
        assertEq(fee, 0);
    }

    function test_zeroUnitsRefused() public {
        vm.expectRevert(EnginePricing.ZeroUnits.selector);
        h.buyQuote(1e18, 0, 100e18, 200);
        vm.expectRevert(EnginePricing.ZeroUnits.selector);
        h.sellQuote(1e18, 0, 100e18, 200);
    }

    function test_spreadBounds() public {
        h.checkSpread(150);
        h.checkSpread(200);
        h.checkSpread(400);
        vm.expectRevert(abi.encodeWithSelector(EnginePricing.SpreadOutOfRange.selector, 149));
        h.checkSpread(149);
        vm.expectRevert(abi.encodeWithSelector(EnginePricing.SpreadOutOfRange.selector, 401));
        h.checkSpread(401);
        vm.expectRevert(abi.encodeWithSelector(EnginePricing.SpreadOutOfRange.selector, 0));
        h.buyQuote(1e18, 1e18, 100e18, 0);
    }

    /// Rounding never favours the trader: a buyer never pays less than exact, a seller never receives more.
    function testFuzz_roundingFavoursTheCounterparty(uint256 v, uint256 units, uint256 s, uint256 spread) public view {
        v = bound(v, 0, 1e24);
        units = bound(units, 1, 1e30);
        s = bound(s, 1, 1e24);
        spread = bound(spread, 150, 400);
        uint256 exactFloor = Math.mulDiv(units, v, 1e18);

        (uint256 premium, uint256 fee) = h.buyQuote(v, units, s, spread);
        assertGe(premium * 1e12, exactFloor, "buyer pays at least the exact premium");
        assertGe(fee * 1e12, 1e16, "at least the $0.01 minimum");

        (uint256 gross, uint256 sellFee) = h.sellQuote(v, units, s, spread);
        assertLe(gross * 1e12, exactFloor, "seller's gross never above exact");
        assertLe(sellFee, gross, "fee capped at the gross");
    }

    /// Buying and selling straight back at the same S and σ never returns more than was paid.
    function testFuzz_roundTripNeverReturnsMoreThanPaid(uint256 v, uint256 units, uint256 s, uint256 spread)
        public
        view
    {
        v = bound(v, 0, 1e24);
        units = bound(units, 1, 1e30);
        s = bound(s, 1, 1e24);
        spread = bound(spread, 150, 400);
        (uint256 premium, uint256 fee) = h.buyQuote(v, units, s, spread);
        (uint256 gross, uint256 sellFee) = h.sellQuote(v, units, s, spread);
        assertLe(gross - sellFee, premium + fee);
        assertLe(gross, premium, "the counterparty never pays out more than it took");
    }

    // ---------------------------------------------------------------- strikes

    function test_strikeStepAndBand() public {
        uint256 step = 100e18; // BTC
        uint256 s = 50_000e18;
        h.checkStrike(25_000e18, s, step); // exactly 0.5×
        h.checkStrike(50_000e18, s, step);
        h.checkStrike(100_000e18, s, step); // exactly 2×
        vm.expectRevert(abi.encodeWithSelector(EnginePricing.StrikeOffStep.selector, 50_050e18, step));
        h.checkStrike(50_050e18, s, step);
        vm.expectRevert(abi.encodeWithSelector(EnginePricing.StrikeOutOfBand.selector, 24_900e18, s));
        h.checkStrike(24_900e18, s, step);
        vm.expectRevert(abi.encodeWithSelector(EnginePricing.StrikeOutOfBand.selector, 100_100e18, s));
        h.checkStrike(100_100e18, s, step);
        vm.expectRevert(abi.encodeWithSelector(EnginePricing.StrikeOffStep.selector, 0, step));
        h.checkStrike(0, s, step);
        vm.expectRevert(EnginePricing.ZeroStep.selector);
        h.checkStrike(50_000e18, s, 0);
        // HYPE step $0.10
        h.checkStrike(73.4e18, 73.258e18, 0.1e18);
        vm.expectRevert(abi.encodeWithSelector(EnginePricing.StrikeOffStep.selector, 73.45e18, 0.1e18));
        h.checkStrike(73.45e18, 73.258e18, 0.1e18);
    }

    // ---------------------------------------------------------------- units and raw

    function testFuzz_rawConversionsFavourTheCounterparty(uint256 units, uint256 norm, uint256 balance) public pure {
        units = bound(units, 1, 1e30);
        norm = bound(norm, 1e6, 1e18); // MIN_NORM to a fresh series
        uint256 raw = EnginePricing.rawForBuy(units, norm);
        assertLe(EnginePricing.unitsOf(raw, norm), units, "a buyer holds at most what was paid for");

        balance = bound(balance, 0, 1e42);
        (uint256 burned, uint256 paid) = EnginePricing.rawForSell(units, norm, balance);
        assertLe(burned, balance, "never burns more than held");
        assertLe(paid, units, "never paid for more than asked");
        assertGe(EnginePricing.unitsOf(burned, norm), paid, "the raw burned is worth at least what is paid");
        if (balance >= Math.mulDiv(units, 1e18, norm, Math.Rounding.Ceil)) assertEq(paid, units);

        (uint256 all, uint256 allUnits) = EnginePricing.rawForSell(type(uint256).max, norm, balance);
        assertEq(all, balance, "sell all burns the whole balance");
        assertEq(allUnits, EnginePricing.unitsOf(balance, norm));
    }
}
