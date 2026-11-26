// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISessionCalendar} from "../../src/SessionCalendar.sol";

/// Test stand-in: the cap share and the session answers are set directly (the real rules are SessionCalendar's own
/// tests). Lets the pool's tests show each cap check applies the share it is given.
contract MockSessionCalendar is ISessionCalendar {
    mapping(bytes32 => uint256) public capBps;
    bool public inSession;
    bool public closedDay;

    function setCapBps(bytes32 market, uint256 bps) external {
        capBps[market] = bps;
    }

    function setSession(bool inSession_, bool closedDay_) external {
        (inSession, closedDay) = (inSession_, closedDay_);
    }

    function isRegularSession(uint256) external view returns (bool) {
        return inSession;
    }

    function isClosedDay(uint256) external view returns (bool) {
        return closedDay;
    }

    function openCapBps(bytes32 market) external view returns (uint256) {
        uint256 b = capBps[market];
        return b == 0 ? 10_000 : b;
    }
}
