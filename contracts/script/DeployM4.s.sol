// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";
import {DeployM3} from "./DeployM3.s.sol";
import {WriterBook, IEngineConfig} from "../src/WriterBook.sol";
import {MockWHYPE} from "../test/mocks/MockWHYPE.sol";

/// @title DeployM4
/// @notice M4 deployment on top of an M1 deployment: everything DeployM3 deploys and configures, plus the WriterBook
///         (writes against exact collateral) and a mock WHYPE, wired before the roles are handed over:
///         - the Engine's admin lets the WriterBook open shape series in the book (`setWriterBook`, once);
///         - the pool accepts the WriterBook's write hooks (`setWriterBook`, once);
///         - the pool counts WHYPE it receives in buybacks at the HYPE mark × 95% (`setWhype`, once).
///         Then every role goes to its owner and the deployer keeps none, as in DeployM3.
/// @dev    LOCAL ONLY (anvil, chain 31337): mock USDC and mock WHYPE with open minting. A testnet deployment needs the
///         real USDC and WHYPE addresses (both (U)) and the owner's yes. Same settings (environment) as DeployM3.
///         Writes deployments/<chainId>-m4.json: every key of the M3 file plus `WriterBook` and `MockWHYPE`, so the
///         services read it as an M3 file.
contract DeployM4 is DeployM3 {
    struct Deployed4 {
        Deployed m3;
        WriterBook writerBook;
        MockWHYPE whype;
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
        console.log("MockUSDC        ", address(d.usdc));
        console.log("MockWHYPE       ", address(d4.whype));
        console.log("MainspringPool  ", address(d.pool));
        console.log("PathFundingBook ", address(d.book));
        console.log("Engine          ", address(d.engine));
        console.log("WriterBook      ", address(d4.writerBook));
    }

    /// @notice Deploys M3, then the WriterBook and mock WHYPE, wires them, then hands every role over.
    function deploy4(Config memory c, address deployer) public returns (Deployed4 memory d4) {
        d4 = deployCore4(c, deployer);
        handOver(c, d4.m3, deployer);
    }

    /// @notice As deploy4, keeping the admin roles (DeployM6 wires more first).
    function deployCore4(Config memory c, address deployer) public returns (Deployed4 memory d4) {
        Deployed memory d = deployCore(c, deployer);
        d4.m3 = d;
        d4.whype = new MockWHYPE();
        d4.writerBook =
            new WriterBook(d.book, IEngineConfig(address(d.engine)), d.pool, c.router, c.board, d.usdc, d4.whype);
        d.engine.setWriterBook(address(d4.writerBook));
        d.pool.setWriterBook(address(d4.writerBook));
        d.pool.setWhype(d4.whype, "HYPE");
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
        vm.serializeAddress(k, "MockUSDC", address(d.usdc));
        vm.serializeAddress(k, "MockWHYPE", address(d4.whype));
        vm.serializeAddress(k, "MainspringPool", address(d.pool));
        vm.serializeAddress(k, "PathFundingBook", address(d.book));
        vm.serializeAddress(k, "WriterBook", address(d4.writerBook));
        vm.serializeBytes32(k, "equityKey", d.pool.equityKey());
        string[] memory markets = new string[](3);
        (markets[0], markets[1], markets[2]) = ("BTC", "ETH", "HYPE");
        vm.serializeString(k, "markets", markets);
        vm.serializeUint(k, "deployBlock", block.number);
        string memory json = vm.serializeAddress(k, "Engine", address(d.engine));
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), "-m4.json"));
    }
}
