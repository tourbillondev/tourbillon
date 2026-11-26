// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {DeployM1} from "../script/DeployM1.s.sol";
import {DeployM3} from "../script/DeployM3.s.sol";
import {DeployM4} from "../script/DeployM4.s.sol";
import {QuorumBoard} from "../src/QuorumBoard.sol";
import {IMarkRouter, IVolSource} from "../src/PathFundingBook.sol";
import {TempoBlend} from "../src/TempoBlend.sol";
import {StrategyMath} from "../src/StrategyMath.sol";

/// DeployM4 on top of a real M1 deployment: the M3 system plus the WriterBook and mock STK1 stock, wired before the roles
/// are handed over; then a local flow with a shape buy, a covered STK1 write and its unwrite.
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
        (c1.markets[0], c1.markets[1], c1.markets[2]) = (bytes32("BTC"), bytes32("ETH"), bytes32("STK1"));
        c1.calendar = m1Script.loadCalendar(m1Script.CALENDAR_FILE());
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
        assertEq(address(d.pool.coverAssets()), address(d4.covers));
        (IERC20 cov, uint256 scale) = d4.covers.coverOf("STK1");
        assertEq(address(cov), address(d4.stock), "STK1's covering token is listed");
        assertEq(scale, 1, "18 decimals: no scaling");
        (cov,) = d4.covers.coverOf("BTC");
        assertEq(address(cov), address(0), "crypto has no covering asset");
        assertEq(address(d4.writerBook.book()), address(d.book));
        assertEq(address(d4.writerBook.engine()), address(d.engine));
        assertEq(address(d4.writerBook.pool()), address(d.pool));
        assertEq(address(d4.writerBook.marks()), address(m1.router));
        assertEq(address(d4.writerBook.vols()), address(m1.board));
        assertEq(address(d4.writerBook.settlement()), address(d.settlement));
        assertEq(address(d4.writerBook.covers()), address(d4.covers));
        assertEq(address(d.settlementAdapter.token()), address(d.settlement));
        assertTrue(d.settlementAdapter.supportsPermit(), "the mock settlement token has permit");
        assertEq(d.settlementAdapter.symbol(), "USDG", "USDG by default (owner D1)");
        assertEq(d.settlement.decimals(), 6);
        // the M3 settings are all there
        assertEq(d.pool.directionalCap("STK1"), 250_000e6);
        assertEq(d.pool.hedgerDeltaCap("STK1"), 625_000e6);
        // the deployer keeps nothing; the admin holds both systems; the risk key is pause-only
        bytes32 admin = d.pool.DEFAULT_ADMIN_ROLE();
        assertFalse(d.pool.hasRole(admin, address(m4Script)));
        assertFalse(d.engine.hasRole(admin, address(m4Script)));
        assertTrue(d.pool.hasRole(admin, ADMIN));
        assertTrue(d.engine.hasRole(admin, ADMIN));
        assertTrue(d.pool.hasRole(d.pool.RISK_PAUSER_ROLE(), RISK));
        assertFalse(d.pool.hasRole(admin, RISK));
        assertTrue(d4.covers.hasRole(admin, ADMIN), "covering-asset listings belong to the admin");
        assertFalse(d4.covers.hasRole(admin, address(m4Script)));
        // each one-time setter is spent
        vm.startPrank(ADMIN);
        vm.expectRevert();
        d.engine.setWriterBook(address(0x1234));
        vm.expectRevert();
        d.pool.setWriterBook(address(0x1234));
        vm.expectRevert();
        d.pool.setCoverAssets(d4.covers);
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
        m1.router.applyRoute("STK1");
        bytes32[3] memory ms = [bytes32("BTC"), "ETH", "STK1"];
        uint256[3] memory px = [uint256(74_000e18), 2_000e18, 70e18];
        for (uint256 i; i < 3; ++i) {
            _voteAll(b, b.markKey(ms[i]), px[i]);
            _voteAll(b, b.volKey(ms[i]), 0.45e18);
        }
        d.book.poke("BTC");
        d.book.poke("STK1");

        // an LP deposits into the pool
        d.settlement.mint(LP, 2_000_000e6);
        vm.startPrank(LP);
        d.settlement.approve(address(d.pool), type(uint256).max);
        d.pool.deposit(2_000_000e6);
        vm.stopPrank();
        d.pool.startEpoch();
        while (!d.pool.markChunk(100)) {}
        d.pool.settle();

        // a trader buys a call spread and sells it
        StrategyMath.Leg[] memory spread = new StrategyMath.Leg[](2);
        spread[0] = StrategyMath.Leg(true, 74_000e18, 1e18);
        spread[1] = StrategyMath.Leg(true, 76_000e18, -1e18);
        d.settlement.mint(TRADER, 100_000e6);
        vm.startPrank(TRADER);
        d.settlement.approve(address(d.engine), type(uint256).max);
        (uint256 id,) = d.engine.buyShape("BTC", spread, TempoBlend.single(1 days), 2e18, type(uint256).max, nowT);
        (, uint256 net) = d.engine.sell(id, type(uint256).max, 0, nowT);
        vm.stopPrank();
        assertGt(net, 0);

        // a covered STK1 Rise written against STK1 stock, then unwritten
        StrategyMath.Leg[] memory rise = new StrategyMath.Leg[](1);
        rise[0] = StrategyMath.Leg(true, 80e18, -1e18);
        d4.stock.mint(WRITER, 100e18);
        d.settlement.mint(WRITER, 1_000e6);
        vm.startPrank(WRITER);
        d4.stock.approve(address(d4.writerBook), type(uint256).max);
        d.settlement.approve(address(d4.writerBook), type(uint256).max);
        (uint256 wid,) =
            d4.writerBook.write("STK1", rise, TempoBlend.single(7 days), 10e18, true, type(int256).min, nowT);
        assertEq(d4.stock.balanceOf(address(d4.writerBook)), 10e18, "exactly the covered calls");
        d4.writerBook.unwrite(wid, type(uint256).max, type(int256).max, nowT);
        vm.stopPrank();
        assertEq(d4.stock.balanceOf(address(d4.writerBook)), 0);
        assertEq(d4.writerBook.totalSettlementLocked(), 0);
        assertEq(d.settlement.balanceOf(address(d.engine)), 0);
    }
}
