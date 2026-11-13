// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A source of marks for the MarkRouter.
interface IMarkSource {
    /// @return px        Mark of `market` in WAD.
    /// @return updatedAt Time the mark was produced. Freshness is judged by the router.
    function markWad(bytes32 market) external view returns (uint256 px, uint256 updatedAt);
}
