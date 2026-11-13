// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Kit suite: QuorumBoard (4 tests), run against our QuorumBoard.
///
/// Changes from the kit file, and why:
///   1. Contract renamed KitQuorumBoardTest so names do not clash with our suite.
///   2. Our constructor (admin, signers, m, window) and setFeed(key, step, heartbeat) replace the kit's
///      setSigner / registerSignerList / configure. m = 3 of n = 5 and the kit's steps and heartbeats are kept.
///      Our m is board-wide, not per key.
///   3. vote(key, round, value): our votes carry the round number.
///   4. One VOL key per market, volKey(name), instead of the kit's per-tempo volKey(name, tau) (decision Q12).
///   5. Values are WAD (a vol of 50% is 0.5e18; latestRoundData answers at 8 decimals), so vols are written
///      as WAD and read back with volBps(name) or at 8 decimals.
///   6. A key's first round needs all n votes (our rule), so each test opens with a full bootstrap round
///      where the kit's first round had only m votes.
///   7. A later round with m but not all n votes finalises once the window (30 s) has passed since its
///      oldest vote (our rule), so the tests wait out the window before the m-th vote.
///   8. setAnchor takes no value (our rule): the anchor is the board's published value, so the Friday close
///      is published by the quorum first and then anchored with a 10% band.
///   9. Errors carry arguments (NotSigner(account), AlreadyVoted(signer)).
///  10. Time moves through a tracked clock (_adv), the kit's own technique elsewhere: with via-IR,
///      block.timestamp can be cached inside one test function, so two warps from it land on the same time.
///   The kit's scenarios and expected results are otherwise unchanged.

import {Test} from "forge-std/Test.sol";
import {QuorumBoard} from "../../src/QuorumBoard.sol";

contract KitQuorumBoardTest is Test {
    uint256 constant WINDOW = 30;
    QuorumBoard b;
    address[] signers;
    bytes32 vk;
    bytes32 mk;
    uint256 nowT = 1_794_236_400;

    function _adv(uint256 dt) internal {
        nowT += dt;
        vm.warp(nowT);
    }

    function setUp() public {
        vm.warp(nowT);
        for (uint256 i; i < 5; i++) {
            signers.push(address(uint160(0x5100 + i)));
        }
        b = new QuorumBoard(address(this), signers, 3, WINDOW);
        vk = b.volKey("NVDA");
        mk = b.markKey("NVDA");
        b.setFeed(vk, 2500, 2 hours);
        b.setFeed(mk, 1000, 15 minutes);
    }

    function _round(bytes32 k) internal view returns (uint80 r) {
        try b.latestRoundData(k) returns (uint80 id, int256, uint256, uint256, uint80) {
            r = id;
        } catch {}
        r += 1;
    }

    function _vote(bytes32 k, uint256 i, uint256 v) internal {
        uint80 r = _round(k);
        vm.prank(signers[i]);
        b.vote(k, r, v);
    }

    /// All five signers vote the same value: a key's first round needs all n.
    function _bootstrap(bytes32 k, uint256 v) internal {
        for (uint256 i; i < 5; i++) {
            _vote(k, i, v);
        }
    }

    function test_median_of_quorum_and_one_signer_cannot_move_it() public {
        _bootstrap(vk, 0.5e18);
        _vote(vk, 0, 0.5e18);
        _vote(vk, 1, 0.52e18);
        (uint80 id,,,,) = b.latestRoundData(vk);
        assertEq(id, 1, "no final before quorum");
        _adv(WINDOW);
        _vote(vk, 2, 9e18); // a rogue or broken signer
        (, int256 a,,,) = b.latestRoundData(vk);
        assertEq(a, 0.52e8, "median ignores the outlier");
        assertEq(b.volBps("NVDA"), 5200);
        assertTrue(b.fresh(vk));
    }

    function test_step_clamp_limits_a_captured_quorum() public {
        _bootstrap(vk, 0.5e18);
        _vote(vk, 0, 2e18);
        _vote(vk, 1, 2e18);
        _adv(WINDOW);
        _vote(vk, 2, 2e18);
        assertEq(b.volBps("NVDA"), 6250, "+25% max per final");
    }

    function test_weekend_mark_clamped_to_anchor_band() public {
        _bootstrap(mk, 100e18); // Friday close, published by the quorum
        b.setAnchor(mk, 1000); // anchored to it, ±10%
        _vote(mk, 0, 104e18);
        _vote(mk, 1, 105e18);
        _adv(WINDOW);
        _vote(mk, 2, 103e18);
        (uint256 v,) = b.latestValue(mk);
        assertEq(v, 104e18);
        _vote(mk, 0, 140e18);
        _vote(mk, 1, 140e18);
        _adv(WINDOW);
        _vote(mk, 2, 140e18);
        (v,) = b.latestValue(mk);
        assertEq(v, 110e18, "never beyond +/-10% of the anchor (and +/-10% per step)");
    }

    function test_only_signers_once_per_round_and_staleness() public {
        vm.expectRevert(abi.encodeWithSelector(QuorumBoard.NotSigner.selector, address(this)));
        b.vote(vk, 1, 0.5e18);
        _vote(vk, 0, 0.5e18);
        vm.prank(signers[0]);
        vm.expectRevert(abi.encodeWithSelector(QuorumBoard.AlreadyVoted.selector, signers[0]));
        b.vote(vk, 1, 0.51e18);
        _vote(vk, 1, 0.5e18);
        _vote(vk, 2, 0.5e18);
        _vote(vk, 3, 0.5e18);
        _vote(vk, 4, 0.5e18);
        _adv(3 hours);
        assertFalse(b.fresh(vk), "stale after heartbeat");
        _vote(vk, 0, 0.51e18); // new round open again for signer 0
    }
}
