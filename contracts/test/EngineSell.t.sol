// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {EngineBase} from "./Engine.t.sol";
import {Engine} from "../src/Engine.sol";
import {EnginePricing} from "../src/EnginePricing.sol";
import {HousePool} from "../src/HousePool.sol";
import {PathFundingBook} from "../src/PathFundingBook.sol";
import {TempoBlend} from "../src/TempoBlend.sol";

contract EngineSellTest is EngineBase {
    uint256 constant ALL = type(uint256).max;
    uint128 constant K = 50_000e18;

    function _sell(uint256 id, uint256 units) internal returns (uint256, uint256) {
        vm.prank(BUYER);
        return engine.sell(id, units, 0, nowT);
    }

    /// Walks the series so normNow is exact, then returns it.
    function _norm(uint256 id) internal returns (uint256) {
        (, bool done) = book.accrue(id, type(uint256).max); // 0 would mean the default 64-interval limit
        assertTrue(done);
        return book.normNow(id);
    }

    function _expectedNet(bool isCall, uint256 units, uint256 s, uint256 sigma, TempoBlend.Part[] memory mv)
        internal
        pure
        returns (uint256 gross, uint256 fee)
    {
        uint256 v = EnginePricing.unitValue(isCall, s, K, sigma, mv);
        return EnginePricing.sellQuote(v, units, s, 200);
    }

    // ---------------------------------------------------------------- round trip and sizes

    function test_roundTripPaysExactlyAndReleasesEverything() public {
        (uint256 id, uint256 cost) = _buy(true, K, _day(), 2e18);
        uint256 buyFee = usdc.balanceOf(FEES);
        (uint256 gross, uint256 fee) = _expectedNet(true, 2e18, 50_000e18, 5000, _day());
        uint256 poolBefore = usdc.balanceOf(address(pool));

        (uint256 paid, uint256 net) = _sell(id, ALL);
        assertEq(paid, 2e18);
        assertEq(net, gross - fee);
        assertEq(usdc.balanceOf(BUYER), 1_000_000e6 - cost + net);
        assertEq(usdc.balanceOf(address(pool)), poolBefore - gross, "the pool pays the gross");
        assertEq(usdc.balanceOf(FEES), buyFee + fee);
        assertEq(usdc.balanceOf(address(engine)), 0, "the engine holds no money");
        assertEq(book.balanceOf(id, BUYER), 0);
        assertEq(pool.openNotional(BTC), 0);
        assertLt(net, cost, "a round trip loses exactly the two fees");
        assertEq(cost - net, buyFee + fee + (cost - buyFee - gross)); // premium − gross is rounding only
        assertLe(cost - buyFee - gross, 1);
    }

    function test_partialSellAllAndOverAsk() public {
        (uint256 id,) = _buy(false, K, _day(), 2e18);
        (uint256 paid,) = _sell(id, 0.5e18);
        assertEq(paid, 0.5e18);
        assertEq(book.balanceOf(id, BUYER), 1.5e18);
        (paid,) = _sell(id, 5e18); // more than held: capped at the holding
        assertEq(paid, 1.5e18);
        assertEq(book.balanceOf(id, BUYER), 0);
        vm.prank(BUYER);
        vm.expectRevert(abi.encodeWithSelector(Engine.NothingToSell.selector, id));
        engine.sell(id, ALL, 0, nowT);
    }

    // ---------------------------------------------------------------- law 3

    function test_sellWorksWhileBuysPaused() public {
        (uint256 id,) = _buy(true, K, _day(), 1e18);
        vm.prank(PAUSER);
        engine.pauseBuys();
        (uint256 paid,) = _sell(id, ALL);
        assertEq(paid, 1e18);
    }

    /// Stale sources fall back to the book's last sample, each input separately.
    function test_staleSourcesUseTheLastSample() public {
        (uint256 id,) = _buy(true, K, _day(), 4e18);
        _adv(5 minutes);
        book.record(BTC, 51_000e18, 5200); // the last good sample differs from the live sources
        marks.set(BTC, 52_000e18);
        vols.set(BTC, 4800);
        _norm(id); // walk to the new sample; 4 units held is plenty for three 1-unit sells

        // stale mark: sample S, fresh σ
        marks.setStale(true);
        (uint256 g, uint256 f) = _expectedNet(true, 1e18, 51_000e18, 4800, _day());
        (, uint256 net) = _sell(id, 1e18);
        assertEq(net, g - f, "stale mark: sample S with the fresh vol");
        marks.setStale(false);

        // stale vol: fresh S, sample σ
        vols.setStale(true);
        (g, f) = _expectedNet(true, 1e18, 52_000e18, 5200, _day());
        (, net) = _sell(id, 1e18);
        assertEq(net, g - f, "stale vol: fresh S with the sample vol");

        // both stale: all from the sample, flags in the event
        marks.setStale(true);
        (g, f) = _expectedNet(true, 1e18, 51_000e18, 5200, _day());
        vm.recordLogs();
        (, net) = _sell(id, 1e18);
        assertEq(net, g - f, "both stale: the last sample");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == Engine.Sold.selector) {
                (,,,,,,,, bool markFromSample, bool volFromSample) = abi.decode(
                    logs[i].data, (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, bool, bool)
                );
                assertTrue(markFromSample && volFromSample);
                seen = true;
            }
        }
        assertTrue(seen);
    }

    /// Funding shrinks units; the sell pays for the shrunk units.
    function test_sellPaysForShrunkUnitsAfterFunding() public {
        (uint256 id,) = _buy(true, K, _day(), 1e18);
        for (uint256 h = 1; h <= 72; h++) {
            _adv(1 hours);
            book.record(BTC, 50_000e18, 5000);
        }
        uint256 norm = _norm(id);
        assertLt(norm, 0.2e18, "three days at a 1-day tempo shrink a lot");
        uint256 held = EnginePricing.unitsOf(1e18, norm);
        (uint256 g, uint256 f) = _expectedNet(true, held, 50_000e18, 5000, _day());
        (uint256 paid, uint256 net) = _sell(id, ALL);
        assertEq(paid, held);
        assertEq(net, g - f);
    }

    /// A series nobody touched for 60 days sells without a keeper, inside one block.
    function test_sellAfter60DaysUntouched() public {
        (uint256 id,) = _buy(false, K, TempoBlend.single(7 days), 1e18);
        uint256 tEnd = T0 + 60 days;
        uint256 hourlyFrom = tEnd - 96 hours;
        uint256 fiveFrom = tEnd - 64 * 5 minutes;
        for (uint256 t = T0 + 1 days; t < hourlyFrom; t += 1 days) {
            _set(t);
            book.record(BTC, 50_000e18, 5000);
        }
        for (uint256 t = hourlyFrom; t < fiveFrom; t += 1 hours) {
            _set(t);
            book.record(BTC, 50_000e18, 5000);
        }
        for (uint256 t = fiveFrom; t < tEnd; t += 5 minutes) {
            _set(t);
            book.record(BTC, 50_000e18, 5000);
        }
        _set(tEnd);
        vm.prank(BUYER);
        uint256 g = gasleft();
        (uint256 paid,) = engine.sell(id, ALL, 0, nowT);
        uint256 used = g - gasleft();
        emit log_named_uint("sell after 60 days untouched: gas", used);
        assertGt(paid, 0);
        assertLt(used, 32_000_000, "fits in a block");
        assertEq(book.balanceOf(id, BUYER), 0);
    }

    /// Past the daily ring (70 days), the sell charges the lost stretch at the maximum rate and still works.
    function test_sellAfter70DaysUsesTheFallback() public {
        (uint256 id,) = _buy(false, K, TempoBlend.single(30 days), 1e18);
        for (uint256 d = 1; d <= 70; d++) {
            _adv(1 days);
            book.record(BTC, 50_000e18, 5000);
        }
        vm.recordLogs();
        (uint256 paid,) = _sell(id, ALL);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool fallbackSeen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == PathFundingBook.HistoryFallback.selector) fallbackSeen = true;
        }
        assertTrue(fallbackSeen, "HistoryFallback emitted");
        assertEq(book.balanceOf(id, BUYER), 0);
        assertGt(paid, 0);
    }

    /// Deep out of the money after a big move: the seller gets 0 and the sell does not revert.
    function test_worthlessSellPaysZero() public {
        (uint256 id,) = _buy(true, K, TempoBlend.single(1 hours), 1e18);
        marks.set(BTC, 25_000e18);
        (uint256 paid, uint256 net) = _sell(id, ALL);
        assertEq(paid, 1e18);
        assertEq(net, 0);
        assertEq(book.balanceOf(id, BUYER), 0);
    }

    // ---------------------------------------------------------------- refusals and the interim blocker

    function test_sellRefusals() public {
        (uint256 id,) = _buy(true, K, _day(), 1e18);
        (uint256 g, uint256 f) = _expectedNet(true, 1e18, 50_000e18, 5000, _day());
        vm.startPrank(BUYER);
        vm.expectRevert(abi.encodeWithSelector(Engine.NetBelowMin.selector, g - f, g - f + 1));
        engine.sell(id, ALL, g - f + 1, nowT);
        vm.expectRevert(abi.encodeWithSelector(Engine.Expired.selector, nowT - 1));
        engine.sell(id, ALL, 0, nowT - 1);
        vm.expectRevert(Engine.ZeroUnits.selector);
        engine.sell(id, 0, 0, nowT);
        vm.expectRevert(abi.encodeWithSelector(PathFundingBook.Unknown.selector, 12345));
        engine.sell(12345, ALL, 0, nowT);
        vm.stopPrank();
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(Engine.NothingToSell.selector, id));
        engine.sell(id, ALL, 0, nowT);
        // exactly minOut passes
        vm.prank(BUYER);
        engine.sell(id, ALL, g - f, nowT);
    }

    /// INTERIM LIMIT (mainnet blocker, M2_NOTES): a drained HousePool cannot pay, and the sell reverts.
    function test_drainedPoolRevertsInsolvent() public {
        (uint256 id,) = _buy(true, K, _day(), 1e18);
        deal(address(usdc), address(pool), 0);
        (uint256 g,) = _expectedNet(true, 1e18, 50_000e18, 5000, _day());
        vm.prank(BUYER);
        vm.expectRevert(abi.encodeWithSelector(HousePool.Insolvent.selector, g, 0));
        engine.sell(id, ALL, 0, nowT);
    }

    // ---------------------------------------------------------------- book addition

    function test_accrueForSellIsEngineOnlyAndMatchesAccrue() public {
        (uint256 id,) = _buy(true, K, _day(), 1e18);
        for (uint256 i = 1; i <= 30; i++) {
            _adv(5 minutes);
            book.record(BTC, 50_000e18 + i * 25e18, 5000);
        }
        vm.prank(STRANGER);
        vm.expectRevert(PathFundingBook.NotEngine.selector);
        book.accrueForSell(id);

        uint256 snap = vm.snapshotState();
        (uint256 viaAccrue, bool done) = book.accrue(id, ALL);
        assertTrue(done);
        vm.revertToState(snap);
        vm.prank(address(engine));
        assertEq(book.accrueForSell(id), viaAccrue);
    }

    // ---------------------------------------------------------------- fuzz

    /// Law 3: whatever the price moves and whichever sources are stale, a sell succeeds and pays at least 0.
    function testFuzz_sellAlwaysWorks(uint256 s1, uint256 s2, uint256 units, uint8 flags, bool isCall) public {
        units = bound(units, 1e15, 2e18);
        s1 = bound(s1, 15_000e18, 150_000e18); // live mark at sell time
        s2 = bound(s2, 15_000e18, 150_000e18); // last recorded sample
        pool.setCap(BTC, type(uint256).max);
        (uint256 id,) = _buy(isCall, K, _day(), units);
        _adv(5 minutes);
        book.record(BTC, s2, 6000);
        marks.set(BTC, s1);
        marks.setStale(flags & 1 != 0);
        vols.setStale(flags & 2 != 0);
        if (flags & 4 != 0) {
            vm.prank(PAUSER);
            engine.pauseBuys();
        }
        uint256 before = usdc.balanceOf(BUYER);
        (uint256 paid, uint256 net) = _sell(id, ALL);
        assertGt(paid, 0);
        assertEq(usdc.balanceOf(BUYER) - before, net);
        assertEq(book.balanceOf(id, BUYER), 0);
    }

    /// Buying and selling straight back with the same inputs never returns more than was paid.
    function testFuzz_immediateRoundTripNeverProfits(uint256 s, uint256 sigma, uint256 units, bool isCall) public {
        s = bound(s, 30_000e18, 90_000e18);
        sigma = bound(sigma, 1000, 20_000);
        units = bound(units, 1e15, 3e18);
        uint128 k = uint128((s / 100e18) * 100e18);
        marks.set(BTC, s);
        vols.set(BTC, sigma);
        pool.setCap(BTC, type(uint256).max);
        vm.prank(BUYER);
        (uint256 id, uint256 cost) = engine.buy(BTC, isCall, k, _day(), units, ALL, nowT);
        (, uint256 net) = _sell(id, ALL);
        assertLe(net, cost);
    }

    // ---------------------------------------------------------------- gas

    function test_sellGas() public {
        (uint256 id,) = _buy(true, K, _day(), 2e18);
        vm.prank(BUYER);
        uint256 g = gasleft();
        engine.sell(id, 1e18, 0, nowT);
        emit log_named_uint("sell gas, caught-up series", g - gasleft());
    }
}
