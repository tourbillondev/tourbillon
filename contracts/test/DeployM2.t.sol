// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployM1} from "../script/DeployM1.s.sol";
import {DeployM2} from "../script/DeployM2.s.sol";
import {QuorumBoard} from "../src/QuorumBoard.sol";
import {MarkRouter} from "../src/MarkRouter.sol";
import {PathFundingBook, IMarkRouter, IVolSource} from "../src/PathFundingBook.sol";
import {TempoBlend} from "../src/TempoBlend.sol";
import {EnginePricing} from "../src/EnginePricing.sol";

/// DeployM2 on top of a real M1 deployment (QuorumBoard, QuorumMarkSource, MarkRouter), then a full local trade:
/// signers vote, anyone pokes, a buyer buys and sells.
contract DeployM2Test is Test {
    address constant ADMIN = address(0xAD);
    address constant FEES = address(0xFEE5);
    address constant S1 = address(0x51);
    address constant S2 = address(0x52);
    address constant S3 = address(0x53);
    address constant BUYER = address(0xB0B);

    DeployM1 m1Script;
    DeployM2 m2Script;
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
        m2Script = new DeployM2();
    }

    function _config() internal view returns (DeployM2.Config memory c) {
        c.admin = ADMIN;
        c.feeRecipient = FEES;
        c.router = IMarkRouter(address(m1.router));
        c.board = IVolSource(address(m1.board));
    }

    function test_wiringSettingsAndRoles() public {
        DeployM2.Deployed memory d = m2Script.deploy(_config(), address(m2Script));
        // wiring
        assertEq(d.book.engine(), address(d.engine));
        assertEq(address(d.book.marks()), address(m1.router));
        assertEq(address(d.book.vols()), address(m1.board));
        assertEq(d.book.recorder(), address(0), "no bootstrap recorder: poke only");
        assertEq(address(d.engine.book()), address(d.book));
        assertEq(address(d.engine.counterparty()), address(d.pool));
        assertEq(address(d.engine.marks()), address(m1.router));
        assertEq(address(d.engine.vols()), address(m1.board));
        assertEq(address(d.engine.usdc()), address(d.usdc));
        assertEq(d.pool.engine(), address(d.engine));
        assertEq(d.pool.feeRecipient(), FEES);
        // settings
        (bool listed, uint16 spread, uint128 step) = d.engine.markets("BTC");
        assertTrue(listed);
        assertEq(spread, 200);
        assertEq(step, 100e18);
        (,, step) = d.engine.markets("ETH");
        assertEq(step, 5e18);
        (,, step) = d.engine.markets("HYPE");
        assertEq(step, 0.1e18);
        assertEq(d.pool.cap("BTC"), 2_000_000e6);
        assertEq(d.pool.cap("ETH"), 1_000_000e6);
        assertEq(d.pool.cap("HYPE"), 500_000e6);
        assertEq(d.usdc.balanceOf(address(d.pool)), 10_000_000e6);
        // roles: ADMIN holds everything, the deployer nothing
        bytes32 adminRole = d.engine.DEFAULT_ADMIN_ROLE();
        assertTrue(d.engine.hasRole(adminRole, ADMIN));
        assertTrue(d.engine.hasRole(d.engine.PAUSER_ROLE(), ADMIN));
        assertTrue(d.pool.hasRole(adminRole, ADMIN));
        assertFalse(d.engine.hasRole(adminRole, address(m2Script)));
        assertFalse(d.engine.hasRole(d.engine.PAUSER_ROLE(), address(m2Script)));
        assertTrue(d.engine.hasRole(d.engine.UNPAUSER_ROLE(), ADMIN));
        assertFalse(d.engine.hasRole(d.engine.UNPAUSER_ROLE(), address(m2Script)));
        assertFalse(d.pool.hasRole(adminRole, address(m2Script)));
    }

    function test_badConfigAndChainRefused() public {
        DeployM2.Config memory c = _config();
        c.admin = address(m2Script);
        vm.expectRevert(abi.encodeWithSelector(DeployM2.BadConfig.selector, "admin"));
        m2Script.deploy(c, address(m2Script));
        c = _config();
        c.router = IMarkRouter(address(0x1234));
        vm.expectRevert(abi.encodeWithSelector(DeployM2.BadConfig.selector, "M1 contracts"));
        m2Script.deploy(c, address(m2Script));
        vm.chainId(99801);
        vm.expectRevert(abi.encodeWithSelector(DeployM2.WrongChain.selector, uint256(99801)));
        m2Script.run();
    }

    /// The full local flow on the real M1 stack: routes applied after the 1 h delay, three signers vote BTC's mark
    /// and vol, anyone pokes a sample, a buyer buys and sells.
    function test_fullLocalTradeOnTheM1Stack() public {
        DeployM2.Deployed memory d = m2Script.deploy(_config(), address(m2Script));
        _set(nowT + 1 hours);
        m1.router.applyRoute("BTC");

        QuorumBoard b = m1.board;
        bytes32 mk = b.markKey("BTC");
        bytes32 vk = b.volKey("BTC");
        address[3] memory signers = [S1, S2, S3];
        uint256[3] memory marks = [uint256(73_900e18), 74_000e18, 74_100e18];
        for (uint256 i; i < 3; ++i) {
            vm.startPrank(signers[i]);
            b.vote(mk, 1, marks[i]);
            b.vote(vk, 1, 0.4323e18); // 43.23%
            vm.stopPrank();
        }
        assertEq(m1.router.markWad("BTC"), 74_000e18);
        assertEq(b.volBps("BTC"), 4323);

        // anyone pokes: the book reads the router and the board itself
        vm.prank(address(0xA11));
        d.book.poke("BTC");
        (uint256 t, uint256 s, uint256 sig) = d.book.latestSample("BTC");
        assertEq(t, nowT);
        assertEq(s, 74_000e18);
        assertEq(sig, 4323);

        d.usdc.mint(BUYER, 100_000e6);
        vm.startPrank(BUYER);
        d.usdc.approve(address(d.engine), type(uint256).max);
        (uint256 id, uint256 cost) =
            d.engine.buy("BTC", true, 74_000e18, TempoBlend.single(1 days), 0.1e18, type(uint256).max, nowT);
        uint256 v = EnginePricing.unitValue(true, 74_000e18, 74_000e18, 4323, TempoBlend.single(1 days));
        (uint256 premium, uint256 fee) = EnginePricing.buyQuote(v, 0.1e18, 74_000e18, 200);
        assertEq(cost, premium + fee);
        (uint256 paid, uint256 net) = d.engine.sell(id, type(uint256).max, 0, nowT);
        vm.stopPrank();
        assertEq(paid, 0.1e18);
        assertLt(net, cost);
        assertEq(d.usdc.balanceOf(BUYER), 100_000e6 - cost + net);
        (, uint256 sellFee) = EnginePricing.sellQuote(v, 0.1e18, 74_000e18, 200);
        assertEq(d.usdc.balanceOf(FEES), fee + sellFee, "the fee recipient holds the buy fee and the sell fee");
    }
}
