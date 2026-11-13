// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MakerVault} from "../src/MakerVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockWHYPE} from "./mocks/MockWHYPE.sol";

/// M6 step 3: the MakerVault.
contract MakerVaultTest is Test {
    address constant ADMIN = address(0xAD);
    address constant BOOK = address(0xB00C); // plays the MatchBook
    address constant AUCTION = address(0xA0C7);
    address constant POOL = address(0x9001);
    address constant M1 = address(0x4D1);
    address constant M2 = address(0x4D2);
    address constant M3 = address(0x4D3);

    MockUSDC usdc;
    MockWHYPE whype;
    MakerVault vault;

    function setUp() public {
        usdc = new MockUSDC();
        whype = new MockWHYPE();
        vault = new MakerVault(ADMIN, IERC20(address(usdc)), IERC20(address(whype)));
        vm.startPrank(ADMIN);
        vault.setMatchBook(BOOK);
        vault.setAuction(AUCTION);
        vm.stopPrank();
        address[3] memory ms = [M1, M2, M3];
        for (uint256 i; i < 3; ++i) {
            usdc.mint(ms[i], 10_000_000e6);
            whype.mint(ms[i], 1_000_000e18);
            vm.startPrank(ms[i]);
            usdc.approve(address(vault), type(uint256).max);
            whype.approve(address(vault), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _u() internal view returns (IERC20) {
        return IERC20(address(usdc));
    }

    function _h() internal view returns (IERC20) {
        return IERC20(address(whype));
    }

    // ---------------------------------------------------------------- 1. deposit and withdraw

    function test_depositAndWithdrawFreeFundsOnly() public {
        vm.startPrank(M1);
        vm.expectEmit(true, true, false, true, address(vault));
        emit MakerVault.Deposited(M1, _u(), 1_000e6);
        vault.deposit(_u(), 1_000e6);
        vault.deposit(_h(), 50e18);
        vm.stopPrank();
        assertEq(vault.freeOf(M1, _u()), 1_000e6);
        assertEq(vault.freeOf(M1, _h()), 50e18);
        assertEq(usdc.balanceOf(address(vault)), 1_000e6);

        // lock part: locked funds cannot be withdrawn
        vm.prank(BOOK);
        vault.lock(M1, _u(), 600e6);
        vm.prank(M1);
        vm.expectRevert(abi.encodeWithSelector(MakerVault.InsufficientFree.selector, 401e6, 400e6));
        vault.withdraw(_u(), 401e6);
        uint256 before = usdc.balanceOf(M1);
        vm.prank(M1);
        vault.withdraw(_u(), 400e6);
        assertEq(usdc.balanceOf(M1) - before, 400e6);
        assertEq(vault.freeOf(M1, _u()), 0);
        assertEq(vault.lockedOf(M1, _u()), 600e6);
        // one maker's funds are not another's
        vm.prank(M2);
        vm.expectRevert(abi.encodeWithSelector(MakerVault.InsufficientFree.selector, 1, 0));
        vault.withdraw(_u(), 1);
        // zero amounts refused
        vm.prank(M1);
        vm.expectRevert(MakerVault.ZeroAmount.selector);
        vault.deposit(_u(), 0);
        vm.prank(M1);
        vm.expectRevert(MakerVault.ZeroAmount.selector);
        vault.withdraw(_h(), 0);
    }

    // ---------------------------------------------------------------- 2–3. operators

    function test_operatorsLockUnlockPaySlash() public {
        vm.prank(M1);
        vault.deposit(_u(), 1_000e6);

        // operator only
        address[2] memory notOps = [address(0xBAD), M1];
        for (uint256 i; i < 2; ++i) {
            vm.startPrank(notOps[i]);
            vm.expectRevert(MakerVault.NotOperator.selector);
            vault.lock(M1, _u(), 1);
            vm.expectRevert(MakerVault.NotOperator.selector);
            vault.unlock(M1, _u(), 1);
            vm.expectRevert(MakerVault.NotOperator.selector);
            vault.pay(M1, _u(), 1, POOL);
            vm.expectRevert(MakerVault.NotOperator.selector);
            vault.slash(M1, _u(), 1, POOL);
            vm.stopPrank();
        }

        // lock beyond free, unlock beyond locked: refused
        vm.startPrank(BOOK);
        vm.expectRevert(abi.encodeWithSelector(MakerVault.InsufficientFree.selector, 1_001e6, 1_000e6));
        vault.lock(M1, _u(), 1_001e6);
        vault.lock(M1, _u(), 700e6);
        vm.expectRevert(abi.encodeWithSelector(MakerVault.InsufficientLocked.selector, 701e6, 700e6));
        vault.unlock(M1, _u(), 701e6);
        vault.unlock(M1, _u(), 100e6);
        assertEq(vault.freeOf(M1, _u()), 400e6);
        assertEq(vault.lockedOf(M1, _u()), 600e6);

        // pay comes out of locked funds and leaves the vault
        vm.expectRevert(abi.encodeWithSelector(MakerVault.InsufficientLocked.selector, 601e6, 600e6));
        vault.pay(M1, _u(), 601e6, POOL);
        vault.pay(M1, _u(), 250e6, POOL);
        assertEq(usdc.balanceOf(POOL), 250e6);
        assertEq(vault.lockedOf(M1, _u()), 350e6);
        assertEq(vault.freeOf(M1, _u()), 400e6, "pay never touches free funds");
        vm.stopPrank();

        // slash takes free funds only, at most what is there, and says how much
        vm.prank(AUCTION); // the second operator
        uint256 taken = vault.slash(M1, _u(), 150e6, POOL);
        assertEq(taken, 150e6);
        vm.prank(BOOK);
        taken = vault.slash(M1, _u(), 10_000e6, POOL);
        assertEq(taken, 250e6, "only the free balance left");
        assertEq(vault.freeOf(M1, _u()), 0);
        assertEq(vault.lockedOf(M1, _u()), 350e6, "slash never touches locked funds");
        assertEq(usdc.balanceOf(POOL), 650e6);
        vm.prank(BOOK);
        assertEq(vault.slash(M1, _u(), 1e6, POOL), 0, "nothing free: nothing taken, no revert");
        assertEq(usdc.balanceOf(address(vault)), 350e6);
    }

    // ---------------------------------------------------------------- 4. tokens and setup

    function test_onlyUsdcAndWhypeAndOperatorsSetOnce() public {
        MockUSDC other = new MockUSDC();
        other.mint(M1, 1e6);
        vm.prank(M1);
        vm.expectRevert(abi.encodeWithSelector(MakerVault.UnsupportedToken.selector, address(other)));
        vault.deposit(IERC20(address(other)), 1e6);
        vm.prank(BOOK);
        vm.expectRevert(abi.encodeWithSelector(MakerVault.UnsupportedToken.selector, address(other)));
        vault.lock(M1, IERC20(address(other)), 0);

        vm.startPrank(ADMIN);
        vm.expectRevert(MakerVault.AlreadySet.selector);
        vault.setMatchBook(address(0x1234));
        vm.expectRevert(MakerVault.AlreadySet.selector);
        vault.setAuction(address(0x1234));
        vm.stopPrank();

        MakerVault fresh = new MakerVault(ADMIN, IERC20(address(usdc)), IERC20(address(whype)));
        vm.prank(address(0xBAD));
        vm.expectRevert(MakerVault.NotAdmin.selector);
        fresh.setMatchBook(BOOK);
        vm.prank(ADMIN);
        vm.expectRevert(MakerVault.ZeroAddress.selector);
        fresh.setMatchBook(address(0));
        // with no operators set, nobody can lock
        vm.prank(BOOK);
        vm.expectRevert(MakerVault.NotOperator.selector);
        fresh.lock(M1, _u(), 0);
        vm.expectRevert(MakerVault.ZeroAddress.selector);
        new MakerVault(address(0), IERC20(address(usdc)), IERC20(address(whype)));
    }

    // ---------------------------------------------------------------- 5. conservation fuzz

    /// Random sequences of every action by three makers and both operators: the vault's balance of each token always
    /// equals Σ free + Σ locked, and nothing goes negative (an underflow would revert the whole test).
    function testFuzz_balancesAlwaysAddUp(uint256 seed) public {
        address[3] memory ms = [M1, M2, M3];
        IERC20[2] memory tokens = [_u(), _h()];
        for (uint256 step; step < 60; ++step) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            address m = ms[r % 3];
            IERC20 t = tokens[(r >> 8) % 2];
            uint256 scale = t == _u() ? 1e6 : 1e18;
            uint256 amt = (1 + (r >> 16) % 1_000) * scale;
            uint256 action = (r >> 48) % 6;
            if (action == 0) {
                vm.prank(m);
                vault.deposit(t, amt);
            } else if (action == 1) {
                uint256 free = vault.freeOf(m, t);
                if (free > 0) {
                    vm.prank(m);
                    vault.withdraw(t, amt % free + 1);
                }
            } else if (action == 2) {
                uint256 free = vault.freeOf(m, t);
                if (free > 0) {
                    vm.prank(BOOK);
                    vault.lock(m, t, amt % free + 1);
                }
            } else if (action == 3) {
                uint256 locked = vault.lockedOf(m, t);
                if (locked > 0) {
                    vm.prank(BOOK);
                    vault.unlock(m, t, amt % locked + 1);
                }
            } else if (action == 4) {
                uint256 locked = vault.lockedOf(m, t);
                if (locked > 0) {
                    vm.prank(BOOK);
                    vault.pay(m, t, amt % locked + 1, POOL);
                }
            } else {
                vm.prank(AUCTION);
                vault.slash(m, t, amt, POOL);
            }
            for (uint256 k; k < 2; ++k) {
                uint256 sum;
                for (uint256 j; j < 3; ++j) {
                    sum += vault.freeOf(ms[j], tokens[k]) + vault.lockedOf(ms[j], tokens[k]);
                }
                assertEq(tokens[k].balanceOf(address(vault)), sum, "the vault holds exactly free + locked");
            }
        }
    }

    // ---------------------------------------------------------------- 6. gas

    function test_vaultGas() public {
        vm.prank(M1);
        vault.deposit(_u(), 1e6); // warm
        uint256 g = gasleft();
        vm.prank(M1);
        vault.deposit(_u(), 1_000e6);
        console2.log("deposit", g - gasleft());
        g = gasleft();
        vm.prank(BOOK);
        vault.lock(M1, _u(), 500e6);
        console2.log("lock", g - gasleft());
        g = gasleft();
        vm.prank(BOOK);
        vault.unlock(M1, _u(), 100e6);
        console2.log("unlock", g - gasleft());
        g = gasleft();
        vm.prank(BOOK);
        vault.pay(M1, _u(), 100e6, POOL);
        console2.log("pay", g - gasleft());
        g = gasleft();
        vm.prank(BOOK);
        vault.slash(M1, _u(), 100e6, POOL);
        console2.log("slash", g - gasleft());
        g = gasleft();
        vm.prank(M1);
        vault.withdraw(_u(), 100e6);
        console2.log("withdraw", g - gasleft());
    }
}
