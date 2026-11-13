// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {QuorumBoard} from "../src/QuorumBoard.sol";

contract QuorumBoardTest is Test {
    /// Tracked clock: with via-IR, block.timestamp can be cached inside one test function.
    uint256 nowT;

    function _set(uint256 t) internal {
        nowT = t;
        vm.warp(t);
    }

    function _adv(uint256 dt) internal {
        _set(nowT + dt);
    }

    // Test defaults: n = 3, m = 2, step 2% per round, heartbeat 60 s, window 30 s, anchor band 10%
    uint16 constant STEP = 200;
    uint32 constant HEARTBEAT = 60;
    uint256 constant WINDOW = 30;
    uint16 constant BAND = 1000;
    bytes32 constant BTC = "BTC";

    QuorumBoard board;
    address gov = makeAddr("timelock");
    address s1 = makeAddr("signer1");
    address s2 = makeAddr("signer2");
    address s3 = makeAddr("signer3");
    address outsider = makeAddr("outsider");
    bytes32 mark;
    bytes32 vol;

    function setUp() public {
        _set(1_800_000_000);
        address[] memory signers = new address[](3);
        signers[0] = s1;
        signers[1] = s2;
        signers[2] = s3;
        board = new QuorumBoard(gov, signers, 2, WINDOW);
        mark = board.markKey(BTC);
        vol = board.volKey(BTC);
        vm.startPrank(gov);
        board.setFeed(mark, STEP, HEARTBEAT);
        board.setFeed(vol, STEP, HEARTBEAT);
        vm.stopPrank();
    }

    function _round(bytes32 key) internal view returns (uint80 r) {
        try board.latestRoundData(key) returns (uint80 id, int256, uint256, uint256, uint80) {
            r = id;
        } catch {}
        r += 1;
    }

    function _voteAll(bytes32 key, uint256 a, uint256 b, uint256 c) internal {
        uint80 r = _round(key);
        vm.prank(s1);
        board.vote(key, r, a);
        vm.prank(s2);
        board.vote(key, r, b);
        vm.prank(s3);
        board.vote(key, r, c);
    }

    function _value(bytes32 key) internal view returns (uint256 v) {
        (v,) = board.latestValue(key);
    }

    /// a. Median ignores an outlier; finalisation rules; AggregatorV3-style read.
    function test_medianVsOutlier() public {
        // 3 votes, one wild outlier: the final is the median, and the outlier's size has no effect
        _voteAll(mark, 100e18, 101e18, 1_000_000e18);
        assertEq(_value(mark), 101e18);
        (uint80 id, int256 answer,, uint256 updatedAt, uint80 answeredIn) = board.latestRoundData(mark);
        assertEq(id, 1);
        assertEq(answeredIn, 1);
        assertEq(answer, 101e8); // 8 decimals
        assertEq(updatedAt, nowT);
        assertEq(board.decimals(), 8);

        // Same honest votes, a low outlier this time: same answer again
        _adv(10);
        _voteAll(mark, 1, 101e18, 100.5e18);
        assertEq(_value(mark), 100.5e18);

        // m votes but window not passed: still open; finalize refuses
        _adv(10);
        vm.prank(s1);
        board.vote(mark, 3, 100e18);
        _adv(5);
        vm.prank(s2);
        board.vote(mark, 3, 101e18);
        assertEq(board.openVotes(mark), 2);
        vm.expectRevert(abi.encodeWithSelector(QuorumBoard.NotReady.selector, mark));
        board.finalize(mark);

        // After the window, anyone finalises: median of the two votes received
        _adv(WINDOW);
        vm.prank(outsider);
        board.finalize(mark);
        assertEq(_value(mark), 100.5e18);
        (uint80 r3,, uint256 started,,) = board.latestRoundData(mark);
        assertEq(r3, 3);
        assertEq(started, nowT - WINDOW - 5); // first vote time

        // A late vote for the finalised round is refused
        vm.prank(s3);
        vm.expectRevert(abi.encodeWithSelector(QuorumBoard.WrongRound.selector, 4, 3));
        board.vote(mark, 3, 100e18);

        // A vote arriving after the window (but inside the heartbeat) counts, then the round finalises
        vm.prank(s1);
        board.vote(mark, 4, 100e18);
        _adv(45);
        vm.prank(s2);
        board.vote(mark, 4, 101e18);
        assertEq(_value(mark), 100.5e18);

        // Votes older than the heartbeat are dropped and never enter a median
        vm.prank(s1);
        board.vote(mark, 5, 90e18); // would pull the median if it stayed
        _adv(HEARTBEAT + 1);
        vm.expectEmit(true, true, true, true, address(board));
        emit QuorumBoard.VoteDropped(mark, 5, s1, 90e18);
        vm.prank(s2);
        board.vote(mark, 5, 101e18);
        assertEq(board.openVotes(mark), 1);
        assertFalse(board.hasVoted(mark, 5, s1));
        vm.prank(s3);
        board.vote(mark, 5, 100.6e18);
        // the dropped signer may vote again; with all n fresh votes the round finalises
        vm.prank(s1);
        board.vote(mark, 5, 100.7e18);
        assertEq(_value(mark), 100.7e18); // median of 100.6, 100.7, 101; the stale 90 is gone

        // One vote alone never finalises, however long it waits (it goes stale and is dropped)
        vm.prank(s1);
        board.vote(mark, 6, 100e18);
        _adv(1 days);
        vm.expectRevert(abi.encodeWithSelector(QuorumBoard.NotReady.selector, mark));
        board.finalize(mark);

        // A key's first round has no step clamp, so it needs all n votes: no window shortcut
        bytes32 eth = board.markKey("ETH");
        vm.prank(gov);
        board.setFeed(eth, STEP, HEARTBEAT);
        vm.prank(s1);
        board.vote(eth, 1, 3000e18);
        vm.prank(s2);
        board.vote(eth, 1, 3001e18);
        _adv(WINDOW + 1);
        vm.expectRevert(abi.encodeWithSelector(QuorumBoard.NotReady.selector, eth));
        board.finalize(eth);
        vm.prank(s3);
        board.vote(eth, 1, 3002e18);
        assertEq(_value(eth), 3001e18);
    }

    /// b. The published value moves at most ±step per round from the last final.
    function test_stepClamp() public {
        _voteAll(mark, 100e18, 100e18, 100e18); // first round: no previous value, no clamp
        assertEq(_value(mark), 100e18);

        vm.recordLogs();
        _voteAll(mark, 110e18, 110e18, 110e18); // +10% asked
        assertEq(_value(mark), 102e18); // +2% published
        // the event keeps the raw median beside the published value
        (uint256 median, uint256 published, uint256 votes) =
            abi.decode(vm.getRecordedLogs()[3].data, (uint256, uint256, uint256));
        assertEq(median, 110e18);
        assertEq(published, 102e18);
        assertEq(votes, 3);

        _voteAll(mark, 90e18, 90e18, 90e18); // down: clamped to −2% of 102
        assertEq(_value(mark), 99.96e18);

        _voteAll(mark, 100e18, 100e18, 100e18); // inside the step: unclamped
        assertEq(_value(mark), 100e18);

        // Reaching a far price takes several rounds
        for (uint256 i; i < 5; ++i) {
            _voteAll(mark, 120e18, 120e18, 120e18);
        }
        assertApproxEqRel(_value(mark), 100e18 * 1.02 ** 5, 1e9);
    }

    /// c. With an anchor, values outside ±band are clamped to the band, never refused.
    function test_anchorBand() public {
        bytes32 nvda = board.markKey("NVDA");
        vm.prank(gov);
        board.setFeed(nvda, 5000, HEARTBEAT); // wide step so only the band binds

        // An anchor needs a published value to anchor to
        vm.prank(gov);
        vm.expectRevert(abi.encodeWithSelector(QuorumBoard.NoData.selector, nvda));
        board.setAnchor(nvda, BAND);

        _voteAll(nvda, 100e18, 100e18, 100e18); // last regular-session mark
        vm.prank(gov);
        board.setAnchor(nvda, BAND);
        (bool active, uint16 band, uint256 anchorValue) = board.anchors(nvda);
        assertTrue(active);
        assertEq(band, BAND);
        assertEq(anchorValue, 100e18);

        _voteAll(nvda, 130e18, 130e18, 130e18);
        assertEq(_value(nvda), 110e18); // clamped up to +10%
        _voteAll(nvda, 80e18, 80e18, 80e18);
        assertEq(_value(nvda), 90e18); // clamped down to −10%
        _voteAll(nvda, 95e18, 95e18, 95e18);
        assertEq(_value(nvda), 95e18); // inside the band: as voted

        // Only governance sets or clears anchors
        vm.prank(s1);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, s1, bytes32(0))
        );
        board.setAnchor(nvda, BAND);

        vm.prank(gov);
        board.clearAnchor(nvda);
        _voteAll(nvda, 130e18, 130e18, 130e18);
        assertEq(_value(nvda), 130e18); // band gone (step is 50%)
    }

    /// d. Signer rules, governance rules, and staleness.
    function test_signerRulesAndStaleness() public {
        // Outsiders, unknown keys, wrong rounds, zero values and double votes are refused
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(QuorumBoard.NotSigner.selector, outsider));
        board.vote(mark, 1, 100e18);

        bytes32 unknown = board.markKey("XYZ");
        vm.prank(s1);
        vm.expectRevert(abi.encodeWithSelector(QuorumBoard.UnknownKey.selector, unknown));
        board.vote(unknown, 1, 100e18);

        vm.prank(s1);
        vm.expectRevert(abi.encodeWithSelector(QuorumBoard.WrongRound.selector, 1, 2));
        board.vote(mark, 2, 100e18);

        vm.prank(s1);
        vm.expectRevert(QuorumBoard.ZeroValue.selector);
        board.vote(mark, 1, 0);

        vm.prank(s1);
        vm.expectRevert(abi.encodeWithSelector(QuorumBoard.ValueTooLarge.selector, 1e36 + 1));
        board.vote(mark, 1, 1e36 + 1);

        vm.prank(s1);
        board.vote(mark, 1, 100e18);
        vm.prank(s1);
        vm.expectRevert(abi.encodeWithSelector(QuorumBoard.AlreadyVoted.selector, s1));
        board.vote(mark, 1, 100e18);

        // Governance: m can never drop below 2 (no single key sets a value) or exceed n
        vm.startPrank(gov);
        vm.expectRevert(abi.encodeWithSelector(QuorumBoard.BadQuorum.selector, 1, 3));
        board.setQuorum(1);
        vm.expectRevert(abi.encodeWithSelector(QuorumBoard.BadQuorum.selector, 4, 3));
        board.setQuorum(4);
        board.setQuorum(3);
        vm.expectRevert(abi.encodeWithSelector(QuorumBoard.BadQuorum.selector, 3, 2));
        board.setSigner(s3, false); // would leave n < m
        board.setQuorum(2);
        vm.stopPrank();
        vm.prank(s1);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, s1, bytes32(0))
        );
        board.setSigner(outsider, true);

        // Staleness: no data, then fresh, then stale after the heartbeat
        assertFalse(board.fresh(vol));
        vm.expectRevert(abi.encodeWithSelector(QuorumBoard.NoData.selector, vol));
        board.volBps(BTC);

        _voteAll(vol, 0.5e18, 0.52e18, 0.51e18); // vol as WAD fraction
        assertTrue(board.fresh(vol));
        assertEq(board.volBps(BTC), 5100);

        _adv(HEARTBEAT);
        assertTrue(board.fresh(vol)); // exactly at the heartbeat: still fresh
        _adv(1);
        assertFalse(board.fresh(vol));
        vm.expectRevert(abi.encodeWithSelector(QuorumBoard.Stale.selector, vol, nowT - HEARTBEAT - 1));
        board.volBps(BTC);
        // latestRoundData still answers (AggregatorV3 style); callers check updatedAt
        (, int256 answer,,,) = board.latestRoundData(vol);
        assertEq(answer, 0.51e8);

        // A removed signer can no longer vote
        vm.prank(gov);
        board.setSigner(s3, false);
        vm.prank(s3);
        vm.expectRevert(abi.encodeWithSelector(QuorumBoard.NotSigner.selector, s3));
        board.vote(vol, 2, 0.5e18);
    }

    /// Gas of the vote that finalises a later round (the 3rd of 3), where the previous final is kept.
    function test_finalisingVoteGas() public {
        _voteAll(mark, 100e18, 100e18, 100e18); // round 1
        _adv(20);
        vm.prank(s1);
        board.vote(mark, 2, 101e18);
        vm.prank(s2);
        board.vote(mark, 2, 101e18);
        vm.prank(s3);
        uint256 g = gasleft();
        board.vote(mark, 2, 101e18);
        emit log_named_uint("finalising vote, round 2", g - gasleft());
        _adv(20);
        vm.prank(s1);
        board.vote(mark, 3, 102e18);
        vm.prank(s2);
        board.vote(mark, 3, 102e18);
        vm.prank(s3);
        g = gasleft();
        board.vote(mark, 3, 102e18);
        emit log_named_uint("finalising vote, round 3 (steady state)", g - gasleft());
    }

    /// previousValue: NoData until a second final exists, then always the final before the latest.
    function test_previousValue() public {
        vm.expectRevert(abi.encodeWithSelector(QuorumBoard.NoData.selector, mark));
        board.previousValue(mark);
        _voteAll(mark, 100e18, 100e18, 100e18);
        vm.expectRevert(abi.encodeWithSelector(QuorumBoard.NoData.selector, mark));
        board.previousValue(mark);
        uint256 t1 = nowT;
        _adv(20);
        _voteAll(mark, 101e18, 101e18, 101e18);
        (uint256 v, uint256 at) = board.previousValue(mark);
        assertEq(v, 100e18);
        assertEq(at, t1);
        _adv(20);
        _voteAll(mark, 102e18, 102e18, 102e18);
        (v,) = board.previousValue(mark);
        assertEq(v, 101e18);
        (uint256 latest,) = board.latestValue(mark);
        assertEq(latest, 102e18);
    }
}
