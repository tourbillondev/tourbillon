// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Kit suite: StrategyQuote (8 tests), run against our StrategyMath, TempoBlend, TempoMath and VolQuoteBook.
///
/// Changes from the kit file, and why:
///   1. Contracts renamed KitStrategyQuoteTest / KitStrategyWrapper / KitBlender so names do not clash with ours.
///   2. writerCollateral takes the market name: covering units (WHYPE) count only on the HYPE market (our rule),
///      so the covered call is written on "HYPE" and the uncovered shapes on "BTC".
///   3. σ passed in basis points (our unit): the fuzz test's uint256(sig) * 1e14 becomes sig.
///   4. test_blend: one σ for every tempo of a Movement (decision Q12; per-tempo σ is for later), Parts instead
///      of fixed arrays, funding per second from quote() instead of fundingPerYear, and our WeightsNotOne error.
///   5. test_signed_quote_checks runs against our stateful VolQuoteBook (decision Q19) instead of the stateless
///      library with a test domain: the maker signs book.hashQuote (domain "Tourbillon", "1", this chain, the
///      book); the size already filled comes from a real 45e18 fill instead of an argument; expiry is reached by
///      moving the clock 61 s instead of passing a later timestamp. The kit's Checker wrapper is no longer needed.
///   Strikes, quantities, expected collateral and tolerances are otherwise unchanged.

import {Test} from "forge-std/Test.sol";
import {StrategyMath} from "../../src/StrategyMath.sol";
import {TempoBlend} from "../../src/TempoBlend.sol";
import {TempoMath} from "../../src/TempoMath.sol";
import {VolQuote, VolQuoteBook} from "../../src/VolQuote.sol";

