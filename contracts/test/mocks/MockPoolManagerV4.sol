// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PoolKey, SwapParams, IUnlockCallbackV4} from "../../src/UniswapV4HedgeRouter.sol";

/// Tests and local anvil only: a stand-in for Uniswap v4's PoolManager (owner Q4), with its flash accounting: inside
/// `unlock` the caller's deltas move with swap, sync/settle and take, and every delta must be back to zero when the
/// callback ends. A pool fills an exact input at a set rate (currency1 base units per currency0 base unit, WAD)
/// less a fee; `fillBps` below 10,000 fills only part of the input (as a price limit would). It holds both tokens as
/// liquidity (minted by the test). Switches let tests make it misbehave.
contract MockPoolManagerV4 {
    using SafeERC20 for IERC20;

    mapping(bytes32 => uint256) public rateWad;
    uint256 public feeBps;
    uint256 public fillBps = 10_000;
    bool public payShort; // `take` sends only half of what it books (a broken venue the pool's balance check catches)
    address public locker;
    mapping(address => int256) public delta; // currency → delta of the locker (+: owed to the locker)
    uint256 internal _nonzero;
    address internal _synced;
    uint256 internal _syncedBalance;

    function setRate(PoolKey memory key, uint256 rate) external {
        rateWad[keccak256(abi.encode(key))] = rate;
    }

    function set(uint256 feeBps_, uint256 fillBps_, bool payShort_) external {
        (feeBps, fillBps, payShort) = (feeBps_, fillBps_, payShort_);
    }

    function unlock(bytes calldata data) external returns (bytes memory r) {
        require(locker == address(0), "locked");
        locker = msg.sender;
        r = IUnlockCallbackV4(msg.sender).unlockCallback(data);
        require(_nonzero == 0, "CurrencyNotSettled");
        locker = address(0);
    }

    function _move(address c, int256 d) internal {
        int256 before = delta[c];
        int256 next = before + d;
        if (before == 0 && next != 0) _nonzero++;
        else if (before != 0 && next == 0) _nonzero--;
        delta[c] = next;
    }

    function swap(PoolKey memory key, SwapParams memory p, bytes calldata) external returns (int256) {
        require(msg.sender == locker, "not the locker");
        require(p.amountSpecified < 0, "exact input only here");
        uint256 rate = rateWad[keccak256(abi.encode(key))];
        require(rate > 0, "no pool");
        uint256 amountIn = uint256(-p.amountSpecified) * fillBps / 10_000;
        uint256 out = p.zeroForOne ? amountIn * rate / 1e18 : amountIn * 1e18 / rate;
        out = out * (10_000 - feeBps) / 10_000;
        (address tin, address tout) = p.zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        _move(tin, -int256(amountIn));
        _move(tout, int256(out));
        int128 a0 = p.zeroForOne ? -int128(int256(amountIn)) : int128(int256(out));
        int128 a1 = p.zeroForOne ? int128(int256(out)) : -int128(int256(amountIn));
        return (int256(a0) << 128) | int256(uint256(uint128(a1)));
    }

    function sync(address currency) external {
        _synced = currency;
        _syncedBalance = IERC20(currency).balanceOf(address(this));
    }

    function settle() external payable returns (uint256 paid) {
        require(msg.sender == locker, "not the locker");
        paid = IERC20(_synced).balanceOf(address(this)) - _syncedBalance;
        _move(_synced, int256(paid));
        _synced = address(0);
    }

    function take(address currency, address to, uint256 amount) external {
        require(msg.sender == locker, "not the locker");
        _move(currency, -int256(amount));
        uint256 give = payShort ? amount / 2 : amount;
        IERC20(currency).safeTransfer(to, give);
    }
}
