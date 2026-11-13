// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployM1} from "../script/DeployM1.s.sol";
import {QuorumBoard} from "../src/QuorumBoard.sol";
import {MarkRouter} from "../src/MarkRouter.sol";

contract DeployM1Test is Test {
    address constant ADMIN = address(0xAD);
    address constant S1 = address(0x51);
    address constant S2 = address(0x52);
    address constant S3 = address(0x53);

    DeployM1 script;
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
        _set(1_794_182_400);
        script = new DeployM1();
    }

    function _config() internal pure returns (DeployM1.Config memory c) {
        c.admin = ADMIN;
        c.signers = new address[](3);
        c.signers[0] = S1;
        c.signers[1] = S2;
        c.signers[2] = S3;
        c.markets = new bytes32[](3);
        c.markets[0] = "BTC";
        c.markets[1] = "ETH";
        c.markets[2] = "HYPE";
    }

    function _deploy() internal returns (DeployM1.Deployed memory) {
        return script.deploy(_config(), address(script));
    }

    function test_deployConfiguresBoardFeedsAndRoles() public {
        DeployM1.Deployed memory d = _deploy();
        QuorumBoard b = d.board;
        bytes32 adminRole = b.DEFAULT_ADMIN_ROLE();

        assertEq(b.signerCount(), 3);
        assertTrue(b.isSigner(S1) && b.isSigner(S2) && b.isSigner(S3));
        assertEq(b.quorum(), 2);
        assertEq(b.window(), 30);

        bytes32[3] memory names = [bytes32("BTC"), "ETH", "HYPE"];
        for (uint256 i; i < 3; ++i) {
            (bool listed, uint16 step, uint32 hb) = b.feeds(b.markKey(names[i]));
            assertTrue(listed);
            assertEq(step, 200, "MARK step 2%");
            assertEq(hb, 60, "MARK heartbeat 60 s");
            (listed, step, hb) = b.feeds(b.volKey(names[i]));
            assertTrue(listed);
            assertEq(step, 1000, "VOL step 10%");
            assertEq(hb, 900, "VOL heartbeat 15 min");
        }

        assertEq(address(d.quorumSource.board()), address(b));
        assertEq(d.router.delay(), 1 hours);

        // the admin holds every role; the deployer holds none
        assertTrue(b.hasRole(adminRole, ADMIN));
        assertTrue(d.router.hasRole(adminRole, ADMIN));
        assertFalse(b.hasRole(adminRole, address(script)));
        assertFalse(d.router.hasRole(adminRole, address(script)));
        assertFalse(b.hasRole(adminRole, S1));
    }

    function test_routesWaitOneHourThenMarksFlowThroughRouter() public {
        DeployM1.Deployed memory d = _deploy();
        MarkRouter r = d.router;
        uint64 eta = uint64(nowT + 1 hours);
        assertEq(d.routeEta, eta);

        bytes32[3] memory names = [bytes32("BTC"), "ETH", "HYPE"];
        for (uint256 i; i < 3; ++i) {
            (MarkRouter.Route memory p, uint64 e) = r.pending(names[i]);
            assertEq(e, eta);
            assertEq(address(p.primary), address(d.quorumSource));
            assertEq(address(p.secondary), address(0));
            assertEq(p.maxAge, 120);
        }

        // too early, by one second
        _adv(1 hours - 1);
        vm.expectRevert(abi.encodeWithSelector(MarkRouter.TooEarly.selector, bytes32("BTC"), eta));
        r.applyRoute("BTC");

        // anyone applies once due
        _adv(1);
        vm.startPrank(address(0xBEEF));
        for (uint256 i; i < 3; ++i) {
            r.applyRoute(names[i]);
        }
        vm.stopPrank();

        // three signers vote; the mark reads through the router
        bytes32 key = d.board.markKey("BTC");
        vm.prank(S1);
        d.board.vote(key, 1, 100_000e18);
        vm.prank(S2);
        d.board.vote(key, 1, 100_010e18);
        vm.prank(S3);
        d.board.vote(key, 1, 99_990e18);
        assertEq(r.markWad("BTC"), 100_000e18, "median of the three votes");

        // stale after maxAge
        _adv(121);
        vm.expectRevert(abi.encodeWithSelector(MarkRouter.Stale.selector, bytes32("BTC"), address(d.quorumSource)));
        r.markWad("BTC");
    }

    function test_onlyAdminChangesConfigAfterDeploy() public {
        DeployM1.Deployed memory d = _deploy();
        MarkRouter.Route memory rt = d.router.route("BTC");
        vm.expectRevert();
        d.router.queueRoute("BTC", rt); // the deployer kept nothing
        vm.expectRevert();
        d.board.setQuorum(3);
        vm.prank(ADMIN);
        d.board.setQuorum(3);
        assertEq(d.board.quorum(), 3);
    }

    function test_badConfigRefused() public {
        DeployM1.Config memory c = _config();
        address self = address(script);

        c.signers = new address[](2);
        c.signers[0] = S1;
        c.signers[1] = S2;
        vm.expectRevert(abi.encodeWithSelector(DeployM1.BadConfig.selector, "signers"));
        script.deploy(c, self);

        c = _config();
        c.signers[2] = S1; // duplicate signer, refused by the board
        vm.expectRevert(abi.encodeWithSelector(QuorumBoard.BadSigner.selector, S1));
        script.deploy(c, self);

        c = _config();
        c.markets = new bytes32[](0);
        vm.expectRevert(abi.encodeWithSelector(DeployM1.BadConfig.selector, "markets"));
        script.deploy(c, self);

        c = _config();
        c.markets[2] = "BTC";
        vm.expectRevert(abi.encodeWithSelector(DeployM1.BadConfig.selector, "duplicate market"));
        script.deploy(c, self);

        c = _config();
        c.admin = self;
        vm.expectRevert(abi.encodeWithSelector(DeployM1.BadConfig.selector, "admin"));
        script.deploy(c, self);

        c = _config();
        c.signers[0] = ADMIN;
        vm.expectRevert(abi.encodeWithSelector(DeployM1.BadConfig.selector, "signer is admin or deployer"));
        script.deploy(c, self);
    }

    function test_runRefusesOtherChains() public {
        vm.chainId(999); // HyperEVM mainnet id, for example
        vm.expectRevert(abi.encodeWithSelector(DeployM1.WrongChain.selector, uint256(999)));
        script.run();
    }
}
