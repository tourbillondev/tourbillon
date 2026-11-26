// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {UniswapV4HedgeRouter, IPoolManagerV4, PoolKey} from "../src/UniswapV4HedgeRouter.sol";
import {MockPoolManagerV4} from "./mocks/MockPoolManagerV4.sol";
import {MockSettlementToken} from "./mocks/MockSettlementToken.sol";
import {MockStockToken} from "./mocks/MockStockToken.sol";

/// RH7b (owner Q4): the Uniswap v4 adapter behind the pool's hedge router, against a mock PoolManager with v4's flash
/// accounting. Decimals come from the tokens.
contract UniswapV4HedgeRouterTest is Test {
    MockPoolManagerV4 pm;
    UniswapV4HedgeRouter r;
    MockSettlementToken usdg;
    MockStockToken stock;
    address gov = makeAddr("timelock");
    address payer = makeAddr("pool");
    address anyone = makeAddr("anyone");

    /// The mock's rate for a stock at `pxWad` (WAD USD per share), from the tokens' own decimals.
    function _rate(PoolKey memory k, uint256 pxWad) internal view returns (uint256) {
        uint256 sd = 10 ** stock.decimals();
        uint256 ud = 10 ** usdg.decimals();
        uint256 stockPerUsdUnit = sd * 1e18 * 1e18 / (pxWad * ud); // WAD: stock base units per settlement base unit
        return k.currency0 == address(usdg) ? stockPerUsdUnit : 1e36 / stockPerUsdUnit;
    }

    function _setUp(uint8 stockDecimals) internal {
        pm = new MockPoolManagerV4();
        r = new UniswapV4HedgeRouter(gov, IPoolManagerV4(address(pm)));
        usdg = new MockSettlementToken("Global Dollar", "USDG", 6);
        stock = new MockStockToken("Tokenized Stock", "STK1", stockDecimals);
        vm.prank(gov);
        r.listPool(address(stock), address(usdg), 3000, 60);
        PoolKey memory k = r.poolOf(address(usdg), address(stock));
        pm.setRate(k, _rate(k, 40e18));
        usdg.mint(address(pm), 1e15);
        stock.mint(address(pm), 1e9 * 10 ** stockDecimals);
        usdg.mint(payer, 1e12);
        stock.mint(payer, 1_000 * 10 ** stockDecimals);
        vm.startPrank(payer);
        usdg.approve(address(r), type(uint256).max);
        stock.approve(address(r), type(uint256).max);
        vm.stopPrank();
    }

    function test_swapsBothWaysAtThePoolsRateAndHoldsNothing() public {
        _setUp(18);
        vm.prank(payer);
        uint256 out = r.swapExactIn(IERC20(address(usdg)), IERC20(address(stock)), 400e6, 9.9e18, payer);
        assertEq(out, 10e18, "$400 at $40: 10 shares");
        vm.prank(payer);
        uint256 back = r.swapExactIn(IERC20(address(stock)), IERC20(address(usdg)), 10e18, 399e6, payer);
        assertEq(back, 400e6);
        assertEq(usdg.balanceOf(address(r)) + stock.balanceOf(address(r)), 0, "the adapter holds nothing");
        assertEq(pm.locker(), address(0));
    }

    function test_aSixDecimalStock() public {
        _setUp(6);
        vm.prank(payer);
        uint256 out = r.swapExactIn(IERC20(address(usdg)), IERC20(address(stock)), 400e6, 1, payer);
        assertEq(out, 10e6, "10 shares at 6 decimals");
    }

    function test_minOutAndAPartialFillGoesBackToThePayer() public {
        _setUp(18);
        pm.set(30, 10_000, false); // a 0.3% fee
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(UniswapV4HedgeRouter.TooLittleOut.selector, 9.97e18, 10e18));
        r.swapExactIn(IERC20(address(usdg)), IERC20(address(stock)), 400e6, 10e18, payer);
        pm.set(0, 5_000, false); // a price limit: half the input is used
        uint256 u0 = usdg.balanceOf(payer);
        vm.prank(payer);
        uint256 out = r.swapExactIn(IERC20(address(usdg)), IERC20(address(stock)), 400e6, 1, payer);
        assertEq(out, 5e18);
        assertEq(u0 - usdg.balanceOf(payer), 200e6, "the unspent half came back");
    }

    function test_refusals() public {
        _setUp(18);
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, anyone, bytes32(0)));
        r.listPool(address(usdg), address(stock), 500, 10);
        vm.startPrank(gov);
        vm.expectRevert(UniswapV4HedgeRouter.ZeroAddress.selector);
        r.listPool(address(0), address(stock), 500, 10); // native ETH is not a stock pair
        vm.expectRevert(UniswapV4HedgeRouter.SameToken.selector);
        r.listPool(address(stock), address(stock), 500, 10);
        vm.stopPrank();
        MockStockToken other = new MockStockToken("Other", "STK2", 18);
        vm.expectRevert(abi.encodeWithSelector(UniswapV4HedgeRouter.NoPool.selector, address(usdg), address(other)));
        r.poolOf(address(usdg), address(other));
        // only the PoolManager calls back, and only inside a swap the adapter started
        vm.expectRevert(UniswapV4HedgeRouter.NotPoolManager.selector);
        r.unlockCallback("");
        vm.prank(address(pm));
        vm.expectRevert(UniswapV4HedgeRouter.NotInSwap.selector);
        r.unlockCallback("");
        vm.expectRevert(UniswapV4HedgeRouter.ZeroAddress.selector);
        new UniswapV4HedgeRouter(gov, IPoolManagerV4(address(0)));
    }

    /// Fuzz: any amount at any price, either way: the output is the pool's rate, nothing stays in the adapter, and the
    /// PoolManager's books close (it would refuse the unlock otherwise).
    function testFuzz_anyAmountAnyPrice(uint64 amountSeed, uint64 pxSeed, bool buy) public {
        _setUp(18);
        uint256 px = bound(pxSeed, 1e18, 10_000e18);
        PoolKey memory k = r.poolOf(address(usdg), address(stock));
        pm.setRate(k, _rate(k, px));
        uint256 amount = buy ? bound(amountSeed, 1e6, 1e11) : bound(amountSeed, 1e15, 100e18);
        (IERC20 tin, IERC20 tout) = buy ? (IERC20(address(usdg)), IERC20(address(stock))) : (IERC20(address(stock)), IERC20(address(usdg)));
        uint256 before = tout.balanceOf(payer);
        vm.prank(payer);
        uint256 out = r.swapExactIn(tin, tout, amount, 0, payer);
        assertEq(tout.balanceOf(payer) - before, out);
        assertEq(usdg.balanceOf(address(r)) + stock.balanceOf(address(r)), 0);
    }
}
