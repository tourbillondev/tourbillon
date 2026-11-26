// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IMarkSource} from "./IMarkSource.sol";

/// @notice The one shape NativeMarkSource reads. Once Robinhood Chain publishes a first-party mark (a precompile, an
///         oracle or a canonical AMM reference (U)), a small adapter contract translates that interface into this
///         one; only the adapter is rewritten per the chain's published interface (Backend §2 D, §4).
interface INativeMarkAdapter {
    /// @return pxWad     Mark of `assetId` in WAD.
    /// @return updatedAt Time the chain produced the mark. Freshness is judged by the MarkRouter.
    function mark(bytes32 assetId) external view returns (uint256 pxWad, uint256 updatedAt);
}

/// @title NativeMarkSource
/// @notice Phase 2 mark source: Robinhood Chain's first-party mark, through an adapter (stub until the chain publishes
///         its mark interface). Used only behind the MarkRouter's timelocked route switch, and only after a first-party
///         mark is live on mainnet (T2: primary = native, secondary = quorum at 50 bps). At T0 it is not routed.
/// @dev    The adapter call is capped in gas and must answer exactly two words; anything else (a revert, a loop, a
///         short or long reply, no code at the address) reverts cleanly with AdapterFailed, so the router counts the
///         source as unavailable. Settings belong to governance (the timelock).
contract NativeMarkSource is IMarkSource, AccessControl {
    uint256 public constant DEFAULT_CALL_GAS = 100_000;
    uint256 public constant MIN_CALL_GAS = 10_000;

    struct Asset {
        bool listed;
        bytes32 assetId; // the chain's own id for the asset (shape (U))
    }

    address public adapter;
    uint256 public callGas = DEFAULT_CALL_GAS;
    mapping(bytes32 => Asset) public assets;

    event AdapterSet(address adapter);
    event CallGasSet(uint256 callGas);
    event AssetSet(bytes32 indexed market, bytes32 assetId);

    error UnknownMarket(bytes32 market);
    error AdapterFailed(bytes32 market);
    error ZeroMark(bytes32 market);
    error BadConfig();

    constructor(address admin, address adapter_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _setAdapter(adapter_);
    }

    /// @inheritdoc IMarkSource
    function markWad(bytes32 market) external view returns (uint256 px, uint256 updatedAt) {
        Asset memory a = assets[market];
        if (!a.listed) revert UnknownMarket(market);
        bool ok;
        (ok, px, updatedAt) = _call(a.assetId);
        if (!ok) revert AdapterFailed(market);
        if (px == 0) revert ZeroMark(market);
    }

    function setAdapter(address adapter_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setAdapter(adapter_);
    }

    function setAsset(bytes32 market, bytes32 assetId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (market == bytes32(0) || assetId == bytes32(0)) revert BadConfig();
        assets[market] = Asset(true, assetId);
        emit AssetSet(market, assetId);
    }

    function setCallGas(uint256 callGas_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (callGas_ < MIN_CALL_GAS) revert BadConfig();
        callGas = callGas_;
        emit CallGasSet(callGas_);
    }

    /// @dev staticcall(callGas, adapter, mark(assetId)); succeeds only with exactly 64 bytes back, and never copies
    ///      more than 64 bytes into memory.
    function _call(bytes32 assetId) internal view returns (bool ok, uint256 px, uint256 updatedAt) {
        address target = adapter;
        uint256 gasLimit = callGas;
        bytes4 sel = INativeMarkAdapter.mark.selector;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, sel)
            mstore(add(ptr, 0x04), assetId)
            ok := staticcall(gasLimit, target, ptr, 0x24, ptr, 0x40)
            if iszero(eq(returndatasize(), 0x40)) { ok := 0 }
            px := mload(ptr)
            updatedAt := mload(add(ptr, 0x20))
        }
        if (!ok) (px, updatedAt) = (0, 0);
    }

    function _setAdapter(address adapter_) internal {
        if (adapter_ == address(0)) revert BadConfig();
        adapter = adapter_;
        emit AdapterSet(adapter_);
    }
}
