// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title ICounterparty
/// @notice The other side of every Engine trade. The Engine never holds money: a buyer's premium and fee go to the
///         counterparty, and sells are paid by it, which also decides where trade fees go. The interim HousePool
///         implements this in M2; MainspringPool replaces it in M3 without any change to the Engine.
interface ICounterparty {
    /// @notice The settlement token (USDC, 6 decimals).
    function asset() external view returns (IERC20);

    /// @notice Called by the Engine after it has moved `premium + fee` (USDC) into the counterparty. Reverts to refuse
    ///         the buy. `units`, `sWad` are WAD; `raw` is the book balance minted; `sigmaBps` the vol the buy used.
    function onBuy(
        bytes32 market,
        uint256 id,
        uint256 units,
        uint256 raw,
        uint256 sWad,
        uint256 sigmaBps,
        uint256 premium,
        uint256 fee
    ) external;

    /// @notice Called by the Engine on every sell: pays `net` to `to` and handles `fee` (both USDC; `gross` = net +
    ///         fee is what the counterparty pays out of its own money). No pause may apply here (law 3). `raw` is the
    ///         book balance burned, `units` the units paid for, at `sWad` and `sigmaBps`.
    function onSell(
        bytes32 market,
        uint256 id,
        uint256 raw,
        uint256 units,
        uint256 sWad,
        uint256 sigmaBps,
        uint256 gross,
        uint256 net,
        uint256 fee,
        address to
    ) external;
}
