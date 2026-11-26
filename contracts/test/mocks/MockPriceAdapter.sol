// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// LOCAL ONLY. Stand-in for an on-chain price adapter in front of Robinhood Chain's own liquidity (the venue is owner
/// queue Q4): the same `mark(assetId)` shape NativeMarkSource and the signers read. Anyone can set a price; the time is
/// the block's, as a pool-backed adapter would give.
contract MockPriceAdapter {
    mapping(bytes32 => uint256) public px;

    function set(bytes32 assetId, uint256 pxWad) external {
        px[assetId] = pxWad;
    }

    function mark(bytes32 assetId) external view returns (uint256 pxWad, uint256 updatedAt) {
        return (px[assetId], block.timestamp);
    }
}
