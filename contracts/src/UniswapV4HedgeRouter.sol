// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IHedgeRouter} from "./HedgeSwap.sol";

/// @dev The parts of Uniswap v4's PoolManager this adapter uses (v4-core, ABI-compatible): a Currency is an address,
///      a BalanceDelta an int256 holding amount0 (upper 128 bits) and amount1 (lower 128 bits), each signed from the
///      caller's side (negative: the caller owes the PoolManager). A negative amountSpecified is an exact input.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManagerV4 {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
}

interface IUnlockCallbackV4 {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

/// @title UniswapV4HedgeRouter
/// @notice The stock hedge's swap path on Robinhood Chain (owner Q4: Uniswap v4), behind the pool's governance-listed
///         router (IHedgeRouter). Swaps an exact input through one listed v4 pool per token pair and sends the output to
///         `to`; whatever input the pool did not take (a price limit) goes back to the payer.
/// @dev    - Governance (the timelock) lists each pair's pool: fee and tick spacing, ERC-20 currencies only, and no
///           hooks (a hook could take a fee or call back; refused).
///         - The adapter holds nothing between calls and has no price of its own: the caller's `minOut` is enforced
///           here, and the Mainspring pool measures what arrived and enforces its own floor at the router mark.
///         - Only the PoolManager may call `unlockCallback`, and only inside a swap this adapter started.
contract UniswapV4HedgeRouter is IHedgeRouter, IUnlockCallbackV4, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    IPoolManagerV4 public immutable poolManager;
    mapping(address => mapping(address => PoolKey)) internal _pools; // sorted pair → key
    bool internal _inSwap;

    event PoolListed(address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing);
    event Swapped(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 spent, uint256 out, address to);

    error ZeroAddress();
    error NotPoolManager();
    error NotInSwap();
    error NoPool(address tokenIn, address tokenOut);
    error HooksRefused(address hooks);
    error SameToken();
    error TooLittleOut(uint256 out, uint256 minOut);
    error BadDelta(int128 owed, int128 received);

    constructor(address admin, IPoolManagerV4 poolManager_) {
        if (admin == address(0) || address(poolManager_) == address(0)) revert ZeroAddress();
        poolManager = poolManager_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Lists (or replaces) the v4 pool for a token pair: ERC-20s only, no hooks. Governance only.
    function listPool(address tokenA, address tokenB, uint24 fee, int24 tickSpacing)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (tokenA == address(0) || tokenB == address(0)) revert ZeroAddress(); // native ETH is not a stock pair
        if (tokenA == tokenB) revert SameToken();
        (address c0, address c1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        _pools[c0][c1] = PoolKey(c0, c1, fee, tickSpacing, address(0));
        emit PoolListed(c0, c1, fee, tickSpacing);
    }

    function poolOf(address tokenA, address tokenB) public view returns (PoolKey memory key) {
        (address c0, address c1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        key = _pools[c0][c1];
        if (key.currency0 == address(0)) revert NoPool(tokenA, tokenB);
        if (key.hooks != address(0)) revert HooksRefused(key.hooks);
    }

    /// @inheritdoc IHedgeRouter
    function swapExactIn(IERC20 tokenIn, IERC20 tokenOut, uint256 amountIn, uint256 minOut, address to)
        external
        nonReentrant
        returns (uint256 out)
    {
        if (to == address(0)) revert ZeroAddress();
        PoolKey memory key = poolOf(address(tokenIn), address(tokenOut));
        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);
        _inSwap = true;
        bytes memory r = poolManager.unlock(abi.encode(key, address(tokenIn) == key.currency0, amountIn, to));
        _inSwap = false;
        uint256 spent;
        (spent, out) = abi.decode(r, (uint256, uint256));
        if (out < minOut) revert TooLittleOut(out, minOut);
        if (spent < amountIn) tokenIn.safeTransfer(msg.sender, amountIn - spent); // a price limit left some unspent
        emit Swapped(address(tokenIn), address(tokenOut), amountIn, spent, out, to);
    }

    /// @notice Called by the PoolManager inside `unlock`: swap, pay what is owed, take the output.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        if (!_inSwap) revert NotInSwap();
        (PoolKey memory key, bool zeroForOne, uint256 amountIn, address to) =
            abi.decode(data, (PoolKey, bool, uint256, address));
        int256 delta = poolManager.swap(
            key,
            SwapParams(zeroForOne, -int256(amountIn), zeroForOne ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1),
            ""
        );
        int128 a0 = int128(delta >> 128);
        int128 a1 = int128(delta);
        (int128 owed, int128 received) = zeroForOne ? (a0, a1) : (a1, a0);
        if (owed > 0 || received < 0 || uint256(uint128(-owed)) > amountIn) revert BadDelta(owed, received);
        uint256 spent = uint256(uint128(-owed));
        uint256 out = uint256(uint128(received));
        (address tin, address tout) = zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        if (spent > 0) {
            poolManager.sync(tin);
            IERC20(tin).safeTransfer(address(poolManager), spent);
            poolManager.settle();
        }
        if (out > 0) poolManager.take(tout, to, out);
        return abi.encode(spent, out);
    }
}
