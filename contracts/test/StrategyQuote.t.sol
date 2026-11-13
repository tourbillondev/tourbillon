// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TempoMath} from "../src/TempoMath.sol";
import {TempoBlend} from "../src/TempoBlend.sol";
import {StrategyMath} from "../src/StrategyMath.sol";
import {VolQuote, VolQuoteBook} from "../src/VolQuote.sol";

/// External wrapper so reverts happen one call deep.
contract TempoBlendHarness {
    function quote(bool isCall, uint256 s, uint256 k, uint256 sigmaBps, TempoBlend.Part[] calldata m)
        external
        pure
        returns (uint256 v, uint256 funding, uint256 rate)
    {
        return TempoBlend.quote(isCall, s, k, sigmaBps, m, TempoMath.defaultBounds());
    }
}

/// External wrapper so StrategyMath reverts happen one call deep.
contract StrategyHarness {
    function collateral(bytes32 market, StrategyMath.Leg[] memory l, int256 c) external pure returns (uint256) {
        return StrategyMath.writerCollateral(market, l, c);
    }
}

contract StrategyQuoteTest is Test {
    uint256 constant REL_1E5 = 1e13;
    TempoBlendHarness blend;
    StrategyHarness strat;

    function setUp() public {
        blend = new TempoBlendHarness();
        strat = new StrategyHarness();
    }

    function _parts(uint256[] memory tempos, uint256[] memory weights)
        internal
        pure
        returns (TempoBlend.Part[] memory m)
    {
        m = new TempoBlend.Part[](tempos.length);
        for (uint256 i; i < tempos.length; ++i) {
            m[i] = TempoBlend.Part(tempos[i], weights[i]);
        }
    }

    function _two(uint256 t0, uint256 w0, uint256 t1, uint256 w1) internal pure returns (TempoBlend.Part[] memory m) {
        m = new TempoBlend.Part[](2);
        m[0] = TempoBlend.Part(t0, w0);
        m[1] = TempoBlend.Part(t1, w1);
    }

    /// Movements: value Σw·V, funding Σw·TV/tempo, shrink rate funding/V, and the shape rules.
    function test_movements() public {
        TempoMath.SigmaBounds memory b = TempoMath.defaultBounds();

        // One part equals TempoMath exactly; funding = TV/tempo; ATM 3-day Rise costs ~$0.53 a day
        (uint256 v, uint256 f, uint256 r) = blend.quote(true, 100e18, 100e18, 5000, TempoBlend.single(3 days));
        assertEq(v, TempoMath.value(true, 100e18, 100e18, 5000, 3 days));
        assertApproxEqRel(v, 1.602446e18, REL_1E5);
        assertApproxEqRel(f * 1 days, 0.534149e18, REL_1E5);
        // At the money TV = V, so the rate is 1/tempo
        assertApproxEqRel(r, uint256(1e18) / 3 days, 1e6);

        // In the money: TV < V, so the rate is below 1/tempo
        (uint256 vItm, uint256 tvItm) = TempoMath.valueAndTimeValue(true, 120e18, 100e18, 5000, 3 days, b);
        (, uint256 fItm, uint256 rItm) = blend.quote(true, 120e18, 100e18, 5000, TempoBlend.single(3 days));
        assertEq(fItm, tvItm / 3 days);
        assertApproxEqRel(rItm, tvItm * 1e18 / vItm / 3 days, 1e6);
        assertLt(rItm, uint256(1e18) / 3 days);

        // Two parts, 30% Day + 70% Week, against a hand-built sum
        (uint256 v1, uint256 tv1) = TempoMath.valueAndTimeValue(false, 95e18, 100e18, 6000, 1 days, b);
        (uint256 v7, uint256 tv7) = TempoMath.valueAndTimeValue(false, 95e18, 100e18, 6000, 7 days, b);
        uint256 vHand = (0.3e18 * v1 + 0.7e18 * v7) / 1e18;
        uint256 fHand = (0.3e18 * tv1 / 1 days + 0.7e18 * tv7 / 7 days) / 1e18;
        (v, f, r) = blend.quote(false, 95e18, 100e18, 6000, _two(1 days, 0.3e18, 7 days, 0.7e18));
        assertEq(v, vHand);
        assertApproxEqAbs(f, fHand, 1);
        assertApproxEqRel(r, f * 1e18 / v, 1e9);
        // The mix's daily cost sits between Day alone and Week alone. Which of the two is
        // higher depends on moneyness: here (5% in the money) Week costs more per day.
        (, uint256 fDay,) = blend.quote(false, 95e18, 100e18, 6000, TempoBlend.single(1 days));
        (, uint256 fWeek,) = blend.quote(false, 95e18, 100e18, 6000, TempoBlend.single(7 days));
        assertGt(fWeek, fDay);
        assertTrue(f > fDay && f < fWeek);
        // At the money it is the other way round: Day costs more per day
        (, fDay,) = blend.quote(true, 100e18, 100e18, 6000, TempoBlend.single(1 days));
        (, fWeek,) = blend.quote(true, 100e18, 100e18, 6000, TempoBlend.single(7 days));
        (, f,) = blend.quote(true, 100e18, 100e18, 6000, _two(1 days, 0.3e18, 7 days, 0.7e18));
        assertTrue(f > fWeek && f < fDay);

        // Deep out of the money the value rounds to 0; the rate takes its limit 1/max tempo
        (v,, r) = blend.quote(true, 1e18, 1000e18, 500, _two(1 hours, 0.5e18, 2 hours, 0.5e18));
        assertEq(v, 0);
        assertEq(r, uint256(1e18) / 2 hours);

        // Shape rules
        vm.expectRevert(TempoBlend.EmptyMovement.selector);
        blend.quote(true, 100e18, 100e18, 5000, new TempoBlend.Part[](0));

        uint256[] memory t5 = new uint256[](5);
        uint256[] memory w5 = new uint256[](5);
        for (uint256 i; i < 5; ++i) {
            t5[i] = (i + 1) * 1 days;
            w5[i] = 0.2e18;
        }
        vm.expectRevert(abi.encodeWithSelector(TempoBlend.TooManyParts.selector, 5));
        blend.quote(true, 100e18, 100e18, 5000, _parts(t5, w5));

        vm.expectRevert(abi.encodeWithSelector(TempoBlend.ZeroWeight.selector, 1));
        blend.quote(true, 100e18, 100e18, 5000, _two(1 days, 1e18, 7 days, 0));

        vm.expectRevert(abi.encodeWithSelector(TempoBlend.RepeatedTempo.selector, 1 days));
        blend.quote(true, 100e18, 100e18, 5000, _two(1 days, 0.5e18, 1 days, 0.5e18));

        vm.expectRevert(abi.encodeWithSelector(TempoBlend.WeightsNotOne.selector, 0.9e18));
        blend.quote(true, 100e18, 100e18, 5000, _two(1 days, 0.5e18, 7 days, 0.4e18));

        vm.expectRevert(abi.encodeWithSelector(TempoBlend.WeightsNotOne.selector, 1e18 + 1));
        blend.quote(true, 100e18, 100e18, 5000, _two(1 days, 0.5e18, 7 days, 0.5e18 + 1));

        // Each part's tempo still has to be in range
        vm.expectRevert(abi.encodeWithSelector(TempoMath.TempoOutOfRange.selector, 31 days));
        blend.quote(true, 100e18, 100e18, 5000, _two(1 days, 0.5e18, 31 days, 0.5e18));

        // Four parts is the maximum and works
        uint256[] memory t4 = new uint256[](4);
        uint256[] memory w4 = new uint256[](4);
        for (uint256 i; i < 4; ++i) {
            t4[i] = (i + 1) * 1 days;
            w4[i] = 0.25e18;
        }
        (v,,) = blend.quote(true, 100e18, 100e18, 5000, _parts(t4, w4));
        assertGt(v, 0);
    }

    /// WHYPE covers only on the HYPE market; covers are never negative; at most four legs.
    /// A covered HYPE collar (long Fall, short Rise above, covered by WHYPE) locks only the covering units,
    /// and its payoff stays between the two strikes at every price.
    function test_coverRulesAndCoveredCollar() public {
        StrategyMath.Leg[] memory collar = new StrategyMath.Leg[](2);
        collar[0] = StrategyMath.Leg(false, 90e18, 1e18); // long Fall 90
        collar[1] = StrategyMath.Leg(true, 110e18, -1e18); // short Rise 110

        // Covered collar on HYPE: no cash, only the WHYPE unit
        assertEq(strat.collateral("HYPE", collar, 1e18), 0);
        (int256 mn, int256 mx, bool mnU, bool mxU) = StrategyMath.bounds(collar, 1e18);
        assertEq(mn, 90e18);
        assertEq(mx, 110e18);
        assertFalse(mnU || mxU);
        for (uint256 sp; sp <= 300; sp += 5) {
            int256 p = StrategyMath.payoffAt(collar, 1e18, sp * 1e18);
            assertTrue(p >= 90e18 && p <= 110e18, "collar stays between the strikes");
        }

        // The same cover anywhere else is refused; without cover the short Rise is naked
        vm.expectRevert(abi.encodeWithSelector(StrategyMath.CoverNotAllowed.selector, bytes32("BTC")));
        strat.collateral("BTC", collar, 1e18);
        vm.expectRevert(StrategyMath.Unbounded.selector);
        strat.collateral("HYPE", collar, 0);
        vm.expectRevert(StrategyMath.NegativeCover.selector);
        strat.collateral("HYPE", collar, -1e18);

        // Half a unit of cover leaves half the short Rise naked
        vm.expectRevert(StrategyMath.Unbounded.selector);
        strat.collateral("HYPE", collar, 0.5e18);

        // Five legs are refused, four are fine
        StrategyMath.Leg[] memory five = new StrategyMath.Leg[](5);
        for (uint256 i; i < 5; i++) {
            five[i] = StrategyMath.Leg(false, uint128(80e18 + i * 5e18), i % 2 == 0 ? int128(1e18) : -1e18);
        }
        vm.expectRevert(StrategyMath.TooManyLegs.selector);
        strat.collateral("BTC", five, 0);
        StrategyMath.Leg[] memory four = new StrategyMath.Leg[](4);
        for (uint256 i; i < 4; i++) {
            four[i] = five[i];
        }
        assertEq(strat.collateral("BTC", four, 0), 10e18); // two written put spreads, 5 wide each, both lose below 80
    }

    /// Fuzz, four legs: no written position can owe more than its collateral. For every bounded shape
    /// (shared tempo and σ), the writer's marked liability −Σ qᵢ·Vᵢ(S) never exceeds the collateral, at
    /// any price, and neither does −payoff(S).
    function testFuzz_fourLegsNeverOweMoreThanCollateral(
        uint256 seed,
        uint256 s,
        uint256 sig,
        uint256 tau,
        bool hype,
        uint256 cover
    ) public view {
        s = bound(s, 1e18, 1000e18);
        sig = bound(sig, 500, 30_000);
        tau = bound(tau, 1 hours, 30 days);
        cover = hype ? bound(cover, 0, 3) * 1e18 : 0;
        StrategyMath.Leg[] memory l = new StrategyMath.Leg[](4);
        for (uint256 i; i < 4; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            l[i] = StrategyMath.Leg(
                r % 2 == 0, uint128(10e18 + (r >> 8) % 490e18), int128(int256((r >> 128) % 5e18)) - 2.5e18
            );
        }
        bytes32 market = hype ? bytes32("HYPE") : bytes32("BTC");
        try strat.collateral(market, l, int256(cover)) returns (uint256 coll) {
            // −payoff at the fuzzed price, and the marked liability
            int256 p = StrategyMath.payoffAt(l, int256(cover), s);
            assertLe(-p, int256(coll));
            int256 marked = int256(cover) * int256(s) / 1e18;
            for (uint256 i; i < 4; i++) {
                uint256 v = TempoMath.value(l[i].isCall, s, l[i].kWad, sig, tau);
                marked += int256(l[i].qty) * int256(v) / 1e18;
            }
            assertLe(-marked, int256(coll) + 1e7, "liability <= collateral (rounding 1e-11)");
        } catch (bytes memory err) {
            assertEq(bytes4(err), StrategyMath.Unbounded.selector); // only naked upside is refused
        }
    }

    // ---------------------------------------------------------------- maker quotes (Quote v2, M6 step 2)

    uint256 constant MAKER_PK = 0xA11CE;

    function _book() internal returns (VolQuoteBook) {
        return new VolQuoteBook(address(this)); // this test plays the filler (the OpenBook router)
    }

    function _q(uint64 nonce, uint64 validUntil) internal pure returns (VolQuote.Quote memory) {
        return VolQuote.Quote(
            vm.addr(MAKER_PK), "BTC", VolQuote.SIDE_CALLS, 95e18, 115e18, 1 days, 7 days, 4800, 50e18, validUntil, nonce
        );
    }

    function _sign(VolQuoteBook book, VolQuote.Quote memory q, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(pk, book.hashQuote(q));
        return abi.encodePacked(r, s_, v);
    }

    function _call(uint256 k) internal pure returns (StrategyMath.Leg[] memory l) {
        l = new StrategyMath.Leg[](1);
        l[0] = StrategyMath.Leg(true, uint128(k), 1e18);
    }

    function _spread(uint256 k1, uint256 k2) internal pure returns (StrategyMath.Leg[] memory l) {
        l = new StrategyMath.Leg[](2);
        l[0] = StrategyMath.Leg(true, uint128(k1), 1e18);
        l[1] = StrategyMath.Leg(true, uint128(k2), -1e18);
    }

    function _swing(uint256 k) internal pure returns (StrategyMath.Leg[] memory l) {
        l = new StrategyMath.Leg[](2);
        l[0] = StrategyMath.Leg(false, uint128(k), 1e18);
        l[1] = StrategyMath.Leg(true, uint128(k), 1e18);
    }

    function _mv(uint256 t1, uint256 t2) internal pure returns (TempoBlend.Part[] memory m) {
        m = new TempoBlend.Part[](2);
        m[0] = TempoBlend.Part(t1, 0.5e18);
        m[1] = TempoBlend.Part(t2, 0.5e18);
    }

    /// Signature: domain "Tourbillon" / "1" / this chain / the book; any change to a signed field, another signer,
    /// another chain or a malformed signature is refused; only the filler fills.
    function test_quoteSignatureAndTamper() public {
        VolQuoteBook book = _book();
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Tourbillon"),
                keccak256("1"),
                block.chainid,
                address(book)
            )
        );
        assertEq(book.domainSeparator(), expected);

        VolQuote.Quote memory q = _q(1, uint64(block.timestamp + 1 hours));
        bytes memory sig = _sign(book, q, MAKER_PK);
        TempoBlend.Part[] memory three = TempoBlend.single(3 days);
        assertEq(book.fill(q, sig, "BTC", _call(100e18), three, 1e18), 4800);

        // Every signed field is covered by the signature, the new `sides` included
        for (uint256 i; i < 8; i++) {
            VolQuote.Quote memory t = _q(1, uint64(block.timestamp + 1 hours));
            if (i == 0) t.sigmaBps = 4000;
            if (i == 1) t.maxUnits = 500e18;
            if (i == 2) t.validUntil += 1 days;
            if (i == 3) t.kLoWad = 50e18;
            if (i == 4) t.tauHi = 30 days;
            if (i == 5) t.nonce = 2;
            if (i == 6) t.name = "ETH";
            if (i == 7) t.sides = VolQuote.SIDE_BOTH;
            vm.expectRevert(VolQuote.BadSignature.selector);
            book.check(t, sig, t.name, _call(100e18), three, 1e18);
        }
        // Signed by someone else (signature made before expectRevert: it calls the book)
        bytes memory other = _sign(book, q, 0xB0B);
        vm.expectRevert(VolQuote.BadSignature.selector);
        book.check(q, other, "BTC", _call(100e18), three, 1e18);
        // Replayed on another chain: the domain differs
        uint256 home = block.chainid;
        vm.chainId(home + 1);
        vm.expectRevert(VolQuote.BadSignature.selector);
        book.check(q, sig, "BTC", _call(100e18), three, 1e18);
        vm.chainId(home);
        // Malformed signature
        vm.expectRevert();
        book.check(q, hex"1234", "BTC", _call(100e18), three, 1e18);
        // Only the filler fills
        vm.prank(address(0xBAD));
        vm.expectRevert(VolQuoteBook.NotFiller.selector);
        book.fill(q, sig, "BTC", _call(100e18), three, 1e18);
    }

    /// Band over the whole order: every leg's side and strike, every Movement part's tempo; edges inclusive; another
    /// market refused; a both-sides quote covers a Swing.
    function test_quoteBandCoversTheWholeOrder() public {
        VolQuoteBook book = _book();
        VolQuote.Quote memory q = _q(1, uint64(block.timestamp + 1 hours));
        bytes memory sig = _sign(book, q, MAKER_PK);
        TempoBlend.Part[] memory three = TempoBlend.single(3 days);

        // edges, a spread inside, a Movement inside
        book.check(q, sig, "BTC", _call(95e18), TempoBlend.single(1 days), 1e18);
        book.check(q, sig, "BTC", _call(115e18), TempoBlend.single(7 days), 1e18);
        book.check(q, sig, "BTC", _spread(100e18, 110e18), three, 1e18);
        book.check(q, sig, "BTC", _call(100e18), _mv(1 days, 7 days), 1e18);

        // a leg outside the strike band
        vm.expectRevert(VolQuote.OutOfBand.selector);
        book.check(q, sig, "BTC", _spread(100e18, 120e18), three, 1e18);
        vm.expectRevert(VolQuote.OutOfBand.selector);
        book.check(q, sig, "BTC", _call(95e18 - 1), three, 1e18);
        // a put against a calls-only quote (a Swing's put leg)
        vm.expectRevert(VolQuote.OutOfBand.selector);
        book.check(q, sig, "BTC", _swing(100e18), three, 1e18);
        // a Movement with one part outside the tempo band
        vm.expectRevert(VolQuote.OutOfBand.selector);
        book.check(q, sig, "BTC", _call(100e18), _mv(1 days, 30 days), 1e18);
        vm.expectRevert(VolQuote.OutOfBand.selector);
        book.check(q, sig, "BTC", _call(100e18), TempoBlend.single(1 days - 1), 1e18);
        // another market; an empty order
        vm.expectRevert(VolQuote.OutOfBand.selector);
        book.check(q, sig, "ETH", _call(100e18), three, 1e18);
        vm.expectRevert(VolQuote.OutOfBand.selector);
        book.check(q, sig, "BTC", new StrategyMath.Leg[](0), three, 1e18);

        // a both-sides quote fills the Swing; a puts-only quote refuses the call leg
        VolQuote.Quote memory both = _q(2, uint64(block.timestamp + 1 hours));
        both.sides = VolQuote.SIDE_BOTH;
        book.check(both, _sign(book, both, MAKER_PK), "BTC", _swing(100e18), three, 1e18);
        VolQuote.Quote memory puts = _q(3, uint64(block.timestamp + 1 hours));
        puts.sides = VolQuote.SIDE_PUTS;
        bytes memory putsSig = _sign(book, puts, MAKER_PK);
        vm.expectRevert(VolQuote.OutOfBand.selector);
        book.check(puts, putsSig, "BTC", _swing(100e18), three, 1e18);
    }

    /// The quote's own terms: sides must be 1, 2 or 3; σ must sit inside the maths bounds (5%–500%).
    function test_quoteSidesAndSigmaBounds() public {
        VolQuoteBook book = _book();
        TempoBlend.Part[] memory three = TempoBlend.single(3 days);
        uint8[2] memory badSides = [uint8(0), 4];
        for (uint256 i; i < 2; i++) {
            VolQuote.Quote memory q = _q(1, uint64(block.timestamp + 1 hours));
            q.sides = badSides[i];
            bytes memory sig = _sign(book, q, MAKER_PK);
            vm.expectRevert(abi.encodeWithSelector(VolQuote.BadSides.selector, badSides[i]));
            book.check(q, sig, "BTC", _call(100e18), three, 1e18);
        }
        uint64[2] memory badSigma = [uint64(499), 50_001];
        for (uint256 i; i < 2; i++) {
            VolQuote.Quote memory q = _q(1, uint64(block.timestamp + 1 hours));
            q.sigmaBps = badSigma[i];
            bytes memory sig = _sign(book, q, MAKER_PK);
            vm.expectRevert(abi.encodeWithSelector(VolQuote.SigmaOutOfRange.selector, badSigma[i]));
            book.check(q, sig, "BTC", _call(100e18), three, 1e18);
        }
        // the bounds themselves are fine
        uint64[2] memory edge = [uint64(500), 50_000];
        for (uint256 i; i < 2; i++) {
            VolQuote.Quote memory q = _q(1, uint64(block.timestamp + 1 hours));
            q.sigmaBps = edge[i];
            book.check(q, _sign(book, q, MAKER_PK), "BTC", _call(100e18), three, 1e18);
        }
    }

    /// Size in order units: fills add up per (maker, nonce) and stop at maxUnits; zero units refused; another nonce has
    /// its own size.
    function test_quoteCumulativeSize() public {
        VolQuoteBook book = _book();
        VolQuote.Quote memory q = _q(1, uint64(block.timestamp + 1 hours));
        bytes memory sig = _sign(book, q, MAKER_PK);
        TempoBlend.Part[] memory three = TempoBlend.single(3 days);
        vm.expectRevert(VolQuoteBook.ZeroUnits.selector);
        book.check(q, sig, "BTC", _call(100e18), three, 0);
        book.fill(q, sig, "BTC", _spread(100e18, 110e18), three, 20e18);
        book.fill(q, sig, "BTC", _call(110e18), TempoBlend.single(5 days), 30e18);
        assertEq(book.filled(q.maker, 1), 50e18);
        vm.expectRevert(VolQuote.TooLarge.selector);
        book.fill(q, sig, "BTC", _call(100e18), three, 1);
        VolQuote.Quote memory q2 = _q(2, uint64(block.timestamp + 1 hours));
        book.fill(q2, _sign(book, q2, MAKER_PK), "BTC", _call(100e18), three, 50e18);
        assertEq(book.filled(q.maker, 2), 50e18);
        // gas of a fill (warm book, a 2-leg order)
        VolQuote.Quote memory q3 = _q(3, uint64(block.timestamp + 1 hours));
        bytes memory sig3 = _sign(book, q3, MAKER_PK);
        StrategyMath.Leg[] memory sp = _spread(100e18, 110e18);
        uint256 g = gasleft();
        book.fill(q3, sig3, "BTC", sp, three, 1e18);
        emit log_named_uint("fill gas, 2-leg order", g - gasleft());
    }

    /// Expiry and cancellation: a quote is good up to and including validUntil; a maker cancels its own nonces only,
    /// and a cancelled nonce never fills again.
    function test_quoteExpiryAndCancelledNonce() public {
        VolQuoteBook book = _book();
        uint256 t0 = block.timestamp;
        VolQuote.Quote memory q = _q(1, uint64(t0 + 60));
        bytes memory sig = _sign(book, q, MAKER_PK);
        TempoBlend.Part[] memory three = TempoBlend.single(3 days);

        vm.warp(t0 + 60);
        book.fill(q, sig, "BTC", _call(100e18), three, 1e18); // at the deadline: fine
        vm.warp(t0 + 61);
        vm.expectRevert(VolQuote.Expired.selector);
        book.fill(q, sig, "BTC", _call(100e18), three, 1e18);
        vm.warp(t0);

        // Someone else cancelling "nonce 2" touches only their own namespace
        VolQuote.Quote memory q2 = _q(2, uint64(t0 + 1 hours));
        bytes memory sig2 = _sign(book, q2, MAKER_PK);
        vm.prank(address(0xBAD));
        book.cancel(2);
        book.fill(q2, sig2, "BTC", _call(100e18), three, 1e18);

        // The maker cancels nonce 2: no further fills
        vm.expectEmit(true, true, false, false, address(book));
        emit VolQuoteBook.Cancelled(q2.maker, 2);
        vm.prank(q2.maker);
        book.cancel(2);
        assertTrue(book.cancelled(q2.maker, 2));
        vm.expectRevert(abi.encodeWithSelector(VolQuoteBook.NonceCancelled.selector, q2.maker, uint64(2)));
        book.fill(q2, sig2, "BTC", _call(100e18), three, 1e18);
    }
}
