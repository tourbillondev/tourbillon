// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

/// @notice The settlement token as the rest of the system sees it (Backend §1; owner D1: USDG on Robinhood Chain, a
///         settlement token configuration possible).
interface ISettlementAdapter {
    function token() external view returns (IERC20);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
    function supportsPermit() external view returns (bool);
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

/// @title SettlementAdapter
/// @notice The one place that knows the settlement token's form: which stablecoin (a deploy setting: USDG by default
///         on Robinhood Chain), canonical or bridged (U). Deposits use approve, or permit (EIP-2612) where the token has
///         it; never transfer authorizations (EIP-3009): nothing here or anywhere else calls them. Every contract pulls
///         the settlement token by allowance, so any such form works, and a different token is a different adapter at
///         deployment, with no contract change.
/// @dev    - Decimals are read from the token, never assumed: every amount in the system is in 6-decimal units, so a
///           token with other decimals is refused here (and by the Engine and the pool at their own deployment).
///         - `symbol` is read once from the token and kept: services, the API and every text show it.
///         - `supportsPermit` is probed once: DOMAIN_SEPARATOR() and nonces() answer. The SDK and API read it to ask the
///           user for a signature (permit) or an approve transaction.
///         - `permit` relays a holder's signed permit to the token (anyone may relay it; it only sets an allowance the
///           holder signed). Holds no tokens and has no admin.
contract SettlementAdapter is ISettlementAdapter {
    /// @notice The unit every amount in the system is counted in.
    uint8 public constant UNIT_DECIMALS = 6;

    IERC20 public immutable token;
    uint8 public immutable decimals;
    bool public immutable supportsPermit;
    string public symbol;

    error ZeroAddress();
    error WrongDecimals(uint8 decimals);
    error NoPermit();

    constructor(IERC20 token_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        uint8 d = IERC20Metadata(address(token_)).decimals();
        if (d != UNIT_DECIMALS) revert WrongDecimals(d);
        token = token_;
        decimals = d;
        symbol = IERC20Metadata(address(token_)).symbol();
        supportsPermit = _answers(address(token_), abi.encodeCall(IERC20Permit.DOMAIN_SEPARATOR, ()))
            && _answers(address(token_), abi.encodeCall(IERC20Permit.nonces, (address(0))));
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        if (!supportsPermit) revert NoPermit();
        IERC20Permit(address(token)).permit(owner, spender, value, deadline, v, r, s);
    }

    function _answers(address t, bytes memory call) internal view returns (bool) {
        (bool ok, bytes memory ret) = t.staticcall(call);
        return ok && ret.length == 32;
    }
}
