// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IHedgeRouter} from "../../src/HedgeSwap.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// A stand-in for Robinhood Chain liquidity (owner queue Q4): swaps USDC and one stock token at a set price (WAD USDC
/// per share) less a fee, minting what it pays out. Switches let tests make it pay short, take more than approved, or
/// fail.
contract MockHedgeRouter is IHedgeRouter {
    using SafeERC20 for IERC20;

    IERC20 public immutable settlement;
    IERC20 public immutable stock;
    uint256 public immutable scale; // 10^(18 − stock decimals)
    uint256 public pxWad;
    uint256 public feeBps;
    uint256 public shortBps; // pays this much less than it promised (ignores minOut)
    bool public broken;

    constructor(IERC20 settlement_, IERC20 stock_, uint256 scale_, uint256 pxWad_) {
        (settlement, stock, scale, pxWad) = (settlement_, stock_, scale_, pxWad_);
    }

    function set(uint256 pxWad_, uint256 feeBps_, uint256 shortBps_, bool broken_) external {
        (pxWad, feeBps, shortBps, broken) = (pxWad_, feeBps_, shortBps_, broken_);
    }

    function swapExactIn(IERC20 tokenIn, IERC20 tokenOut, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256 out)
    {
        require(!broken, "router down");
        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);
        if (tokenIn == settlement && tokenOut == stock) out = Math.mulDiv(amountIn * 1e12, 1e18, pxWad * scale);
        else if (tokenIn == stock && tokenOut == settlement) out = Math.mulDiv(amountIn * scale, pxWad, 1e30);
        else revert("pair");
        out = out * (10_000 - feeBps) / 10_000;
        if (shortBps == 0) require(out >= minOut, "slippage");
        else out = out * (10_000 - shortBps) / 10_000;
        IMintable(address(tokenOut)).mint(to, out);
    }
}
