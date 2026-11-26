// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";

interface IArbSys {
    function arbOSVersion() external view returns (uint256);
    function arbBlockNumber() external view returns (uint256);
}

interface IArbGasInfo {
    function getGasAccountingParams() external view returns (uint256 speedLimit, uint256 gasPoolMax, uint256 maxTxGas);
}

/// Facts about Robinhood Chain (an Arbitrum Orbit L2), measured on the chain itself. Every chain fact in the spec is
/// (U) until measured (Backend §1): the chain id, the ArbOS version, the gas limits, the base fee, and whether Cancun
/// opcodes work. Block time comes from two reports a known time apart.
library ProbeLib {
    struct Report {
        uint256 chainId;
        uint256 arbOsVersion; // ArbSys reports 55 + version; this field holds the version
        uint256 maxTxGas;
        uint256 blockGasLimit;
        uint256 baseFee;
        uint256 parentBlockNumber; // block.number on Arbitrum chains is the parent-chain block
        uint256 arbBlockNumber;
        uint256 timestamp;
        bool mcopy; // Cancun
        bool transientStorage; // Cancun
    }

    function measure() internal returns (Report memory r) {
        r.chainId = block.chainid;
        r.arbOsVersion = IArbSys(address(0x64)).arbOSVersion() - 55;
        (,, r.maxTxGas) = IArbGasInfo(address(0x6C)).getGasAccountingParams();
        r.blockGasLimit = block.gaslimit;
        r.baseFee = block.basefee;
        r.parentBlockNumber = block.number;
        r.arbBlockNumber = IArbSys(address(0x64)).arbBlockNumber();
        r.timestamp = block.timestamp;
        bool ok;
        assembly {
            let p := mload(0x40)
            mstore(p, 0x1234)
            mcopy(add(p, 0x20), p, 0x20)
            ok := eq(mload(add(p, 0x20)), 0x1234)
        }
        r.mcopy = ok;
        assembly {
            tstore(0, 7)
            ok := eq(tload(0), 7)
            tstore(0, 0)
        }
        r.transientStorage = ok;
    }
}

/// Deployed once on testnet: keeps the report from its deployment block and is used to test source verification.
contract RobinhoodProbe {
    ProbeLib.Report public atDeploy;

    constructor() {
        atDeploy = ProbeLib.measure();
    }

    function measure() external returns (ProbeLib.Report memory) {
        return ProbeLib.measure();
    }
}

/// Never deployed: its creation code gives back the ABI-encoded report, so an eth_call of the creation code runs the
/// probe on the chain's own node without a transaction, a key or any gas.
contract RobinhoodProbeReport {
    constructor() {
        bytes memory out = abi.encode(ProbeLib.measure());
        assembly {
            return(add(out, 0x20), mload(out))
        }
    }
}

/// Deploys RobinhoodProbe on the Robinhood Chain testnet only. The deployer key is typed at a hidden prompt
/// (--interactives 1); nothing is stored. Any other chain, mainnet 4663 included, is refused before anything is sent.
contract ProbeDeploy is Script {
    uint256 internal constant ROBINHOOD_TESTNET_ID = 46630; // from the studio's record, not the spec: (U) until probed

    error WrongChain(uint256 chainId);

    function run() external returns (RobinhoodProbe probe) {
        if (block.chainid != ROBINHOOD_TESTNET_ID) revert WrongChain(block.chainid);
        vm.startBroadcast();
        probe = new RobinhoodProbe();
        vm.stopBroadcast();
        console.log("RobinhoodProbe deployed at", address(probe));
    }
}
