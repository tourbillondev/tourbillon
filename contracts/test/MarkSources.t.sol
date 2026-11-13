// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {QuorumBoard} from "../src/QuorumBoard.sol";
import {QuorumMarkSource} from "../src/QuorumMarkSource.sol";
import {CoreReadMarkSource} from "../src/CoreReadMarkSource.sol";
import {MarkRouter} from "../src/MarkRouter.sol";
import {IMarkSource} from "../src/IMarkSource.sol";

/// Stand-in for the HyperCore read precompile (shape (U)): abi.encode(uint32 index) -> uint64 raw.
contract MockCorePrecompile {
    mapping(uint32 => uint64) public raw;

    function set(uint32 index, uint64 value) external {
        raw[index] = value;
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        require(data.length == 32, "shape");
        return abi.encode(raw[abi.decode(data, (uint32))]);
    }
}

contract MarkSourcesTest is Test {
    /// Tracked clock: with via-IR, block.timestamp can be cached inside one test function.
    uint256 nowT;

    function _set(uint256 t) internal {
        nowT = t;
        vm.warp(t);
    }

    function _adv(uint256 dt) internal {
        _set(nowT + dt);
    }

    uint32 constant HEARTBEAT = 60;
    uint32 constant MAX_AGE = 120;
    uint256 constant DELAY = 48 hours;
    bytes32 constant BTC = "BTC";
    bytes32 constant HYPE = "HYPE";
    uint32 constant BTC_INDEX = 0;
    uint32 constant HYPE_INDEX = 159;
    // Placeholder address for tests only; the Elysium address is unpublished (U)
    address constant PRECOMPILE = 0x0000000000000000000000000000000000000806;

    address gov = makeAddr("timelock");
    address s1 = makeAddr("signer1");
    address s2 = makeAddr("signer2");
    address s3 = makeAddr("signer3");
    address anyone = makeAddr("anyone");

    QuorumBoard board;
    QuorumMarkSource quorumSrc;
    CoreReadMarkSource coreSrc;
    MockCorePrecompile core;
    MarkRouter router;

    function setUp() public {
        _set(1_800_000_000);
        address[] memory signers = new address[](3);
        signers[0] = s1;
        signers[1] = s2;
        signers[2] = s3;
        board = new QuorumBoard(gov, signers, 2, 30);
        vm.startPrank(gov);
        board.setFeed(board.markKey(BTC), 200, HEARTBEAT);
        board.setFeed(board.markKey(HYPE), 200, HEARTBEAT);
        vm.stopPrank();
        quorumSrc = new QuorumMarkSource(board);

        vm.etch(PRECOMPILE, address(new MockCorePrecompile()).code);
        core = MockCorePrecompile(payable(PRECOMPILE));
        coreSrc = new CoreReadMarkSource(gov, PRECOMPILE);
        vm.startPrank(gov);
        coreSrc.setAsset(BTC, BTC_INDEX, 5); // BTC: szDecimals 5, so raw has 1 decimal
        coreSrc.setAsset(HYPE, HYPE_INDEX, 2); // HYPE: szDecimals 2, so raw has 4 decimals
        vm.stopPrank();

        router = new MarkRouter(gov, DELAY);
    }

    function _publish(bytes32 market, uint256 px) internal {
        bytes32 key = board.markKey(market);
        uint80 r;
        try board.latestRoundData(key) returns (uint80 id, int256, uint256, uint256, uint80) {
            r = id;
        } catch {}
        ++r;
        vm.prank(s1);
        board.vote(key, r, px);
        vm.prank(s2);
        board.vote(key, r, px);
        vm.prank(s3);
        board.vote(key, r, px);
    }

    /// Puts `code` at the precompile address and checks the read reverts with PrecompileFailed
    /// using less than `maxGas` in total.
    function _failsCleanly(bytes memory code, uint256 maxGas) internal {
        vm.etch(PRECOMPILE, code);
        uint256 before = gasleft();
        try coreSrc.markWad(BTC) {
            fail();
        } catch (bytes memory err) {
            assertEq(bytes4(err), CoreReadMarkSource.PrecompileFailed.selector);
        }
        assertLt(before - gasleft(), maxGas);
    }

    function _route(IMarkSource p, IMarkSource s, uint16 dev) internal pure returns (MarkRouter.Route memory) {
        return MarkRouter.Route(p, s, MAX_AGE, dev);
    }

    function _setRoute(bytes32 market, MarkRouter.Route memory r) internal {
        vm.prank(gov);
        router.queueRoute(market, r);
        _adv(DELAY);
        router.applyRoute(market);
    }

    /// 1. The quorum and precompile sources report the same mark in the same WAD units.
    function test_sourcesAgreeInUnits() public {
        core.set(BTC_INDEX, 971234); // 97123.4 with 1 decimal
        core.set(HYPE_INDEX, 412345); // 41.2345 with 4 decimals
        _publish(BTC, 97123.4e18);
        _publish(HYPE, 41.2345e18);

        (uint256 coreBtc, uint256 coreAt) = coreSrc.markWad(BTC);
        (uint256 quorumBtc, uint256 quorumAt) = quorumSrc.markWad(BTC);
        assertEq(coreBtc, 97123.4e18);
        assertEq(coreBtc, quorumBtc);
        assertEq(coreAt, nowT); // precompile reading is fresh at the current block
        assertEq(quorumAt, nowT);

        (uint256 coreHype,) = coreSrc.markWad(HYPE);
        (uint256 quorumHype,) = quorumSrc.markWad(HYPE);
        assertEq(coreHype, 41.2345e18);
        assertEq(coreHype, quorumHype);

        // Failure modes of the precompile adapter
        vm.expectRevert(abi.encodeWithSelector(CoreReadMarkSource.UnknownMarket.selector, bytes32("ETH")));
        coreSrc.markWad("ETH");
        core.set(BTC_INDEX, 0);
        vm.expectRevert(abi.encodeWithSelector(CoreReadMarkSource.ZeroMark.selector, BTC));
        coreSrc.markWad(BTC);
        // A failing, out-of-gas or malformed precompile reverts cleanly within the gas cap
        assertEq(coreSrc.callGas(), 100_000);
        _failsCleanly(hex"5f5ffd", 150_000); // reverts (PUSH0 PUSH0 REVERT)
        _failsCleanly(hex"fe", 150_000); // invalid opcode: burns only the capped gas
        _failsCleanly(hex"5b5f56", 150_000); // endless loop (JUMPDEST PUSH0 JUMP): out of gas at the cap
        _failsCleanly(hex"60405ff3", 150_000); // 64-byte reply instead of 32
        _failsCleanly(hex"5f195f5260205ff3", 150_000); // 32 bytes, but not a uint64
        _failsCleanly(hex"", 150_000); // no code at the address

        // The cap is configurable by governance only, with a floor
        vm.prank(anyone);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, anyone, bytes32(0))
        );
        coreSrc.setCallGas(50_000);
        vm.prank(gov);
        vm.expectRevert(CoreReadMarkSource.BadConfig.selector);
        coreSrc.setCallGas(9_999);
        vm.prank(gov);
        coreSrc.setCallGas(30_000);
        _failsCleanly(hex"5b5f56", 60_000); // a lower cap bounds the loop lower

        // Quorum source with nothing published
        vm.expectRevert(abi.encodeWithSelector(QuorumBoard.NoData.selector, board.markKey("ETH")));
        quorumSrc.markWad("ETH");

        // Only governance configures the adapter
        vm.prank(anyone);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, anyone, bytes32(0))
        );
        coreSrc.setAsset(BTC, 1, 5);
    }

    /// 2. Route changes wait out the timelock; the primary must be fresh; a fresh secondary
    ///    must agree within maxDevBps (a 2% disagreement is refused).
    function test_routerTimelockFreshnessCrossCheck() public {
        vm.expectRevert(abi.encodeWithSelector(MarkRouter.NoRoute.selector, BTC));
        router.markWad(BTC);

        // T2 route: precompile primary, quorum secondary, 50 bps
        MarkRouter.Route memory t2 = _route(coreSrc, quorumSrc, 50);
        vm.prank(anyone);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, anyone, bytes32(0))
        );
        router.queueRoute(BTC, t2);

        vm.prank(gov);
        router.queueRoute(BTC, t2);
        uint64 eta = uint64(nowT + DELAY);
        _adv(DELAY - 1);
        vm.expectRevert(abi.encodeWithSelector(MarkRouter.TooEarly.selector, BTC, eta));
        router.applyRoute(BTC);
        vm.expectRevert(abi.encodeWithSelector(MarkRouter.NoRoute.selector, BTC)); // nothing live yet
        router.markWad(BTC);
        _adv(1);
        vm.prank(anyone); // anyone applies once the delay has passed
        router.applyRoute(BTC);
        vm.expectRevert(abi.encodeWithSelector(MarkRouter.NotQueued.selector, BTC));
        router.applyRoute(BTC);

        // Agreeing sources: the primary's mark is returned
        core.set(BTC_INDEX, 1000000); // 100000.0
        _publish(BTC, 100_000e18);
        assertEq(router.markWad(BTC), 100_000e18);

        // 0.3% apart: inside 50 bps, primary returned
        core.set(BTC_INDEX, 1003000);
        assertEq(router.markWad(BTC), 100_300e18);

        // 2% apart: refused
        core.set(BTC_INDEX, 1020000);
        vm.expectRevert(abi.encodeWithSelector(MarkRouter.Disagree.selector, BTC, 102_000e18, 100_000e18));
        router.markWad(BTC);

        // Secondary stale: no cross-check possible, the fresh primary stands
        _adv(MAX_AGE + 1);
        assertEq(router.markWad(BTC), 102_000e18);

        // Primary unavailable: Stale, whatever the secondary says
        _publish(BTC, 102_000e18);
        core.set(BTC_INDEX, 0);
        vm.expectRevert(abi.encodeWithSelector(MarkRouter.Stale.selector, BTC, address(coreSrc)));
        router.markWad(BTC);

        // A queued change can be cancelled, and bad routes are refused
        vm.startPrank(gov);
        router.queueRoute(BTC, _route(quorumSrc, IMarkSource(address(0)), 0));
        router.cancelRoute(BTC);
        vm.expectRevert(abi.encodeWithSelector(MarkRouter.NotQueued.selector, BTC));
        router.cancelRoute(BTC);
        vm.expectRevert(MarkRouter.BadRoute.selector);
        router.queueRoute(BTC, _route(quorumSrc, quorumSrc, 50)); // same source twice
        vm.expectRevert(MarkRouter.BadRoute.selector);
        router.queueRoute(BTC, _route(coreSrc, quorumSrc, 0)); // secondary without a band
        vm.expectRevert(MarkRouter.BadRoute.selector);
        router.queueRoute(BTC, _route(IMarkSource(anyone), IMarkSource(address(0)), 0)); // not a contract
        vm.stopPrank();
    }

    /// 3. A quorum-only route (T0) goes stale when the board stops publishing, then recovers.
    function test_quorumOnlyRouteGoesStale() public {
        _setRoute(HYPE, _route(quorumSrc, IMarkSource(address(0)), 0));

        // Nothing published yet: the primary is unavailable
        vm.expectRevert(abi.encodeWithSelector(MarkRouter.Stale.selector, HYPE, address(quorumSrc)));
        router.markWad(HYPE);

        _publish(HYPE, 41e18);
        assertEq(router.markWad(HYPE), 41e18);

        _adv(MAX_AGE);
        assertEq(router.markWad(HYPE), 41e18); // exactly maxAge old: still fresh

        _adv(1);
        vm.expectRevert(abi.encodeWithSelector(MarkRouter.Stale.selector, HYPE, address(quorumSrc)));
        router.markWad(HYPE);

        // The quorum publishes again: the route recovers
        _publish(HYPE, 41.5e18);
        assertEq(router.markWad(HYPE), 41.5e18);
    }
}
