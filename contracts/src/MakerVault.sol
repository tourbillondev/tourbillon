// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ICoveringAssets} from "./CoveringAssets.sol";
import {CoverLedger} from "./CoverLedger.sol";

/// @title MakerVault
/// @notice Makers' collateral for the open book (M6; spec §5: "Deposit settlement token or a covering tokenized asset; withdraw
///         whatever isn't locked, at any time; slash unpaid buybacks"). Each maker has a free and a locked balance per
///         token; the vault holds every token itself.
/// @dev    - Makers deposit and withdraw free balances at any time. Nothing pauses a withdrawal and no admin can block it.
///         - Operators (the MatchBook, later the RiskAuction) lock free balances as exact collateral, unlock them as it is
///           released, pay out of locked balances (a buyback to the pool, an auction settlement), and slash free balances
///           (D4: a buyback shortfall beyond the locked collateral, an unrevealed auction bond), never more than the
///           maker's free balance.
///         - The admin's only power: setting each operator once (a single key until M7).
///         - settlement token, and the covering tokens listed in CoveringAssets. A covering token must arrive exactly (G9); one
///           that cannot be paid out stays owed here (CoverLedger) and `pay` / `slash` say so, so the operator pauses
///           opens on its market (owner D3).
contract MakerVault is CoverLedger {
    using SafeERC20 for IERC20;

    IERC20 public immutable settlement;
    ICoveringAssets public immutable covers;
    address public immutable admin;

    address public matchBook; // operator, set once
    address public auction; // operator, set once

    mapping(address => mapping(IERC20 => uint256)) public freeOf; // maker => token => free
    mapping(address => mapping(IERC20 => uint256)) public lockedOf; // maker => token => locked

    event Deposited(address indexed maker, IERC20 indexed token, uint256 amount);
    event Withdrawn(address indexed maker, IERC20 indexed token, uint256 amount);
    event Locked(address indexed maker, IERC20 indexed token, uint256 amount, address indexed by);
    event Unlocked(address indexed maker, IERC20 indexed token, uint256 amount, address indexed by);
    event Paid(address indexed maker, IERC20 indexed token, uint256 amount, address to, address indexed by);
    event Slashed(
        address indexed maker, IERC20 indexed token, uint256 asked, uint256 taken, address to, address indexed by
    );
    event OperatorSet(string role, address operator);

    error ZeroAddress();
    error ZeroAmount();
    error UnsupportedToken(address token);
    error NotAdmin();
    error NotOperator();
    error AlreadySet();
    error InsufficientFree(uint256 wanted, uint256 free);
    error InsufficientLocked(uint256 wanted, uint256 locked);

    constructor(address admin_, IERC20 settlement_, ICoveringAssets covers_) {
        if (admin_ == address(0) || address(settlement_) == address(0) || address(covers_) == address(0)) {
            revert ZeroAddress();
        }
        admin = admin_;
        settlement = settlement_;
        covers = covers_;
    }

    modifier onlyOperator() {
        if (msg.sender == address(0) || (msg.sender != matchBook && msg.sender != auction)) revert NotOperator();
        _;
    }

    // ---------------------------------------------------------------- makers

    function deposit(IERC20 token, uint256 amount) external nonReentrant {
        _supported(token);
        if (amount == 0) revert ZeroAmount();
        freeOf[msg.sender][token] += amount;
        emit Deposited(msg.sender, token, amount);
        if (token == settlement) token.safeTransferFrom(msg.sender, address(this), amount);
        else _pullCoverExact(token, msg.sender, amount);
    }

    /// @notice Withdraws free balances. Never paused.
    function withdraw(IERC20 token, uint256 amount) external nonReentrant {
        _supported(token);
        if (amount == 0) revert ZeroAmount();
        uint256 free = freeOf[msg.sender][token];
        if (amount > free) revert InsufficientFree(amount, free);
        freeOf[msg.sender][token] = free - amount;
        emit Withdrawn(msg.sender, token, amount);
        token.safeTransfer(msg.sender, amount);
    }

    // ---------------------------------------------------------------- operators

    /// @notice Free → locked (collateral for a fill). Refused if the maker's free balance is short.
    function lock(address maker, IERC20 token, uint256 amount) external onlyOperator {
        _supported(token);
        uint256 free = freeOf[maker][token];
        if (amount > free) revert InsufficientFree(amount, free);
        freeOf[maker][token] = free - amount;
        lockedOf[maker][token] += amount;
        emit Locked(maker, token, amount, msg.sender);
    }

    /// @notice Locked → free (collateral released by decay, a close or a buyback's remainder).
    function unlock(address maker, IERC20 token, uint256 amount) external onlyOperator {
        _supported(token);
        uint256 locked = lockedOf[maker][token];
        if (amount > locked) revert InsufficientLocked(amount, locked);
        lockedOf[maker][token] = locked - amount;
        freeOf[maker][token] += amount;
        emit Unlocked(maker, token, amount, msg.sender);
    }

    /// @notice Pays `amount` out of the maker's locked balances to `to` (a buyback to the pool, an auction settlement).
    ///         `sent` is false when a covering token could not move: it is then owed to `to` here.
    function pay(address maker, IERC20 token, uint256 amount, address to)
        external
        nonReentrant
        onlyOperator
        returns (bool sent)
    {
        _supported(token);
        if (to == address(0)) revert ZeroAddress();
        uint256 locked = lockedOf[maker][token];
        if (amount > locked) revert InsufficientLocked(amount, locked);
        lockedOf[maker][token] = locked - amount;
        emit Paid(maker, token, amount, to, msg.sender);
        sent = _out(token, to, amount);
    }

    /// @notice Takes up to `amount` of the maker's FREE balance to `to` (D4 backstop); the result is what was taken.
    function slash(address maker, IERC20 token, uint256 amount, address to)
        external
        nonReentrant
        onlyOperator
        returns (uint256 taken, bool sent)
    {
        _supported(token);
        if (to == address(0)) revert ZeroAddress();
        uint256 free = freeOf[maker][token];
        taken = amount < free ? amount : free;
        freeOf[maker][token] = free - taken;
        emit Slashed(maker, token, amount, taken, to, msg.sender);
        sent = _out(token, to, taken);
    }

    /// @dev settlement token always moves (or the call reverts); a covering token that cannot move is kept owed to `to`.
    function _out(IERC20 token, address to, uint256 amount) internal returns (bool) {
        if (token != settlement) return _sendCover(token, to, amount);
        if (amount > 0) token.safeTransfer(to, amount);
        return true;
    }

    // ---------------------------------------------------------------- admin (once each)

    function setMatchBook(address matchBook_) external {
        _setOnce(matchBook_, matchBook);
        matchBook = matchBook_;
        emit OperatorSet("matchBook", matchBook_);
    }

    function setAuction(address auction_) external {
        _setOnce(auction_, auction);
        auction = auction_;
        emit OperatorSet("auction", auction_);
    }

    function _setOnce(address next, address current) internal view {
        if (msg.sender != admin) revert NotAdmin();
        if (current != address(0)) revert AlreadySet();
        if (next == address(0)) revert ZeroAddress();
    }

    function _supported(IERC20 token) internal view {
        if (token != settlement && !covers.isCover(token)) revert UnsupportedToken(address(token));
    }
}
