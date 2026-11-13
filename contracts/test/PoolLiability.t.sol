// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PoolLiability} from "../src/PoolLiability.sol";
import {PathFundingBook, IMarkRouter, IVolSource} from "../src/PathFundingBook.sol";
import {TempoBlend} from "../src/TempoBlend.sol";
import {EnginePricing} from "../src/EnginePricing.sol";
import {MockMarks, MockVols} from "./Engine.t.sol";

/// Holds a PoolLiability state and acts as the book's engine, so it can open real series.
contract LiabilityHarness {
    using PoolLiability for PoolLiability.State;

    PoolLiability.State internal st;
    PathFundingBook public immutable book;

    constructor(PathFundingBook book_, IMarkRouter marks, IVolSource vols) {
        book = book_;
        st.init(book_, marks, vols, 15_000);
    }

    function list(bytes32 m, uint16 shock) external {
        st.listMarket(m, shock);
    }

    function open(bytes32 m, bool isCall, uint128 k, TempoBlend.Part[] calldata mv) external returns (uint256) {
        return book.open(m, isCall, k, mv);
    }

    function buy(bytes32 m, uint256 id, uint256 units, uint256 raw, uint256 s, uint256 sigma) external {
        st.onBuy(m, id, units, raw, s, sigma);
    }

    function sell(uint256 id, uint256 raw) external {
        st.onSell(id, raw, 0);
    }

    function sellValued(uint256 id, uint256 raw, uint256 baseValue) external {
        st.onSell(id, raw, baseValue);
    }

    function navBase(bytes32 m) external view returns (uint256) {
        return st.navBase(m);
    }

    function start() external {
        st.startEpoch();
    }

    function mark(uint256 n) external returns (bool) {
        return st.markChunk(n);
    }

    function liveBase(bytes32 m) external view returns (uint256) {
        return st.liveBase(m);
    }

    function liveStressed(bytes32 m) external view returns (uint256) {
        return st.liveStressed(m);
    }

    function finals(bytes32 m) external view returns (uint256 base, uint256 stressed) {
        return (st.m[m].finalBase, st.m[m].finalStressed);
    }

    function runs(bytes32 m) external view returns (uint256 base, uint256 up, uint256 down) {
        return (st.m[m].runBase, st.m[m].runUp, st.m[m].runDown);
    }

    function seriesOf(bytes32 m) external view returns (uint256[] memory) {
        return st.m[m].series;
    }

    function raw(uint256 id) external view returns (uint256) {
        return st.raw[id];
    }

    function epoch() external view returns (uint256) {
        return st.epoch;
    }

    function marking() external view returns (bool) {
        return st.marking;
    }
}

