// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ICoveringAssets} from "./CoveringAssets.sol";
import {IMarkRouter} from "./PathFundingBook.sol";

/// @notice The swap path the pool hedges stock markets through (Backend §6: Robinhood Chain's own liquidity, DEX or
///         canonical AMM (U)). One adapter per venue, listed through governance; it swaps an exact input and sends
///         the output to `to`.
interface IHedgeRouter {
    function swapExactIn(IERC20 tokenIn, IERC20 tokenOut, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256 amountOut);
}

/// @title HedgeSwap
/// @notice The on-chain stock hedge (owner G7): the pool swaps settlement token for a market's tokenized stock, or back, through
///         the listed router. Linked as a public library, so it runs in the pool's own context: the pool holds the
///         inventory, the keeper never holds tokens.
/// @dev    The keeper never chooses a price: `minOut` must be at least the value at the router mark less the listed
///         slippage, and the output is measured from the pool's own balance, never taken from the router's reply.
library HedgeSwap {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD_PER_SETTLEMENT_UNIT = 1e12;

    uint256 public constant MAX_SLIPPAGE_BPS = 300;

    /// @notice The hedge settings and counters, kept in the pool's storage; set by governance only.
    struct Limits {
        address router; // the listed swap adapter; zero = no on-chain hedging
        uint16 slippageBps; // the most a swap may give away against the router mark
        uint256 dailyCap; // settlement token of swaps (either way) per UTC day, across markets
        mapping(bytes32 => uint256) inventoryCap; // WAD shares the pool may hold after a hedge buy
        mapping(uint256 => uint256) onDay; // UTC day → settlement token of swaps
    }

    event HedgeSwapped(bytes32 indexed market, bool buy, uint256 amountIn, uint256 amountOut, uint256 markWad);
    event HedgeSet(address router, uint16 slippageBps, bytes32 indexed market, uint256 inventoryCap, uint256 dailyCap);

    error NoHedgeRouter();
    error NoCoverToken(bytes32 market);
    error ZeroAmount();
    error SlippageTooHigh(uint256 bps);
    error InventoryCapExceeded(bytes32 market, uint256 wouldHold, uint256 cap);
    error DailyCapExceeded(uint256 wouldBe, uint256 cap);
    error MinOutBelowFloor(uint256 minOut, uint256 floor);
    error SwapShort(uint256 received, uint256 minOut);
    error SpentMoreThanAsked(uint256 spent, uint256 amountIn);

    /// @notice The lowest output the pool accepts for `amountIn` at mark `s` (WAD settlement token per share): settlement token → token when
    ///         `buy`, token → settlement token otherwise, less `slipBps`; rounded down.
    /// @param scale 10^(18 − token decimals).
    function floorOut(bool buy, uint256 amountIn, uint256 s, uint256 scale, uint256 slipBps)
        public
        pure
        returns (uint256)
    {
        uint256 fair = buy
            ? Math.mulDiv(amountIn * WAD_PER_SETTLEMENT_UNIT, 1e18, s * scale) // token units
            : Math.mulDiv(amountIn * scale, s, 1e18 * WAD_PER_SETTLEMENT_UNIT); // settlement token units
        return Math.mulDiv(fair, BPS - slipBps, BPS);
    }

    /// @notice One hedge swap for `market` (the pool's hedgeSwap): no listed router, no token or no fresh mark (law 2)
    ///         refuses; a buy must stay within the market's inventory cap; every swap counts towards the daily cap.
    function run(
        Limits storage L,
        IERC20 settlement,
        ICoveringAssets covers,
        IMarkRouter marks,
        bytes32 market,
        bool buy,
        uint256 amountIn,
        uint256 minOut
    ) public returns (uint256 out) {
        address r = L.router;
        if (r == address(0)) revert NoHedgeRouter();
        if (amountIn == 0) revert ZeroAmount();
        if (address(covers) == address(0)) revert NoCoverToken(market);
        (IERC20 token, uint256 scale) = covers.coverOf(market);
        if (address(token) == address(0)) revert NoCoverToken(market);
        uint256 s = marks.markWad(market);
        out = swap(settlement, token, scale, r, s, L.slippageBps, buy, amountIn, minOut);
        uint256 day = block.timestamp / 1 days;
        uint256 today = L.onDay[day] + (buy ? amountIn : out);
        if (today > L.dailyCap) revert DailyCapExceeded(today, L.dailyCap);
        L.onDay[day] = today;
        if (buy) {
            uint256 held = token.balanceOf(address(this)) * scale;
            if (held > L.inventoryCap[market]) revert InventoryCapExceeded(market, held, L.inventoryCap[market]);
        }
        emit HedgeSwapped(market, buy, amountIn, out, s);
    }

    /// @notice Governance: the router (zero turns hedging off), its slippage bound, one market's inventory cap and the
    ///         daily cap.
    function configure(
        Limits storage L,
        address router,
        uint16 slippageBps,
        bytes32 market,
        uint256 inventoryCap,
        uint256 dailyCap
    ) public {
        if (slippageBps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh(slippageBps);
        (L.router, L.slippageBps, L.dailyCap) = (router, slippageBps, dailyCap);
        L.inventoryCap[market] = inventoryCap;
        emit HedgeSet(router, slippageBps, market, inventoryCap, dailyCap);
    }

    /// @notice Swaps exactly `amountIn` of the input through `router`; gives back what arrived (≥ minOut ≥ the floor).
    function swap(
        IERC20 settlement,
        IERC20 token,
        uint256 scale,
        address router,
        uint256 s,
        uint256 slipBps,
        bool buy,
        uint256 amountIn,
        uint256 minOut
    ) internal returns (uint256 out) {
        uint256 floor = floorOut(buy, amountIn, s, scale, slipBps);
        if (minOut < floor || minOut == 0) revert MinOutBelowFloor(minOut, floor);
        (IERC20 tin, IERC20 tout) = buy ? (settlement, token) : (token, settlement);
        uint256 in0 = tin.balanceOf(address(this));
        uint256 out0 = tout.balanceOf(address(this));
        tin.forceApprove(router, amountIn);
        IHedgeRouter(router).swapExactIn(tin, tout, amountIn, minOut, address(this));
        tin.forceApprove(router, 0);
        uint256 spent = in0 - tin.balanceOf(address(this));
        if (spent > amountIn) revert SpentMoreThanAsked(spent, amountIn);
        out = tout.balanceOf(address(this)) - out0;
        if (out < minOut) revert SwapShort(out, minOut);
    }
}
