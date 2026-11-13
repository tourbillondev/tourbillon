// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EnginePricing} from "../src/EnginePricing.sol";
import {TempoBlend} from "../src/TempoBlend.sol";
import {StrategyMath} from "../src/StrategyMath.sol";

/// External wrappers so reverts can be expected.
contract ShapePricingHarness {
    function checkBuyerShape(StrategyMath.Leg[] memory legs) external pure {
        EnginePricing.checkBuyerShape(legs);
    }

    function checkShapeStrikes(StrategyMath.Leg[] memory legs, uint256 s, uint256 step) external pure {
        EnginePricing.checkShapeStrikes(legs, s, step);
    }

    function buy(int256 v, uint256 units, StrategyMath.Leg[] memory legs, uint256 s)
        external
        pure
        returns (uint256, uint256)
    {
        return EnginePricing.shapeBuyQuote(v, units, legs, s, 200);
    }

    function sell(int256 v, uint256 units, StrategyMath.Leg[] memory legs, uint256 s, uint256 spread)
        external
        pure
        returns (uint256, uint256)
    {
        return EnginePricing.shapeSellQuote(v, units, legs, s, spread);
    }
}

/// M4 step 5: shape pricing and checks.
contract ShapePricingTest is Test {
    ShapePricingHarness h;

    function setUp() public {
        h = new ShapePricingHarness();
    }

    function _leg(bool isCall, uint256 k, int256 q) internal pure returns (StrategyMath.Leg memory) {
        return StrategyMath.Leg(isCall, uint128(k), int128(q));
    }

    function _one(StrategyMath.Leg memory a) internal pure returns (StrategyMath.Leg[] memory l) {
        l = new StrategyMath.Leg[](1);
        l[0] = a;
    }

    function _two(StrategyMath.Leg memory a, StrategyMath.Leg memory b)
        internal
        pure
        returns (StrategyMath.Leg[] memory l)
    {
        l = new StrategyMath.Leg[](2);
        (l[0], l[1]) = (a, b);
    }

    function _three(StrategyMath.Leg memory a, StrategyMath.Leg memory b, StrategyMath.Leg memory c)
        internal
        pure
        returns (StrategyMath.Leg[] memory l)
    {
        l = new StrategyMath.Leg[](3);
        (l[0], l[1], l[2]) = (a, b, c);
    }

    function _condor() internal pure returns (StrategyMath.Leg[] memory l) {
        l = new StrategyMath.Leg[](4);
        l[0] = _leg(true, 90e18, 1e18);
        l[1] = _leg(true, 100e18, -1e18);
        l[2] = _leg(true, 110e18, -1e18);
        l[3] = _leg(true, 120e18, 1e18);
    }

    function _v(StrategyMath.Leg[] memory legs, uint256 s, uint256 sig, TempoBlend.Part[] memory m, bool up)
        internal
        pure
        returns (int256)
    {
        return EnginePricing.shapeValue(legs, s, sig, m, up);
    }

    // ---------------------------------------------------------------- 1. one leg prices like today

    function test_oneLegShapePricesLikeTodaysSingleLeg() public pure {
        TempoBlend.Part[] memory week = TempoBlend.single(7 days);
        bool[2] memory kinds = [true, false];
        uint256[5] memory ss = [uint256(60e18), 95e18, 100e18, 108e18, 180e18];
        uint256[3] memory units = [uint256(1e18), 3.7e18, 250e18];
        for (uint256 c; c < 2; ++c) {
            for (uint256 i; i < 5; ++i) {
                StrategyMath.Leg[] memory legs = _one(_leg(kinds[c], 100e18, 1e18));
                uint256 today = EnginePricing.unitValue(kinds[c], ss[i], 100e18, 5000, week);
                int256 down = _v(legs, ss[i], 5000, week, false);
                int256 up = _v(legs, ss[i], 5000, week, true);
                assertEq(down, int256(today), "rounded down: exactly today's value");
                assertLe(up - down, 1, "rounded up: at most 1 wei more");
                for (uint256 u; u < 3; ++u) {
                    // sell: identical
                    (uint256 g0, uint256 f0) = EnginePricing.sellQuote(today, units[u], ss[i], 200);
                    (uint256 g1, uint256 f1) = EnginePricing.shapeSellQuote(down, units[u], legs, ss[i], 200);
                    assertEq(g1, g0);
                    assertEq(f1, f0);
                    // buy: within one USDC unit (the value now rounds up)
                    (uint256 p0, uint256 b0) = EnginePricing.buyQuote(today, units[u], ss[i], 200);
                    (uint256 p1, uint256 b1) = EnginePricing.shapeBuyQuote(up, units[u], legs, ss[i], 200);
                    assertGe(p1, p0);
                    assertLe(p1 - p0, 1);
                    assertGe(b1, b0);
                    assertLe(b1 - b0, 1);
                }
            }
        }
    }

    // ---------------------------------------------------------------- 2. value = leg sum; fee basis

    function test_valueIsTheLegSumAndFeeBasis() public pure {
        TempoBlend.Part[] memory day = TempoBlend.single(1 days);
        uint256 s = 103e18;
        uint256 c100 = EnginePricing.unitValue(true, s, 100e18, 6000, day);
        uint256 c110 = EnginePricing.unitValue(true, s, 110e18, 6000, day);
        uint256 p100 = EnginePricing.unitValue(false, s, 100e18, 6000, day);

        // call spread: within 1 wei of the leg sum either way
        StrategyMath.Leg[] memory spread = _two(_leg(true, 100e18, 1e18), _leg(true, 110e18, -1e18));
        int256 sum = int256(c100) - int256(c110);
        assertApproxEqAbs(_v(spread, s, 6000, day, false), sum, 1);
        assertApproxEqAbs(_v(spread, s, 6000, day, true), sum, 1);
        // Swing
        StrategyMath.Leg[] memory swing = _two(_leg(false, 100e18, 1e18), _leg(true, 100e18, 1e18));
        assertApproxEqAbs(_v(swing, s, 6000, day, false), int256(c100 + p100), 2);

        // notional units per shape unit: max(long, short)
        assertEq(EnginePricing.shapeNotionalPerUnit(spread), 1e18);
        assertEq(EnginePricing.shapeNotionalPerUnit(swing), 2e18);
        assertEq(EnginePricing.shapeNotionalPerUnit(_condor()), 2e18);
        StrategyMath.Leg[] memory ratio = _two(_leg(true, 100e18, 1e18), _leg(true, 110e18, -2e18));
        assertEq(EnginePricing.shapeNotionalPerUnit(ratio), 2e18);
        StrategyMath.Leg[] memory guardPool = _two(_leg(false, 90e18, -1e18), _leg(true, 110e18, 1e18));
        assertEq(EnginePricing.shapeNotionalPerUnit(guardPool), 1e18);

        // a worked fee: 10 call spreads at S = 103: 2% of |price| (or $0.01), plus 3 bps × 10 × 103
        int256 price = int256(10) * _v(spread, s, 6000, day, true);
        uint256 spreadPart = uint256(price) * 200 / 10_000;
        if (spreadPart < 1e16) spreadPart = 1e16;
        assertApproxEqAbs(EnginePricing.shapeFee(price, 10e18, spread, s, 200), spreadPart + 0.309e18, 2);
        // a Swing pays the notional fee on 2 units of underlying per shape unit
        assertEq(
            EnginePricing.shapeFee(1e18, 10e18, swing, s, 200) - EnginePricing.shapeFee(1e18, 10e18, spread, s, 200),
            0.309e18
        );
        // the fee is on |price|: a negative price costs the same fee as its mirror
        assertEq(
            EnginePricing.shapeFee(-5e18, 1e18, spread, s, 200), EnginePricing.shapeFee(5e18, 1e18, spread, s, 200)
        );
    }

    // ---------------------------------------------------------------- 3. rounding favours the counterparty

    function testFuzz_roundingFavoursTheCounterparty(uint256 seed, uint256 s, uint256 units) public pure {
        s = bound(s, 60e18, 160e18);
        units = bound(units, 1e15, 1_000e18);
        TempoBlend.Part[] memory day = TempoBlend.single(1 days + seed % 5 days);
        StrategyMath.Leg[] memory legs = seed % 3 == 0
            ? _condor()
            : seed % 3 == 1
                ? _two(_leg(true, 100e18, 1e18), _leg(true, 110e18, -1e18))
                : _two(_leg(false, 90e18, -1e18), _leg(true, 110e18, 1e18)); // a pool-side Guard: value of either sign
        int256 down = _v(legs, s, 5000, day, false);
        int256 up = _v(legs, s, 5000, day, true);
        assertGe(up, down);
        assertLe(up - down, 1);

        // write credit ≤ value × units (in USDC, floor); unwrite cost ≥ value × units (ceil)
        (int256 credit, uint256 wf) = EnginePricing.shapeWriteQuote(down, units, legs, s, 200);
        (int256 cost, uint256 uf) = EnginePricing.shapeUnwriteQuote(up, units, legs, s, 200);
        int256 exactE = int256(units) * down; // value × units, scaled by 1e36
        assertLe((credit + int256(wf)) * 1e30, exactE, "credit before fee at most the value");
        assertGe((cost - int256(uf)) * 1e30, int256(units) * up, "cost before fee at least the value");
        assertGe(cost, credit, "a round trip never pays the writer");
        assertGt(wf, 0);
        assertGt(uf, 0);

        // buys and sells, for shapes a buyer may hold
        if (seed % 3 != 2) {
            (uint256 premium, uint256 bf) = EnginePricing.shapeBuyQuote(up, units, legs, s, 200);
            (uint256 gross, uint256 sf) = EnginePricing.shapeSellQuote(down, units, legs, s, 200);
            assertGe(premium * 1e30, units * uint256(down), "premium at least the value");
            assertLe(gross * 1e30, units * uint256(up), "gross at most the value");
            assertGe(premium + bf, gross - sf, "a round trip never pays the buyer");
            assertLe(sf, gross);
        }
    }

    // ---------------------------------------------------------------- 4. what a buyer may hold (law 1)

    function test_buyerShapesThatCanOweAreRefused() public {
        // allowed: payoff never below 0
        h.checkBuyerShape(_two(_leg(true, 100e18, 1e18), _leg(true, 110e18, -1e18))); // call spread
        h.checkBuyerShape(_two(_leg(false, 90e18, -1e18), _leg(false, 100e18, 1e18))); // put spread
        h.checkBuyerShape(_two(_leg(false, 100e18, 1e18), _leg(true, 100e18, 1e18))); // Swing
        h.checkBuyerShape(_condor()); // long condor
        h.checkBuyerShape(_three(_leg(true, 90e18, 1e18), _leg(true, 100e18, -2e18), _leg(true, 110e18, 1e18))); // butterfly
        h.checkBuyerShape(_one(_leg(false, 100e18, 1e18))); // a plain Fall

        // refused: a short call (unbounded), a short put, a risk reversal, the Guard pair, a ratio spread
        StrategyMath.Leg[][5] memory owe = [
            _one(_leg(true, 100e18, -1e18)),
            _one(_leg(false, 100e18, -1e18)),
            _two(_leg(false, 90e18, -1e18), _leg(true, 110e18, 1e18)),
            _two(_leg(false, 90e18, 1e18), _leg(true, 110e18, -1e18)),
            _two(_leg(true, 100e18, 1e18), _leg(true, 110e18, -2e18))
        ];
        for (uint256 i; i < 5; ++i) {
            vm.expectRevert(EnginePricing.ShapeCanOwe.selector);
            h.checkBuyerShape(owe[i]);
        }
    }

    // ---------------------------------------------------------------- 5. strikes on every leg

    function test_strikeChecksOnEveryLeg() public {
        h.checkShapeStrikes(_condor(), 100e18, 5e18);
        StrategyMath.Leg[] memory off = _two(_leg(true, 100e18, 1e18), _leg(true, 112e18, -1e18));
        vm.expectRevert(abi.encodeWithSelector(EnginePricing.StrikeOffStep.selector, 112e18, 5e18));
        h.checkShapeStrikes(off, 100e18, 5e18);
        StrategyMath.Leg[] memory far = _two(_leg(false, 45e18, -1e18), _leg(false, 100e18, 1e18));
        vm.expectRevert(abi.encodeWithSelector(EnginePricing.StrikeOutOfBand.selector, 45e18, 100e18));
        h.checkShapeStrikes(far, 100e18, 5e18);
    }

    // ---------------------------------------------------------------- 6. worthless sells; zero units

    function test_worthlessShapeSellsForZeroAndNeverReverts() public view {
        StrategyMath.Leg[] memory spread = _two(_leg(true, 190e18, 1e18), _leg(true, 200e18, -1e18));
        int256 v = _v(spread, 100e18, 2000, TempoBlend.single(1 hours), false);
        assertEq(v, 0, "far out of the money");
        (uint256 gross, uint256 fee) = h.sell(v, 5e18, spread, 100e18, 400);
        assertEq(gross, 0);
        assertEq(fee, 0);
        (gross, fee) = h.sell(-3, 5e18, spread, 100e18, 400); // a rounding below 0 counts as 0
        assertEq(gross, 0);
        assertEq(fee, 0);
    }

    function test_zeroUnitsRefusedAndANegativeRoundingBuysAtZero() public {
        StrategyMath.Leg[] memory spread = _two(_leg(true, 100e18, 1e18), _leg(true, 110e18, -1e18));
        vm.expectRevert(EnginePricing.ZeroUnits.selector);
        h.buy(1e18, 0, spread, 100e18);
        vm.expectRevert(EnginePricing.ZeroUnits.selector);
        h.sell(1e18, 0, spread, 100e18, 200);
        // a deep out-of-the-money spread can compute a few wei below 0 (TempoMath rounding): bought at 0 plus the fee
        (uint256 premium, uint256 fee) = h.buy(-4, 1e18, spread, 100e18);
        assertEq(premium, 0);
        assertEq(fee, 10_000 + 30_000);
    }

    // ---------------------------------------------------------------- 7. a write can be a net debit

    function test_writeCreditCanBeNegative() public pure {
        TempoBlend.Part[] memory week = TempoBlend.single(7 days);
        // Guard, pool side: short the Fall at 90, long the Rise at 110 (the writer buys the Fall and writes the Rise)
        StrategyMath.Leg[] memory guardPool = _two(_leg(false, 90e18, -1e18), _leg(true, 110e18, 1e18));
        // below 100 the Fall is worth more than the Rise: the pool's side is negative, so the writer pays
        int256 v = _v(guardPool, 88e18, 5000, week, false);
        assertLt(v, 0);
        (int256 credit, uint256 fee) = EnginePricing.shapeWriteQuote(v, 10e18, guardPool, 88e18, 200);
        assertLt(credit, 0);
        assertLe(credit, -int256(fee));
        // above 100 the Rise is worth more: the writer receives
        v = _v(guardPool, 112e18, 5000, week, false);
        assertGt(v, 0);
        (credit,) = EnginePricing.shapeWriteQuote(v, 10e18, guardPool, 112e18, 200);
        assertGt(credit, 0);
        // a worthless write: the writer pays the minimum fee
        StrategyMath.Leg[] memory far = _two(_leg(true, 190e18, 1e18), _leg(true, 200e18, -1e18));
        (credit, fee) = EnginePricing.shapeWriteQuote(0, 1e18, far, 100e18, 200);
        assertEq(credit, -int256(fee));
        assertEq(fee, 10_000 + 30_000); // $0.01 + 3 bps × 1 × $100
    }
}
