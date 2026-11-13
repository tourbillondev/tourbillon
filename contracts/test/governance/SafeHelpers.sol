// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

/// The Safe v1.4.1 calls the tests use (operation 0 = call).
interface Safe {
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce
    ) external view returns (bytes32);
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool);
    function nonce() external view returns (uint256);
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
}

/// Signs and sends Safe transactions with test-only keys.
abstract contract SafeHelpers is Test {
    /// Signatures from the given keys, sorted by signer address (Safe requires ascending owners).
    function _sigs(bytes32 h, uint256[] memory pks) internal pure returns (bytes memory out) {
        for (uint256 i = 1; i < pks.length; ++i) {
            for (uint256 j = i; j > 0 && vm.addr(pks[j - 1]) > vm.addr(pks[j]); --j) {
                (pks[j - 1], pks[j]) = (pks[j], pks[j - 1]);
            }
        }
        for (uint256 i; i < pks.length; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(pks[i], h);
            out = abi.encodePacked(out, r, s, v);
        }
    }

    function _exec(Safe safe, uint256[] memory pks, address to, bytes memory data) internal returns (bool) {
        bytes32 h = safe.getTransactionHash(to, 0, data, 0, 0, 0, 0, address(0), address(0), safe.nonce());
        bytes memory sigs = _sigs(h, pks);
        return safe.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sigs);
    }

    function execExternal(Safe safe, uint256[] memory pks, address to, bytes memory data) external returns (bool) {
        return _exec(safe, pks, to, data);
    }
}
