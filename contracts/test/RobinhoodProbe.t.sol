// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ProbeLib, RobinhoodProbe, RobinhoodProbeReport, ProbeDeploy} from "../script/RobinhoodProbe.s.sol";

/// Stand-ins for the Arbitrum precompiles (a local chain has none).
contract FakeArbSys {
    function arbOSVersion() external pure returns (uint256) {
        return 55 + 40;
    }

    function arbBlockNumber() external pure returns (uint256) {
        return 123_456;
    }
}

contract FakeArbGasInfo {
    function getGasAccountingParams() external pure returns (uint256, uint256, uint256) {
        return (7_000_000, 32_000_000, 32_000_000);
    }
}

contract RobinhoodProbeTest is Test {
    function setUp() public {
        vm.etch(address(0x64), address(new FakeArbSys()).code);
        vm.etch(address(0x6C), address(new FakeArbGasInfo()).code);
        vm.chainId(46630);
        vm.fee(0.01 gwei);
        vm.warp(1_800_000_000);
    }

    function _check(ProbeLib.Report memory r) internal view {
        assertEq(r.chainId, 46630, "chain id");
        assertEq(r.arbOsVersion, 40, "ArbOS version (reported minus 55)");
        assertEq(r.maxTxGas, 32_000_000, "max gas per transaction");
        assertEq(r.blockGasLimit, block.gaslimit, "block gas limit");
        assertEq(r.baseFee, 0.01 gwei, "base fee");
        assertGt(r.arbBlockNumber, 0, "L2 block number (forge answers ArbSys.arbBlockNumber itself)");
        assertEq(r.timestamp, 1_800_000_000, "timestamp");
        assertTrue(r.mcopy, "Cancun mcopy");
        assertTrue(r.transientStorage, "Cancun transient storage");
    }

    function test_theDeployedProbeKeepsItsReportAndMeasuresAgain() public {
        RobinhoodProbe p = new RobinhoodProbe();
        (uint256 chainId, uint256 arbOs,,,,,,, bool mcopy, bool tstore) = p.atDeploy();
        assertEq(chainId, 46630);
        assertEq(arbOs, 40);
        assertTrue(mcopy && tstore);
        _check(p.measure());
    }

    function test_theReportRunsWithoutATransaction() public {
        // what an eth_call of the creation code does: the constructor gives back the encoded report
        (bool ok, bytes memory out) = address(this).call(abi.encodeCall(this.runCreationCode, ()));
        assertTrue(ok);
        _check(abi.decode(abi.decode(out, (bytes)), (ProbeLib.Report)));
    }

    function runCreationCode() external returns (bytes memory out) {
        bytes memory code = type(RobinhoodProbeReport).creationCode;
        address a;
        assembly {
            a := create(0, add(code, 0x20), mload(code))
        }
        out = a.code; // the constructor's return data became the "code"
    }

    function test_deployRefusesEveryChainButTheTestnet() public {
        ProbeDeploy d = new ProbeDeploy();
        uint256[4] memory refused = [uint256(4663), 31337, 99801, 1]; // mainnet, anvil, the old Elysium testnet, Ethereum
        for (uint256 i; i < refused.length; ++i) {
            vm.chainId(refused[i]);
            vm.expectRevert(abi.encodeWithSelector(ProbeDeploy.WrongChain.selector, refused[i]));
            d.run();
        }
    }
}
