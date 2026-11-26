// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";
import {DeployM3} from "./DeployM3.s.sol";
import {WriterBook, IEngineConfig} from "../src/WriterBook.sol";
import {MockStockToken} from "../test/mocks/MockStockToken.sol";
import {CoveringAssets, ICoverMarks} from "../src/CoveringAssets.sol";

/// @title DeployM4
/// @notice M4 deployment on top of an M1 deployment: everything DeployM3 deploys and configures, plus the WriterBook
///         (writes against exact collateral), the covering-asset table and a mock tokenized stock (STK1), wired before
///         the roles are handed over:
///         - the Engine's admin lets the WriterBook open shape series in the book (`setWriterBook`, once);
///         - the pool accepts the WriterBook's write hooks (`setWriterBook`, once);
///         - the pool counts covering tokens it receives in buybacks at their mark × 95% (`setCoverAssets`, once);
///         - STK1's token is listed as its covering asset, checked between every holder (the WriterBook and the pool).
///         Then every role goes to its owner and the deployer keeps none, as in DeployM3; the covering-asset table's
///         admin too.
/// @dev    LOCAL ONLY (anvil, chain 31337): mock USDC and a mock tokenized stock with open minting. A testnet deployment
///         needs the real USDC and stock token addresses (owner queue Q1, Q2) and the owner's yes. Same settings
///         (environment) as DeployM3. Writes deployments/<chainId>-m4.json: every key of the M3 file plus `WriterBook`,
///         `CoveringAssets` and `MockStockToken`, so the services read it as an M3 file.
contract DeployM4 is DeployM3 {
    struct Deployed4 {
        Deployed m3;
        WriterBook writerBook;
        MockStockToken stock; // STK1's covering token (placeholder)
        CoveringAssets covers;
    }

    function run() external virtual override returns (Deployed memory d) {
        if (block.chainid != 31337) revert WrongChain(block.chainid);
        Config memory c = configFromEnv();
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        Deployed4 memory d4 = deploy4(c, deployer);
        vm.stopBroadcast();
        d = d4.m3;
        _write4(c, d4, deployer);
        console.log("SettlementToken ", address(d.settlement));
        console.log("MockStockToken  ", address(d4.stock));
        console.log("CoveringAssets  ", address(d4.covers));
        console.log("MainspringPool  ", address(d.pool));
        console.log("PathFundingBook ", address(d.book));
        console.log("Engine          ", address(d.engine));
        console.log("WriterBook      ", address(d4.writerBook));
    }

    /// @notice Deploys M3, then the WriterBook, the covering-asset table and the mock stock, wires them, lists STK1,
    ///         then hands every role over.
    function deploy4(Config memory c, address deployer) public returns (Deployed4 memory d4) {
        d4 = deployCore4(c, deployer);
        address[] memory holders = new address[](2);
        (holders[0], holders[1]) = (address(d4.writerBook), address(d4.m3.pool));
        d4.covers.list("STK1", d4.stock, holders);
        handOver(c, d4.m3, deployer);
        handOverCovers(d4.covers, c.admin, deployer);
    }

    /// @notice The covering-asset table goes to `to` (the timelock under M7); the deployer keeps nothing.
    function handOverCovers(CoveringAssets covers, address to, address deployer) public {
        bytes32 adminRole = covers.DEFAULT_ADMIN_ROLE();
        covers.grantRole(adminRole, to);
        covers.renounceRole(adminRole, deployer);
    }

    /// @notice As deploy4, keeping the admin roles and listing nothing yet (DeployM6 wires more holders first).
    function deployCore4(Config memory c, address deployer) public returns (Deployed4 memory d4) {
        Deployed memory d = deployCore(c, deployer);
        d4.m3 = d;
        d4.stock = new MockStockToken("Mock Stock One", "STK1", 18);
        d4.covers = new CoveringAssets(deployer, ICoverMarks(address(c.router)));
        d4.writerBook =
            new WriterBook(d.book, IEngineConfig(address(d.engine)), d.pool, c.router, c.board, d.settlement, d4.covers);
        d.engine.setWriterBook(address(d4.writerBook));
        d.pool.setWriterBook(address(d4.writerBook));
        d.pool.setCoverAssets(d4.covers);
    }

    function _write4(Config memory c, Deployed4 memory d4, address deployer) internal {
        Deployed memory d = d4.m3;
        string memory k = "m4";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "deployer", deployer);
        vm.serializeAddress(k, "admin", c.admin);
        vm.serializeAddress(k, "riskPauser", c.riskPauser);
        vm.serializeAddress(k, "protocolRecipient", c.protocolRecipient);
        vm.serializeAddress(k, "MarkRouter", address(c.router));
        vm.serializeAddress(k, "QuorumBoard", address(c.board));
        writeSettlement(k, d);
        vm.serializeAddress(k, "MockStockToken", address(d4.stock));
        vm.serializeAddress(k, "CoveringAssets", address(d4.covers));
        vm.serializeAddress(k, "MainspringPool", address(d.pool));
        vm.serializeAddress(k, "PathFundingBook", address(d.book));
        vm.serializeAddress(k, "WriterBook", address(d4.writerBook));
        vm.serializeBytes32(k, "equityKey", d.pool.equityKey());
        string[] memory markets = new string[](3);
        (markets[0], markets[1], markets[2]) = ("BTC", "ETH", "STK1");
        vm.serializeString(k, "markets", markets);
        vm.serializeUint(k, "deployBlock", block.number);
        string memory json = vm.serializeAddress(k, "Engine", address(d.engine));
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), "-m4.json"));
    }
}
