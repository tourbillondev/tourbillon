// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {QuorumBoard} from "../src/QuorumBoard.sol";

/// @title ListEquityFeed
/// @notice Lists a MainspringPool's EQUITY key on the QuorumBoard (M3 step 4): step clamp 50%, heartbeat 2 h. Run by
///         the board's admin (`--sender` = ADMIN; locally anvil's unlocked account, no key).
///
///         Settings (environment):
///           M3_DEPLOYMENT  default: deployments/<chainId>-m3.json (written by DeployM3)
contract ListEquityFeed is Script {
    uint16 public constant STEP_BPS = 5000;
    uint32 public constant HEARTBEAT = 2 hours;

    function run() external {
        string memory path =
            vm.envOr("M3_DEPLOYMENT", string.concat("deployments/", vm.toString(block.chainid), "-m3.json"));
        string memory json = vm.readFile(path);
        QuorumBoard board = QuorumBoard(vm.parseJsonAddress(json, ".QuorumBoard"));
        bytes32 key = vm.parseJsonBytes32(json, ".equityKey");
        vm.startBroadcast();
        board.setFeed(key, STEP_BPS, HEARTBEAT);
        vm.stopBroadcast();
        console.log("EQUITY feed listed");
        console.logBytes32(key);
    }
}
