// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {StrategyMath} from "../src/StrategyMath.sol";
import {EnginePricing} from "../src/EnginePricing.sol";
import {TempoBlend} from "../src/TempoBlend.sol";

contract CollateralHarness {
    function collateral(bytes32 market, StrategyMath.Leg[] memory legs, int256 cover) external pure returns (uint256) {
        return StrategyMath.writerCollateral(market, legs, cover);
    }
}

/// M4 step 8a, the T1 gate in pure maths: "no written position can owe more than its collateral".
/// The collateral side is checked against the exact payoff (WAD × WAD scale) with no tolerance (owner, after the step 8
/// finding). For random 1–4 leg shapes from the writer's side (signed amounts, mixed calls and puts, strikes around the price,
/// optional WHYPE cover on HYPE) with collateral = StrategyMath's exact worst case:
///   1. at every price (0, every strike, a dense grid, far above the top strike) the writer's loss ≤ the collateral;
///   2. at any price, vol and tempo, the buyback value (the pool's side) ≤ the collateral (+ the cover's value),
///      within the few-wei TempoMath tolerance (M4 step 6 finding);
///   3. shapes that cannot be covered (a net short call without cover, cover off HYPE) are always refused;
///   4. the collateral is exact: some price reaches it, so nothing is over-locked.
contract WriterCollateralFuzzTest is Test {
    uint256 constant S0 = 100e18;
    int256 constant WEI_TOLERANCE = 1_000; // TempoMath wei-level rounding × legs × amounts, in WAD USDC
    CollateralHarness h;

    function setUp() public {
        h = new CollateralHarness();
    }

    struct Case {
        StrategyMath.Leg[] legs; // the writer's side
        bool cover;
        int256 coverQty;
        bytes32 market;
    }

    function _case(uint256 seed, bool wantCover, bool offHype) internal pure returns (Case memory c) {
        uint256 n = 1 + seed % 4;
        c.legs = new StrategyMath.Leg[](n);
        int256 callSlope;
        for (uint256 j; j < n; ++j) {
            uint256 r = uint256(keccak256(abi.encode(seed, j)));
            bool isCall = r % 2 == 0;
            uint256 k = (50 + ((r >> 8) % 151)) * 1e18; // strikes 50..200 around S0 = 100
            int256 q = int256(0.1e18 + (r >> 32) % 4.9e18); // 0.1..5
            if ((r >> 96) % 2 == 0) q = -q;
            c.legs[j] = StrategyMath.Leg(isCall, uint128(k), int128(q));
            if (isCall) callSlope += q;
        }
        c.market = offHype ? bytes32("BTC") : bytes32("HYPE");
        c.cover = wantCover && callSlope < 0;
        c.coverQty = c.cover ? -callSlope : int256(0);
    }

    function _maxStrike(StrategyMath.Leg[] memory legs) internal pure returns (uint256 m) {
        for (uint256 j; j < legs.length; ++j) {
            if (legs[j].kWad > m) m = legs[j].kWad;
        }
    }

    function _neg(StrategyMath.Leg[] memory legs) internal pure returns (StrategyMath.Leg[] memory out) {
        out = new StrategyMath.Leg[](legs.length);
        for (uint256 j; j < legs.length; ++j) {
            out[j] = StrategyMath.Leg(legs[j].isCall, legs[j].kWad, -legs[j].qty);
        }
    }

    /// forge-config: default.fuzz.runs = 10000
    function testFuzz_noWrittenPositionOwesMoreThanItsCollateral(
        uint256 seed,
        bool wantCover,
        uint256 sPick,
        uint256 sigma,
        uint256 tempo
    ) public {
        Case memory c = _case(seed, wantCover, false);
        int256 callSlope;
        for (uint256 j; j < c.legs.length; ++j) {
            if (c.legs[j].isCall) callSlope += c.legs[j].qty;
        }

        // 3. a net short call without cover is refused; with cover the slope is exactly offset
        if (callSlope + c.coverQty < 0) {
            vm.expectRevert(StrategyMath.Unbounded.selector);
            h.collateral(c.market, c.legs, c.coverQty);
            return;
        }
        uint256 coll = h.collateral(c.market, c.legs, c.coverQty);

        // 1. the writer's loss at every price is at most the collateral (the cover's value is in the payoff); 4. exact
        uint256 kMax = _maxStrike(c.legs);
        int256 minScaled = _checkAt(c, coll, 0);
        for (uint256 j; j < c.legs.length; ++j) {
            int256 p = _checkAt(c, coll, c.legs[j].kWad);
            if (p < minScaled) minScaled = p;
        }
        for (uint256 i = 1; i <= 60; ++i) {
            _checkAt(c, coll, kMax * 3 * i / 60);
        }
        _checkAt(c, coll, kMax * 10);
        _checkAt(c, coll, kMax * 1000);
        assertEq(
            coll,
            minScaled < 0 ? Math.ceilDiv(uint256(-minScaled), 1e18) : 0,
            "exact: the true worst case (reached at 0 or a strike), rounded up to a wei"
        );

        // 2. the buyback value (the pool's side) at any price, vol and tempo is at most the collateral plus the cover
        uint256 s = S0 * bound(sPick, 30, 300) / 100;
        sigma = bound(sigma, 500, 30_000);
        tempo = bound(tempo, 1 hours, 30 days);
        int256 v = EnginePricing.shapeValue(_neg(c.legs), s, sigma, TempoBlend.single(tempo), true);
        int256 coverValue = c.coverQty * int256(s) / 1e18;
        assertLe(v, int256(coll) + coverValue + WEI_TOLERANCE, "the buyback never exceeds the collateral");
    }

    /// The exact payoff (WAD × WAD, no division) at `s` against the collateral: no tolerance.
    function _checkAt(Case memory c, uint256 coll, uint256 s) internal pure returns (int256 p) {
        p = StrategyMath.payoffAtScaled(c.legs, c.coverQty, s);
        assertGe(p, -int256(coll) * 1e18, "the writer never owes more than the collateral at this price");
    }

    /// 3. cover counts only on HYPE: anywhere else it is refused.
    /// forge-config: default.fuzz.runs = 10000
    function testFuzz_coverOffHypeIsRefused(uint256 seed) public {
        Case memory c = _case(seed, true, true);
        if (!c.cover) return; // nothing to cover
        vm.expectRevert(abi.encodeWithSelector(StrategyMath.CoverNotAllowed.selector, bytes32("BTC")));
        h.collateral(c.market, c.legs, c.coverQty);
    }

    /// 2 with a Movement: the value bound holds for any mix of tempos too.
    /// forge-config: default.fuzz.runs = 10000
    function testFuzz_buybackBoundWithAMovement(uint256 seed, uint256 sPick, uint256 sigma) public view {
        Case memory c = _case(seed, true, false);
        if (c.legs.length > 2) return; // the cap: 2 legs × a 2-part Movement
        int256 callSlope;
        for (uint256 j; j < c.legs.length; ++j) {
            if (c.legs[j].isCall) callSlope += c.legs[j].qty;
        }
        if (callSlope + c.coverQty < 0) return;
        uint256 coll = h.collateral(c.market, c.legs, c.coverQty);
        TempoBlend.Part[] memory mv = new TempoBlend.Part[](2);
        mv[0] = TempoBlend.Part(1 hours + seed % 3 days, 0.3e18);
        mv[1] = TempoBlend.Part(4 days + seed % 20 days, 0.7e18);
        uint256 s = S0 * bound(sPick, 30, 300) / 100;
        sigma = bound(sigma, 500, 30_000);
        int256 v = EnginePricing.shapeValue(_neg(c.legs), s, sigma, mv, true);
        assertLe(v, int256(coll) + c.coverQty * int256(s) / 1e18 + WEI_TOLERANCE);
    }
}
