// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Governance, ISafeProxyFactory} from "../../src/governance/Governance.sol";
import {Safe, SafeHelpers} from "./SafeHelpers.sol";

/// Records who called it: stands in for a governed contract.
contract Target {
    address public lastCaller;
    uint256 public value;

    function set(uint256 v) external {
        lastCaller = msg.sender;
        value = v;
    }
}

/// Deploys through the library in its own context, so the deployer is a known contract with no role afterwards.
contract Deployer {
    function timelock(address safe, uint256 delay) external returns (TimelockController) {
        return Governance.deployTimelock(safe, delay);
    }

    function check(uint256 chainId, uint256 delay) external pure {
        Governance.checkDelay(chainId, delay);
    }
}

/// M7 step 2: the 3-of-5 Safe, the 2-of-3 guardian Safe (real Safe v1.4.1 proxies) and the timelock (G1, G2, G19).
contract GovernanceTest is SafeHelpers {
    address factory;
    address singleton;
    Safe admin;
    Safe guardian;
    TimelockController tl;
    Deployer dep;
    Target target;
    uint256[5] adminPks; // test-only keys
    uint256[3] guardianPks;
    address constant ANYONE = address(0xA11);

    function setUp() public {
        vm.chainId(31337);
        factory = deployCode("SafeProxyFactory.sol:SafeProxyFactory");
        singleton = deployCode("Safe.sol:Safe");
        address[] memory a = new address[](5);
        for (uint256 i; i < 5; ++i) {
            adminPks[i] = 0xA000 + i;
            a[i] = vm.addr(adminPks[i]);
        }
        address[] memory g = new address[](3);
        for (uint256 i; i < 3; ++i) {
            guardianPks[i] = 0xB000 + i;
            g[i] = vm.addr(guardianPks[i]);
        }
        admin = Safe(payable(Governance.deployAdminSafe(ISafeProxyFactory(factory), singleton, a, 1)));
        guardian = Safe(payable(Governance.deployGuardian(ISafeProxyFactory(factory), singleton, g, 2)));
        dep = new Deployer();
        tl = dep.timelock(address(admin), Governance.TESTNET_DELAY);
        target = new Target();
    }

    // ---------------------------------------------------------------- helpers

    function _adminKeys(uint256 n) internal view returns (uint256[] memory k) {
        k = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            k[i] = adminPks[i];
        }
    }

    function _guardianKeys(uint256 n) internal view returns (uint256[] memory k) {
        k = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            k[i] = guardianPks[i];
        }
    }

    function _schedule(bytes memory call, bytes32 salt) internal returns (bool) {
        bytes memory data =
            abi.encodeCall(TimelockController.schedule, (address(target), 0, call, bytes32(0), salt, tl.getMinDelay()));
        return _exec(admin, _adminKeys(3), address(tl), data);
    }

    // ---------------------------------------------------------------- 1. Safe thresholds

    function test_thresholdsThreeOfFiveAndTwoOfThree() public {
        assertEq(admin.getThreshold(), 3);
        assertEq(admin.getOwners().length, 5);
        assertEq(guardian.getThreshold(), 2);
        assertEq(guardian.getOwners().length, 3);
        bytes memory call = abi.encodeCall(Target.set, (7));

        vm.expectRevert(bytes("GS020")); // signatures data too short: fewer than the threshold
        this.execExternal(admin, _adminKeys(2), address(target), call);
        assertTrue(_exec(admin, _adminKeys(3), address(target), call));
        assertEq(target.lastCaller(), address(admin));

        vm.expectRevert(bytes("GS020"));
        this.execExternal(guardian, _guardianKeys(1), address(target), abi.encodeCall(Target.set, (8)));
        assertTrue(_exec(guardian, _guardianKeys(2), address(target), abi.encodeCall(Target.set, (8))));
        assertEq(target.lastCaller(), address(guardian));
        assertEq(target.value(), 8);
    }

    // ---------------------------------------------------------------- 2. the timelock

    function test_timelockSafeSchedulesAnyoneExecutesAfterTheDelay() public {
        bytes memory call = abi.encodeCall(Target.set, (42));
        bytes32 salt = keccak256("op-1");
        assertTrue(_schedule(call, salt));
        bytes32 id = tl.hashOperation(address(target), 0, call, bytes32(0), salt);
        assertTrue(tl.isOperationPending(id));

        // before the delay: nobody, not even the Safe, can execute
        vm.warp(block.timestamp + Governance.TESTNET_DELAY - 1);
        vm.prank(ANYONE);
        vm.expectRevert();
        tl.execute(address(target), 0, call, bytes32(0), salt);
        bytes memory early = abi.encodeCall(TimelockController.execute, (address(target), 0, call, bytes32(0), salt));
        vm.expectRevert(bytes("GS013")); // the Safe's inner call failed
        this.execExternal(admin, _adminKeys(3), address(tl), early);

        // after the delay: anyone
        vm.warp(block.timestamp + 1);
        vm.prank(ANYONE);
        tl.execute(address(target), 0, call, bytes32(0), salt);
        assertEq(target.value(), 42);
        assertEq(target.lastCaller(), address(tl), "the governed contract sees only the timelock");
        assertTrue(tl.isOperationDone(id));
    }

    function test_theSafeCancelsAndOnlyTheSafeSchedules() public {
        bytes memory call = abi.encodeCall(Target.set, (1));
        bytes32 salt = keccak256("op-2");
        assertTrue(_schedule(call, salt));
        bytes32 id = tl.hashOperation(address(target), 0, call, bytes32(0), salt);
        assertTrue(_exec(admin, _adminKeys(3), address(tl), abi.encodeCall(TimelockController.cancel, (id))));
        assertFalse(tl.isOperation(id));

        // no one else schedules or cancels: an owner alone, the guardian, the deployer, anyone
        address[4] memory others = [vm.addr(adminPks[0]), address(guardian), address(dep), ANYONE];
        bytes32 proposer = tl.PROPOSER_ROLE();
        uint256 minDelay = tl.getMinDelay(); // read first: a call inside the arguments would use up the prank
        for (uint256 i; i < 4; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(
                abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, others[i], proposer)
            );
            tl.schedule(address(target), 0, call, bytes32(0), salt, minDelay);
        }
        // the guardian cannot cancel either (G3)
        assertTrue(_schedule(call, salt));
        bytes memory cancel = abi.encodeCall(TimelockController.cancel, (id));
        vm.expectRevert(bytes("GS013"));
        this.execExternal(guardian, _guardianKeys(2), address(tl), cancel);
        // and the Safe cannot shorten the delay: a schedule below the minimum is refused
        bytes memory short = abi.encodeCall(
            TimelockController.schedule,
            (address(target), 0, call, bytes32(0), keccak256("op-3"), Governance.TESTNET_DELAY - 1)
        );
        vm.expectRevert(bytes("GS013"));
        this.execExternal(admin, _adminKeys(3), address(tl), short);
    }

    function test_changingTheDelayItselfWaitsOutTheDelay() public {
        // updateDelay is callable only by the timelock itself: a direct call from the Safe is refused
        bytes memory upd = abi.encodeCall(TimelockController.updateDelay, (0));
        vm.expectRevert(bytes("GS013"));
        this.execExternal(admin, _adminKeys(3), address(tl), upd);
        vm.prank(address(admin));
        vm.expectRevert(abi.encodeWithSelector(TimelockController.TimelockUnauthorizedCaller.selector, address(admin)));
        tl.updateDelay(0);
    }

    // ---------------------------------------------------------------- 3. the delay rule (G19)

    function test_delayRuleOneHourOnlyOnAnvilAndTheElysiumTestnet() public {
        dep.check(31337, 1 hours);
        dep.check(99801, 1 hours);
        dep.check(1, 48 hours);
        dep.check(999_999, 72 hours);
        vm.expectRevert(abi.encodeWithSelector(Governance.DelayTooShort.selector, 1, 1 hours, 48 hours));
        dep.check(1, 1 hours);
        vm.expectRevert(abi.encodeWithSelector(Governance.DelayTooShort.selector, 999, 48 hours - 1, 48 hours));
        dep.check(999, 48 hours - 1);
        // deployTimelock applies it to the chain it runs on
        vm.chainId(999);
        vm.expectRevert(abi.encodeWithSelector(Governance.DelayTooShort.selector, 999, 1 hours, 48 hours));
        dep.timelock(address(admin), 1 hours);
        TimelockController main = dep.timelock(address(admin), 48 hours);
        assertEq(main.getMinDelay(), 48 hours);
        vm.chainId(99801);
        assertEq(dep.timelock(address(admin), 1 hours).getMinDelay(), 1 hours);
    }

    // ---------------------------------------------------------------- 4. no admin EOA

    function test_noAdminButTheTimelockItselfAndNoRoleForTheDeployer() public view {
        bytes32 adminRole = tl.DEFAULT_ADMIN_ROLE();
        assertTrue(tl.hasRole(adminRole, address(tl)), "self-administered");
        address[5] memory nobody = [address(dep), address(this), address(admin), address(guardian), ANYONE];
        for (uint256 i; i < 5; ++i) {
            assertFalse(tl.hasRole(adminRole, nobody[i]));
        }
        assertTrue(tl.hasRole(tl.PROPOSER_ROLE(), address(admin)));
        assertTrue(tl.hasRole(tl.CANCELLER_ROLE(), address(admin)));
        assertTrue(tl.hasRole(tl.EXECUTOR_ROLE(), address(0)), "anyone executes a ready operation");
        assertFalse(tl.hasRole(tl.PROPOSER_ROLE(), address(dep)));
        assertFalse(tl.hasRole(tl.CANCELLER_ROLE(), address(guardian)));
        assertEq(tl.getMinDelay(), 1 hours);
    }

    function test_safesNeedExactlyTheSpecOwnerCounts() public {
        address[] memory four = new address[](4);
        for (uint256 i; i < 4; ++i) {
            four[i] = address(uint160(0xC0 + i));
        }
        vm.expectRevert(abi.encodeWithSelector(Governance.BadOwners.selector, 4, 5));
        this.adminSafe(four);
        vm.expectRevert(abi.encodeWithSelector(Governance.BadOwners.selector, 4, 3));
        this.guardianSafe(four);
    }

    function adminSafe(address[] memory owners) external returns (address) {
        return Governance.deployAdminSafe(ISafeProxyFactory(factory), singleton, owners, 9);
    }

    function guardianSafe(address[] memory owners) external returns (address) {
        return Governance.deployGuardian(ISafeProxyFactory(factory), singleton, owners, 9);
    }
}
