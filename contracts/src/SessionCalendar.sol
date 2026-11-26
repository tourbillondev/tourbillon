// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice What the board and the pool ask the calendar.
interface ISessionCalendar {
    function isRegularSession(uint256 t) external view returns (bool);
    function isClosedDay(uint256 t) external view returns (bool);
    function openCapBps(bytes32 market) external view returns (uint256);
}

/// @title SessionCalendar
/// @notice The regular US equity session for tokenized-stock markets (Backend §4; owner G1–G3): 09:30–16:00 New York,
///         Monday to Friday, without US market holidays, closing early on early-close days, with New York's daylight
///         saving. Every setting goes through governance (the timelock). Read the same data the signers read
///         (`calendar/us-regular-session.json`).
///         - Marks: QuorumBoard anchors a stock key's out-of-session rounds to its last in-session value (±10%).
///         - Caps (G3): on a weekend or holiday, opens on a stock market are capped at 25% of normal; sells never.
///         - Crypto markets have no session: they are never listed here.
///         A year that is not set counts as closed (the cautious side: marks anchored, caps at 25%).
/// @dev    Day numbers are days since 1970-01-01 in New York dates. (U): Robinhood Chain's own trading hours are not
///         confirmed (owner queue Q11).
contract SessionCalendar is ISessionCalendar, AccessControl {
    uint256 public constant BPS = 10_000;
    uint256 public constant WEEKEND_CAP_BPS = 2_500; // G3: a quarter of normal
    uint8 internal constant HOLIDAY = 1;
    uint8 internal constant EARLY_CLOSE = 2;

    struct Year {
        bool set;
        uint64 dstStart; // UTC second daylight saving starts (02:00 New York)
        uint64 dstEnd; // UTC second it ends
    }

    struct Hours {
        uint16 open; // minutes after midnight, New York
        uint16 close;
        uint16 earlyClose;
    }

    Hours public sessionHours = Hours(570, 960, 780);
    mapping(uint256 => Year) public yearInfo;
    mapping(uint256 => uint8) public dayKind; // day number → HOLIDAY or EARLY_CLOSE
    mapping(uint256 => uint32[]) internal _daysOf; // the days set for a year, cleared when the year is set again
    mapping(bytes32 => bool) public isStockMarket;

    event YearSet(uint256 indexed year, uint64 dstStart, uint64 dstEnd, uint32[] holidays, uint32[] earlyCloses);
    event HoursSet(uint16 open, uint16 close, uint16 earlyClose);
    event StockMarketSet(bytes32 indexed market, bool isStock);

    error BadYear(uint256 year);
    error BadDst();
    error BadDay(uint256 day);
    error BadHours();
    error BadMarket();

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------- reads

    /// @notice True when `t` (Unix seconds) falls inside a regular session.
    function isRegularSession(uint256 t) public view returns (bool) {
        (bool listed, uint256 day, uint256 minute) = _local(t);
        if (!listed || _weekend(day)) return false;
        uint8 kind = dayKind[day];
        if (kind == HOLIDAY) return false;
        Hours memory h = sessionHours;
        return minute >= h.open && minute < (kind == EARLY_CLOSE ? h.earlyClose : h.close);
    }

    /// @notice True on a weekend or a holiday (New York date), and in any year that is not set.
    function isClosedDay(uint256 t) public view returns (bool) {
        (bool listed, uint256 day,) = _local(t);
        return !listed || _weekend(day) || dayKind[day] == HOLIDAY;
    }

    /// @notice The share of a market's normal open caps allowed now, in bps: 25% on a weekend or holiday for a
    ///         tokenized-stock market, else 100%.
    function openCapBps(bytes32 market) external view returns (uint256) {
        return isStockMarket[market] && isClosedDay(block.timestamp) ? WEEKEND_CAP_BPS : BPS;
    }

    function daysOf(uint256 year) external view returns (uint32[] memory) {
        return _daysOf[year];
    }

    // ---------------------------------------------------------------- governance

    /// @notice Sets (or replaces) one year: its daylight-saving switch times and its holidays and early closes.
    function setYear(uint16 year, uint64 dstStart, uint64 dstEnd, uint32[] calldata holidays, uint32[] calldata earlyCloses)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (year < 1971 || year > 9999) revert BadYear(year);
        if (dstStart >= dstEnd || _yearOfDay(dstStart / 1 days) != year || _yearOfDay(dstEnd / 1 days) != year) {
            revert BadDst();
        }
        uint32[] storage old = _daysOf[year];
        for (uint256 i; i < old.length; ++i) {
            delete dayKind[old[i]];
        }
        delete _daysOf[year];
        _setDays(year, holidays, HOLIDAY);
        _setDays(year, earlyCloses, EARLY_CLOSE);
        yearInfo[year] = Year(true, dstStart, dstEnd);
        emit YearSet(year, dstStart, dstEnd, holidays, earlyCloses);
    }

    function setHours(uint16 open, uint16 close, uint16 earlyClose) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!(open < earlyClose && earlyClose < close && close <= 1440)) revert BadHours();
        sessionHours = Hours(open, close, earlyClose);
        emit HoursSet(open, close, earlyClose);
    }

    function setStockMarket(bytes32 market, bool isStock) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (market == bytes32(0)) revert BadMarket();
        isStockMarket[market] = isStock;
        emit StockMarketSet(market, isStock);
    }

    // ---------------------------------------------------------------- internals

    function _setDays(uint256 year, uint32[] calldata ds, uint8 kind) internal {
        for (uint256 i; i < ds.length; ++i) {
            uint256 d = ds[i];
            if (_yearOfDay(d) != year || _weekend(d) || dayKind[d] != 0) revert BadDay(d);
            dayKind[d] = kind;
            _daysOf[year].push(uint32(d));
        }
    }

    /// @dev New York day number and minute of `t`, and whether that day's year is set. Daylight saving comes from the
    ///      UTC year's switch times (both fall well inside the year, so New Year never straddles a switch).
    function _local(uint256 t) internal view returns (bool listed, uint256 day, uint256 minute) {
        Year memory y = yearInfo[_yearOfDay(t / 1 days)];
        uint256 offset = y.set && t >= y.dstStart && t < y.dstEnd ? 4 hours : 5 hours;
        if (t < offset) return (false, 0, 0);
        uint256 local = t - offset;
        day = local / 1 days;
        minute = (local % 1 days) / 60;
        listed = yearInfo[_yearOfDay(day)].set;
    }

    /// @dev 1970-01-01 was a Thursday.
    function _weekend(uint256 day) internal pure returns (bool) {
        uint256 wd = (day + 4) % 7; // 0 = Sunday
        return wd == 0 || wd == 6;
    }

    /// @dev The civil year of a day number (H. Hinnant's days-to-civil, for days on or after 1970-01-01).
    function _yearOfDay(uint256 z) internal pure returns (uint256) {
        z += 719_468;
        uint256 era = z / 146_097;
        uint256 doe = z - era * 146_097;
        uint256 yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        uint256 y = yoe + era * 400;
        return mp >= 10 ? y + 1 : y; // months 1 and 2 belong to the next civil year
    }
}
