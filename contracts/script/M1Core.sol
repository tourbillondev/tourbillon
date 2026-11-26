// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {QuorumBoard} from "../src/QuorumBoard.sol";
import {QuorumMarkSource} from "../src/QuorumMarkSource.sol";
import {MarkRouter} from "../src/MarkRouter.sol";
import {IMarkSource} from "../src/IMarkSource.sol";
import {SessionCalendar} from "../src/SessionCalendar.sol";
import {CommonBase} from "forge-std/Base.sol";

/// @title M1Core
/// @notice The M1 contracts and their settings, deployed by the calling script with the deployer as admin: QuorumBoard
///         (MARK and VOL feeds per market), QuorumMarkSource and MarkRouter with a quorum-only route queued for every
///         market; the SessionCalendar (RH4) with the regular US session from `calendar/us-regular-session.json`, the
///         tokenized-stock markets listed on it, and their MARK keys bound to the session rule (±10%). DeployM1 hands the
///         admin roles to `ADMIN`; DeployM7 lists more first and hands them to the timelock.
abstract contract M1Core is CommonBase {
    uint256 public constant QUORUM = 2; // m of n = 3
    uint256 public constant WINDOW = 30 seconds;
    uint16 public constant MARK_STEP_BPS = 200; // 2% per round
    uint32 public constant MARK_HEARTBEAT = 60 seconds;
    uint16 public constant VOL_STEP_BPS = 1000; // 10% per round (sanity cap; vol moves slowly)
    uint32 public constant VOL_HEARTBEAT = 15 minutes;
    uint32 public constant MARK_MAX_AGE = 120 seconds;
    uint256 public constant ROUTER_DELAY = 1 hours; // the router's own delay (testnet; M7 G8 keeps it behind the timelock)
    uint256 public constant MIN_SIGNERS = 3;
    uint16 public constant SESSION_BAND_BPS = 1000; // ±10% (Backend §4)
    string public constant CALENDAR_FILE = "calendar/us-regular-session.json";

    struct CalYear {
        uint16 year;
        uint64 dstStart;
        uint64 dstEnd;
        uint32[] holidays;
        uint32[] earlyCloses;
    }

    struct CalendarData {
        uint16 open;
        uint16 close;
        uint16 earlyClose;
        CalYear[] yearList;
    }

    error NotAMarket(bytes32 market);

    struct M1Deployed {
        QuorumBoard board;
        QuorumMarkSource quorumSource;
        MarkRouter router;
        uint64 routeEta;
        SessionCalendar calendar;
    }

    /// @notice Deploys and configures the M1 contracts; `deployer` keeps every admin role.
    function m1Core(
        address deployer,
        address[] memory signers,
        bytes32[] memory markets,
        bytes32[] memory stockMarkets,
        CalendarData memory cal
    ) public returns (M1Deployed memory d) {
        d.board = new QuorumBoard(deployer, signers, QUORUM, WINDOW);
        for (uint256 i; i < markets.length; ++i) {
            d.board.setFeed(d.board.markKey(markets[i]), MARK_STEP_BPS, MARK_HEARTBEAT);
            d.board.setFeed(d.board.volKey(markets[i]), VOL_STEP_BPS, VOL_HEARTBEAT);
        }
        d.quorumSource = new QuorumMarkSource(d.board);
        d.router = new MarkRouter(deployer, ROUTER_DELAY);
        MarkRouter.Route memory r = MarkRouter.Route({
            primary: IMarkSource(address(d.quorumSource)),
            secondary: IMarkSource(address(0)),
            maxAge: MARK_MAX_AGE,
            maxDevBps: 0
        });
        for (uint256 i; i < markets.length; ++i) {
            d.router.queueRoute(markets[i], r);
        }
        (, d.routeEta) = d.router.pending(markets[0]);

        // the session calendar and the stock markets' session rule (RH4)
        d.calendar = new SessionCalendar(deployer);
        d.calendar.setHours(cal.open, cal.close, cal.earlyClose);
        for (uint256 i; i < cal.yearList.length; ++i) {
            CalYear memory y = cal.yearList[i];
            d.calendar.setYear(y.year, y.dstStart, y.dstEnd, y.holidays, y.earlyCloses);
        }
        d.board.setCalendar(d.calendar);
        for (uint256 i; i < stockMarkets.length; ++i) {
            bool listed;
            for (uint256 j; j < markets.length; ++j) {
                if (markets[j] == stockMarkets[i]) listed = true;
            }
            if (!listed) revert NotAMarket(stockMarkets[i]);
            d.calendar.setStockMarket(stockMarkets[i], true);
            d.board.setSessionKey(d.board.markKey(stockMarkets[i]), SESSION_BAND_BPS);
        }
    }

    /// @notice The calendar data file (one source for the signers and the chain).
    function loadCalendar(string memory path) public view returns (CalendarData memory cal) {
        string memory json = vm.readFile(path);
        cal.open = uint16(vm.parseJsonUint(json, ".hours.open"));
        cal.close = uint16(vm.parseJsonUint(json, ".hours.close"));
        cal.earlyClose = uint16(vm.parseJsonUint(json, ".hours.earlyClose"));
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(".years[", vm.toString(n), "]"))) ++n;
        cal.yearList = new CalYear[](n);
        for (uint256 i; i < n; ++i) {
            string memory at = string.concat(".years[", vm.toString(i), "]");
            cal.yearList[i].year = uint16(vm.parseJsonUint(json, string.concat(at, ".year")));
            cal.yearList[i].dstStart = uint64(vm.parseJsonUint(json, string.concat(at, ".dstStart")));
            cal.yearList[i].dstEnd = uint64(vm.parseJsonUint(json, string.concat(at, ".dstEnd")));
            cal.yearList[i].holidays = _u32(vm.parseJsonUintArray(json, string.concat(at, ".holidays")));
            cal.yearList[i].earlyCloses = _u32(vm.parseJsonUintArray(json, string.concat(at, ".earlyCloses")));
        }
    }

    function _u32(uint256[] memory a) internal pure returns (uint32[] memory out) {
        out = new uint32[](a.length);
        for (uint256 i; i < a.length; ++i) {
            out[i] = uint32(a[i]);
        }
    }
}
