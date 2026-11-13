// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployM1} from "../script/DeployM1.s.sol";
import {DeployM3} from "../script/DeployM3.s.sol";
import {QuorumBoard} from "../src/QuorumBoard.sol";
import {MainspringPool} from "../src/MainspringPool.sol";
import {PathFundingBook, IMarkRouter, IVolSource} from "../src/PathFundingBook.sol";
import {TempoBlend} from "../src/TempoBlend.sol";
import {EnginePricing} from "../src/EnginePricing.sol";

/// DeployM3 on top of a real M1 deployment, then a full local flow: EQUITY feed listed by the board admin, signers
/// vote marks, vols and EQUITY, anyone pokes, an LP funds the pool through a round, a trader buys and sells.
contract DeployM3Test is Test {
    address constant ADMIN = address(0xAD);
    address constant RISK = address(0x815C);
    address constant PROTO = address(0x9907);
    address constant S1 = address(0x51);
    address constant S2 = address(0x52);
    address constant S3 = address(0x53);
    address constant LP = address(0x1B);
    address constant TRADER = address(0x7A);

    DeployM1 m1Script;
    DeployM3 m3Script;
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
        m3Script = new DeployM3();
    }

    function _config() internal view returns (DeployM3.Config memory c) {
        c.admin = ADMIN;
        c.riskPauser = RISK;
        c.protocolRecipient = PROTO;
        c.router = IMarkRouter(address(m1.router));
        c.board = IVolSource(address(m1.board));
    }

    function test_wiringSettingsAndRoles() public {
        DeployM3.Deployed memory d = m3Script.deploy(_config(), address(m3Script));
        assertEq(d.book.engine(), address(d.engine));
        assertEq(d.book.recorder(), address(0), "poke only");
        assertEq(address(d.book.marks()), address(m1.router));
        assertEq(address(d.book.vols()), address(m1.board));
        assertEq(address(d.engine.counterparty()), address(d.pool), "MainspringPool replaces HousePool");
        assertEq(address(d.engine.book()), address(d.book));
        assertEq(d.pool.engine(), address(d.engine));
        assertEq(address(d.pool.equityFeed()), address(m1.board));
        assertEq(address(d.pool.asset()), address(d.usdc));
        assertEq(d.pool.protocolRecipient(), PROTO);
        assertEq(d.pool.notionalCap("BTC"), 5_000_000e6);
        assertEq(d.pool.notionalCap("ETH"), 3_000_000e6);
        assertEq(d.pool.notionalCap("HYPE"), 1_000_000e6);
        assertEq(d.pool.directionalCap("BTC"), 1_000_000e6);
        assertEq(d.pool.directionalCap("ETH"), 600_000e6);
        assertEq(d.pool.directionalCap("HYPE"), 250_000e6);
        assertEq(d.pool.hedgerDeltaCap("BTC"), 2_500_000e6);
        assertEq(d.pool.hedgerDeltaCap("ETH"), 1_200_000e6);
        assertEq(d.pool.hedgerDeltaCap("HYPE"), 357_143e6);
        // the rule directionalCap ≤ hedgerDeltaCap × 2 × shock holds for every deployed market (the pool refuses
        // otherwise, so a deploy with a cap the hedger cannot carry reverts)
        assertEq(d.pool.maxDirectionalCap("BTC"), 1_000_000e6);
        assertEq(d.pool.maxDirectionalCap("ETH"), 600_000e6);
        assertEq(d.pool.maxDirectionalCap("HYPE"), 250_000_100000);
        (bool listed, uint16 spread, uint128 step) = d.engine.markets("HYPE");
        assertTrue(listed);
        assertEq(spread, 200);
        assertEq(step, 0.1e18);
        assertEq(d.usdc.balanceOf(address(d.pool)), 0, "no funding: LPs fund the pool");
        bytes32 admin = d.pool.DEFAULT_ADMIN_ROLE();
        assertTrue(d.pool.hasRole(admin, ADMIN));
        assertTrue(d.engine.hasRole(admin, ADMIN));
        assertTrue(d.engine.hasRole(d.engine.PAUSER_ROLE(), ADMIN));
        assertTrue(d.pool.hasRole(d.pool.RISK_PAUSER_ROLE(), RISK));
        assertFalse(d.pool.hasRole(admin, address(m3Script)));
        assertFalse(d.engine.hasRole(admin, address(m3Script)));
        assertFalse(d.pool.hasRole(admin, RISK), "the risk key is pause-only");
        // M7 step 3: the new pause roles are the admin's for now; the deployer keeps none of them
        bytes32[3] memory poolRoles = [d.pool.PAUSER_ROLE(), d.pool.UNPAUSER_ROLE(), d.pool.RISK_PAUSER_ROLE()];
        for (uint256 i; i < 2; ++i) {
            assertTrue(d.pool.hasRole(poolRoles[i], ADMIN));
        }
        for (uint256 i; i < 3; ++i) {
            assertFalse(d.pool.hasRole(poolRoles[i], address(m3Script)));
        }
        assertTrue(d.engine.hasRole(d.engine.UNPAUSER_ROLE(), ADMIN));
        assertFalse(d.engine.hasRole(d.engine.UNPAUSER_ROLE(), address(m3Script)));
        assertFalse(d.pool.hasRole(d.pool.PAUSER_ROLE(), RISK), "the risk key cannot pause deposits");
    }

    function test_badConfigAndChainRefused() public {
        DeployM3.Config memory c = _config();
        c.admin = address(m3Script);
        vm.expectRevert(abi.encodeWithSelector(DeployM3.BadConfig.selector, "admin"));
        m3Script.deploy(c, address(m3Script));
        c = _config();
        c.riskPauser = address(0);
        vm.expectRevert(abi.encodeWithSelector(DeployM3.BadConfig.selector, "risk pauser"));
        m3Script.deploy(c, address(m3Script));
        c = _config();
        c.router = IMarkRouter(address(0x1234));
        vm.expectRevert(abi.encodeWithSelector(DeployM3.BadConfig.selector, "M1 contracts"));
        m3Script.deploy(c, address(m3Script));
        vm.chainId(99801);
        vm.expectRevert(abi.encodeWithSelector(DeployM3.WrongChain.selector, uint256(99801)));
        m3Script.run();
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

    function test_fullLocalFlowOnTheM1Stack() public {
        DeployM3.Deployed memory d = m3Script.deploy(_config(), address(m3Script));
        QuorumBoard b = m1.board;
        bytes32 eqKey = d.pool.equityKey();
        vm.prank(ADMIN);
        b.setFeed(eqKey, 5000, 2 hours); // what ListEquityFeed does
        _set(nowT + 1 hours);
        m1.router.applyRoute("BTC");
        m1.router.applyRoute("ETH");
        m1.router.applyRoute("HYPE");

        // signers: marks and vols for every market, EQUITY twice (P&L 0)
        bytes32[3] memory ms = [bytes32("BTC"), "ETH", "HYPE"];
        uint256[3] memory px = [uint256(74_000e18), 2_000e18, 70e18];
        for (uint256 i; i < 3; ++i) {
            _voteAll(b, b.markKey(ms[i]), px[i]);
            _voteAll(b, b.volKey(ms[i]), 0.45e18);
        }
        _voteAll(b, eqKey, d.pool.EQUITY_OFFSET());
        d.book.poke("BTC");
        d.book.poke("ETH");
        d.book.poke("HYPE");

        // an LP funds the pool through a round
        d.usdc.mint(LP, 2_000_000e6);
        vm.startPrank(LP);
        d.usdc.approve(address(d.pool), type(uint256).max);
        d.pool.deposit(2_000_000e6);
        vm.stopPrank();
        d.pool.startEpoch();
        while (!d.pool.markChunk(100)) {}
        d.pool.settle();
        vm.prank(LP);
        d.pool.claimShares(0);
        assertEq(d.pool.balanceOf(LP), 2_000_000e18);

        // a trader buys and sells; the protocol receives 10% of each fee
        d.usdc.mint(TRADER, 100_000e6);
        vm.startPrank(TRADER);
        d.usdc.approve(address(d.engine), type(uint256).max);
        (uint256 id, uint256 cost) =
            d.engine.buy("BTC", true, 74_000e18, TempoBlend.single(1 days), 0.5e18, type(uint256).max, nowT);
        uint256 v = EnginePricing.unitValue(true, 74_000e18, 74_000e18, 4500, TempoBlend.single(1 days));
        (uint256 premium, uint256 fee) = EnginePricing.buyQuote(v, 0.5e18, 74_000e18, 200);
        assertEq(cost, premium + fee);
        (, uint256 net) = d.engine.sell(id, type(uint256).max, 0, nowT);
        vm.stopPrank();
        (uint256 gross, uint256 sellFee) = EnginePricing.sellQuote(v, 0.5e18, 74_000e18, 200);
        assertEq(net, gross - sellFee);
        assertEq(d.usdc.balanceOf(PROTO), fee / 10 + sellFee / 10);
        assertEq(d.usdc.balanceOf(address(d.engine)), 0);
        assertEq(d.pool.openNotional("BTC"), 0, "the notional is released");

        // EQUITY: a second final makes the equity term ready (P&L 0, nothing sent: 0)
        _set(nowT + 1 hours);
        _voteAll(b, eqKey, d.pool.EQUITY_OFFSET());
        assertTrue(d.pool.equityReady());
        assertEq(d.pool.equityTerm(), 0);
    }
}
