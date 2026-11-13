// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Kit suite: MarkSources (4 tests), run against our QuorumBoard, mark sources, MarkRouter and PathFundingBook.
///
/// Changes from the kit file, and why:
///   1. Contracts renamed KitMockCorePx / KitMarkSourcesTest so names do not clash with our suite.
///   2. Our QuorumBoard constructor and setFeed replace setSigner / registerSignerList / configure;
///      the kit's m = 2 of n = 3, steps and heartbeats are kept.
///   3. _mark has all three signers vote, with the round number: a key's first round needs all n (our rule),
///      and a full round finalises at once without the 30 s window.
///   4. CoreReadMarkSource.setAsset replaces list.
///   5. MarkRouter.markWad returns the price only (as in the spec), not (price, updatedAt).
///   6. Errors carry arguments (NoRoute(market), TooEarly(market, eta), Stale(market, source),
///      Disagree(market, primary, secondary)).
///   7. test_poke_takes_price_from_router_not_caller: one VOL key per market, volKey(name), voted as a WAD
///      fraction (0.5e18 = 50%) by all three signers (first round needs all n); the book takes our
///      IMarkRouter / IVolSource types.
///   Scenarios, prices and the 2% refusal are otherwise unchanged.

import {Test} from "forge-std/Test.sol";
import {QuorumBoard} from "../../src/QuorumBoard.sol";
import {IMarkSource} from "../../src/IMarkSource.sol";
import {QuorumMarkSource} from "../../src/QuorumMarkSource.sol";
import {CoreReadMarkSource} from "../../src/CoreReadMarkSource.sol";
import {MarkRouter} from "../../src/MarkRouter.sol";
import {PathFundingBook, IMarkRouter, IVolSource} from "../../src/PathFundingBook.sol";

contract KitMockCorePx {
    uint64 public px;

    function set(uint64 p) external {
        px = p;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(px);
    }
}

contract KitMarkSourcesTest is Test {
    QuorumBoard board;
    QuorumMarkSource qsrc;
    CoreReadMarkSource csrc;
    MarkRouter router;
    KitMockCorePx core;
    address[] signers;
    bytes32 constant BTC = "BTC";
    address constant PRECOMPILE = address(0x0000000000000000000000000000000000000807); // placeholder until Elysium publishes
    uint256 nowT = 1_794_236_400;

    function _adv(uint256 dt) internal {
        nowT += dt;
        vm.warp(nowT);
    }

    function setUp() public {
        vm.warp(nowT);
        for (uint256 i; i < 3; i++) {
            signers.push(address(uint160(0x5100 + i)));
        }
        board = new QuorumBoard(address(this), signers, 2, 30);
        board.setFeed(board.markKey(BTC), 2000, 5 minutes);
        board.setFeed(board.volKey(BTC), 2500, 2 hours);
        qsrc = new QuorumMarkSource(board);
        KitMockCorePx impl = new KitMockCorePx();
        vm.etch(PRECOMPILE, address(impl).code);
        core = KitMockCorePx(payable(PRECOMPILE));
        csrc = new CoreReadMarkSource(address(this), PRECOMPILE);
        csrc.setAsset(BTC, 0, 5); // BTC-style szDecimals 5: raw / 10
        router = new MarkRouter(address(this), 1 days);
    }

    function _mark(uint256 v) internal {
        bytes32 k = board.markKey(BTC); // compute before prank: a view call would consume it
        uint80 r;
        try board.latestRoundData(k) returns (uint80 id, int256, uint256, uint256, uint80) {
            r = id;
        } catch {}
        ++r;
        for (uint256 i; i < 3; i++) {
            vm.prank(signers[i]);
            board.vote(k, r, v);
        }
    }

    function _route(IMarkSource p, IMarkSource s) internal {
        router.queueRoute(BTC, MarkRouter.Route(p, s, 5 minutes, 50));
        _adv(1 days);
        router.applyRoute(BTC);
    }

    function test_quorum_and_core_sources_agree_in_units() public {
        _mark(93_120e18);
        core.set(931_200); // 931200 / 10 = 93120.0
        (uint256 a,) = qsrc.markWad(BTC);
        (uint256 b,) = csrc.markWad(BTC);
        assertEq(a, 93_120e18);
        assertEq(b, 93_120e18);
    }

    function test_router_timelock_staleness_and_cross_check() public {
        vm.expectRevert(abi.encodeWithSelector(MarkRouter.NoRoute.selector, BTC));
        router.markWad(BTC);
        router.queueRoute(BTC, MarkRouter.Route(csrc, qsrc, 5 minutes, 50));
        vm.expectRevert(abi.encodeWithSelector(MarkRouter.TooEarly.selector, BTC, uint64(nowT + 1 days)));
        router.applyRoute(BTC);
        _adv(1 days);
        router.applyRoute(BTC);
        core.set(931_200);
        _mark(93_100e18); // 2 bps apart: fine
        uint256 px = router.markWad(BTC);
        assertEq(px, 93_120e18);
        core.set(950_000); // 2% apart from the quorum: refused
        vm.expectRevert(abi.encodeWithSelector(MarkRouter.Disagree.selector, BTC, 95_000e18, 93_100e18));
        router.markWad(BTC);
    }

    function test_quorum_only_route_goes_stale() public {
        _route(qsrc, IMarkSource(address(0)));
        _mark(93_120e18);
        router.markWad(BTC);
        _adv(6 minutes);
        vm.expectRevert(abi.encodeWithSelector(MarkRouter.Stale.selector, BTC, address(qsrc)));
        router.markWad(BTC);
    }

    function test_poke_takes_price_from_router_not_caller() public {
        _route(qsrc, IMarkSource(address(0)));
        bytes32 vk = board.volKey(BTC);
        for (uint256 i; i < 3; i++) {
            vm.prank(signers[i]);
            board.vote(vk, 1, 0.5e18);
        }
        PathFundingBook book =
            new PathFundingBook(address(this), address(0), IMarkRouter(address(router)), IVolSource(address(board)));
        _mark(93_120e18);
        vm.prank(address(0xCAFE)); // anyone
        (bool l0,,) = book.poke(BTC);
        assertTrue(l0);
        vm.expectRevert(PathFundingBook.NotRecorder.selector); // no bootstrap recorder in production
        book.record(BTC, 1e18, 5000);
        _adv(6 minutes);
        vm.expectRevert(abi.encodeWithSelector(MarkRouter.Stale.selector, BTC, address(qsrc))); // no fresh mark, no sample
        book.poke(BTC);
    }
}
