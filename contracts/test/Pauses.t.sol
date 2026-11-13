// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MainspringPoolBase} from "./MainspringPool.t.sol";
import {MainspringPool} from "../src/MainspringPool.sol";
import {TempoBlend} from "../src/TempoBlend.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// M7 step 3: pausing and unpausing split (G3, G4) and the deposit pause (G18). The guardian holds the pausers, the
/// automated risk key only `pauseMarket`, the Safe the unpauser; here they stand in as three addresses.
contract PausesTest is MainspringPoolBase {
    address constant GUARDIAN = address(0x6A2D);
    address constant RISK = address(0x815C);
    address constant SAFE = address(0x5AFE);

    function setUp() public override {
        super.setUp();
        // the step 4 layout, by hand: pausers to the guardian, the market pause also to the risk key, unpausers to
        // the Safe; the admin (this test) gives up its interim pause roles
        pool.grantRole(pool.PAUSER_ROLE(), GUARDIAN);
        pool.grantRole(pool.RISK_PAUSER_ROLE(), GUARDIAN);
        pool.grantRole(pool.RISK_PAUSER_ROLE(), RISK);
        pool.grantRole(pool.UNPAUSER_ROLE(), SAFE);
        pool.renounceRole(pool.PAUSER_ROLE(), address(this));
        pool.renounceRole(pool.UNPAUSER_ROLE(), address(this));
        engine.grantRole(engine.PAUSER_ROLE(), GUARDIAN);
        engine.grantRole(engine.UNPAUSER_ROLE(), SAFE);
        engine.renounceRole(engine.UNPAUSER_ROLE(), address(this));
    }

    function _unauth(address who, bytes32 role) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, who, role);
    }

    // ---------------------------------------------------------------- the deposit pause

    function test_depositPauseStopsNewDepositsOnlyAndQueuedOnesStillSettle() public {
        _seed(1_000_000e6);
        (uint256 id,) = _buy(BTC, true, 70_000e18, 1e18);
        _lp(B, 200_000e6); // queued before the pause
        uint256 queuedRound = pool.round();
        vm.prank(A);
        pool.requestWithdraw(100_000e18);

        vm.prank(GUARDIAN);
        pool.pauseDeposits();
        assertTrue(pool.depositsPaused());
        vm.prank(B);
        vm.expectRevert(MainspringPool.DepositsArePaused.selector);
        pool.deposit(1e6);

        // everything else goes on: the round settles (the queued deposit becomes shares), claims, withdrawals, sells
        _set(nowT + 1 hours);
        _epochAndSettle();
        vm.prank(B);
        pool.claimShares(queuedRound);
        assertGt(pool.balanceOf(B), 0, "the queued deposit settled into shares");
        uint256 usdcA = usdc.balanceOf(A);
        vm.prank(A);
        pool.withdraw(queuedRound);
        assertGt(usdc.balanceOf(A), usdcA, "withdrawals are never paused");
        _sell(id, ALL); // sells are never paused
        vm.prank(A);
        pool.requestWithdraw(1e18);

        vm.prank(SAFE);
        pool.unpauseDeposits();
        assertFalse(pool.depositsPaused());
        _lp(B, 1e6);
    }

    function test_onlyThePauserPausesDepositsAndTheRiskKeyCannot() public {
        bytes32 pauser = pool.PAUSER_ROLE();
        address[4] memory no = [RISK, SAFE, ATTACKER, address(this)];
        for (uint256 i; i < 4; ++i) {
            vm.prank(no[i]);
            vm.expectRevert(_unauth(no[i], pauser));
            pool.pauseDeposits();
        }
        vm.prank(GUARDIAN);
        pool.pauseDeposits();
    }

    // ---------------------------------------------------------------- unpausing (G4)

    function test_onlyTheUnpauserUnpausesAndNoPauserCan() public {
        _seed(1_000_000e6);
        vm.startPrank(GUARDIAN);
        engine.pauseBuys();
        pool.pauseMarket(BTC);
        pool.pauseDeposits();
        vm.stopPrank();
        vm.prank(RISK);
        pool.pauseMarket(ETH);

        bytes32 pu = pool.UNPAUSER_ROLE();
        bytes32 eu = engine.UNPAUSER_ROLE();
        address[4] memory no = [GUARDIAN, RISK, ATTACKER, address(this)]; // this test is still the admin
        for (uint256 i; i < 4; ++i) {
            vm.startPrank(no[i]);
            vm.expectRevert(_unauth(no[i], eu));
            engine.unpauseBuys();
            vm.expectRevert(_unauth(no[i], pu));
            pool.unpauseMarket(BTC);
            vm.expectRevert(_unauth(no[i], pu));
            pool.unpauseDeposits();
            vm.expectRevert(_unauth(no[i], pu));
            pool.resumeOpens();
            vm.stopPrank();
        }
        vm.startPrank(SAFE);
        engine.unpauseBuys();
        pool.unpauseMarket(BTC);
        pool.unpauseMarket(ETH);
        pool.unpauseDeposits();
        pool.resumeOpens();
        vm.stopPrank();
        assertFalse(engine.buysPaused());
        assertFalse(pool.marketPaused(BTC));
        assertFalse(pool.depositsPaused());
        _buy(BTC, true, 70_000e18, 1e18);
    }

    function test_theAdminCanOnlyGrantTheUnpauserNotUseIt() public {
        vm.prank(GUARDIAN);
        engine.pauseBuys();
        bytes32 eu = engine.UNPAUSER_ROLE();
        vm.expectRevert(_unauth(address(this), eu));
        engine.unpauseBuys();
        engine.grantRole(eu, address(this)); // after the handover the admin is the timelock: a delayed grant
        engine.unpauseBuys();
        assertFalse(engine.buysPaused());
    }

    function test_theRiskKeyPausesMarketsOnly() public {
        vm.startPrank(RISK);
        pool.pauseMarket(BTC);
        vm.expectRevert(_unauth(RISK, pool.PAUSER_ROLE()));
        pool.pauseDeposits();
        vm.expectRevert(_unauth(RISK, engine.PAUSER_ROLE()));
        engine.pauseBuys();
        vm.stopPrank();
        vm.prank(TRADER);
        vm.expectRevert(abi.encodeWithSelector(MainspringPool.MarketIsPaused.selector, BTC));
        engine.buy(BTC, true, 70_000e18, TempoBlend.single(1 days), 1e18, ALL, nowT);
    }
}
