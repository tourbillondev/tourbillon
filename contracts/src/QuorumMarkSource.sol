// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IMarkSource} from "./IMarkSource.sol";
import {QuorumBoard} from "./QuorumBoard.sol";

/// @title QuorumMarkSource
/// @notice Phase 1 mark source: the QuorumBoard's MARK key for each market.
contract QuorumMarkSource is IMarkSource {
    QuorumBoard public immutable board;

    constructor(QuorumBoard board_) {
        board = board_;
    }

    /// @inheritdoc IMarkSource
    /// @dev Reverts with the board's NoData if the market has never been published.
    function markWad(bytes32 market) external view returns (uint256 px, uint256 updatedAt) {
        return board.latestValue(board.markKey(market));
    }
}
