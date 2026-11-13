// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Kit suite: PathFunding (8 tests), run against our PathFundingBook (the kit's structure with our walk).
///
/// Changes from the kit file, and why:
///   1. Contract renamed KitPathFundingTest so names do not clash with our suite.
///   2. Book constructor takes our IMarkRouter / IVolSource types.
///   3. open(name, isCall, k, movement): series carry a Movement (a single tempo is TempoBlend.single(tau));
///      the per-position skew argument is gone (decision: skew dropped).
///   4. A series opens only once a sample exists (law 2: no price, no open), so tests that opened before the
///      first record now record the first sample, then open, at the same timestamp.
///   5. The reference maths uses our rate: TempoBlend.rateE36 (TV/V per second at 36 decimals, rounded up),
///      X += ceil(rate·Δt/1e18) per interval, norm = PathFunding.factor(X). The kit used TempoMath.rate /
///      decay with WAD rates; our TempoMath has no such helpers. σ is passed in bps (our unit).
///   6. A second sample inside the same 5-minute bucket is ignored quietly in both, so
///      test_history_cannot_be_rewritten_or_skipped is unchanged in substance.
///   7. In test_gas_of_a_64_step_walk the first of the 64 samples is recorded before the open (change 4).
///   Scenarios, tolerances and assertions are otherwise unchanged.

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PathFundingBook, IMarkRouter, IVolSource} from "../../src/PathFundingBook.sol";
import {PathFunding} from "../../src/PathFunding.sol";
import {TempoMath} from "../../src/TempoMath.sol";
import {TempoBlend} from "../../src/TempoBlend.sol";

