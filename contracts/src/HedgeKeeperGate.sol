// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice The pool's on-chain hedge entry point (MainspringPool.hedgeSwap, `HEDGER_ROLE` only).
interface IPoolHedgeSwap {
    function hedgeSwap(bytes32 market, bool buy, uint256 amountIn, uint256 minOut) external returns (uint256 out);
}

/// @title HedgeKeeperGate
/// @notice Holds the pool's `HEDGER_ROLE` instead of a key (owner C63), so hedging can be stopped at once. Only the
///         listed hedger key may call `hedgeSwap`, which goes to the pool unchanged: the gate never holds tokens and
///         never picks a price (the pool still sets the floor at the router mark, the caps and free money only).
/// @dev    - The guardian (`FREEZER_ROLE`) freezes the gate instantly; only the Safe (`UNFREEZER_ROLE`) unfreezes it.
///         - The hedger key behind the gate changes only through the timelock (the gate's admin).
///         - While frozen every swap is refused; nothing else in the system changes (sells, withdrawals and opens
///           follow their own rules; the risk monitor sees the hedger failing and pauses stock opens after 15 minutes).
contract HedgeKeeperGate is AccessControl {
    bytes32 public constant FREEZER_ROLE = keccak256("FREEZER_ROLE");
    bytes32 public constant UNFREEZER_ROLE = keccak256("UNFREEZER_ROLE");

    IPoolHedgeSwap public immutable pool;
    address public hedger; // the one key allowed to call hedgeSwap; zero = none
    bool public frozen;

    event HedgerSet(address indexed hedger);
    event HedgingFrozen(address indexed by);
    event HedgingUnfrozen(address indexed by);

    error ZeroAddress();
    error NotHedger();
    error Frozen();

    constructor(address admin, IPoolHedgeSwap pool_) {
        if (admin == address(0) || address(pool_) == address(0)) revert ZeroAddress();
        pool = pool_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice The listed hedger key's swap, forwarded to the pool with the same arguments.
    function hedgeSwap(bytes32 market, bool buy, uint256 amountIn, uint256 minOut) external returns (uint256 out) {
        if (msg.sender != hedger || hedger == address(0)) revert NotHedger();
        if (frozen) revert Frozen();
        out = pool.hedgeSwap(market, buy, amountIn, minOut);
    }

    /// @notice Stops every hedge swap at once. The guardian.
    function freeze() external onlyRole(FREEZER_ROLE) {
        frozen = true;
        emit HedgingFrozen(msg.sender);
    }

    /// @notice Lets hedge swaps run again. The Safe only.
    function unfreeze() external onlyRole(UNFREEZER_ROLE) {
        frozen = false;
        emit HedgingUnfrozen(msg.sender);
    }

    /// @notice The hedger key behind the gate (zero removes it). The timelock only.
    function setHedger(address hedger_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        hedger = hedger_;
        emit HedgerSet(hedger_);
    }
}
