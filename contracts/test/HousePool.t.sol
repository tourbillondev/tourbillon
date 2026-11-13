// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {HousePool} from "../src/HousePool.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract SevenDecimals {
    function decimals() external pure returns (uint8) {
        return 7;
    }
}

/// The test contract is both the admin and (once set) the engine.
contract HousePoolTest is Test {
    bytes32 constant BTC = "BTC";
    bytes32 constant ETH = "ETH";
    address constant SELLER = address(0x5E11);
    address constant FEES = address(0xFEE);
    address constant STRANGER = address(0xBAD);

    MockUSDC usdc;
    HousePool pool;

    function setUp() public {
        usdc = new MockUSDC();
        pool = new HousePool(address(this), usdc, FEES);
        pool.setEngine(address(this));
        usdc.mint(address(this), 10_000_000e6);
        usdc.approve(address(pool), type(uint256).max);
        pool.deposit(1_000_000e6);
        pool.setCap(BTC, 500_000e6);
        pool.setCap(ETH, 100_000e6);
    }

    function test_constructorChecks() public {
        MockUSDC seven = MockUSDC(address(new SevenDecimals())); // created first: a call inside the arguments would consume expectRevert
        vm.expectRevert(abi.encodeWithSelector(HousePool.NotSixDecimals.selector, 7));
        new HousePool(address(this), seven, FEES);
        vm.expectRevert(HousePool.ZeroAddress.selector);
        new HousePool(address(0), usdc, FEES);
        assertEq(address(pool.asset()), address(usdc));
    }

    function test_onlyEngineAndAdmin() public {
        vm.startPrank(STRANGER);
        vm.expectRevert(HousePool.NotEngine.selector);
        pool.onBuy(BTC, 1, 1e18, 1e18, 100e18, 0, 1e6, 0);
        vm.expectRevert(HousePool.NotEngine.selector);
        pool.onSell(BTC, 1, 1, 0, 0, 0, 0, 0, 0, SELLER);
        bytes32 admin = pool.DEFAULT_ADMIN_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, STRANGER, admin)
        );
        pool.setCap(BTC, 1);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, STRANGER, admin)
        );
        pool.deposit(1);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, STRANGER, admin)
        );
        pool.withdraw(STRANGER, 1);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, STRANGER, admin)
        );
        pool.setEngine(STRANGER);
        vm.stopPrank();

        // the engine is set once
        vm.expectRevert(HousePool.EngineAlreadySet.selector);
        pool.setEngine(STRANGER);
        HousePool fresh = new HousePool(address(this), usdc, FEES);
        vm.expectRevert(HousePool.NotEngine.selector); // no engine yet: nobody may call
        fresh.onBuy(BTC, 1, 1e18, 1e18, 100e18, 0, 0, 0);
        vm.expectRevert(HousePool.ZeroAddress.selector);
        fresh.setEngine(address(0));
    }

    function test_capsPerMarket() public {
        // 5 BTC units at $100,000 = $500,000: exactly the cap
        pool.onBuy(BTC, 1, 5e18, 5e18, 100_000e18, 0, 1, 0);
        assertEq(pool.openNotional(BTC), 500_000e6);
        // one more cent of notional is refused
        vm.expectRevert(abi.encodeWithSelector(HousePool.CapExceeded.selector, BTC, 500_000e6 + 10_000, 500_000e6));
        pool.onBuy(BTC, 2, 1e16, 1e16, 1e18, 0, 1, 0); // 0.01 units × $1 = $0.01
        // ETH has its own cap
        pool.onBuy(ETH, 3, 10e18, 10e18, 3_000e18, 0, 1, 0);
        assertEq(pool.openNotional(ETH), 30_000e6);
        // a cap of 0 refuses every buy
        vm.expectRevert(abi.encodeWithSelector(HousePool.CapExceeded.selector, bytes32("HYPE"), 1, 0));
        pool.onBuy("HYPE", 4, 1e12, 1e12, 1e18, 0, 0, 0); // the smallest notional rounds up to 1 micro-USDC
        vm.expectRevert(HousePool.ZeroRaw.selector);
        pool.onBuy(BTC, 1, 1, 0, 1e18, 0, 0, 0);
    }

    function test_proRataReleaseAndExactPayout() public {
        pool.onBuy(BTC, 7, 3e18, 300, 50_000e18, 0, 0, 0); // $150,000 entry notional on 300 raw
        // sell a third of the raw
        pool.onSell(BTC, 7, 100, 0, 0, 0, 1_000e6 + 25e6, 1_000e6, 25e6, SELLER);
        assertEq(pool.seriesNotional(7), 100_000e6);
        assertEq(pool.openNotional(BTC), 100_000e6);
        assertEq(usdc.balanceOf(SELLER), 1_000e6);
        assertEq(usdc.balanceOf(FEES), 25e6);
        // more raw than held is capped: the rest is released exactly
        pool.onSell(BTC, 7, 1_000, 0, 0, 0, 0, 0, 0, SELLER);
        assertEq(pool.seriesRaw(7), 0);
        assertEq(pool.seriesNotional(7), 0);
        assertEq(pool.openNotional(BTC), 0);
        assertEq(pool.totalOpenNotional(), 0);
    }

    /// INTERIM LIMIT (mainnet blocker): a sell the pool cannot pay reverts.
    function test_insolventSellReverts() public {
        pool.onBuy(BTC, 1, 1e18, 1e18, 100_000e18, 0, 0, 0);
        uint256 bal = usdc.balanceOf(address(pool));
        vm.expectRevert(abi.encodeWithSelector(HousePool.Insolvent.selector, bal + 1, bal));
        pool.onSell(BTC, 1, 1e18, 0, 0, 0, bal + 1, bal, 1, SELLER);
    }

    function test_withdrawOnlyAboveReserve() public {
        pool.onBuy(BTC, 1, 2e18, 2e18, 100_000e18, 0, 0, 0); // $200,000 open: reserve $400,000
        assertEq(pool.reserve(), 400_000e6);
        assertEq(pool.free(), 600_000e6);
        vm.expectRevert(abi.encodeWithSelector(HousePool.AboveFree.selector, 600_000e6 + 1, 600_000e6));
        pool.withdraw(address(this), 600_000e6 + 1);
        pool.withdraw(address(this), 600_000e6);
        assertEq(pool.free(), 0);
        // once nothing is open, everything is free
        pool.onSell(BTC, 1, 2e18, 0, 0, 0, 0, 0, 0, SELLER);
        assertEq(pool.free(), 400_000e6);
        pool.withdraw(address(this), 400_000e6);
        assertEq(usdc.balanceOf(address(pool)), 0);
    }

    /// Random buys and sells on three series in two markets: market and total notional always equal the sum of
    /// the series, and closing every series brings them back to exactly zero.
    function testFuzz_accountingReturnsToZero(uint256 seed) public {
        uint256[3] memory ids = [uint256(11), 22, 33];
        bytes32[3] memory mk = [BTC, BTC, ETH];
        pool.setCap(BTC, type(uint256).max);
        pool.setCap(ETH, type(uint256).max);
        for (uint256 i; i < 40; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 j = r % 3;
            if ((r >> 8) % 3 != 0) {
                pool.onBuy(
                    mk[j], ids[j], bound(r >> 16, 1, 1e24), bound(r >> 96, 1, 1e24), bound(r >> 176, 1, 1e24), 0, 0, 0
                );
            } else if (pool.seriesRaw(ids[j]) > 0) {
                pool.onSell(mk[j], ids[j], bound(r >> 16, 1, pool.seriesRaw(ids[j])), 0, 0, 0, 0, 0, 0, SELLER);
            }
            assertEq(pool.openNotional(BTC), pool.seriesNotional(11) + pool.seriesNotional(22));
            assertEq(pool.openNotional(ETH), pool.seriesNotional(33));
            assertEq(pool.totalOpenNotional(), pool.openNotional(BTC) + pool.openNotional(ETH));
        }
        for (uint256 j; j < 3; ++j) {
            if (pool.seriesRaw(ids[j]) > 0) {
                pool.onSell(mk[j], ids[j], pool.seriesRaw(ids[j]), 0, 0, 0, 0, 0, 0, SELLER);
            }
        }
        assertEq(pool.totalOpenNotional(), 0);
        assertEq(pool.openNotional(BTC), 0);
        assertEq(pool.openNotional(ETH), 0);
    }

    function test_mockUsdcHasSixDecimalsAndPermit() public {
        assertEq(usdc.decimals(), 6);
        uint256 pk = 0xA11CE; // a throwaway test key, generated for this test only
        address owner = vm.addr(pk);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdc.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                        owner,
                        address(pool),
                        5e6,
                        0,
                        deadline
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        usdc.permit(owner, address(pool), 5e6, deadline, v, r, s);
        assertEq(usdc.allowance(owner, address(pool)), 5e6);
    }
}
