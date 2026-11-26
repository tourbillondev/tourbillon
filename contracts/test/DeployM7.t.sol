// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HedgeKeeperGate} from "../src/HedgeKeeperGate.sol";
import {MockPoolManagerV4} from "./mocks/MockPoolManagerV4.sol";
import {SettlementAdapter} from "../src/SettlementAdapter.sol";
import {MockSettlementToken} from "./mocks/MockSettlementToken.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {DeployM3} from "../script/DeployM3.s.sol";
import {DeployM6} from "../script/DeployM6.s.sol";
import {DeployM7} from "../script/DeployM7.s.sol";
import {QuorumBoard} from "../src/QuorumBoard.sol";
import {MarkRouter} from "../src/MarkRouter.sol";
import {IMarkSource} from "../src/IMarkSource.sol";
import {MainspringPool} from "../src/MainspringPool.sol";
import {Engine} from "../src/Engine.sol";
import {VolQuote} from "../src/VolQuote.sol";
import {TempoBlend} from "../src/TempoBlend.sol";
import {StrategyMath} from "../src/StrategyMath.sol";
import {Governance} from "../src/governance/Governance.sol";
import {Safe, SafeHelpers} from "./governance/SafeHelpers.sol";

/// M7 step 4: DeployM7 and the full handover. The law-6 role sweep rebuilds every role holder from the deploy's own
/// RoleGranted / RoleRevoked events and compares it with the role map exactly; then every kind of action is tried
/// through the path the role map gives it (timelock, guardian, Safe directly) and refused on every other path.
contract DeployM7Test is SafeHelpers {
    address constant RISK = address(0x815C);
    address constant POSTER = address(0x9057);
    address constant PROTO = address(0x9907);
    address constant S1 = address(0x51);
    address constant S2 = address(0x52);
    address constant S3 = address(0x53);
    address constant LP = address(0x1B);
    address constant TRADER = address(0x7A);
    address constant TREASURY = address(0x7EA5);
    address constant ANYONE = address(0xA11);
    bytes32 constant ROLE_GRANTED = keccak256("RoleGranted(bytes32,address,address)");
    bytes32 constant ROLE_REVOKED = keccak256("RoleRevoked(bytes32,address,address)");

    DeployM7 m7;
    DeployM7.Deployed7 d7;
    Vm.Log[] deployLogs;
    uint256[5] safePks; // test-only keys
    uint256[3] guardianPks;
    uint256 nowT;
    mapping(address => mapping(bytes32 => address[])) holders;

    function _set(uint256 t) internal {
        nowT = t;
        vm.warp(t);
    }

    function _config() internal view returns (DeployM7.Config7 memory c) {
        c.safeOwners = new address[](5);
        for (uint256 i; i < 5; ++i) {
            c.safeOwners[i] = vm.addr(safePks[i]);
        }
        c.guardianOwners = new address[](3);
        for (uint256 i; i < 3; ++i) {
            c.guardianOwners[i] = vm.addr(guardianPks[i]);
        }
        c.riskPauser = RISK;
        c.receiptsPoster = POSTER;
        c.protocolRecipient = PROTO;
        c.signers = new address[](3);
        (c.signers[0], c.signers[1], c.signers[2]) = (S1, S2, S3);
        c.delay = Governance.TESTNET_DELAY;
        (c.caps.btc, c.caps.eth, c.caps.stk1) = (5_000_000e6, 3_000_000e6, 1_000_000e6);
        c.stockMarkets = m7.stockMarkets7(); // STK1, bound to the session rule (the production shape)
    }

    function setUp() public {
        vm.chainId(31337);
        // Tuesday 2026-11-10 15:00 UTC = 10:00 New York, in the regular session: STK1 is a stock market bound to the
        // session rule (RH4), so its first mark needs the session (law 2)
        _set(1_794_182_400 + 39 hours);
        for (uint256 i; i < 5; ++i) {
            safePks[i] = 0xA000 + i;
        }
        for (uint256 i; i < 3; ++i) {
            guardianPks[i] = 0xB000 + i;
        }
        m7 = new DeployM7();
        DeployM7.Config7 memory c = _config();
        vm.recordLogs();
        DeployM7.Deployed7 memory d = m7.deploy7(c, address(m7));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            deployLogs.push(logs[i]);
        }
        d7 = d;
    }

    // ---------------------------------------------------------------- helpers

    function _safe() internal view returns (Safe) {
        return Safe(payable(d7.gov.safe));
    }

    function _guardian() internal view returns (Safe) {
        return Safe(payable(d7.gov.guardian));
    }

    function _keys(uint256 n, bool guardian) internal view returns (uint256[] memory k) {
        k = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            k[i] = guardian ? guardianPks[i] : safePks[i];
        }
    }

    function _pool() internal view returns (MainspringPool) {
        return d7.m6.m4.m3.pool;
    }

    function _engine() internal view returns (Engine) {
        return d7.m6.m4.m3.engine;
    }

    function _schedule(address target, bytes memory call, bytes32 salt) internal {
        TimelockController tl = d7.gov.timelock;
        bytes memory s =
            abi.encodeCall(TimelockController.schedule, (target, 0, call, bytes32(0), salt, tl.getMinDelay()));
        assertTrue(_exec(_safe(), _keys(3, false), address(tl), s));
    }

    function _contains(address[] storage xs, address a) internal view returns (bool) {
        for (uint256 i; i < xs.length; ++i) {
            if (xs[i] == a) return true;
        }
        return false;
    }

    /// The holders of `role` on `c`, rebuilt from the deploy's events, must be exactly `want`.
    function _exactly(address c, bytes32 role, address[] memory want, string memory what) internal view {
        address[] storage got = holders[c][role];
        assertEq(got.length, want.length, what);
        for (uint256 i; i < want.length; ++i) {
            assertTrue(_contains(got, want[i]), what);
        }
    }

    function _one(address a) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }

    function _two(address a, address b) internal pure returns (address[] memory r) {
        r = new address[](2);
        (r[0], r[1]) = (a, b);
    }

    // ---------------------------------------------------------------- 1. the law-6 role sweep

    function test_law6RoleSweepFromEveryGrantAndRevoke() public {
        address board = address(d7.m1.board);
        address router = address(d7.m1.router);
        address engine = address(_engine());
        address pool = address(_pool());
        address tl = address(d7.gov.timelock);
        address receipts = address(d7.receipts);
        address calendar = address(d7.m1.calendar);
        address covers = address(d7.m6.m4.covers);
        address gate = address(d7.hedgeGate);
        // rebuild every holder set from the events
        for (uint256 i; i < deployLogs.length; ++i) {
            Vm.Log memory l = deployLogs[i];
            if (l.topics.length < 3 || (l.topics[0] != ROLE_GRANTED && l.topics[0] != ROLE_REVOKED)) continue;
            assertTrue(
                l.emitter == board || l.emitter == router || l.emitter == engine || l.emitter == pool || l.emitter == tl
                    || l.emitter == receipts || l.emitter == calendar || l.emitter == covers || l.emitter == gate,
                "no other contract has roles"
            );
            address who = address(uint160(uint256(l.topics[2])));
            address[] storage hs = holders[l.emitter][l.topics[1]];
            if (l.topics[0] == ROLE_GRANTED) {
                if (!_contains(hs, who)) hs.push(who);
            } else {
                for (uint256 j; j < hs.length; ++j) {
                    if (hs[j] == who) {
                        hs[j] = hs[hs.length - 1];
                        hs.pop();
                        break;
                    }
                }
            }
        }
        MainspringPool p = _pool();
        Engine e = _engine();
        TimelockController t = d7.gov.timelock;
        bytes32 admin = p.DEFAULT_ADMIN_ROLE();
        address safe = d7.gov.safe;
        address guardian = d7.gov.guardian;
        // the role map, exactly
        _exactly(board, admin, _one(tl), "board admin = the timelock");
        _exactly(router, admin, _one(tl), "router admin = the timelock");
        _exactly(calendar, admin, _one(tl), "SessionCalendar admin = the timelock");
        _exactly(covers, admin, _one(tl), "CoveringAssets admin = the timelock (listings, Backend section 5)");
        _exactly(engine, admin, _one(tl), "Engine admin = the timelock");
        _exactly(engine, e.PAUSER_ROLE(), _one(guardian), "Engine pauser = the guardian");
        _exactly(engine, e.UNPAUSER_ROLE(), _one(safe), "Engine unpauser = the Safe");
        _exactly(pool, admin, _one(tl), "pool admin = the timelock");
        _exactly(pool, p.PAUSER_ROLE(), _one(guardian), "deposit pauser = the guardian");
        _exactly(pool, p.RISK_PAUSER_ROLE(), _two(guardian, RISK), "market pause = the guardian and E1");
        _exactly(pool, p.UNPAUSER_ROLE(), _one(safe), "pool unpauser = the Safe");
        _exactly(pool, p.TREASURER_ROLE(), _one(safe), "treasurer = the Safe");
        _exactly(pool, p.HEDGER_ROLE(), _one(gate), "the hedge keeper role = the gate, never a key (C63)");
        _exactly(gate, admin, _one(tl), "gate admin (the hedger key) = the timelock");
        _exactly(gate, d7.hedgeGate.FREEZER_ROLE(), _one(guardian), "the guardian freezes hedging");
        _exactly(gate, d7.hedgeGate.UNFREEZER_ROLE(), _one(safe), "only the Safe unfreezes");
        assertEq(d7.hedgeGate.hedger(), address(0), "no hedger key until the timelock sets one");
        assertGt(gate.code.length, 0);
        _exactly(tl, admin, _one(tl), "the timelock administers itself");
        _exactly(tl, t.PROPOSER_ROLE(), _one(safe), "only the Safe proposes");
        _exactly(tl, t.CANCELLER_ROLE(), _one(safe), "only the Safe cancels");
        _exactly(tl, t.EXECUTOR_ROLE(), _one(address(0)), "anyone executes after the delay");
        _exactly(receipts, admin, _one(tl), "ReceiptRoots admin = the timelock");
        _exactly(receipts, d7.receipts.POSTER_ROLE(), _one(POSTER), "the receipts service posts (G10)");
        // the holders are contracts, except E1 (the one named exception) and the open executor
        address[4] memory contracts_ = [tl, safe, guardian, address(t)];
        for (uint256 i; i < 4; ++i) {
            assertGt(contracts_[i].code.length, 0);
        }
        assertEq(RISK.code.length, 0, "E1 is a key");
        assertEq(POSTER.code.length, 0, "the poster is a key that can only post roots (G10)");
        // the deployer holds nothing anywhere, and the views agree with the events
        address[9] memory roleContracts = [board, router, engine, pool, tl, receipts, calendar, covers, gate];
        for (uint256 i; i < 9; ++i) {
            assertFalse(QuorumBoard(roleContracts[i]).hasRole(admin, address(m7)), "the deployer kept no admin");
        }
        assertTrue(p.hasRole(p.RISK_PAUSER_ROLE(), RISK));
        assertFalse(p.hasRole(p.PAUSER_ROLE(), RISK), "E1 cannot pause deposits");
        assertFalse(p.hasRole(admin, safe), "the Safe never skips the timelock");
        // AgentRouter has no roles and no admin; it is wired to this deployment's router, Engine, book and USDC
        assertEq(address(d7.agents.openBook()), address(d7.m6.openBook));
        assertEq(address(d7.agents.engine()), engine);
        assertEq(address(d7.agents.book()), address(d7.m6.m4.m3.book));
        // contracts with an immutable admin: every setter already spent
        vm.startPrank(address(m7));
        vm.expectRevert();
        d7.m6.vault.setMatchBook(address(1));
        vm.expectRevert();
        d7.m6.vault.setAuction(address(1));
        vm.expectRevert();
        d7.m6.matchBook.setRouter(address(1));
        vm.expectRevert();
        d7.m6.matchBook.setPool(address(1));
        vm.expectRevert();
        d7.m6.volFeed.setRecorder(address(1));
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- 2. timelocked actions

    function test_everyListedAdminActionOnlyThroughTheTimelockAfterTheDelay() public {
        MainspringPool p = _pool();
        Engine e = _engine();
        MarkRouter r = d7.m1.router;
        QuorumBoard b = d7.m1.board;
        address newSigner = address(0x54);
        MarkRouter.Route memory route =
            MarkRouter.Route(IMarkSource(address(d7.m1.quorumSource)), IMarkSource(address(0)), 90, 0);
        address[4] memory targets = [address(p), address(e), address(b), address(r)];
        bytes[4] memory calls = [
            abi.encodeCall(MainspringPool.setCaps, (bytes32("BTC"), 4_000_000e6, 1_000_000e6)),
            abi.encodeCall(Engine.setMarket, (bytes32("BTC"), 100e18, 300)),
            abi.encodeCall(QuorumBoard.setSigner, (newSigner, true)),
            abi.encodeCall(MarkRouter.queueRoute, (bytes32("BTC"), route))
        ];
        for (uint256 i; i < 4; ++i) {
            // the Safe directly: refused (the inner call fails)
            vm.expectRevert(bytes("GS013"));
            this.execExternal(_safe(), _keys(3, false), targets[i], calls[i]);
            _schedule(targets[i], calls[i], bytes32(i));
        }
        TimelockController tl = d7.gov.timelock;
        _set(nowT + Governance.TESTNET_DELAY - 1);
        for (uint256 i; i < 4; ++i) {
            vm.prank(ANYONE);
            vm.expectRevert();
            tl.execute(targets[i], 0, calls[i], bytes32(0), bytes32(i));
        }
        _set(nowT + 1);
        for (uint256 i; i < 4; ++i) {
            vm.prank(ANYONE);
            tl.execute(targets[i], 0, calls[i], bytes32(0), bytes32(i));
        }
        assertEq(p.notionalCap("BTC"), 4_000_000e6);
        (, uint16 spread,) = e.markets("BTC");
        assertEq(spread, 300);
        assertTrue(b.isSigner(newSigner));
        (MarkRouter.Route memory queued,) = r.pending("BTC");
        assertEq(queued.maxAge, 90, "the route is queued and still waits out the router's own delay (G8)");
    }

    // ---------------------------------------------------------------- 3. the guardian and the Safe directly

    function test_guardianPausesOnlyAndTheSafeUnpausesDirectly() public {
        MainspringPool p = _pool();
        Engine e = _engine();
        uint256[] memory g = _keys(2, true);
        assertTrue(_exec(_guardian(), g, address(e), abi.encodeCall(Engine.pauseBuys, ())));
        assertTrue(_exec(_guardian(), g, address(p), abi.encodeCall(MainspringPool.pauseMarket, (bytes32("ETH")))));
        assertTrue(_exec(_guardian(), g, address(p), abi.encodeCall(MainspringPool.pauseDeposits, ())));
        assertTrue(e.buysPaused() && p.marketPaused("ETH") && p.depositsPaused());
        // nothing else: no unpause, no setting, no grant, no treasury move
        bytes[5] memory no = [
            abi.encodeCall(MainspringPool.unpauseDeposits, ()),
            abi.encodeCall(MainspringPool.unpauseMarket, (bytes32("ETH"))),
            abi.encodeCall(MainspringPool.setCaps, (bytes32("BTC"), 1, 1)),
            abi.encodeCall(MainspringPool.sendToTreasury, (1)),
            abi.encodeWithSignature("grantRole(bytes32,address)", p.DEFAULT_ADMIN_ROLE(), d7.gov.guardian)
        ];
        for (uint256 i; i < 5; ++i) {
            vm.expectRevert(bytes("GS013"));
            this.execExternal(_guardian(), g, address(p), no[i]);
        }
        vm.expectRevert(bytes("GS013"));
        this.execExternal(_guardian(), g, address(e), abi.encodeCall(Engine.unpauseBuys, ()));
        // the Safe unpauses directly, with no delay
        uint256[] memory s = _keys(3, false);
        assertTrue(_exec(_safe(), s, address(e), abi.encodeCall(Engine.unpauseBuys, ())));
        assertTrue(_exec(_safe(), s, address(p), abi.encodeCall(MainspringPool.unpauseMarket, (bytes32("ETH")))));
        assertTrue(_exec(_safe(), s, address(p), abi.encodeCall(MainspringPool.unpauseDeposits, ())));
        assertFalse(e.buysPaused() || p.marketPaused("ETH") || p.depositsPaused());
        // E1 pauses one market and nothing else
        vm.startPrank(RISK);
        p.pauseMarket("BTC");
        vm.expectRevert();
        p.pauseDeposits();
        vm.expectRevert();
        e.pauseBuys();
        vm.expectRevert();
        p.unpauseMarket("BTC");
        vm.stopPrank();
    }

    /// RH8b (C63): the hedge keeper gate under governance. The hedger key is set only through the timelock; the
    /// guardian freezes at once but cannot unfreeze or change the key; the Safe unfreezes directly; nobody else acts.
    function test_hedgeGateFreezeAndKeyThroughGovernance() public {
        HedgeKeeperGate g = d7.hedgeGate;
        address key = address(0x4ED6E);
        bytes memory setKey = abi.encodeCall(HedgeKeeperGate.setHedger, (key));
        // the Safe directly, the guardian, the deployer: refused
        vm.expectRevert(bytes("GS013"));
        this.execExternal(_safe(), _keys(3, false), address(g), setKey);
        vm.expectRevert(bytes("GS013"));
        this.execExternal(_guardian(), _keys(2, true), address(g), setKey);
        vm.prank(address(m7));
        vm.expectRevert();
        g.setHedger(key);
        // through the timelock, after the delay
        _schedule(address(g), setKey, bytes32("gate-key"));
        _set(nowT + Governance.TESTNET_DELAY);
        vm.prank(ANYONE);
        d7.gov.timelock.execute(address(g), 0, setKey, bytes32(0), bytes32("gate-key"));
        assertEq(g.hedger(), key);
        // the guardian freezes at once; it cannot unfreeze; the Safe unfreezes directly
        assertTrue(_exec(_guardian(), _keys(2, true), address(g), abi.encodeCall(HedgeKeeperGate.freeze, ())));
        assertTrue(g.frozen());
        vm.expectRevert(bytes("GS013"));
        this.execExternal(_guardian(), _keys(2, true), address(g), abi.encodeCall(HedgeKeeperGate.unfreeze, ()));
        vm.prank(key);
        vm.expectRevert(HedgeKeeperGate.Frozen.selector);
        g.hedgeSwap("STK1", true, 1e6, 1);
        assertTrue(_exec(_safe(), _keys(3, false), address(g), abi.encodeCall(HedgeKeeperGate.unfreeze, ())));
        assertFalse(g.frozen());
        // E1 and the key itself can neither freeze nor unfreeze
        vm.prank(RISK);
        vm.expectRevert();
        g.freeze();
        vm.prank(key);
        vm.expectRevert();
        g.unfreeze();
    }

    function test_runRefusesMainnetAndOldChains() public {
        DeployM7 other = new DeployM7();
        uint256[2] memory refused = [uint256(4663), 99801]; // Robinhood Chain mainnet, the old Elysium testnet
        for (uint256 i; i < refused.length; ++i) {
            vm.chainId(refused[i]);
            vm.expectRevert(abi.encodeWithSelector(DeployM3.WrongChain.selector, refused[i]));
            other.run();
        }
    }

    /// RH7b (owner D1): the settlement token is a deploy setting. USDG (the mock) by default on anvil; a configured
    /// token (here a USDC) is used as given with its own symbol; a token without 6 decimals is refused; a real chain
    /// without SETTLEMENT_TOKEN is refused.
    function test_settlementTokenIsADeploySetting() public {
        assertEq(d7.m6.m4.m3.settlementAdapter.symbol(), "USDG");
        assertEq(address(_pool().asset()), address(d7.m6.m4.m3.settlement));
        DeployM7 other = new DeployM7();
        DeployM7.Config7 memory c = _config();
        MockSettlementToken settlementLike = new MockSettlementToken("USD Coin", "USDC", 6);
        c.settlement = IERC20(address(settlementLike));
        DeployM7.Deployed7 memory d = other.deploy7(c, address(other));
        assertEq(address(d.m6.m4.m3.settlement), address(settlementLike), "the configured token, not a mock");
        assertEq(d.m6.m4.m3.settlementAdapter.symbol(), "USDC");
        assertEq(address(d.agents.settlement()), address(settlementLike));
        DeployM7 third = new DeployM7();
        MockSettlementToken eighteen = new MockSettlementToken("Eighteen", "E18", 18);
        c.settlement = IERC20(address(eighteen));
        vm.expectRevert(abi.encodeWithSelector(SettlementAdapter.WrongDecimals.selector, uint8(18)));
        third.deploy7(c, address(third));
        // a real chain: SETTLEMENT_TOKEN is required
        vm.chainId(46630);
        vm.setEnv("SAFE_OWNERS", "0x0000000000000000000000000000000000000a01,0x0000000000000000000000000000000000000a02,0x0000000000000000000000000000000000000a03");
        vm.setEnv("GUARDIAN_OWNERS", "0x0000000000000000000000000000000000000b01");
        vm.setEnv("RISK_PAUSER", "0x0000000000000000000000000000000000000c01");
        vm.setEnv("RECEIPTS_POSTER", "0x0000000000000000000000000000000000000c02");
        vm.setEnv("PROTOCOL_RECIPIENT", "0x0000000000000000000000000000000000000c03");
        vm.setEnv("SIGNERS", "0x0000000000000000000000000000000000000d01");
        vm.setEnv("SETTLEMENT_TOKEN", "0x0000000000000000000000000000000000000000");
        vm.expectRevert(abi.encodeWithSelector(DeployM3.BadConfig.selector, "SETTLEMENT_TOKEN"));
        other.config7FromEnv();
        vm.setEnv("SETTLEMENT_TOKEN", vm.toString(address(settlementLike)));
        assertEq(address(other.config7FromEnv().settlement), address(settlementLike));
        vm.chainId(31337);
    }

    /// RH7b (Q4): with a v4 PoolManager given, the Uniswap v4 hedge router is deployed, administered by the timelock
    /// only; without one, none.
    function test_uniswapV4RouterDeployedUnderTheTimelock() public {
        assertEq(address(d7.hedgeRouter), address(0));
        DeployM7 other = new DeployM7();
        DeployM7.Config7 memory c = _config();
        c.poolManager = address(new MockPoolManagerV4());
        DeployM7.Deployed7 memory d = other.deploy7(c, address(other));
        assertEq(address(d.hedgeRouter.poolManager()), c.poolManager);
        assertTrue(d.hedgeRouter.hasRole(bytes32(0), address(d.gov.timelock)));
        assertFalse(d.hedgeRouter.hasRole(bytes32(0), address(other)), "the deployer holds nothing");
        assertFalse(d.hedgeRouter.hasRole(bytes32(0), d.gov.safe));
    }

    function test_delayRuleRefusesOneHourOffAnvilAndTheRobinhoodTestnet() public {
        DeployM7 other = new DeployM7();
        DeployM7.Config7 memory c = _config();
        vm.chainId(4663); // Robinhood Chain mainnet
        vm.expectRevert(abi.encodeWithSelector(Governance.DelayTooShort.selector, 4663, 1 hours, 48 hours));
        other.deploy7(c, address(other));
        c.delay = 48 hours;
        DeployM7.Deployed7 memory d = other.deploy7(c, address(other));
        assertEq(d.gov.timelock.getMinDelay(), 48 hours);
    }

    // ---------------------------------------------------------------- 4. a local flow on the M7 deployment

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

    function _live() internal {
        QuorumBoard b = d7.m1.board;
        _set(nowT + 1 hours); // the router's own delay for the first routes
        bytes32[3] memory ms = [bytes32("BTC"), "ETH", "STK1"];
        uint256[3] memory px = [uint256(74_000e18), 2_000e18, 70e18];
        for (uint256 i; i < 3; ++i) {
            d7.m1.router.applyRoute(ms[i]);
            _voteAll(b, b.markKey(ms[i]), px[i]);
            _voteAll(b, b.volKey(ms[i]), 0.45e18);
        }
        d7.m6.m4.m3.book.poke("BTC");
        MainspringPool p = _pool();
        d7.m6.m4.m3.settlement.mint(LP, 2_000_000e6);
        vm.startPrank(LP);
        d7.m6.m4.m3.settlement.approve(address(p), type(uint256).max);
        p.deposit(2_000_000e6);
        vm.stopPrank();
        p.startEpoch();
        while (!p.markChunk(100)) {}
        p.settle();
        vm.prank(LP);
        p.claimShares(0);
    }

    function _spread() internal pure returns (StrategyMath.Leg[] memory l) {
        l = new StrategyMath.Leg[](2);
        l[0] = StrategyMath.Leg(true, 74_000e18, 1e18);
        l[1] = StrategyMath.Leg(true, 76_000e18, -1e18);
    }

    function test_localFlowRoutedBuySellPauseCycleAndATreasuryMove() public {
        _live();
        MainspringPool p = _pool();
        Engine e = _engine();
        d7.m6.m4.m3.settlement.mint(TRADER, 100_000e6);
        vm.prank(TRADER);
        d7.m6.m4.m3.settlement.approve(address(e), type(uint256).max);
        VolQuote.Quote[] memory noQ = new VolQuote.Quote[](0);
        vm.prank(TRADER);
        (uint256 id,,) = d7.m6.openBook
            .buy(
                "BTC",
                _spread(),
                TempoBlend.single(1 days),
                2e18,
                type(uint256).max,
                nowT,
                noQ,
                new bytes[](0),
                new uint256[](0)
            );
        // the guardian pauses buys: opens refused, the sell goes through; the Safe unpauses
        assertTrue(_exec(_guardian(), _keys(2, true), address(e), abi.encodeCall(Engine.pauseBuys, ())));
        vm.prank(TRADER);
        vm.expectRevert(Engine.BuysArePaused.selector);
        d7.m6.openBook
            .buy(
                "BTC",
                _spread(),
                TempoBlend.single(1 days),
                1e18,
                type(uint256).max,
                nowT,
                noQ,
                new bytes[](0),
                new uint256[](0)
            );
        vm.prank(TRADER);
        (, uint256 net) = e.sell(id, type(uint256).max, 0, nowT);
        assertGt(net, 0, "sells are never paused");
        assertTrue(_exec(_safe(), _keys(3, false), address(e), abi.encodeCall(Engine.unpauseBuys, ())));

        // a treasury move: the address through the timelock, the move itself by the Safe directly within the cap
        _schedule(address(p), abi.encodeCall(MainspringPool.setTreasury, (TREASURY)), "treasury");
        _set(nowT + Governance.TESTNET_DELAY);
        d7.gov.timelock
            .execute(address(p), 0, abi.encodeCall(MainspringPool.setTreasury, (TREASURY)), bytes32(0), "treasury");
        QuorumBoard b = d7.m1.board;
        bytes32 eq = p.equityKey();
        _voteAll(b, eq, p.EQUITY_OFFSET());
        _set(nowT + 1 hours);
        _voteAll(b, eq, p.EQUITY_OFFSET());
        uint256 before = IERC20(address(d7.m6.m4.m3.settlement)).balanceOf(TREASURY);
        assertTrue(
            _exec(_safe(), _keys(3, false), address(p), abi.encodeCall(MainspringPool.sendToTreasury, (10_000e6)))
        );
        assertEq(IERC20(address(d7.m6.m4.m3.settlement)).balanceOf(TREASURY) - before, 10_000e6);
        // nobody else moves treasury USDC
        vm.prank(ANYONE);
        vm.expectRevert();
        p.sendToTreasury(1);
    }
}