contract KitStrategyQuoteTest is Test {
    function _legs(bool c0, uint128 k0, int128 q0, bool c1, uint128 k1, int128 q1)
        internal
        pure
        returns (StrategyMath.Leg[] memory l)
    {
        l = new StrategyMath.Leg[](2);
        l[0] = StrategyMath.Leg(c0, k0, q0);
        l[1] = StrategyMath.Leg(c1, k1, q1);
    }

    // ── collateral ──
    function test_writer_of_call_spread_locks_the_width() public pure {
        // writer sells the 100 call, buys the 110 call: worst case = width 10 per unit
        StrategyMath.Leg[] memory l = _legs(true, 100e18, -1e18, true, 110e18, 1e18);
        assertEq(StrategyMath.writerCollateral("BTC", l, 0), 10e18);
    }

    function test_cash_secured_put_locks_strike_and_covered_call_locks_nothing() public pure {
        StrategyMath.Leg[] memory p = new StrategyMath.Leg[](1);
        p[0] = StrategyMath.Leg(false, 95e18, -2e18);
        assertEq(StrategyMath.writerCollateral("BTC", p, 0), 190e18, "2 units x strike");
        StrategyMath.Leg[] memory c = new StrategyMath.Leg[](1);
        c[0] = StrategyMath.Leg(true, 120e18, -1e18);
        assertEq(StrategyMath.writerCollateral("HYPE", c, 1e18), 0, "1 WHYPE unit covers the short call");
    }

    function test_naked_short_call_is_refused() public {
        StrategyMath.Leg[] memory c = new StrategyMath.Leg[](1);
        c[0] = StrategyMath.Leg(true, 120e18, -1e18);
        KitStrategyWrapper w = new KitStrategyWrapper();
        vm.expectRevert(StrategyMath.Unbounded.selector);
        w.collateral("BTC", c, 0);
    }

    function test_iron_condor_writer_locks_the_wider_wing() public pure {
        StrategyMath.Leg[] memory l = new StrategyMath.Leg[](4);
        l[0] = StrategyMath.Leg(false, 80e18, 1e18); // long put wing
        l[1] = StrategyMath.Leg(false, 90e18, -1e18); // short put
        l[2] = StrategyMath.Leg(true, 110e18, -1e18); // short call
        l[3] = StrategyMath.Leg(true, 125e18, 1e18); // long call wing (wider)
        assertEq(StrategyMath.writerCollateral("BTC", l, 0), 15e18);
        (int256 mn, int256 mx, bool mnU, bool mxU) = StrategyMath.bounds(l, 0);
        assertEq(mn, -15e18);
        assertEq(mx, 0);
        assertFalse(mnU);
        assertFalse(mxU);
    }

    function test_collar_bounds() public pure {
        // own 1 unit, long 90 put, short 115 call: value between 90 and 115
        StrategyMath.Leg[] memory l = _legs(false, 90e18, 1e18, true, 115e18, -1e18);
        (int256 mn, int256 mx, bool mnU, bool mxU) = StrategyMath.bounds(l, 1e18);
        assertEq(mn, 90e18);
        assertEq(mx, 115e18);
        assertFalse(mnU);
        assertFalse(mxU);
    }

    /// The no-expiry value of a written spread never exceeds the locked collateral, at any S, sigma, tempo.
    function testFuzz_value_never_exceeds_collateral(uint128 s, uint64 sig, uint32 tau, uint128 k1, uint128 w)
        public
        pure
    {
        s = uint128(bound(s, 1e18, 1000e18));
        sig = uint64(bound(sig, 1000, 30000));
        tau = uint32(bound(tau, 3600, 30 days));
        k1 = uint128(bound(k1, 10e18, 500e18));
        w = uint128(bound(w, 1e18, 100e18));
        uint128 k2 = k1 + w;
        StrategyMath.Leg[] memory l = _legs(true, k1, -1e18, true, k2, 1e18);
        uint256 coll = StrategyMath.writerCollateral("BTC", l, 0);
        // deep out of the money both values are a few wei and TempoMath's rounding can order them either way (V(95) = 4
        // wei, V(100) = 5 wei at S = 1.6): a spread worth "less than 0" by rounding is worth 0 (M4 step 6)
        uint256 v1 = TempoMath.value(true, s, k1, sig, tau);
        uint256 v2 = TempoMath.value(true, s, k2, sig, tau);
        uint256 v = v1 > v2 ? v1 - v2 : 0;
        assertLe(v, coll + 1e6, "spread value <= width");
    }

    // ── maker quotes ── (Quote v2, M6 step 2: `sides` replaces `isCall`; the check takes the whole order)
    function _quote(address maker) internal view returns (VolQuote.Quote memory) {
        return VolQuote.Quote(
            maker,
            "NVDA",
            VolQuote.SIDE_CALLS,
            95e18,
            115e18,
            1 days,
            7 days,
            4800,
            50e18,
            uint64(block.timestamp + 60),
            1
        );
    }

    function _call(uint128 k) internal pure returns (StrategyMath.Leg[] memory l) {
        l = new StrategyMath.Leg[](1);
        l[0] = StrategyMath.Leg(true, k, 1e18);
    }

    function test_signed_quote_checks() public {
        uint256 t0 = block.timestamp;
        VolQuoteBook book = new VolQuoteBook(address(this));
        (address maker, uint256 pk) = makeAddrAndKey("maker");
        VolQuote.Quote memory q = _quote(maker);
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(pk, book.hashQuote(q));
        bytes memory sig = abi.encodePacked(r, s_, v);
        TempoBlend.Part[] memory three = TempoBlend.single(3 days);
        book.check(q, sig, "NVDA", _call(100e18), three, 10e18); // ok
        vm.expectRevert(VolQuote.OutOfBand.selector);
        book.check(q, sig, "NVDA", _call(130e18), three, 10e18);
        book.fill(q, sig, "NVDA", _call(100e18), three, 45e18); // 45 of 50 used
        vm.expectRevert(VolQuote.TooLarge.selector);
        book.check(q, sig, "NVDA", _call(100e18), three, 10e18);
        vm.warp(t0 + 61);
        vm.expectRevert(VolQuote.Expired.selector);
        book.check(q, sig, "NVDA", _call(100e18), three, 1e18);
        vm.warp(t0);
        q.sigmaBps = 3000; // taker tampers with the maker's vol
        vm.expectRevert(VolQuote.BadSignature.selector);
        book.check(q, sig, "NVDA", _call(100e18), three, 1e18);
    }

    // ── any tempo / movement ──
    function test_blend_is_exact_weighted_sum_and_needs_full_weight() public {
        TempoBlend.Part[] memory m = new TempoBlend.Part[](3);
        m[0] = TempoBlend.Part(1 days, 0.5e18);
        m[1] = TempoBlend.Part(7 days, 0.3e18);
        m[2] = TempoBlend.Part(30 days, 0.2e18);
        uint256 v = TempoBlend.value(true, 100e18, 105e18, 5000, m);
        uint256 ref = TempoMath.value(true, 100e18, 105e18, 5000, 1 days) * 5 / 10
            + TempoMath.value(true, 100e18, 105e18, 5000, 7 days) * 3 / 10
            + TempoMath.value(true, 100e18, 105e18, 5000, 30 days) * 2 / 10;
        assertApproxEqAbs(v, ref, 10);
        (, uint256 fundingPerSecond,) = TempoBlend.quote(true, 100e18, 105e18, 5000, m, TempoMath.defaultBounds());
        assertGt(fundingPerSecond, 0);
        m[2].weight = 0.1e18;
        KitBlender b = new KitBlender();
        vm.expectRevert(abi.encodeWithSelector(TempoBlend.WeightsNotOne.selector, 0.9e18));
        b.value(m);
    }
}

contract KitStrategyWrapper {
    function collateral(bytes32 market, StrategyMath.Leg[] memory l, int256 c) external pure returns (uint256) {
        return StrategyMath.writerCollateral(market, l, c);
    }
}

contract KitBlender {
    function value(TempoBlend.Part[] memory m) external pure returns (uint256) {
        return TempoBlend.value(true, 100e18, 105e18, 5000, m);
    }
}
