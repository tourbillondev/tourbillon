// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MainspringPoolBase} from "./MainspringPool.t.sol";
import {MainspringPool} from "../src/MainspringPool.sol";
import {Engine} from "../src/Engine.sol";
import {TempoBlend} from "../src/TempoBlend.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// M3 step 5: the risk rules on opens (coverage, caps, drawdown pause, market pauses).
contract MainspringPoolRiskTest is MainspringPoolBase {
    address constant RISK = address(0x815C);

    function _buyAs(bytes32 m, bool isCall, uint128 k, uint256 units, uint256 tempo) internal returns (uint256 id) {
        vm.prank(TRADER);
        (id,) = engine.buy(m, isCall, k, TempoBlend.single(tempo), units, ALL, nowT);
    }

    // ---------------------------------------------------------------- coverage

    /// A buy is refused once Elysium USDC would no longer cover the stressed liability.
    function test_coverageRefusesTheBuyThatWouldBreachIt() public {
        _seed(500_000e6);
        uint256 bought;
        while (true) {
            vm.prank(TRADER);
            try engine.buy(BTC, true, 70_000e18, TempoBlend.single(1 days), 1e18, ALL, nowT) {
                ++bought;
            } catch (bytes memory err) {
                assertEq(bytes4(err), MainspringPool.CoverageBreached.selector, "refused for coverage only");
                break;
            }
        }
        assertGt(bought, 0);
        assertGe(pool.available(), pool.stressedLiability(), "every accepted buy left the pool covered");
    }

    /// Equity, queued deposits and owed USDC never count towards coverage.
    function test_coverageCountsElysiumUsdcOnly() public {
        _seed(200_000e6);
        _postEquity(5_000_000e6); // a large P&L on Hyperliquid
        _set(nowT + 1 hours);
        _postEquity(5_000_000e6);
        _lp(B, 10_000_000e6); // queued deposit
        assertGt(pool.navNow(), 4_000_000e6, "NAV counts the equity");
        vm.prank(TRADER);
        vm.expectRevert(); // CoverageBreached: neither the equity nor the queued deposit can pay sells
        engine.buy(BTC, true, 70_000e18, TempoBlend.single(1 days), 20e18, ALL, nowT);
    }

    /// Law 3 under the coverage rule: after any accepted buys at S0, a price anywhere within the shock band and vol up
    /// to × 1.5 leaves every sell payable (option values are convex in S and increase with vol).
    function testFuzz_everySellPayableWithinTheStressBand(uint256 seed, uint256 moveBps, uint256 volUp) public {
        moveBps = bound(moveBps, 0, 4000); // 0..4000 → −20%..+20% (BTC shock 2000)
        volUp = bound(volUp, 10_000, 15_000); // vol × 1 .. × 1.5
        _seed(400_000e6);
        uint256[] memory ids = new uint256[](12);
        uint256 n;
        for (uint256 i; i < 12; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            bool isCall = r % 2 == 0;
            uint128 k = uint128((70_000 + ((r >> 8) % 11) * 1_000 - 5_000) * 1e18);
            uint256 units = bound(r >> 32, 1e17, 3e18);
            uint256 tempo = [uint256(1 hours), 1 days, 7 days][(r >> 16) % 3];
            vm.prank(TRADER);
            try engine.buy(BTC, isCall, k, TempoBlend.single(tempo), units, ALL, nowT) returns (uint256 id, uint256) {
                ids[n++] = id;
            } catch {}
        }
        // the move, at once (same time: no funding), fresh mark and vol
        marks.set(BTC, 70_000e18 * (8_000 + moveBps) / 10_000);
        vols.set(BTC, 4500 * volUp / 10_000);
        for (uint256 i; i < n; ++i) {
            if (book.balanceOf(ids[i], TRADER) == 0) continue; // the same terms bought twice: already sold
            vm.prank(TRADER);
            engine.sell(ids[i], ALL, 0, nowT); // must not revert (Insolvent would)
        }
    }

    // ---------------------------------------------------------------- caps

    function test_notionalCapWithProRataRelease() public {
        _seed(5_000_000e6);
        pool.setCaps(BTC, 210_000e6, 1e15); // three 1-unit buys at $70,000
        uint256 id = _buyAs(BTC, true, 70_000e18, 2e18, 1 days);
        _buyAs(BTC, false, 70_000e18, 1e18, 1 days);
        assertEq(pool.openNotional(BTC), 210_000e6);
        vm.prank(TRADER);
        vm.expectRevert(
            abi.encodeWithSelector(MainspringPool.NotionalCapExceeded.selector, BTC, 210_000e6 + 7_000e6, 210_000e6)
        );
        engine.buy(BTC, true, 70_000e18, TempoBlend.single(1 days), 0.1e18, ALL, nowT);
        vm.prank(TRADER);
        engine.sell(id, 1e18, 0, nowT); // half of the series: half its notional released
        assertEq(pool.openNotional(BTC), 140_000e6);
        vm.prank(TRADER);
        engine.sell(id, ALL, 0, nowT);
        assertEq(pool.openNotional(BTC), 70_000e6);
        assertEq(pool.seriesNotional(id), 0);
        // ETH has its own cap
        pool.setCaps(ETH, 0, 1e15);
        vm.prank(TRADER);
        vm.expectRevert(abi.encodeWithSelector(MainspringPool.NotionalCapExceeded.selector, ETH, 2_000e6, 0));
        engine.buy(ETH, true, 2_000e18, TempoBlend.single(1 days), 1e18, ALL, nowT);
    }

    /// Owner rule: directional cap ≤ hedger delta cap × 2 × shock, on every setter that moves one side of it.
    function test_directionalCapLimitedByHedgerCapacity() public {
        // BTC shock 20%: $2.5M of hedger delta carries a $1M directional cap. setUp's 1e15 directional cap would break
        // the rule, so lowering the hedger cap first is refused
        vm.expectRevert(abi.encodeWithSelector(MainspringPool.DirectionalAboveHedge.selector, BTC, 1e15, 1_000_000e6));
        pool.setHedgerDeltaCap(BTC, 2_500_000e6);
        pool.setCaps(BTC, 1e15, 1_000_000e6);
        vm.expectEmit(address(pool));
        emit MainspringPool.HedgerDeltaCapSet(BTC, 2_500_000e6);
        pool.setHedgerDeltaCap(BTC, 2_500_000e6);
        assertEq(pool.maxDirectionalCap(BTC), 1_000_000e6);
        assertEq(pool.directionalCap(BTC), 1_000_000e6);
        vm.expectRevert(
            abi.encodeWithSelector(MainspringPool.DirectionalAboveHedge.selector, BTC, 1_000_000e6 + 1, 1_000_000e6)
        );
        pool.setCaps(BTC, 1e15, 1_000_000e6 + 1);
        // lowering the hedger cap or the shock below what the directional cap needs is refused
        vm.expectRevert(
            abi.encodeWithSelector(MainspringPool.DirectionalAboveHedge.selector, BTC, 1_000_000e6, 999_999_600000)
        );
        pool.setHedgerDeltaCap(BTC, 2_499_999e6);
        vm.expectRevert(
            abi.encodeWithSelector(MainspringPool.DirectionalAboveHedge.selector, BTC, 1_000_000e6, 999_500_000000)
        );
        pool.setShock(BTC, 1999);
        pool.setShock(BTC, 2500); // a larger shock allows more
        assertEq(pool.maxDirectionalCap(BTC), 1_250_000e6);
        // a market not listed has no hedge capacity: only a zero directional cap
        bytes32 sol = "SOL";
        pool.setHedgerDeltaCap(sol, 1_000_000e6);
        assertEq(pool.maxDirectionalCap(sol), 0);
        vm.expectRevert(abi.encodeWithSelector(MainspringPool.DirectionalAboveHedge.selector, sol, 1, 0));
        pool.setCaps(sol, 1, 1);
        pool.setCaps(sol, 1, 0);
        // admin only
        bytes32 admin = pool.DEFAULT_ADMIN_ROLE();
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, ATTACKER, admin)
        );
        pool.setHedgerDeltaCap(BTC, 1e16);
    }

    function test_directionalCapStopsOneSidedBooksAndAllowsHedgingBuys() public {
        _seed(5_000_000e6);
        pool.setCaps(BTC, 1e15, 60_000e6);
        // calls only: exposure grows on one side until the cap stops it
        uint256 accepted;
        while (true) {
            vm.prank(TRADER);
            try engine.buy(BTC, true, 70_000e18, TempoBlend.single(1 days), 1e18, ALL, nowT) {
                ++accepted;
            } catch (bytes memory err) {
                assertEq(bytes4(err), MainspringPool.DirectionalCapExceeded.selector);
                break;
            }
        }
        assertGt(accepted, 0);
        uint256 dir = pool.directional(BTC);
        assertLe(dir, 60_000e6);
        // a put lowers the exposure: allowed even though another call would not be
        _buyAs(BTC, false, 70_000e18, 1e18, 1 days);
        assertLt(pool.directional(BTC), dir);
    }

    // ---------------------------------------------------------------- drawdown

    /// NAV per share more than 15% below the 30-day high pauses every open; sells and withdrawals continue; only the
    /// admin resumes.
    function test_drawdownPauseAt16PercentNotAt14() public {
        _seed(1_000_000e6); // round 0: NAV per share at par
        pool.setTreasury(TREASURY);
        _postEquity(0);
        _set(nowT + 1 hours);
        _postEquity(0);
        pool.sendToTreasury(200_000e6);
        uint256 id = _buyAs(BTC, true, 70_000e18, 1e18, 1 days);

        // a 14% loss on Hyperliquid: no pause
        _set(nowT + 1 hours);
        _postEquity(-140_000e6);
        _epochAndSettle();
        assertFalse(pool.opensPaused());
        // a 16% loss: paused
        _set(nowT + 1 hours);
        _postEquity(-160_000e6);
        _epochAndSettle();
        assertTrue(pool.opensPaused());

        vm.prank(TRADER);
        vm.expectRevert(MainspringPool.OpensArePaused.selector);
        engine.buy(BTC, true, 70_000e18, TempoBlend.single(1 days), 1e18, ALL, nowT);
        vm.prank(TRADER);
        engine.sell(id, ALL, 0, nowT); // sells continue
        vm.prank(A);
        pool.requestWithdraw(1_000e18); // withdrawals continue
        _set(nowT + 1 hours);
        _postEquity(-160_000e6);
        _epochAndSettle();
        uint256 r = pool.round() - 1; // read first: a call in the arguments would take the prank
        vm.prank(A);
        pool.withdraw(r);

        vm.prank(RISK);
        vm.expectRevert();
        pool.resumeOpens();
        pool.resumeOpens();
        assertFalse(pool.opensPaused());
        _buyAs(BTC, true, 70_000e18, 1e18, 1 days);
    }

    function test_drawdownHighRollsOffAfter30Days() public {
        _seed(1_000_000e6);
        pool.setTreasury(TREASURY);
        _postEquity(0);
        _set(nowT + 1 hours);
        _postEquity(0);
        pool.sendToTreasury(200_000e6);
        // 31 days later, NAV per share 16% below the old high: the old high has left the window
        _set(nowT + 31 days);
        _postEquity(-160_000e6);
        _set(nowT + 1 hours);
        _postEquity(-160_000e6);
        _epochAndSettle();
        assertFalse(pool.opensPaused(), "the high from 31 days ago no longer counts");
    }

    // ---------------------------------------------------------------- market pauses

    function test_riskPauserPausesOneMarketOnly() public {
        _seed(5_000_000e6);
        uint256 id = _buyAs(BTC, true, 70_000e18, 1e18, 1 days);
        bytes32 role = pool.RISK_PAUSER_ROLE();
        pool.grantRole(role, RISK);
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, ATTACKER, role)
        );
        pool.pauseMarket(BTC);
        vm.prank(RISK);
        pool.pauseMarket(BTC);
        vm.prank(TRADER);
        vm.expectRevert(abi.encodeWithSelector(MainspringPool.MarketIsPaused.selector, BTC));
        engine.buy(BTC, true, 70_000e18, TempoBlend.single(1 days), 1e18, ALL, nowT);
        _buyAs(ETH, true, 2_000e18, 1e18, 1 days); // other markets unaffected
        vm.prank(TRADER);
        engine.sell(id, ALL, 0, nowT); // sells unaffected
        bytes32 unpauser = pool.UNPAUSER_ROLE();
        vm.prank(RISK);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, RISK, unpauser)
        );
        pool.unpauseMarket(BTC); // the risk key cannot unpause
        pool.unpauseMarket(BTC);
        _buyAs(BTC, true, 70_000e18, 1e18, 1 days);
    }
}
