// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployM1} from "../script/DeployM1.s.sol";
import {DeployM3} from "../script/DeployM3.s.sol";
import {DeployM6} from "../script/DeployM6.s.sol";
import {VolQuote} from "../src/VolQuote.sol";
import {QuorumBoard} from "../src/QuorumBoard.sol";
import {IMarkRouter, IVolSource} from "../src/PathFundingBook.sol";
import {TempoBlend} from "../src/TempoBlend.sol";
import {StrategyMath} from "../src/StrategyMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// DeployM6 on top of a real M1 deployment: the M4 system plus the six open-book contracts, wired before the roles are
/// handed over; then a local flow: a maker's quote fills a routed buy, the buyer sells and the maker is bought back,
/// and the pool's own carried risk can be auctioned.
contract DeployM6Test is Test {
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
    DeployM6 m6Script;
    uint256 constant MAKER_PK = 0xA11CE; // a test-only key
    address maker;
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
        m6Script = new DeployM6();
        maker = vm.addr(MAKER_PK);
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

    function _caps() internal pure returns (DeployM6.Caps6 memory caps) {
        (caps.btc, caps.eth, caps.hype) = (5_000_000e6, 3_000_000e6, 1_000_000e6);
    }

    function test_wiringAndRoles() public {
        DeployM6.Deployed6 memory d6 = m6Script.deploy6(_config(), _caps(), address(m6Script));
        DeployM3.Deployed memory d = d6.m4.m3;
        address ob = address(d6.openBook);
        assertEq(d.engine.openBook(), ob);
        assertEq(d6.matchBook.router(), ob);
        assertEq(d6.matchBook.pool(), address(d.pool));
        assertEq(d6.vault.matchBook(), address(d6.matchBook));
        assertEq(d6.vault.auction(), address(d6.auction));
        assertEq(d.pool.matchBook(), address(d6.matchBook));
        assertEq(d.pool.auction(), address(d6.auction));
        assertEq(d6.quoteBook.filler(), ob);
        assertEq(d6.volFeed.recorder(), ob);
        assertEq(address(d6.openBook.volFeed()), address(d6.volFeed));
        assertEq(d6.openBook.auction(), address(d6.auction));
        assertEq(address(d6.vault.usdc()), address(d.usdc));
        assertEq(address(d6.vault.whype()), address(d6.m4.whype));
        assertEq(d.pool.openBookCap("BTC"), 5_000_000e6);
        assertEq(d.pool.openBookCap("HYPE"), 1_000_000e6);
        // the M4 wiring is still there
        assertEq(d.book.writer(), address(d6.m4.writerBook));
        assertEq(d.pool.writerBook(), address(d6.m4.writerBook));
        // the deployer keeps no role; every one-time setter is spent
        bytes32 admin = d.pool.DEFAULT_ADMIN_ROLE();
        assertFalse(d.pool.hasRole(admin, address(m6Script)));
        assertFalse(d.engine.hasRole(admin, address(m6Script)));
        assertTrue(d.pool.hasRole(admin, ADMIN));
        assertTrue(d.engine.hasRole(admin, ADMIN));
        vm.startPrank(address(m6Script));
        vm.expectRevert();
        d6.matchBook.setRouter(address(0x1234));
        vm.expectRevert();
        d6.vault.setAuction(address(0x1234));
        vm.expectRevert();
        d6.volFeed.setRecorder(address(0x1234));
        vm.stopPrank();
        vm.startPrank(ADMIN);
        vm.expectRevert();
        d.engine.setOpenBook(address(0x1234));
        vm.expectRevert();
        d.pool.setMatchBook(address(0x1234));
        vm.expectRevert();
        d.pool.setAuction(address(0x1234));
        vm.expectRevert();
        d6.openBook.setAuction(address(0x1234));
        vm.expectRevert();
        d6.openBook.setVolFeed(d6.volFeed);
        vm.stopPrank();
    }

    function _live(DeployM3.Deployed memory d) internal {
        QuorumBoard b = m1.board;
        bytes32 eqKey = d.pool.equityKey();
        vm.prank(ADMIN);
        b.setFeed(eqKey, 5000, 2 hours);
        _set(nowT + 1 hours);
        bytes32[3] memory ms = [bytes32("BTC"), "ETH", "HYPE"];
        uint256[3] memory px = [uint256(74_000e18), 2_000e18, 70e18];
        for (uint256 i; i < 3; ++i) {
            m1.router.applyRoute(ms[i]);
            _voteAll(b, b.markKey(ms[i]), px[i]);
            _voteAll(b, b.volKey(ms[i]), 0.45e18);
        }
        d.book.poke("BTC");
        d.usdc.mint(LP, 2_000_000e6);
        vm.startPrank(LP);
        d.usdc.approve(address(d.pool), type(uint256).max);
        d.pool.deposit(2_000_000e6);
        vm.stopPrank();
        d.pool.startEpoch();
        while (!d.pool.markChunk(100)) {}
        d.pool.settle();
    }

    function _spread() internal pure returns (StrategyMath.Leg[] memory l) {
        l = new StrategyMath.Leg[](2);
        l[0] = StrategyMath.Leg(true, 74_000e18, 1e18);
        l[1] = StrategyMath.Leg(true, 76_000e18, -1e18);
    }

    function test_localFlowMakerFillBuybackAndAnAuctionLot() public {
        DeployM6.Deployed6 memory d6 = m6Script.deploy6(_config(), _caps(), address(m6Script));
        DeployM3.Deployed memory d = d6.m4.m3;
        _live(d);

        // a maker funds its vault and quotes BTC calls at 40% (the board is at 45%)
        d.usdc.mint(maker, 100_000e6);
        vm.startPrank(maker);
        d.usdc.approve(address(d6.vault), type(uint256).max);
        d6.vault.deposit(IERC20(address(d.usdc)), 100_000e6);
        vm.stopPrank();
        VolQuote.Quote memory q = VolQuote.Quote(
            maker,
            "BTC",
            VolQuote.SIDE_CALLS,
            60_000e18,
            90_000e18,
            1 hours,
            30 days,
            4000,
            100e18,
            uint64(nowT + 1 hours),
            1
        );
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(MAKER_PK, d6.quoteBook.hashQuote(q));
        VolQuote.Quote[] memory qs = new VolQuote.Quote[](1);
        qs[0] = q;
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = abi.encodePacked(r, s_, v);

        d.usdc.mint(TRADER, 100_000e6);
        vm.startPrank(TRADER);
        d.usdc.approve(address(d.engine), type(uint256).max);
        (uint256 id,, uint8 kind) = d6.openBook
            .buy("BTC", _spread(), TempoBlend.single(1 days), 2e18, type(uint256).max, nowT, qs, sigs, new uint256[](0));
        vm.stopPrank();
        assertEq(kind, d6.openBook.KIND_QUOTE(), "the maker is cheaper than the pool");
        assertGt(d6.vault.lockedOf(maker, IERC20(address(d.usdc))), 0, "exact collateral locked");
        assertEq(d.pool.matchedRawOf(id), d6.matchBook.matchedRaw(id), "the pool mirrors the MatchBook");
        (,,, uint256 count,) = d6.volFeed.read("BTC", 1);
        assertEq(count, 1, "the fill is in the vol feed");

        // the buyer sells: the maker is bought back in the same transaction
        vm.prank(TRADER);
        d.engine.sell(id, type(uint256).max, 0, nowT);
        assertEq(d6.matchBook.matchedRaw(id), 0);
        assertEq(d.pool.matchedRawOf(id), 0);

        // the pool's own carried risk can be auctioned
        vm.prank(TRADER);
        d6.openBook
            .buy(
                "BTC",
                _spread(),
                TempoBlend.single(7 days),
                5e18,
                type(uint256).max,
                nowT,
                new VolQuote.Quote[](0),
                new bytes[](0),
                new uint256[](0)
            );
        uint256 lotId = d6.auction.start("BTC");
        assertGt(d6.auction.lot(lotId).raw, 0);
        assertGt(d6.auction.lot(lotId).bond, 0);
        assertEq(d.usdc.balanceOf(address(d.engine)), 0);
    }
}
