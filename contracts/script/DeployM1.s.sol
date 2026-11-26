// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {QuorumBoard} from "../src/QuorumBoard.sol";
import {QuorumMarkSource} from "../src/QuorumMarkSource.sol";
import {MarkRouter} from "../src/MarkRouter.sol";
import {SessionCalendar} from "../src/SessionCalendar.sol";
import {IMarkSource} from "../src/IMarkSource.sol";
import {M1Core} from "./M1Core.sol";

/// @title DeployM1
/// @notice M1 deployment: QuorumBoard (MARK and VOL feeds per market), QuorumMarkSource and MarkRouter with a
///         quorum-only route queued for every market. The deployer configures everything, hands every admin
///         role to `ADMIN` and keeps none.
/// @dev    Testnet only (Robinhood Chain testnet 46630 (U), or a local anvil 31337): the 1 h router delay is the testnet
///         value; mainnet uses 48 h behind the Safe and timelock. The testnet admin is a single key, which
///         does not meet law 6; it is replaced by the Safe and timelock before mainnet.
///
///         Settings (environment):
///           ADMIN    address that receives every admin role (not the deployer, not a signer)
///           SIGNERS  comma-separated signer addresses (at least 3)
///           MARKETS  comma-separated market names (default BTC,ETH,STK1; STK1 is the placeholder tokenized stock, Q2)
///           STOCK_MARKETS  the tokenized-stock markets among them (default none): listed on the SessionCalendar, MARK
///                    keys bound to the session rule (±10% out of session). Never guessed from a name.
///           CALENDAR_FILE  the calendar data (default calendar/us-regular-session.json)
///
///         The deployer key is typed at a hidden prompt (--interactives 1) or comes from a keystore account;
///         locally, anvil's unlocked accounts are used (--unlocked). Addresses are written to
///         deployments/<chainId>.json.
contract DeployM1 is Script, M1Core {
    struct Config {
        address admin;
        address[] signers;
        bytes32[] markets;
        bytes32[] stockMarkets;
        CalendarData calendar;
    }

    struct Deployed {
        QuorumBoard board;
        QuorumMarkSource quorumSource;
        MarkRouter router;
        uint64 routeEta;
        SessionCalendar calendar;
    }

    error WrongChain(uint256 chainId);
    error BadConfig(string why);

    uint256 internal constant ROBINHOOD_TESTNET_ID = 46630; // (U) until probed

    function run() external returns (Deployed memory d) {
        if (block.chainid != ROBINHOOD_TESTNET_ID && block.chainid != 31337) revert WrongChain(block.chainid);
        Config memory c = configFromEnv();

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        d = deploy(c, deployer);
        vm.stopBroadcast();

        _write(c, d, deployer);
        console.log("QuorumBoard      ", address(d.board));
        console.log("QuorumMarkSource ", address(d.quorumSource));
        console.log("MarkRouter       ", address(d.router));
        console.log("routes applicable from", uint256(d.routeEta));
    }

    function configFromEnv() public view returns (Config memory c) {
        c.admin = vm.envAddress("ADMIN");
        c.signers = vm.envAddress("SIGNERS", ",");
        string[] memory names = vm.envOr("MARKETS", ",", _defaultMarkets());
        c.markets = new bytes32[](names.length);
        for (uint256 i; i < names.length; ++i) {
            bytes memory b = bytes(names[i]);
            if (b.length == 0 || b.length > 32) revert BadConfig("market name");
            c.markets[i] = bytes32(b);
        }
        c.stockMarkets = _bytes32s(vm.envOr("STOCK_MARKETS", ",", new string[](0)));
        c.calendar = loadCalendar(vm.envOr("CALENDAR_FILE", CALENDAR_FILE));
    }

    function _bytes32s(string[] memory names) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](names.length);
        for (uint256 i; i < names.length; ++i) {
            bytes memory b = bytes(names[i]);
            if (b.length == 0 || b.length > 32) revert BadConfig("market name");
            out[i] = bytes32(b);
        }
    }

    /// @notice Deploys and configures everything as `deployer` (M1Core), then hands admin to `c.admin`.
    function deploy(Config memory c, address deployer) public returns (Deployed memory d) {
        _check(c, deployer);

        M1Deployed memory m = m1Core(deployer, c.signers, c.markets, c.stockMarkets, c.calendar);
        (d.board, d.quorumSource, d.router, d.routeEta, d.calendar) = (m.board, m.quorumSource, m.router, m.routeEta, m.calendar);

        bytes32 adminRole = d.board.DEFAULT_ADMIN_ROLE();
        d.board.grantRole(adminRole, c.admin);
        d.board.renounceRole(adminRole, deployer);
        d.router.grantRole(adminRole, c.admin);
        d.router.renounceRole(adminRole, deployer);
        d.calendar.grantRole(adminRole, c.admin);
        d.calendar.renounceRole(adminRole, deployer);
    }

    function _check(Config memory c, address deployer) internal pure {
        if (c.admin == address(0) || c.admin == deployer) revert BadConfig("admin");
        if (c.signers.length < MIN_SIGNERS) revert BadConfig("signers");
        if (c.markets.length == 0) revert BadConfig("markets");
        for (uint256 i; i < c.signers.length; ++i) {
            if (c.signers[i] == c.admin || c.signers[i] == deployer) revert BadConfig("signer is admin or deployer");
        }
        for (uint256 i; i < c.markets.length; ++i) {
            for (uint256 j; j < i; ++j) {
                if (c.markets[i] == c.markets[j]) revert BadConfig("duplicate market");
            }
        }
        // duplicate or zero signers are refused by QuorumBoard itself (BadSigner)
    }

    function _defaultMarkets() internal pure returns (string[] memory m) {
        m = new string[](3);
        m[0] = "BTC";
        m[1] = "ETH";
        m[2] = "STK1";
    }

    function _names(bytes32[] memory m) internal pure returns (string[] memory out) {
        out = new string[](m.length);
        for (uint256 i; i < m.length; ++i) {
            uint256 n;
            while (n < 32 && m[i][n] != 0) ++n;
            bytes memory b = new bytes(n);
            for (uint256 j; j < n; ++j) {
                b[j] = m[i][j];
            }
            out[i] = string(b);
        }
    }

    function _write(Config memory c, Deployed memory d, address deployer) internal {
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "deployer", deployer);
        vm.serializeAddress(k, "admin", c.admin);
        vm.serializeAddress(k, "signers", c.signers);
        vm.serializeString(k, "markets", _names(c.markets));
        vm.serializeAddress(k, "QuorumBoard", address(d.board));
        vm.serializeAddress(k, "QuorumMarkSource", address(d.quorumSource));
        vm.serializeAddress(k, "MarkRouter", address(d.router));
        vm.serializeAddress(k, "SessionCalendar", address(d.calendar));
        vm.serializeString(k, "stockMarkets", _names(c.stockMarkets));
        string memory json = vm.serializeUint(k, "routeEta", d.routeEta);
        vm.createDir("deployments", true);
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }
}
