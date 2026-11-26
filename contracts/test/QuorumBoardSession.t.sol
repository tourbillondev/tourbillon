// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {QuorumBoard} from "../src/QuorumBoard.sol";
import {SessionCalendar} from "../src/SessionCalendar.sol";
import {M1Core} from "../script/M1Core.sol";

/// RH4: the session rule on a tokenized-stock MARK key (Backend §4; owner G1). In session the board records each
/// final; out of session every final stays within ±10% of the last in-session one; with none yet, out-of-session
/// rounds do not finalise (law 2: the key stays stale, opens stay closed). Crypto keys are never bound.
contract QuorumBoardSessionTest is Test, M1Core {
    QuorumBoard board;
    SessionCalendar cal;
    address s1 = makeAddr("s1");
    address s2 = makeAddr("s2");
    address s3 = makeAddr("s3");
    address anyone = makeAddr("anyone");
    bytes32 constant STK1 = "STK1";
    bytes32 constant BTC = "BTC";
    bytes32 kStk;
    bytes32 kBtc;

    uint256 constant TUE_1500 = 1_795_532_400; // Tue 2026-11-24 15:00 UTC = 10:00 New York (in session)
    uint256 constant TUE_2200 = 1_795_557_600; // 17:00 New York (after the close)
    uint256 constant WED_1500 = 1_795_618_800; // Wed 10:00 New York
    uint256 constant SAT_1500 = 1_795_878_000; // Sat 2026-11-28
    uint256 nowT;

    function _set(uint256 t) internal {
        nowT = t;
        vm.warp(t);
    }

    function setUp() public {
        _set(TUE_1500);
        address[] memory sg = new address[](3);
        (sg[0], sg[1], sg[2]) = (s1, s2, s3);
        board = new QuorumBoard(address(this), sg, 2, 30);
        cal = new SessionCalendar(address(this));
        CalendarData memory d = loadCalendar(CALENDAR_FILE);
        for (uint256 i; i < d.yearList.length; ++i) {
            CalYear memory y = d.yearList[i];
            cal.setYear(y.year, y.dstStart, y.dstEnd, y.holidays, y.earlyCloses);
        }
        cal.setStockMarket(STK1, true);
        kStk = board.markKey(STK1);
        kBtc = board.markKey(BTC);
        board.setFeed(kStk, 200, 60);
        board.setFeed(kBtc, 200, 60);
        board.setCalendar(cal);
        board.setSessionKey(kStk, 1000);
    }

    /// All three signers vote `v` in the next round (finalises at once).
    function _round(bytes32 key, uint256 v) internal returns (uint256 published) {
        uint80 r;
        try board.latestRoundData(key) returns (uint80 id, int256, uint256, uint256, uint80) {
            r = id;
        } catch {}
        ++r;
        vm.prank(s1);
        board.vote(key, r, v);
        vm.prank(s2);
        board.vote(key, r, v);
        vm.prank(s3);
        board.vote(key, r, v);
        (published,) = board.latestValue(key);
    }

    function test_inSessionFinalsAreRecorded() public {
        assertEq(_round(kStk, 400e18), 400e18);
        assertEq(board.sessionValue(kStk), 400e18);
        _set(nowT + 60);
        assertEq(_round(kStk, 404e18), 404e18); // 1% move, inside the 2% step
        assertEq(board.sessionValue(kStk), 404e18, "the last in-session final is the anchor");
    }

    function test_outOfSessionFinalsStayWithinTenPercentOfTheLastSessionValue() public {
        _round(kStk, 400e18);
        _set(TUE_2200);
        // signers vote the token price alone after the close; a run of votes 30% higher climbs 2% a round (step clamp)
        // and stops at +10% of the session value
        uint256 p;
        for (uint256 i; i < 10; ++i) {
            _set(nowT + 60);
            p = _round(kStk, 520e18);
        }
        assertEq(p, 440e18, "capped at +10%");
        assertEq(board.sessionValue(kStk), 400e18, "out-of-session finals never move the anchor");
        // and down, past −10%
        for (uint256 i; i < 20; ++i) {
            _set(nowT + 60);
            p = _round(kStk, 200e18);
        }
        assertEq(p, 360e18, "capped at -10%");
        // the next morning the session rule lets go: only the step clamp applies, and the anchor follows again
        _set(WED_1500);
        assertEq(_round(kStk, 365e18), 365e18);
        assertEq(board.sessionValue(kStk), 365e18);
    }

    function test_weekendsAreAnchoredToo() public {
        _round(kStk, 400e18);
        _set(SAT_1500);
        uint256 p;
        for (uint256 i; i < 8; ++i) {
            _set(nowT + 60);
            p = _round(kStk, 600e18);
        }
        assertEq(p, 440e18);
    }

    function test_withNoSessionValueYetOutOfSessionRoundsDoNotFinalise() public {
        _set(SAT_1500); // listed on a weekend: no in-session value
        vm.prank(s1);
        board.vote(kStk, 1, 400e18);
        vm.prank(s2);
        board.vote(kStk, 1, 400e18);
        vm.prank(s3);
        board.vote(kStk, 1, 400e18); // all three in: still not final
        vm.expectRevert(abi.encodeWithSelector(QuorumBoard.NoData.selector, kStk));
        board.latestValue(kStk);
        assertFalse(board.fresh(kStk), "stale: opens on the market stay closed (law 2)");
        _set(nowT + 31);
        vm.expectRevert(abi.encodeWithSelector(QuorumBoard.NotReady.selector, kStk));
        board.finalize(kStk);
        // Monday's session: the old votes are dropped as stale, fresh votes finalise and anchor
        _set(1_796_052_600); // Mon 2026-11-30 15:30 UTC = 10:30 New York
        assertEq(_round(kStk, 401e18), 401e18);
        assertEq(board.sessionValue(kStk), 401e18);
    }

    function test_cryptoKeysHaveNoSessionRule() public {
        _round(kBtc, 97_000e18);
        _set(SAT_1500);
        uint256 p;
        for (uint256 i; i < 10; ++i) {
            _set(nowT + 60);
            p = _round(kBtc, 150_000e18);
        }
        assertGt(p, 97_000e18 * 11 / 10, "only the step clamp applies to crypto");
        assertEq(board.sessionValue(kBtc), 0);
    }

    function test_settingsGovernanceOnlyAndBounded() public {
        bytes memory denied = abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, anyone, bytes32(0));
        vm.startPrank(anyone);
        vm.expectRevert(denied);
        board.setSessionKey(kBtc, 500);
        vm.expectRevert(denied);
        board.setCalendar(cal);
        vm.stopPrank();
        vm.expectRevert(QuorumBoard.BadConfig.selector);
        board.setSessionKey(kStk, 1001); // more than 10%
        bytes32 nope = board.markKey("NOPE"); // computed first: a call inside the arguments would take the expectRevert
        vm.expectRevert(QuorumBoard.BadConfig.selector);
        board.setSessionKey(nope, 1000); // not listed
        vm.expectRevert(QuorumBoard.BadConfig.selector);
        board.setCalendar(SessionCalendar(anyone)); // not a contract
        QuorumBoard fresh = new QuorumBoard(address(this), _signers(), 2, 30);
        fresh.setFeed(kStk, 200, 60);
        vm.expectRevert(QuorumBoard.BadConfig.selector);
        fresh.setSessionKey(kStk, 1000); // no calendar yet
        // unbinding clears the anchor
        _round(kStk, 400e18);
        board.setSessionKey(kStk, 0);
        assertEq(board.sessionValue(kStk), 0);
    }

    /// Fuzz: after the close, whatever the signers vote, every final stays within ±10% of the session value.
    function testFuzz_outOfSessionAlwaysInsideTheBand(uint256 seed) public {
        _round(kStk, 400e18);
        _set(TUE_2200);
        for (uint256 i; i < 12; ++i) {
            _set(nowT + 60);
            uint256 v = bound(uint256(keccak256(abi.encode(seed, i))), 1e18, 4_000e18);
            uint256 p = _round(kStk, v);
            assertGe(p, 360e18);
            assertLe(p, 440e18);
        }
    }

    function _signers() internal view returns (address[] memory sg) {
        sg = new address[](3);
        (sg[0], sg[1], sg[2]) = (s1, s2, s3);
    }
}