contract PoolLiabilityTest is Test {
    uint256 constant T0 = 1_794_182_400;
    bytes32 constant BTC = "BTC";
    bytes32 constant ETH = "ETH";
    bytes32 constant HYPE = "HYPE";
    uint256 constant WAD = 1e18;

    MockMarks marks;
    MockVols vols;
    PathFundingBook book;
    LiabilityHarness h;
    uint256 nowT;
    mapping(bytes32 => uint16) shock;
    mapping(bytes32 => uint256) step;

    function _set(uint256 t) internal {
        nowT = t;
        vm.warp(t);
    }

    function setUp() public {
        _set(T0);
        marks = new MockMarks();
        vols = new MockVols();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        book = new PathFundingBook(predicted, address(this), marks, vols);
        h = new LiabilityHarness(book, marks, vols);
        require(address(h) == predicted, "prediction");
        (shock[BTC], shock[ETH], shock[HYPE]) = (2000, 2500, 3500);
        (step[BTC], step[ETH], step[HYPE]) = (100e18, 5e18, 0.1e18);
        _market(BTC, 70_000e18, 4500);
        _market(ETH, 2_000e18, 6000);
        _market(HYPE, 70e18, 8000);
    }

    function _market(bytes32 m, uint256 s, uint256 sigma) internal {
        h.list(m, shock[m]);
        marks.set(m, s);
        vols.set(m, sigma);
        book.record(m, s, sigma);
    }

    function _mv(uint256 kind) internal pure returns (TempoBlend.Part[] memory m) {
        if (kind % 4 == 0) return TempoBlend.single(1 hours);
        if (kind % 4 == 1) return TempoBlend.single(1 days);
        if (kind % 4 == 2) return TempoBlend.single(7 days);
        m = new TempoBlend.Part[](3);
        m[0] = TempoBlend.Part(1 hours, 0.2e18);
        m[1] = TempoBlend.Part(1 days, 0.5e18);
        m[2] = TempoBlend.Part(7 days, 0.3e18);
    }

    /// Opens a series and buys `raw` (fresh series: norm 1, so units = raw) at the market's current mark and vol.
    function _openBuy(bytes32 m, bool isCall, int256 stepsFromMark, uint256 kind, uint256 raw)
        internal
        returns (uint256 id)
    {
        uint256 s = marks.px(m);
        uint128 k = uint128(uint256(int256((s / step[m])) + stepsFromMark) * step[m]);
        id = h.open(m, isCall, k, _mv(kind));
        h.buy(m, id, raw, raw, s, vols.bps(m));
    }

    // ---------------------------------------------------------------- independent expected values

    struct Expect {
        uint256 base;
        uint256 up;
        uint256 down;
        uint256 perSeriesWorst;
    }

    function _seriesValue(uint256 id, uint256 s, uint256 sigma) internal view returns (uint256) {
        (, bool isCall, uint128 k, TempoBlend.Part[] memory mv) = book.seriesOf(id);
        uint256 units = Math.mulDiv(h.raw(id), book.normNow(id), WAD, Math.Rounding.Ceil);
        if (units == 0) return 0;
        return Math.mulDiv(units, EnginePricing.unitValue(isCall, s, k, sigma, mv), WAD, Math.Rounding.Ceil);
    }

    function _expect(bytes32 m) internal view returns (Expect memory e) {
        uint256 s = marks.px(m);
        uint256 sigma = vols.bps(m);
        uint256 sigS = Math.mulDiv(sigma, 15_000, 10_000, Math.Rounding.Ceil);
        if (sigS > 50_000) sigS = 50_000;
        uint256 sUp = s * (10_000 + shock[m]) / 10_000;
        uint256 sDown = s * (10_000 - shock[m]) / 10_000;
        uint256[] memory ids = h.seriesOf(m);
        for (uint256 i; i < ids.length; ++i) {
            e.base += _seriesValue(ids[i], s, sigma);
            uint256 u = _seriesValue(ids[i], sUp, sigS);
            uint256 d = _seriesValue(ids[i], sDown, sigS);
            e.up += u;
            e.down += d;
            e.perSeriesWorst += u > d ? u : d;
        }
    }

    function _markAll(uint256 chunk) internal {
        h.start();
        while (!h.mark(chunk)) {}
    }

    // ---------------------------------------------------------------- exactness and chunking

    /// A random portfolio on three markets, aged so norms are below 1: the epoch equals the independent sum at the
    /// mark and under the whole-market stress, whatever the chunk size.
    /// forge-config: default.fuzz.runs = 48
    function testFuzz_exactAndChunkIndependent(uint256 seed) public {
        bytes32[3] memory ms = [BTC, ETH, HYPE];
        for (uint256 i; i < 24; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            bytes32 m = ms[r % 3];
            int256 off = int256((r >> 8) % 9) - 4;
            uint256 raw = bound(r >> 32, 1e15, 50e18);
            uint256 id = h.open(
                m, (r >> 16) % 2 == 0, uint128(uint256(int256(marks.px(m) / step[m]) + off) * step[m]), _mv(r >> 24)
            );
            h.buy(m, id, raw, raw, marks.px(m), vols.bps(m));
        }
        // age the book: samples move, norms shrink, and the live mark moves away from the buy prices
        for (uint256 j = 1; j <= 6; ++j) {
            _set(nowT + 10 minutes);
            for (uint256 i; i < 3; ++i) {
                book.record(ms[i], marks.px(ms[i]) * (1000 + j) / 1000, vols.bps(ms[i]));
            }
        }
        for (uint256 i; i < 3; ++i) {
            marks.set(ms[i], marks.px(ms[i]) * 103 / 100);
        }

        uint256 snap = vm.snapshotState();
        _markAll(1);
        uint256[3] memory base1;
        uint256[3] memory str1;
        for (uint256 i; i < 3; ++i) {
            (base1[i], str1[i]) = h.finals(ms[i]);
            Expect memory e = _expect(ms[i]);
            assertEq(base1[i], e.base, "base equals the independent sum");
            assertEq(str1[i], e.up > e.down ? e.up : e.down, "stressed = max(all up, all down)");
            assertGe(str1[i], base1[i], "stressed >= base");
        }
        for (uint256 c = 0; c < 2; ++c) {
            vm.revertToState(snap);
            snap = vm.snapshotState();
            _markAll(c == 0 ? 5 : 1000);
            for (uint256 i; i < 3; ++i) {
                (uint256 b, uint256 s) = h.finals(ms[i]);
                assertEq(b, base1[i], "same base whatever the chunk size");
                assertEq(s, str1[i], "same stressed whatever the chunk size");
            }
        }
    }

    // ---------------------------------------------------------------- whole-market stress

    function test_stressIsOneDirectionPerMarket() public {
        // BTC: calls only, so the up scenario is the worst
        _openBuy(BTC, true, 0, 1, 2e18);
        _openBuy(BTC, true, 5, 2, 1e18);
        _openBuy(BTC, true, -3, 3, 3e18);
        // ETH: calls and puts, so neither direction hits every series at its worst
        _openBuy(ETH, true, 2, 1, 20e18);
        _openBuy(ETH, false, -2, 1, 20e18);
        _openBuy(ETH, false, 0, 2, 5e18);
        _markAll(100);

        Expect memory btc = _expect(BTC);
        (uint256 bBase, uint256 bStr) = h.finals(BTC);
        assertEq(bStr, btc.up, "calls only: stressed is the up scenario");
        assertGt(btc.up, btc.down);
        assertGe(bStr, bBase);

        Expect memory eth = _expect(ETH);
        (uint256 eBase, uint256 eStr) = h.finals(ETH);
        assertEq(eStr, eth.up > eth.down ? eth.up : eth.down);
        assertLt(eStr, eth.perSeriesWorst, "a mix is below the sum of each series at its own worst");
        assertGe(eStr, eBase);
    }

    function test_volMultiplierIsCappedAt500() public {
        vols.set(HYPE, 40_000); // 400% × 1.5 = 600%, capped at 500%
        book.record(HYPE, 70e18, 40_000);
        _set(nowT + 5 minutes);
        _openBuy(HYPE, true, 0, 1, 10e18);
        _markAll(100); // would revert in TempoMath above 500% without the cap
        (, uint256 s) = h.finals(HYPE);
        assertGt(s, 0);
    }

    // ---------------------------------------------------------------- registry

    function test_capOf256SeriesPerMarketAndSellsNeverRefused() public {
        vm.pauseGasMetering();
        uint256 first;
        for (uint256 i; i < 256; ++i) {
            uint256 id = _openBuy(BTC, i % 2 == 0, int256(i % 64) - 32, i / 64, 1e15);
            if (i == 0) first = id;
        }
        vm.resumeGasMetering();
        assertEq(h.seriesOf(BTC).length, 256);
        uint128 k = uint128((marks.px(BTC) / step[BTC] + 40) * step[BTC]);
        uint256 extra = h.open(BTC, true, k, TempoBlend.single(1 days));
        (uint256 px, uint256 sig) = (marks.px(BTC), vols.bps(BTC)); // read first: calls in the arguments would take the expectRevert
        vm.expectRevert(abi.encodeWithSelector(PoolLiability.TooManySeries.selector, BTC));
        h.buy(BTC, extra, 1e15, 1e15, px, sig);
        // other markets are separate
        _openBuy(ETH, true, 0, 1, 1e18);
        // more raw than held: capped, never reverts; the slot is freed
        h.sell(first, 1e30);
        assertEq(h.raw(first), 0);
        assertEq(h.seriesOf(BTC).length, 255);
        h.buy(BTC, extra, 1e15, 1e15, px, sig);
        assertEq(h.seriesOf(BTC).length, 256);
        h.sell(12345, 1); // an unknown series: nothing happens
    }

    /// Selling out series while their market is being marked never skips or double-marks another series: a marked
    /// series that is removed stays counted (conservative), an unmarked one that is removed is not counted.
    function test_removalDuringMarkingMarksEachSeriesOnce() public {
        uint256[] memory ids = new uint256[](10);
        for (uint256 i; i < 10; ++i) {
            ids[i] = _openBuy(BTC, i % 2 == 0, int256(i) - 5, i, (i + 1) * 1e17);
        }
        uint256 s = marks.px(BTC);
        uint256 sigma = vols.bps(BTC);
        uint256 v1 = _seriesValue(ids[1], s, sigma); // will be marked, then sold out
        uint256 total;
        for (uint256 i; i < 10; ++i) {
            if (i != 7) total += _seriesValue(ids[i], s, sigma); // ids[7] is sold out before it is marked
        }
        h.start();
        assertFalse(h.mark(4)); // BTC series 0..3 marked
        h.sell(ids[1], 1e30); // marked: stays counted
        h.sell(ids[7], 1e30); // not yet marked: not counted
        while (!h.mark(3)) {}
        (uint256 base,) = h.finals(BTC);
        assertEq(base, total, "every remaining series once, the removed marked one kept");
        assertGt(v1, 0);
        assertEq(h.seriesOf(BTC).length, 8);
    }

    // ---------------------------------------------------------------- epochs

    function test_epochTimingAndStaleSources() public {
        _openBuy(BTC, true, 0, 1, 1e18);
        vm.expectRevert(PoolLiability.NotMarking.selector);
        h.mark(10);
        h.start();
        vm.expectRevert(PoolLiability.EpochInProgress.selector);
        h.start();
        while (!h.mark(10)) {}
        assertEq(h.epoch(), 1);
        _set(nowT + 1 hours - 1);
        vm.expectRevert(abi.encodeWithSelector(PoolLiability.EpochTooSoon.selector, T0 + 1 hours));
        h.start();
        _set(nowT + 1);
        marks.setStale(true);
        vm.expectRevert(abi.encodeWithSelector(MockMarks.Stale.selector, BTC));
        h.start();
        marks.setStale(false);
        vols.setStale(true);
        vm.expectRevert(abi.encodeWithSelector(MockVols.Stale.selector, BTC));
        h.start();
        vols.setStale(false);
        h.start();
        assertTrue(h.marking());
    }

    // ---------------------------------------------------------------- between epochs

    function test_buysAddAtOnceSellsWaitForTheNextEpoch() public {
        uint256 a = _openBuy(BTC, true, 0, 1, 2e18);
        _markAll(100);
        (uint256 base0, uint256 str0) = h.finals(BTC);
        assertEq(h.liveBase(BTC), base0);
        assertEq(h.liveStressed(BTC), str0);

        // a put: its down value is the larger of the two
        uint256 s = marks.px(BTC);
        uint256 sigma = vols.bps(BTC);
        uint256 b = _openBuy(BTC, false, -2, 2, 1e18);
        uint256 sigS = sigma * 15_000 / 10_000;
        uint256 vb = _seriesValue(b, s, sigma);
        uint256 up = _seriesValue(b, s * 12_000 / 10_000, sigS);
        uint256 down = _seriesValue(b, s * 8_000 / 10_000, sigS);
        assertGt(down, up);
        assertEq(h.liveBase(BTC), base0 + vb);
        assertEq(h.liveStressed(BTC), str0 + down, "a buy adds the larger of its up and down values");

        h.sell(a, 1e30);
        assertEq(h.liveStressed(BTC), str0 + down, "a sell lowers nothing until the next epoch");

        // during marking, a buy counts for both the old and the new epoch's live value
        _set(nowT + 1 hours);
        h.start();
        uint256 c = _openBuy(BTC, true, 1, 1, 1e18);
        uint256 cUp = _seriesValue(c, s * 12_000 / 10_000, sigS);
        assertEq(h.liveStressed(BTC), str0 + down + cUp);
        while (!h.mark(100)) {}
        (, uint256 str1) = h.finals(BTC);
        assertEq(h.liveStressed(BTC), str1 + cUp, "the new epoch plus buys since it started");
        assertEq(str1, _expectStressed(BTC));
    }

    function _expectStressed(bytes32 m) internal view returns (uint256) {
        Expect memory e = _expect(m);
        return e.up > e.down ? e.up : e.down;
    }

    // ---------------------------------------------------------------- gas

    function test_markingGas() public {
        _openBuy(BTC, true, 0, 1, 1e18); // single tempo
        _openBuy(ETH, true, 0, 3, 1e18); // 3-part Movement
        h.start();
        uint256 g = gasleft();
        h.mark(1);
        uint256 single = g - gasleft();
        g = gasleft();
        h.mark(1);
        uint256 movement = g - gasleft();
        emit log_named_uint("mark one series, single tempo", single);
        emit log_named_uint("mark one series, 3-part Movement", movement);
    }

    /// A full epoch: 256 series on each of the three markets (768).
    function test_fullEpochGas() public {
        vm.pauseGasMetering();
        bytes32[3] memory ms = [BTC, ETH, HYPE];
        for (uint256 j; j < 3; ++j) {
            for (uint256 i; i < 256; ++i) {
                _openBuy(ms[j], i % 2 == 0, int256(i % 64) - 32, i / 64, 1e17);
            }
        }
        vm.resumeGasMetering();
        h.start();
        uint256 chunk = 120;
        uint256 total;
        uint256 worst;
        uint256 txs;
        bool done;
        while (!done) {
            uint256 g = gasleft();
            done = h.mark(chunk);
            uint256 used = g - gasleft();
            total += used;
            if (used > worst) worst = used;
            ++txs;
        }
        emit log_named_uint("full epoch, 768 series: total gas", total);
        emit log_named_uint("full epoch: transactions of 120 series", txs);
        emit log_named_uint("full epoch: worst transaction gas", worst);
        assertLt(worst, 30_000_000, "a chunk of 120 series fits in a block");
    }

    /// NAV base with sells during marking, on a series already walked and on one not reached yet: each sell is counted
    /// exactly once, so the result equals an epoch taken after the sells (same S, σ and time).
    function test_navBaseCountsMidMarkingSellsExactlyOnce() public {
        uint256[] memory ids = new uint256[](8);
        for (uint256 i; i < 8; ++i) {
            ids[i] = _openBuy(BTC, i % 2 == 0, int256(i) - 4, i, (i + 2) * 1e17);
        }
        uint256 s = marks.px(BTC);
        uint256 sigma = vols.bps(BTC);
        // values of the parts that will be sold, at the epoch's S and σ (what the pool pays for them)
        uint256 half1 = h.raw(ids[1]) / 2;
        uint256 v1 = _partValue(ids[1], half1, s, sigma);
        uint256 v6 = _seriesValue(ids[6], s, sigma);
        uint256 snap = vm.snapshotState();

        // X: start, walk 3 series, sell half of a walked one and all of an unwalked one, finish
        h.start();
        assertFalse(h.mark(3));
        h.sellValued(ids[1], half1, v1);
        h.sellValued(ids[6], 1e30, v6);
        while (!h.mark(3)) {}
        uint256 x = h.navBase(BTC);

        // Y: the same sells first, then a fresh epoch
        vm.revertToState(snap);
        h.sellValued(ids[1], half1, v1);
        h.sellValued(ids[6], 1e30, v6);
        h.start();
        while (!h.mark(100)) {}
        uint256 y = h.navBase(BTC);

        assertApproxEqAbs(x, y, 4, "each mid-marking sell counted exactly once");
    }

    function _partValue(uint256 id, uint256 rawPart, uint256 s, uint256 sigma) internal view returns (uint256) {
        (, bool isCall, uint128 k, TempoBlend.Part[] memory mv) = book.seriesOf(id);
        uint256 units = Math.mulDiv(rawPart, book.normNow(id), WAD, Math.Rounding.Ceil);
        return Math.mulDiv(units, EnginePricing.unitValue(isCall, s, k, sigma, mv), WAD, Math.Rounding.Ceil);
    }
}
