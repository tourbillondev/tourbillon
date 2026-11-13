// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IMarkSource} from "./IMarkSource.sol";

/// @title CoreReadMarkSource
/// @notice Phase 2 mark source: Elysium's HyperCore read precompile.
/// @dev Shape (U), not yet published for Elysium: staticcall(abi.encode(uint32 index)) returns
///      a uint64 raw mark with (6 − szDecimals) decimals, so px = raw · 10^(12 + szDecimals) in WAD.
///      Marks are sequencer-attested and current, so a reading counts as fresh at the current block.
///      Configuration sits behind DEFAULT_ADMIN_ROLE (the timelock). The router's timelocked switch
///      and cross-check stand between this adapter and any price use.
///      The call is capped at `callGas` (default 100k) and copies back at most 32 bytes, so a
///      failing, looping or oversized precompile reply reverts cleanly with PrecompileFailed.
///      Re-check the cap against the precompile's real cost at the M5 testnet probe (U).
contract CoreReadMarkSource is IMarkSource, AccessControl {
    uint256 public constant DEFAULT_CALL_GAS = 100_000;
    uint256 public constant MIN_CALL_GAS = 10_000;

    struct Asset {
        bool listed;
        uint32 index;
        uint8 szDecimals;
    }

    address public precompile;
    uint256 public callGas = DEFAULT_CALL_GAS;
    mapping(bytes32 => Asset) public assets;

    event PrecompileSet(address precompile);
    event CallGasSet(uint256 callGas);
    event AssetSet(bytes32 indexed market, uint32 index, uint8 szDecimals);

    error UnknownMarket(bytes32 market);
    error PrecompileFailed(bytes32 market);
    error ZeroMark(bytes32 market);
    error BadConfig();

    constructor(address admin, address precompile_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _setPrecompile(precompile_);
    }

    /// @inheritdoc IMarkSource
    function markWad(bytes32 market) external view returns (uint256 px, uint256 updatedAt) {
        Asset memory a = assets[market];
        if (!a.listed) revert UnknownMarket(market);
        (bool ok, uint256 word) = _call(a.index);
        if (!ok || word > type(uint64).max) revert PrecompileFailed(market);
        uint64 raw = uint64(word);
        if (raw == 0) revert ZeroMark(market);
        px = uint256(raw) * 10 ** (12 + uint256(a.szDecimals));
        updatedAt = block.timestamp;
    }

    function setPrecompile(address precompile_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setPrecompile(precompile_);
    }

    function setAsset(bytes32 market, uint32 index, uint8 szDecimals) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (szDecimals > 6) revert BadConfig(); // perp prices carry 6 − szDecimals decimals
        assets[market] = Asset(true, index, szDecimals);
        emit AssetSet(market, index, szDecimals);
    }

    function setCallGas(uint256 callGas_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (callGas_ < MIN_CALL_GAS) revert BadConfig();
        callGas = callGas_;
        emit CallGasSet(callGas_);
    }

    /// @dev staticcall(callGas, precompile, abi.encode(index)); succeeds only with exactly 32 bytes back,
    ///      and never copies more than 32 bytes into memory.
    function _call(uint32 index) internal view returns (bool ok, uint256 word) {
        address target = precompile;
        uint256 gasLimit = callGas;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, index)
            ok := staticcall(gasLimit, target, ptr, 0x20, ptr, 0x20)
            if iszero(eq(returndatasize(), 0x20)) { ok := 0 }
            word := mload(ptr)
        }
    }

    function _setPrecompile(address precompile_) internal {
        if (precompile_ == address(0)) revert BadConfig();
        precompile = precompile_;
        emit PrecompileSet(precompile_);
    }
}
