// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployM1} from "../script/DeployM1.s.sol";
import {DeployM3} from "../script/DeployM3.s.sol";
import {DeployM4} from "../script/DeployM4.s.sol";
import {QuorumBoard} from "../src/QuorumBoard.sol";
import {IMarkRouter, IVolSource} from "../src/PathFundingBook.sol";
import {TempoBlend} from "../src/TempoBlend.sol";
import {StrategyMath} from "../src/StrategyMath.sol";

/// DeployM4 on top of a real M1 deployment: the M3 system plus the WriterBook and mock WHYPE, wired before the roles
/// are handed over; then a local flow with a shape buy, a covered HYPE write and its unwrite.
contract DeployM4Test is Test {
    address constant ADMIN = address(0xAD);
    address constant RISK = address(0x815C);
    address constant PROTO = address(0x9907);
    address constant S1 = address(0x51);
    address constant S2 = address(0x52);
    address constant S3 = address(0x53);
    address constant LP = address(0x1B);
    address constant TRADER = address(0x7A);
    address constant WRITER = address(0x3317);

    DeployM1 m1Script;
    DeployM4 m4Script;
    DeployM1.Deployed m1;
    uint256 nowT;

    function _set(uint256 t) internal {
        nowT = t;
        vm.warp(t);
    }

    function setUp() public {
        _set(1_794_182_400);
        m1Script = new DeployM1();
        DeployM1.Config memory c1;
        c1.admin = ADMIN;
        c1.signers = new address[](3);
        (c1.signers[0], c1.signers[1], c1.signers[2]) = (S1, S2, S3);
        c1.markets = new bytes32[](3);
        (c1.markets[0], c1.markets[1], c1.markets[2]) = (bytes32("BTC"), bytes32("ETH"), bytes32("HYPE"));
        m1 = m1Script.deploy(c1, address(m1Script));
        m4Script = new DeployM4();
    }

    function _config() internal view returns (DeployM3.Config memory c) {
        c.admin = ADMIN;
        c.riskPauser = RISK;
        c.protocolRecipient = PROTO;
        c.router = IMarkRouter(address(m1.router));
        c.board = IVolSource(address(m1.board));
    }

    function _voteAll(QuorumBoard b, bytes32 key, uint256 value) internal {
        uint80 r = 1;
        try b.latestRoundData(key) returns (uint80 id, int256, uint256, uint256, uint80) {
            r = id + 1;
        } catch {}
        address[3] memory s = [S1, S2, S3];
        for (uint256 i; i < 3; ++i) {
            vm.prank(s[i]);
            b.vote(key, r, value);
        }
    }

    function test_wiringAndRoles() public {
        DeployM4.Deployed4 memory d4 = m4Script.deploy4(_config(), address(m4Script));
        DeployM3.Deployed memory d = d4.m3;
        assertEq(d.book.writer(), address(d4.writerBook), "the WriterBook may open shape series");
        assertEq(d.pool.writerBook(), address(d4.writerBook));
        assertEq(address(d.pool.whype()), address(d4.whype));
        assertEq(d.pool.whypeMarket(), bytes32("HYPE"));
        assertEq(address(d4.writerBook.book()), address(d.book));
        assertEq(address(d4.writerBook.engine()), address(d.engine));
        assertEq(address(d4.writerBook.pool()), address(d.pool));
        assertEq(address(d4.writerBook.marks()), address(m1.router));
        assertEq(address(d4.writerBook.vols()), address(m1.board));
        assertEq(address(d4.writerBook.usdc()), address(d.usdc));
        assertEq(address(d4.writerBook.whype()), address(d4.whype));
        // the M3 settings are all there
        assertEq(d.pool.directionalCap("HYPE"), 250_000e6);
        assertEq(d.pool.hedgerDeltaCap("HYPE"), 357_143e6);
        // the deployer keeps nothing; the admin holds both systems; the risk key is pause-only
        bytes32 admin = d.pool.DEFAULT_ADMIN_ROLE();
        assertFalse(d.pool.hasRole(admin, address(m4Script)));
        assertFalse(d.engine.hasRole(admin, address(m4Script)));
        assertTrue(d.pool.hasRole(admin, ADMIN));
        assertTrue(d.engine.hasRole(admin, ADMIN));
        assertTrue(d.pool.hasRole(d.pool.RISK_PAUSER_ROLE(), RISK));
        assertFalse(d.pool.hasRole(admin, RISK));
        // each one-time setter is spent
        vm.startPrank(ADMIN);
        vm.expectRevert();
        d.engine.setWriterBook(address(0x1234));
        vm.expectRevert();
        d.pool.setWriterBook(address(0x1234));
        vm.expectRevert();
        d.pool.setWhype(d4.whype, "HYPE");
        vm.stopPrank();
    }

    function test_localFlowWithAShapeAndACoveredWrite() public {
        DeployM4.Deployed4 memory d4 = m4Script.deploy4(_config(), address(m4Script));
        DeployM3.Deployed memory d = d4.m3;
        QuorumBoard b = m1.board;
        bytes32 eqKey = d.pool.equityKey(); // read first: a call inside the arguments would use up the prank
        vm.prank(ADMIN);
        b.setFeed(eqKey, 5000, 2 hours);
        _set(nowT + 1 hours);
        m1.router.applyRoute("BTC");
        m1.router.applyRoute("ETH");
        m1.router.applyRoute("HYPE");
        bytes32[3] memory ms = [bytes32("BTC"), "ETH", "HYPE"];
        uint256[3] memory px = [uint256(74_000e18), 2_000e18, 70e18];
        for (uint256 i; i < 3; ++i) {
            _voteAll(b, b.markKey(ms[i]), px[i]);
            _voteAll(b, b.volKey(ms[i]), 0.45e18);
        }
        d.book.poke("BTC");
        d.book.poke("HYPE");

        // an LP funds the pool
        d.usdc.mint(LP, 2_000_000e6);
        vm.startPrank(LP);
        d.usdc.approve(address(d.pool), type(uint256).max);
        d.pool.deposit(2_000_000e6);
        vm.stopPrank();
        d.pool.startEpoch();
        while (!d.pool.markChunk(100)) {}
        d.pool.settle();

        // a trader buys a call spread and sells it
        StrategyMath.Leg[] memory spread = new StrategyMath.Leg[](2);
        spread[0] = StrategyMath.Leg(true, 74_000e18, 1e18);
        spread[1] = StrategyMath.Leg(true, 76_000e18, -1e18);
        d.usdc.mint(TRADER, 100_000e6);
        vm.startPrank(TRADER);
        d.usdc.approve(address(d.engine), type(uint256).max);
        (uint256 id,) = d.engine.buyShape("BTC", spread, TempoBlend.single(1 days), 2e18, type(uint256).max, nowT);
        (, uint256 net) = d.engine.sell(id, type(uint256).max, 0, nowT);
        vm.stopPrank();
        assertGt(net, 0);

        // a covered HYPE Rise written against WHYPE, then unwritten
        StrategyMath.Leg[] memory rise = new StrategyMath.Leg[](1);
        rise[0] = StrategyMath.Leg(true, 80e18, -1e18);
        d4.whype.mint(WRITER, 100e18);
        d.usdc.mint(WRITER, 1_000e6);
        vm.startPrank(WRITER);
        d4.whype.approve(address(d4.writerBook), type(uint256).max);
        d.usdc.approve(address(d4.writerBook), type(uint256).max);
        (uint256 wid,) =
            d4.writerBook.write("HYPE", rise, TempoBlend.single(7 days), 10e18, true, type(int256).min, nowT);
        assertEq(d4.whype.balanceOf(address(d4.writerBook)), 10e18, "exactly the covered calls");
        d4.writerBook.unwrite(wid, type(uint256).max, type(int256).max, nowT);
        vm.stopPrank();
        assertEq(d4.whype.balanceOf(address(d4.writerBook)), 0);
        assertEq(d4.writerBook.totalUsdcLocked(), 0);
        assertEq(d.usdc.balanceOf(address(d.engine)), 0);
    }
}