contract KitPathFundingTest is Test {
    PathFundingBook book;
    bytes32 constant NVDA = "NVDA";
    uint32 constant DAY = 1 days;
    uint32 constant WEEK = 7 days;
    uint256 constant T0 = 1_794_236_400;

    struct Pt {
        uint64 t;
        uint128 s;
        uint64 sig;
    }

    uint256 nowT = T0;
    /// vm.warp + a tracked clock: with via_ir, block.timestamp can be cached inside one test function.

    function _adv(uint256 dt) internal {
        nowT += dt;
        vm.warp(nowT);
    }

    function _set(uint256 t) internal {
        nowT = t;
        vm.warp(t);
    }

    Pt[] path;

    function _newBook() internal returns (PathFundingBook) {
        return new PathFundingBook(address(this), address(this), IMarkRouter(address(0)), IVolSource(address(0)));
    }

    function _rate(bool isCall, uint256 s, uint256 k, uint256 sigBps, uint32 tau) internal pure returns (uint256) {
        return TempoBlend.rateE36(isCall, s, k, sigBps, TempoBlend.single(tau), TempoMath.defaultBounds());
    }

    /// one constant-price interval, exactly as the library computes it
    function _step(bool isCall, uint256 s, uint256 k, uint256 sigBps, uint32 tau, uint256 dt)
        internal
        pure
        returns (uint256)
    {
        return PathFunding.factor(Math.ceilDiv(_rate(isCall, s, k, sigBps, tau) * dt, 1e18));
    }

    function setUp() public {
        vm.warp(T0);
        book = _newBook();
    }

    function _rec(uint128 s, uint64 sig) internal {
        book.record(NVDA, s, sig);
        path.push(Pt(uint64(nowT), s, sig));
    }

    /// brute-force reference: exp(-sum r_i dt_i) using every recorded sample (valid while level 0 covers all)
    function _expected(bool isCall, uint128 k, uint32 tau, uint64 from, uint64 to) internal view returns (uint256) {
        uint256 ex;
        for (uint256 i; i < path.length; i++) {
            uint64 a = path[i].t < from ? from : path[i].t;
            uint64 b = i + 1 < path.length ? path[i + 1].t : to;
            if (b > to) b = to;
            if (b <= a) continue;
            ex += Math.ceilDiv(_rate(isCall, path[i].s, k, path[i].sig, tau) * (b - a), 1e18);
        }
        return PathFunding.factor(ex);
    }

    function test_constant_path_is_one_closed_form_step() public {
        _rec(100e18, 5000);
        uint256 id = book.open(NVDA, true, 100e18, TempoBlend.single(WEEK));
        _set(T0 + 4 hours);
        (uint256 n,) = book.accrue(id, 0);
        assertEq(n, _step(true, 100e18, 100e18, 5000, WEEK, 4 hours), "a constant price is a single exponential step");
    }

    function test_varying_path_is_exact() public {
        uint128[8] memory px = [uint128(100e18), 104e18, 97e18, 110e18, 91e18, 100e18, 120e18, 99e18];
        for (uint256 i; i < px.length; i++) {
            _rec(px[i], uint64(4000 + i * 300));
            _adv(17 minutes);
        }
        uint256 call = book.open(NVDA, true, 105e18, TempoBlend.single(DAY));
        uint256 put = book.open(NVDA, false, 95e18, TempoBlend.single(WEEK));
        // positions opened at the end; rewind their start by opening earlier instead:
        _set(T0); // fresh book to open at T0
        PathFundingBook b2 = _newBook();
        delete path;
        b2.record(NVDA, px[0], 4000);
        path.push(Pt(uint64(nowT), px[0], 4000));
        uint256 c2 = b2.open(NVDA, true, 105e18, TempoBlend.single(DAY));
        uint256 p2 = b2.open(NVDA, false, 95e18, TempoBlend.single(WEEK));
        _adv(17 minutes);
        for (uint256 i = 1; i < px.length; i++) {
            b2.record(NVDA, px[i], uint64(4000 + i * 300));
            path.push(Pt(uint64(nowT), px[i], uint64(4000 + i * 300)));
            _adv(17 minutes);
        }
        (uint256 nc,) = b2.accrue(c2, 0);
        (uint256 np,) = b2.accrue(p2, 0);
        assertApproxEqRel(nc, _expected(true, 105e18, DAY, uint64(T0), uint64(nowT)), 1e6, "call");
        assertApproxEqRel(np, _expected(false, 95e18, WEEK, uint64(T0), uint64(nowT)), 1e6, "put");
        assertTrue(call != put);
    }

    function test_resumable_and_toucher_independent() public {
        PathFundingBook a = _newBook();
        PathFundingBook b = _newBook();
        uint256 ia;
        uint256 ib;
        for (uint256 i; i < 40; i++) {
            uint128 s = uint128(95e18 + (i * 7919 % 11) * 1e18);
            a.record(NVDA, s, 5000);
            b.record(NVDA, s, 5000);
            if (i == 0) {
                ia = a.open(NVDA, true, 100e18, TempoBlend.single(DAY));
                ib = b.open(NVDA, true, 100e18, TempoBlend.single(DAY));
            }
            _adv(6 minutes);
            if (i % 9 == 0) a.accrue(ia, 0); // someone touches `a` along the way
        }
        (uint256 na,) = a.accrue(ia, 0);
        // `b` accrues in small resumable chunks
        bool done;
        uint256 nb;
        for (uint256 j; j < 50 && !done; j++) {
            (nb, done) = b.accrue(ib, 3);
        }
        assertTrue(done, "finished in chunks");
        assertApproxEqRel(na, nb, 1e3, "same result however and whenever it is touched");
    }

    function test_coarse_levels_cover_long_dormancy() public {
        uint256 id;
        // 3 days of samples every 5 minutes; level 0 keeps only the last ~5h, level 1 the hours before
        for (uint256 i; i < 3 * 288; i++) {
            book.record(NVDA, uint128(100e18 + (i % 13) * 1e17), 4500);
            if (i == 0) id = book.open(NVDA, false, 90e18, TempoBlend.single(WEEK));
            _adv(5 minutes);
        }
        assertLe(book.horizon(NVDA), T0, "still covered back to open");
        bool done;
        uint256 n;
        uint256 calls;
        while (!done) {
            (n, done) = book.accrue(id, 64);
            calls++;
        }
        assertLt(n, 1e18, "funding charged");
        assertGt(n, 0.3e18, "OTM weekly put over 3 days loses less than 3/7 of units");
        assertLe(calls, 4, "bounded walks");
    }

    function test_deep_itm_pays_little_far_otm_pays_full_rate() public {
        _rec(100e18, 5000);
        uint256 itm = book.open(NVDA, true, 50e18, TempoBlend.single(WEEK));
        uint256 otm = book.open(NVDA, true, 200e18, TempoBlend.single(WEEK));
        _set(T0 + 1 days);
        (uint256 ni,) = book.accrue(itm, 0);
        (uint256 no,) = book.accrue(otm, 0);
        assertGt(ni, 0.999e18, "deep ITM: almost no funding");
        assertApproxEqRel(
            no, PathFunding.factor(uint256(1e18) / 7), 1e12, "far OTM: rate 1, units shrink by e^(-1/7) a day"
        );
    }

    function test_history_cannot_be_rewritten_or_skipped() public {
        _rec(100e18, 5000);
        uint256 id = book.open(NVDA, true, 100e18, TempoBlend.single(DAY));
        _set(T0 + 1 minutes);
        _rec(150e18, 5000); // too soon for level 0 (5-minute gap): ignored there
        _set(T0 + 1 hours);
        (uint256 n,) = book.accrue(id, 0);
        assertEq(n, _step(true, 100e18, 100e18, 5000, DAY, 1 hours), "the early print did not change the gap's price");
        vm.prank(address(0xBAD));
        vm.expectRevert(PathFundingBook.NotRecorder.selector);
        book.record(NVDA, 1e18, 5000);
    }

    function test_mint_requires_caught_up() public {
        _rec(100e18, 5000);
        uint256 id = book.open(NVDA, true, 100e18, TempoBlend.single(DAY));
        book.mint(id, address(1), 10e18);
        assertEq(book.units(id, address(1)), 10e18);
        _set(T0 + 12 hours);
        book.mint(id, address(1), 1e18); // accrues first
        assertLt(book.units(id, address(1)), 11e18, "units shrank before the new mint");
    }

    function test_gas_of_a_64_step_walk() public {
        uint256 id;
        for (uint256 i; i < 64; i++) {
            book.record(NVDA, uint128(100e18 + i * 1e17), 5000);
            if (i == 0) id = book.open(NVDA, true, 100e18, TempoBlend.single(DAY));
            _adv(5 minutes);
        }
        uint256 g = gasleft();
        (uint256 n,) = book.accrue(id, 64);
        emit log_named_uint("gas, 64 steps", g - gasleft());
        emit log_named_uint("norm", n);
        assertLt(n, 1e18);
        assertLt(g - gasleft(), 3_500_000);
    }
}
