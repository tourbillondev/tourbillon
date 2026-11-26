// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice The pool pauses opens on a market whose covering token could not move (MainspringPool.onCoverStuck).
interface ICoverOutage {
    function onCoverStuck(bytes32 market) external;
}

/// @title CoverLedger
/// @notice How the books and the vault move covering tokens (tokenized stocks, which may have transfer restrictions or
///         issuer pauses (U)).
///         - In: a pull must deliver exactly the amount asked (G9: rebasing and fee-on-transfer behaviour is refused).
///         - Out: a covering token that cannot move does not stop anything (owner D3). It stays here, owed to its
///           receiver, and anyone can settle it once transfers work. The caller then pauses opens on that market (the
///           failure counts as an outage, Backend §11); sells and settlement token payments go on (law 3).
abstract contract CoverLedger is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Covering tokens held here because they could not move: token => receiver => amount.
    mapping(IERC20 => mapping(address => uint256)) public owedCover;
    mapping(IERC20 => uint256) public owedCoverTotal;

    event CoverOwed(IERC20 indexed token, address indexed to, uint256 amount);
    event CoverSettled(IERC20 indexed token, address indexed to, uint256 amount);

    error CoverNotExact(uint256 asked, uint256 received);
    error NothingOwed();

    /// @notice Sends `to` the covering tokens owed to it. Anyone may call; it reverts (changing nothing) while the token
    ///         still cannot move.
    function settleCover(IERC20 token, address to) external nonReentrant {
        uint256 a = owedCover[token][to];
        if (a == 0) revert NothingOwed();
        owedCover[token][to] = 0;
        owedCoverTotal[token] -= a;
        emit CoverSettled(token, to, a);
        token.safeTransfer(to, a);
    }

    /// @dev Pulls exactly `amount` of `token` from `from`.
    function _pullCoverExact(IERC20 token, address from, uint256 amount) internal {
        if (amount == 0) return;
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        uint256 got = token.balanceOf(address(this)) - before;
        if (got != amount) revert CoverNotExact(amount, got);
    }

    /// @dev Sends `amount` of `token` to `to`; if the token refuses, keeps it owed to `to` and gives false.
    function _sendCover(IERC20 token, address to, uint256 amount) internal returns (bool sent) {
        if (amount == 0 || token.trySafeTransfer(to, amount)) return true;
        owedCover[token][to] += amount;
        owedCoverTotal[token] += amount;
        emit CoverOwed(token, to, amount);
        return false;
    }
}
