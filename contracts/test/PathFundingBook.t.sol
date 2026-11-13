// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {PathFundingBook, IMarkRouter, IVolSource} from "../src/PathFundingBook.sol";
import {PathFunding} from "../src/PathFunding.sol";
import {TempoBlend} from "../src/TempoBlend.sol";

contract PathFundingBookTest is Test {
    uint256 constant T0 = 1_794_182_400; // a day boundary
    uint256 constant BLOCK_GAS = 32_000_000; // Arbitrum Orbit default block gas limit; Elysium's own is (U)
    bytes32 constant BTC = "BTC";
    bytes32 constant OLD = "OLD";
    address constant HOLDER = address(0xA11CE);

    PathFundingBook book;
    uint256 nowT;

    /// Tracked clock: with via-IR, block.timestamp can be cached inside one test function.
    function _set(uint256 t) internal {
        nowT = t;
        vm.warp(t);
    }

    function _adv(uint256 dt) internal {
        _set(nowT + dt);
    }

    function setUp() public {
        _set(T0);
        book = new PathFundingBook(address(this), address(this), IMarkRouter(address(0)), IVolSource(address(0)));
    }

    function _rec(bytes32 m, uint256 i) internal {
        book.record(m, 100e18 + (i % 17) * 1e17, 5000 + (i % 7) * 100);
    }

    /// Steps reported by the last Accrued event in the recorded logs.
    function _stepsFromLogs() internal returns (uint256 steps) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == PathFundingBook.Accrued.selector) {
                (,, steps) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            }
        }
    }

    /// The accrual walker visits every open series at least every 7 days, far inside the 64-day daily
    /// ring, so every series stays walkable. A series nobody walks for more than 64 days loses its
    /// history and accrue reverts with HistoryGone (the reason the cadence exists).
    function test_walkerCadenceKeepsEveryPositionWalkable() public {
        // Market BTC: a sample every hour for 30 days; series opened on days 0, 2 and 9
        uint256[] memory ids = new uint256[](3);
        uint256 opened;
        for (uint256 hr; hr <= 30 * 24; hr++) {
            _rec(BTC, hr);
            if (hr == 0 || hr == 2 * 24 || hr == 9 * 24) {
                ids[opened++] = book.open(BTC, opened % 2 == 0, 100e18, TempoBlend.single(1 days * (opened + 1)));
            }
            if (hr > 0 && hr % (7 * 24) == 0) {
                // the walker's weekly pass: every open series catches up fully
                for (uint256 j; j < opened; j++) {
                    (, bool done) = book.accrue(ids[j], type(uint256).max);
                    assertTrue(done, "walker catches every series up");
                }
            }
            _adv(1 hours);
        }

        // Market OLD: one sample a day for 66 days. Series A is walked weekly; B is left alone for 63 days,
        // C for 65 days.
        book.record(OLD, 100e18, 5000);
        uint256 a = book.open(OLD, true, 100e18, TempoBlend.single(7 days));
        uint256 b = book.open(OLD, true, 110e18, TempoBlend.single(7 days));
        uint256 c = book.open(OLD, true, 120e18, TempoBlend.single(7 days));
        for (uint256 d = 1; d <= 66; d++) {
            _adv(1 days);
            book.record(OLD, 100e18 + (d % 5) * 1e18, 5000);
            if (d % 7 == 0) {
                (, bool done) = book.accrue(a, type(uint256).max);
                assertTrue(done);
            }
            if (d == 63) {
                (, bool done) = book.accrue(b, type(uint256).max); // 63 days: still inside the daily ring
                assertTrue(done, "63 days untouched is still walkable");
            }
        }
        (, bool aDone) = book.accrue(a, type(uint256).max);
        assertTrue(aDone, "the weekly-walked series is always fine");
        vm.expectRevert(abi.encodeWithSelector(PathFunding.HistoryGone.selector, T0 + 30 * 24 hours + 1 hours));
        book.accrue(c, type(uint256).max); // 65 days untouched: its first sample is gone
    }

    /// A sell on a series nobody has touched for 60 days walks the whole history itself (no keeper),
    /// and the walk fits in a block. A buy on the same series stops at 16 intervals and reverts.
    function test_sellAfter60DaysUntouchedNeedsNoKeeper() public {
        book.record(BTC, 100e18, 5000);
        uint256 id = book.open(BTC, false, 95e18, TempoBlend.single(7 days));
        book.mint(id, HOLDER, 10e18);

        // The rings as a 5-minute poker leaves them after 60 days: one sample per day, then the last
        // 4 days hourly, then the last 5 h 20 min every 5 minutes.
        uint256 tEnd = T0 + 60 days;
        uint256 hourlyFrom = tEnd - 96 hours;
        uint256 fiveFrom = tEnd - 64 * 5 minutes;
        uint256 i;
        for (uint256 t = T0 + 1 days; t < hourlyFrom; t += 1 days) {
            _set(t);
            _rec(BTC, ++i);
        }
        for (uint256 t = hourlyFrom; t < fiveFrom; t += 1 hours) {
            _set(t);
            _rec(BTC, ++i);
        }
        for (uint256 t = fiveFrom; t < tEnd; t += 5 minutes) {
            _set(t);
            _rec(BTC, ++i);
        }
        _set(tEnd);

        // A buy may walk only 16 intervals: refused while the series is this far behind
        vm.expectRevert(abi.encodeWithSelector(PathFundingBook.NotCaughtUp.selector, id));
        book.mint(id, address(0xB0B), 1e18);

        // The sell walks everything itself
        vm.recordLogs();
        uint256 g = gasleft();
        book.burn(id, HOLDER, 10e18);
        uint256 used = g - gasleft();
        uint256 steps = _stepsFromLogs();
        emit log_named_uint("sell after 60 days: intervals walked", steps);
        emit log_named_uint("sell after 60 days: gas", used);
        assertEq(book.balanceOf(id, HOLDER), 0);
        assertGt(steps, 200, "the full ring history was walked");
        assertLe(steps, 224);
        assertLt(used, BLOCK_GAS, "fits in a block");

        // Now caught up, a buy goes through
        book.mint(id, address(0xB0B), 1e18);
    }

    /// Law 3 never depends on the walker: a sell on a series untouched for 70 days (its start is gone from
    /// the daily ring) still succeeds. The lost stretch is charged at the maximum rate, 1/(shortest tempo),
    /// which is at least what the real path charged; the rest is walked as usual. accrue and mint still
    /// revert with HistoryGone. (Fallback not in the spec; to confirm.)
    function test_sellAfter70DaysChargesLostHistoryAtMaxRate() public {
        // Twin book with the identical path; its copy of the series is walked every week.
        PathFundingBook twin =
            new PathFundingBook(address(this), address(this), IMarkRouter(address(0)), IVolSource(address(0)));
        TempoBlend.Part[] memory mv = new TempoBlend.Part[](2);
        mv[0] = TempoBlend.Part(1 days, 0.5e18); // shortest tempo: 1 day
        mv[1] = TempoBlend.Part(7 days, 0.5e18);
        uint128 k = 60e18; // deep in the money, so the real rate is far below the maximum

        uint256 t0 = nowT;
        book.record(BTC, 100e18, 5000);
        twin.record(BTC, 100e18, 5000);
        uint256 id = book.open(BTC, true, k, mv);
        assertEq(twin.open(BTC, true, k, mv), id);
        book.mint(id, HOLDER, 10e18);

        uint256 twinXAtHorizon;
        for (uint256 d = 1; d <= 70; d++) {
            _adv(1 days);
            uint256 s = 100e18 + (d % 9) * 1e18;
            book.record(BTC, s, 5000);
            twin.record(BTC, s, 5000);
            twin.accrue(id, type(uint256).max);
            if (d == 7) twinXAtHorizon = twin.cursor(id).x; // what the real path charged up to day 7
        }
        uint256 horizon = book.horizon(BTC);
        assertEq(horizon, t0 + 7 days, "the daily ring holds days 7..70");

        // accrue and mint still refuse
        vm.expectRevert(abi.encodeWithSelector(PathFunding.HistoryGone.selector, t0));
        book.accrue(id, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(PathFunding.HistoryGone.selector, t0));
        book.mint(id, HOLDER, 1e18);

        // The sell goes through, charging the 7 lost days at 1/(1 day)
        uint256 charged = (horizon - t0) * 1e18 / 1 days;
        vm.expectEmit(true, false, false, true, address(book));
        emit PathFundingBook.HistoryFallback(id, t0, horizon, charged);
        book.burn(id, HOLDER, 10e18);
        assertEq(book.balanceOf(id, HOLDER), 0);

        // At least as much as any real path: more than the real path over the lost stretch, and the
        // resulting norm is no higher than the twin's, which saw the real history all along
        assertGe(charged, twinXAtHorizon);
        assertGt(charged, twinXAtHorizon * 100, "deep ITM: the real charge was far smaller");
        assertLe(book.normNow(id), twin.normNow(id));
        assertGe(book.normNow(id), book.MIN_NORM());
        assertTrue(PathFunding.factor(book.cursor(id).x) < twin.normNow(id));
    }

    /// latestSample follows each new level-0 sample; a second sample in the same 5-minute bucket is ignored.
    function test_latestSampleFollowsLevelZero() public {
        vm.expectRevert(PathFunding.NoHistory.selector);
        book.latestSample(BTC);

        book.record(BTC, 100e18, 5000);
        (uint256 t, uint256 s, uint256 sig) = book.latestSample(BTC);
        assertEq(t, T0);
        assertEq(s, 100e18);
        assertEq(sig, 5000);

        _adv(1 minutes);
        book.record(BTC, 101e18, 5100); // same bucket: ignored
        (t, s, sig) = book.latestSample(BTC);
        assertEq(t, T0);
        assertEq(s, 100e18);
        assertEq(sig, 5000);

        _adv(5 minutes);
        book.record(BTC, 102e18, 5200);
        (t, s, sig) = book.latestSample(BTC);
        assertEq(t, T0 + 6 minutes);
        assertEq(s, 102e18);
        assertEq(sig, 5200);

        vm.expectRevert(PathFunding.NoHistory.selector);
        book.latestSample(OLD); // other markets are separate
    }

    /// seriesOf returns exactly the terms given to open; exists tracks whether a series was opened.
    function test_seriesOfAndExists() public {
        book.record(BTC, 100e18, 5000);
        TempoBlend.Part[] memory mv = new TempoBlend.Part[](3);
        mv[0] = TempoBlend.Part(1 hours, 0.2e18);
        mv[1] = TempoBlend.Part(1 days, 0.5e18);
        mv[2] = TempoBlend.Part(30 days, 0.3e18);

        uint256 idM = book.idOf(BTC, true, 105e18, mv);
        uint256 idS = book.idOf(BTC, false, 95e18, TempoBlend.single(7 days));
        assertFalse(book.exists(idM));
        assertFalse(book.exists(idS));
        vm.expectRevert(abi.encodeWithSelector(PathFundingBook.Unknown.selector, idM));
        book.seriesOf(idM);

        assertEq(book.open(BTC, true, 105e18, mv), idM);
        assertEq(book.open(BTC, false, 95e18, TempoBlend.single(7 days)), idS);
        assertTrue(book.exists(idM));
        assertTrue(book.exists(idS));

        (bytes32 name, bool isCall, uint128 k, TempoBlend.Part[] memory got) = book.seriesOf(idM);
        assertEq(name, BTC);
        assertTrue(isCall);
        assertEq(k, 105e18);
        assertEq(got.length, 3);
        for (uint256 i; i < 3; ++i) {
            assertEq(got[i].tempo, mv[i].tempo);
            assertEq(got[i].weight, mv[i].weight);
        }

        (name, isCall, k, got) = book.seriesOf(idS);
        assertEq(name, BTC);
        assertFalse(isCall);
        assertEq(k, 95e18);
        assertEq(got.length, 1);
        assertEq(got[0].tempo, 7 days);
        assertEq(got[0].weight, 1e18);
    }

    /// At most 30k gas per interval for a single-tempo series (decision Q11); Movements are reported.
    function test_gasPerIntervalAtMost30k() public {
        book.record(BTC, 100e18, 5000);
        uint256 single = book.open(BTC, true, 100e18, TempoBlend.single(1 days));
        TempoBlend.Part[] memory mv = new TempoBlend.Part[](3);
        mv[0] = TempoBlend.Part(1 hours, 0.2e18);
        mv[1] = TempoBlend.Part(1 days, 0.5e18);
        mv[2] = TempoBlend.Part(30 days, 0.3e18);
        uint256 movement = book.open(BTC, true, 100e18, mv);
        for (uint256 i = 1; i < 64; i++) {
            _adv(5 minutes);
            _rec(BTC, i);
        }

        vm.recordLogs();
        uint256 g = gasleft();
        book.accrue(single, 64);
        uint256 used = g - gasleft();
        uint256 steps = _stepsFromLogs();
        assertEq(steps, 63);
        emit log_named_uint("single tempo: gas per interval", used / steps);
        assertLe(used / steps, 30_000, "<= 30k gas per interval");

        vm.recordLogs();
        g = gasleft();
        book.accrue(movement, 64);
        used = g - gasleft();
        steps = _stepsFromLogs();
        emit log_named_uint("3-tempo Movement: gas per interval (reported, not capped)", used / steps);
    }
}
