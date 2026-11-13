// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IWriteCounterparty
/// @notice The other side of every write (M4 decision D1: the pool takes every write at its bid). The WriterBook holds
///         the writer's collateral; the counterparty pays or receives the credit and the buyback, and handles the fee.
interface IWriteCounterparty {
    /// @notice Called by the WriterBook after locking the collateral. `credit` (USDC, signed) is what the writer
    ///         receives: if positive the counterparty pays it to `writer`; if negative the WriterBook has already moved
    ///         −credit from the writer into the counterparty. Reverts to refuse the write (pauses, coverage).
    function onWrite(
        bytes32 market,
        uint256 seriesId,
        uint256 writeId,
        uint256 units,
        uint256 raw,
        uint256 sWad,
        uint256 sigmaBps,
        int256 credit,
        uint256 fee,
        address writer
    ) external;

    /// @notice Called by the WriterBook on every unwrite, after it has moved `usdcIn` (USDC) and `whypeIn` (WHYPE)
    ///         of the buyback into the counterparty. `cost` (USDC, signed, already capped at the collateral) is the
    ///         buyback: if negative the counterparty pays −cost to `writer`. No pause may apply (law 3 for writers).
    function onUnwrite(
        bytes32 market,
        uint256 seriesId,
        uint256 writeId,
        uint256 raw,
        uint256 units,
        uint256 sWad,
        uint256 sigmaBps,
        int256 cost,
        uint256 fee,
        uint256 usdcIn,
        uint256 whypeIn,
        address writer
    ) external;
}
