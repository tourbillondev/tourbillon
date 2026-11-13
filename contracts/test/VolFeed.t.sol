// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VolFeed} from "../src/VolFeed.sol";
import {TempoBlend} from "../src/TempoBlend.sol";

/// M6 step 8: the vol feed on its own.
contract VolFeedTest is Test {
    bytes32 constant BTC = "BTC";
    address constant ADMIN = address(0xAD);
    address constant REC = address(0x0B00);
    VolFeed feed;

    function setUp() public {
        vm.warp(1_794_182_400);
        feed = new VolFeed(ADMIN);
        vm.prank(ADMIN);
        feed.setRecorder(REC);
    }

    function _mv(uint256 t1, uint256 w1, uint256 t2) internal pure returns (TempoBlend.Part[] memory m) {
        m = new TempoBlend.Part[](2);
        m[0] = TempoBlend.Part(t1, w1);
        m[1] = TempoBlend.Part(t2, 1e18 - w1);
    }

    function test_buckets() public view {
        uint256[10] memory t =
            [uint256(1 hours), 4 hours, 5 hours, 1 days, 2.6 days, 2.7 days, 7 days, 14 days, 15 days, 30 days];
        uint8[10] memory b = [uint8(0), 0, 1, 1, 1, 2, 2, 2, 3, 3];
        for (uint256 i; i < 10; ++i) {
            assertEq(feed.bucketOf(TempoBlend.single(t[i])), b[i]);
        }
        // a Movement: its weighted-average tempo (half 1 day, half 7 days = 4 days: the 7-day bucket)
        assertEq(feed.bucketOf(_mv(1 days, 0.5e18, 7 days)), 2);
        // mostly 1 hour, a little 30 days (0.9 h + 3 d = 3.04 d): the 7-day bucket
        assertEq(feed.bucketOf(_mv(1 hours, 0.9e18, 30 days)), 2);
    }

    function test_recordsAndWeightsWithADailyHalfLife() public {
        (uint256 last, uint256 avg, uint256 board, uint256 count, uint256 at) = feed.read(BTC, 1);
        assertEq(last + avg + board + count + at, 0, "empty");
        TempoBlend.Part[] memory day = TempoBlend.single(1 days);
        vm.startPrank(REC);
        feed.record(BTC, day, 4000, 4500, 100e6, 2);
        feed.record(BTC, day, 5000, 4500, 300e6, 3); // same time: (4,000 × 100 + 5,000 × 300) / 400 = 4,750
        (last, avg, board, count,) = feed.read(BTC, 1);
        assertEq(last, 5000);
        assertEq(avg, 4750);
        assertEq(board, 4500);
        assertEq(count, 2);
        // a day later the earlier weights count half: (4,750 × 400 / 2 + 3,000 × 200) / (200 + 200) = 3,875
        vm.warp(block.timestamp + 1 days);
        feed.record(BTC, day, 3000, 0, 200e6, 2);
        vm.stopPrank();
        (last, avg, board, count, at) = feed.read(BTC, 1);
        assertEq(last, 3000);
        assertApproxEqAbs(avg, 3875, 1);
        assertEq(board, 0, "the board was stale at that fill");
        assertEq(count, 3);
        assertEq(at, block.timestamp);
        // other buckets and markets untouched
        (,,, count,) = feed.read(BTC, 2);
        assertEq(count, 0);
        (,,, count,) = feed.read("ETH", 1);
        assertEq(count, 0);
    }

    function test_onlyTheRecorderAndSetOnce() public {
        TempoBlend.Part[] memory day = TempoBlend.single(1 days);
        vm.expectRevert(VolFeed.NotRecorder.selector);
        feed.record(BTC, day, 4000, 4500, 1, 2);
        vm.prank(ADMIN);
        vm.expectRevert(VolFeed.AlreadySet.selector);
        feed.setRecorder(address(0x1234));
        VolFeed fresh = new VolFeed(ADMIN);
        vm.expectRevert(VolFeed.NotAdmin.selector);
        fresh.setRecorder(REC);
        vm.prank(REC);
        vm.expectRevert(VolFeed.NotRecorder.selector); // no recorder set: nobody records
        fresh.record(BTC, day, 4000, 4500, 1, 2);
    }
}
