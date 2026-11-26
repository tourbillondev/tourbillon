// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {SessionCalendar} from "../src/SessionCalendar.sol";
import {M1Core} from "../script/M1Core.sol";

/// RH4: the regular US session on-chain (owner G1–G3), loaded from the same data file the signers read.
contract SessionCalendarTest is Test, M1Core {
    SessionCalendar cal;
    address gov = makeAddr("timelock");
    address anyone = makeAddr("anyone");
    bytes32 constant STK1 = "STK1";
    bytes32 constant BTC = "BTC";

    // UTC instants (checked against the New York clock by hand)
    uint256 constant TUE_OPEN_EST = 1_795_530_600; // Tue 2026-11-24 14:30 UTC = 09:30 New York
    uint256 constant WED_OPEN_EDT = 1_784_122_200; // Wed 2026-07-15 13:30 UTC = 09:30 New York
    uint256 constant SAT_NOON = 1_795_885_200; // Sat 2026-11-28 17:00 UTC
    uint256 constant THANKSGIVING = 1_795_705_200; // Thu 2026-11-26 15:00 UTC
    uint256 constant DAY_AFTER_TG_1259 = 1_795_802_340; // Fri 2026-11-27 17:59 UTC = 12:59 New York

    function setUp() public {
        cal = new SessionCalendar(gov);
        CalendarData memory d = loadCalendar(CALENDAR_FILE);
        vm.startPrank(gov);
        cal.setHours(d.open, d.close, d.earlyClose);
        for (uint256 i; i < d.yearList.length; ++i) {
            CalYear memory y = d.yearList[i];
            cal.setYear(y.year, y.dstStart, y.dstEnd, y.holidays, y.earlyCloses);
        }
        cal.setStockMarket(STK1, true);
        vm.stopPrank();
    }

    function test_regularHoursInBothDaylightSavingSeasons() public view {
        assertFalse(cal.isRegularSession(TUE_OPEN_EST - 1));
        assertTrue(cal.isRegularSession(TUE_OPEN_EST));
        assertTrue(cal.isRegularSession(TUE_OPEN_EST + 6.5 hours - 1)); // 15:59:59
        assertFalse(cal.isRegularSession(TUE_OPEN_EST + 6.5 hours)); // 16:00
        assertFalse(cal.isRegularSession(WED_OPEN_EDT - 60));
        assertTrue(cal.isRegularSession(WED_OPEN_EDT));
        assertFalse(cal.isRegularSession(WED_OPEN_EDT + 6.5 hours));
    }

    function test_theDaylightSavingSwitchDays() public view {
        // Monday 2026-03-09 (after the 2026-03-08 switch): 09:30 New York = 13:30 UTC
        assertTrue(cal.isRegularSession(1_773_063_000));
        assertFalse(cal.isRegularSession(1_773_063_000 - 60));
        // Monday 2026-11-02 (after the 2026-11-01 switch): 09:30 New York = 14:30 UTC
        assertFalse(cal.isRegularSession(1_793_629_800 - 3600));
        assertTrue(cal.isRegularSession(1_793_629_800));
    }

    function test_weekendsHolidaysAndEarlyCloses() public view {
        assertFalse(cal.isRegularSession(SAT_NOON));
        assertTrue(cal.isClosedDay(SAT_NOON));
        assertFalse(cal.isRegularSession(THANKSGIVING));
        assertTrue(cal.isClosedDay(THANKSGIVING));
        assertTrue(cal.isRegularSession(DAY_AFTER_TG_1259)); // early close at 13:00
        assertFalse(cal.isRegularSession(DAY_AFTER_TG_1259 + 60));
        assertFalse(cal.isClosedDay(DAY_AFTER_TG_1259 + 60), "an early close is a trading day: full caps");
        assertFalse(cal.isClosedDay(TUE_OPEN_EST + 10 hours), "a weekday evening is not a closed day");
    }

    function test_unlistedYearsAreClosed() public view {
        assertFalse(cal.isRegularSession(1_764_084_600)); // Tue 2025-11-25 15:30 UTC
        assertTrue(cal.isClosedDay(1_764_084_600));
        assertFalse(cal.isRegularSession(1_836_660_600)); // Tue 2028-03-14
        assertTrue(cal.isClosedDay(1_836_660_600));
    }

    function test_openCapsAQuarterOnWeekendsAndHolidaysForStockMarketsOnly() public {
        vm.warp(SAT_NOON);
        assertEq(cal.openCapBps(STK1), 2_500);
        assertEq(cal.openCapBps(BTC), 10_000, "crypto has no weekend rule");
        vm.warp(THANKSGIVING);
        assertEq(cal.openCapBps(STK1), 2_500);
        vm.warp(TUE_OPEN_EST + 10 hours); // a weekday evening: anchored marks, full caps
        assertEq(cal.openCapBps(STK1), 10_000);
    }

    function test_governanceOnly() public {
        bytes memory denied = abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, anyone, bytes32(0));
        vm.startPrank(anyone);
        vm.expectRevert(denied);
        cal.setYear(2028, 1, 2, new uint32[](0), new uint32[](0));
        vm.expectRevert(denied);
        cal.setHours(570, 960, 780);
        vm.expectRevert(denied);
        cal.setStockMarket(BTC, true);
        vm.stopPrank();
    }

    function test_badSettingsRefused() public {
        uint32[] memory none = new uint32[](0);
        vm.startPrank(gov);
        vm.expectRevert(SessionCalendar.BadDst.selector);
        cal.setYear(2028, 1_836_000_000, 1_835_000_000, none, none); // end before start
        vm.expectRevert(SessionCalendar.BadDst.selector);
        cal.setYear(2028, 1_773_000_000, 1_836_660_600, none, none); // start in 2026
        uint32[] memory bad = new uint32[](1);
        bad[0] = 20_454; // 2026-01-01, not in 2028
        vm.expectRevert(abi.encodeWithSelector(SessionCalendar.BadDay.selector, 20_454));
        cal.setYear(2028, 1_836_000_000, 1_857_000_000, bad, none);
        bad[0] = 21_191; // Saturday 2028-01-08: a weekend day is never a holiday
        vm.expectRevert(abi.encodeWithSelector(SessionCalendar.BadDay.selector, 21_191));
        cal.setYear(2028, 1_836_000_000, 1_857_000_000, bad, none);
        uint32[] memory twice = new uint32[](2);
        (twice[0], twice[1]) = (21_194, 21_194); // Tuesday 2028-01-11 twice
        vm.expectRevert(abi.encodeWithSelector(SessionCalendar.BadDay.selector, 21_194));
        cal.setYear(2028, 1_836_000_000, 1_857_000_000, twice, none);
        vm.expectRevert(SessionCalendar.BadHours.selector);
        cal.setHours(960, 570, 780);
        vm.expectRevert(SessionCalendar.BadHours.selector);
        cal.setHours(570, 1441, 780);
        vm.expectRevert(SessionCalendar.BadMarket.selector);
        cal.setStockMarket(bytes32(0), true);
        vm.expectRevert(abi.encodeWithSelector(SessionCalendar.BadYear.selector, 1970));
        cal.setYear(1970, 1, 2, none, none);
        vm.stopPrank();
    }

    function test_settingAYearAgainReplacesItsDays() public {
        assertFalse(cal.isRegularSession(THANKSGIVING));
        (bool set, uint64 s, uint64 e) = cal.yearInfo(2026);
        assertTrue(set);
        vm.prank(gov);
        cal.setYear(2026, s, e, new uint32[](0), new uint32[](0)); // no holidays any more
        assertTrue(cal.isRegularSession(THANKSGIVING));
        assertEq(cal.daysOf(2026).length, 0);
    }

    /// Fuzz: a moment in the regular session is never on a closed day, and every answer is defined (never reverts).
    function testFuzz_sessionImpliesTradingDay(uint256 t) public view {
        t = bound(t, 0, 2 ** 40);
        if (cal.isRegularSession(t)) assertFalse(cal.isClosedDay(t));
    }
}
