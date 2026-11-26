// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {QuorumBoard} from "../src/QuorumBoard.sol";
import {QuorumMarkSource} from "../src/QuorumMarkSource.sol";
import {NativeMarkSource, INativeMarkAdapter} from "../src/NativeMarkSource.sol";
import {MarkRouter} from "../src/MarkRouter.sol";
import {IMarkSource} from "../src/IMarkSource.sol";

/// Stand-in for the adapter in front of Robinhood Chain's first-party mark (its interface is (U)).
contract MockNativeAdapter is INativeMarkAdapter {
    mapping(bytes32 => uint256) public px;
    mapping(bytes32 => uint256) public at;

    function set(bytes32 assetId, uint256 pxWad, uint256 updatedAt) external {
        px[assetId] = pxWad;
        at[assetId] = updatedAt;
    }

    function mark(bytes32 assetId) external view returns (uint256, uint256) {
        return (px[assetId], at[assetId]);
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
    bytes32 constant STK1 = "STK1"; // placeholder for a launch tokenized stock (owner queue Q2)
    bytes32 constant BTC_ID = keccak256("native:BTC"); // the chain's own asset ids are (U)
    bytes32 constant STK1_ID = keccak256("native:STK1");
    // Placeholder address for tests only; the chain's first-party mark interface is unpublished (U)
    address constant ADAPTER = 0x0000000000000000000000000000000000000806;

    address gov = makeAddr("timelock");
    address s1 = makeAddr("signer1");
    address s2 = makeAddr("signer2");
    address s3 = makeAddr("signer3");
    address anyone = makeAddr("anyone");

    QuorumBoard board;
    QuorumMarkSource quorumSrc;
    NativeMarkSource nativeSrc;
    MockNativeAdapter native;
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
        board.setFeed(board.markKey(STK1), 200, HEARTBEAT);
        vm.stopPrank();
        quorumSrc = new QuorumMarkSource(board);

        vm.etch(ADAPTER, address(new MockNativeAdapter()).code);
        native = MockNativeAdapter(ADAPTER);
        nativeSrc = new NativeMarkSource(gov, ADAPTER);
        vm.startPrank(gov);
        nativeSrc.setAsset(BTC, BTC_ID);
        nativeSrc.setAsset(STK1, STK1_ID);
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

    /// Puts `code` at the adapter address and checks the read reverts with AdapterFailed
    /// using less than `maxGas` in total.
    function _failsCleanly(bytes memory code, uint256 maxGas) internal {
        vm.etch(ADAPTER, code);
        uint256 before = gasleft();
        try nativeSrc.markWad(BTC) {
            fail();
        } catch (bytes memory err) {
            assertEq(bytes4(err), NativeMarkSource.AdapterFailed.selector);
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

    /// 1. The quorum and native sources report the same mark in the same WAD units; the native source passes the
    ///    chain's own time through, and its adapter fails cleanly.
    function test_sourcesAgreeInUnits() public {
        native.set(BTC_ID, 97123.4e18, nowT - 3);
        native.set(STK1_ID, 412.345e18, nowT);
        _publish(BTC, 97123.4e18);
        _publish(STK1, 412.345e18);

        (uint256 nativeBtc, uint256 nativeAt) = nativeSrc.markWad(BTC);
        (uint256 quorumBtc, uint256 quorumAt) = quorumSrc.markWad(BTC);
        assertEq(nativeBtc, 97123.4e18);
        assertEq(nativeBtc, quorumBtc);
        assertEq(nativeAt, nowT - 3); // the chain's own time, judged by the router
        assertEq(quorumAt, nowT);

        (uint256 nativeStk,) = nativeSrc.markWad(STK1);
        (uint256 quorumStk,) = quorumSrc.markWad(STK1);
        assertEq(nativeStk, 412.345e18);
        assertEq(nativeStk, quorumStk);

        // Failure modes of the adapter
        vm.expectRevert(abi.encodeWithSelector(NativeMarkSource.UnknownMarket.selector, bytes32("ETH")));
        nativeSrc.markWad("ETH");
        native.set(BTC_ID, 0, nowT);
        vm.expectRevert(abi.encodeWithSelector(NativeMarkSource.ZeroMark.selector, BTC));
        nativeSrc.markWad(BTC);
        // A failing, out-of-gas or malformed adapter reverts cleanly within the gas cap
        assertEq(nativeSrc.callGas(), 100_000);
        _failsCleanly(hex"5f5ffd", 150_000); // reverts (PUSH0 PUSH0 REVERT)
        _failsCleanly(hex"fe", 150_000); // invalid opcode: burns only the capped gas
        _failsCleanly(hex"5b5f56", 150_000); // endless loop (JUMPDEST PUSH0 JUMP): out of gas at the cap
        _failsCleanly(hex"60205ff3", 150_000); // a 32-byte reply instead of 64
        _failsCleanly(hex"60605ff3", 150_000); // a 96-byte reply instead of 64
        _failsCleanly(hex"", 150_000); // no code at the address

        // The cap is configurable by governance only, with a floor
        vm.prank(anyone);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, anyone, bytes32(0))
        );
        nativeSrc.setCallGas(50_000);
        vm.prank(gov);
        vm.expectRevert(NativeMarkSource.BadConfig.selector);
        nativeSrc.setCallGas(9_999);
        vm.prank(gov);
        nativeSrc.setCallGas(30_000);
        _failsCleanly(hex"5b5f56", 60_000); // a lower cap bounds the loop lower

        // Quorum source with nothing published
        vm.expectRevert(abi.encodeWithSelector(QuorumBoard.NoData.selector, board.markKey("ETH")));
        quorumSrc.markWad("ETH");

        // Only governance configures the adapter; empty settings are refused
        vm.startPrank(anyone);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, anyone, bytes32(0))
        );
        nativeSrc.setAsset(BTC, BTC_ID);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, anyone, bytes32(0))
        );
        nativeSrc.setAdapter(anyone);
        vm.stopPrank();
        vm.startPrank(gov);
        vm.expectRevert(NativeMarkSource.BadConfig.selector);
        nativeSrc.setAsset(BTC, bytes32(0));
        vm.expectRevert(NativeMarkSource.BadConfig.selector);
        nativeSrc.setAdapter(address(0));
        vm.stopPrank();
        vm.expectRevert(NativeMarkSource.BadConfig.selector);
        new NativeMarkSource(gov, address(0));
    }

    /// Fuzz: whatever the adapter answers, the source gives back exactly the chain's price and time, or refuses a zero.
    function testFuzz_nativeSourcePassesTheChainsValuesThrough(uint256 px, uint256 at) public {
        native.set(BTC_ID, px, at);
        if (px == 0) {
            vm.expectRevert(abi.encodeWithSelector(NativeMarkSource.ZeroMark.selector, BTC));
            nativeSrc.markWad(BTC);
            return;
        }
        (uint256 got, uint256 gotAt) = nativeSrc.markWad(BTC);
        assertEq(got, px);
        assertEq(gotAt, at);
    }

    /// 2. Route changes wait out the timelock; the primary must be fresh; a fresh secondary
    ///    must agree within maxDevBps (a 2% disagreement is refused).
    function test_routerTimelockFreshnessCrossCheck() public {
        vm.expectRevert(abi.encodeWithSelector(MarkRouter.NoRoute.selector, BTC));
        router.markWad(BTC);

        // T2 route: native primary, quorum secondary, 50 bps
        MarkRouter.Route memory t2 = _route(nativeSrc, quorumSrc, 50);
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
        native.set(BTC_ID, 100_000e18, nowT);
        _publish(BTC, 100_000e18);
        assertEq(router.markWad(BTC), 100_000e18);

        // 0.3% apart: inside 50 bps, primary returned
        native.set(BTC_ID, 100_300e18, nowT);
        assertEq(router.markWad(BTC), 100_300e18);

        // 2% apart: refused
        native.set(BTC_ID, 102_000e18, nowT);
        vm.expectRevert(abi.encodeWithSelector(MarkRouter.Disagree.selector, BTC, 102_000e18, 100_000e18));
        router.markWad(BTC);

        // Secondary stale: no cross-check possible, the fresh primary stands
        _adv(MAX_AGE + 1);
        native.set(BTC_ID, 102_000e18, nowT);
        assertEq(router.markWad(BTC), 102_000e18);

        // The native mark's own time decides its freshness: older than maxAge, or from the future, is unavailable
        _publish(BTC, 102_000e18);
        native.set(BTC_ID, 102_000e18, nowT - MAX_AGE - 1);
        vm.expectRevert(abi.encodeWithSelector(MarkRouter.Stale.selector, BTC, address(nativeSrc)));
        router.markWad(BTC);
        native.set(BTC_ID, 102_000e18, nowT + 1);
        vm.expectRevert(abi.encodeWithSelector(MarkRouter.Stale.selector, BTC, address(nativeSrc)));
        router.markWad(BTC);

        // Primary unavailable: Stale, whatever the secondary says
        native.set(BTC_ID, 0, nowT);
        vm.expectRevert(abi.encodeWithSelector(MarkRouter.Stale.selector, BTC, address(nativeSrc)));
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
        router.queueRoute(BTC, _route(nativeSrc, quorumSrc, 0)); // secondary without a band
        vm.expectRevert(MarkRouter.BadRoute.selector);
        router.queueRoute(BTC, _route(IMarkSource(anyone), IMarkSource(address(0)), 0)); // not a contract
        vm.stopPrank();
    }

    /// 3. A quorum-only route (T0) goes stale when the board stops publishing, then recovers.
    function test_quorumOnlyRouteGoesStale() public {
        _setRoute(STK1, _route(quorumSrc, IMarkSource(address(0)), 0));

        // Nothing published yet: the primary is unavailable
        vm.expectRevert(abi.encodeWithSelector(MarkRouter.Stale.selector, STK1, address(quorumSrc)));
        router.markWad(STK1);

        _publish(STK1, 41e18);
        assertEq(router.markWad(STK1), 41e18);

        _adv(MAX_AGE);
        assertEq(router.markWad(STK1), 41e18); // exactly maxAge old: still fresh

        _adv(1);
        vm.expectRevert(abi.encodeWithSelector(MarkRouter.Stale.selector, STK1, address(quorumSrc)));
        router.markWad(STK1);

        // The quorum publishes again: the route recovers
        _publish(STK1, 41.5e18);
        assertEq(router.markWad(STK1), 41.5e18);
    }
}
