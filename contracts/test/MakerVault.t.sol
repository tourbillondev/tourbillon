// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MakerVault} from "../src/MakerVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockStockToken} from "./mocks/MockStockToken.sol";
import {CoverFixture} from "./mocks/CoverFixture.sol";
import {CoverLedger as CoverLedgerErrors} from "../src/CoverLedger.sol";
import {CoveringAssets} from "../src/CoveringAssets.sol";

/// M6 step 3: the MakerVault.
contract MakerVaultTest is Test {
    address constant ADMIN = address(0xAD);
    address constant BOOK = address(0xB00C); // plays the MatchBook
    address constant AUCTION = address(0xA0C7);
    address constant POOL = address(0x9001);
    address constant M1 = address(0x4D1);
    address constant M2 = address(0x4D2);
    address constant M3 = address(0x4D3);

    MockUSDC settlement;
    MockStockToken stock;
    MakerVault vault;

    function setUp() public {
        settlement = new MockUSDC();
        stock = new MockStockToken("Mock Stock One", "STK1", 18);
        vault = new MakerVault(ADMIN, IERC20(address(settlement)), CoverFixture.listed(address(this), address(0x4A4B), IERC20(address(stock))));
        vm.startPrank(ADMIN);
        vault.setMatchBook(BOOK);
        vault.setAuction(AUCTION);
        vm.stopPrank();
        address[3] memory ms = [M1, M2, M3];
        for (uint256 i; i < 3; ++i) {
            settlement.mint(ms[i], 10_000_000e6);
            stock.mint(ms[i], 1_000_000e18);
            vm.startPrank(ms[i]);
            settlement.approve(address(vault), type(uint256).max);
            stock.approve(address(vault), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _u() internal view returns (IERC20) {
        return IERC20(address(settlement));
    }

    function _h() internal view returns (IERC20) {
        return IERC20(address(stock));
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
        assertEq(settlement.balanceOf(address(vault)), 1_000e6);

        // lock part: locked balance cannot be withdrawn
        vm.prank(BOOK);
        vault.lock(M1, _u(), 600e6);
        vm.prank(M1);
        vm.expectRevert(abi.encodeWithSelector(MakerVault.InsufficientFree.selector, 401e6, 400e6));
        vault.withdraw(_u(), 401e6);
        uint256 before = settlement.balanceOf(M1);
        vm.prank(M1);
        vault.withdraw(_u(), 400e6);
        assertEq(settlement.balanceOf(M1) - before, 400e6);
        assertEq(vault.freeOf(M1, _u()), 0);
        assertEq(vault.lockedOf(M1, _u()), 600e6);
        // one maker's balance is not another's
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

        // pay comes out of locked balance and leaves the vault
        vm.expectRevert(abi.encodeWithSelector(MakerVault.InsufficientLocked.selector, 601e6, 600e6));
        vault.pay(M1, _u(), 601e6, POOL);
        vault.pay(M1, _u(), 250e6, POOL);
        assertEq(settlement.balanceOf(POOL), 250e6);
        assertEq(vault.lockedOf(M1, _u()), 350e6);
        assertEq(vault.freeOf(M1, _u()), 400e6, "pay never touches free balance");
        vm.stopPrank();

        // slash takes free balance only, at most what is there, and says how much
        vm.prank(AUCTION); // the second operator
        (uint256 taken,) = vault.slash(M1, _u(), 150e6, POOL);
        assertEq(taken, 150e6);
        vm.prank(BOOK);
        (taken,) = vault.slash(M1, _u(), 10_000e6, POOL);
        assertEq(taken, 250e6, "only the free balance left");
        assertEq(vault.freeOf(M1, _u()), 0);
        assertEq(vault.lockedOf(M1, _u()), 350e6, "slash never touches locked balance");
        assertEq(settlement.balanceOf(POOL), 650e6);
        vm.prank(BOOK);
        (taken,) = vault.slash(M1, _u(), 1e6, POOL);
        assertEq(taken, 0, "nothing free: nothing taken, no revert");
        assertEq(settlement.balanceOf(address(vault)), 350e6);
    }

    // ---------------------------------------------------------------- 4. tokens and setup

    function test_onlySettlementAndListedCoverAndOperatorsSetOnce() public {
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

        CoveringAssets cov = CoverFixture.listed(address(this), address(0x4A4B), IERC20(address(stock)));
        MakerVault fresh = new MakerVault(ADMIN, IERC20(address(settlement)), cov);
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
        new MakerVault(address(0), IERC20(address(settlement)), cov);
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

    // ---------------------------------------------------------------- 5. covering tokens (RH5, owner D3, G9)

    /// A covering token must arrive exactly: a fee-on-transfer (or rebasing-on-transfer) deposit is refused.
    function test_aCoveringDepositMustArriveExactly() public {
        stock.setFeeBps(10); // 0.1% kept on the way
        vm.prank(M1);
        vm.expectRevert(abi.encodeWithSelector(CoverLedgerErrors.CoverNotExact.selector, 1_000e18, 999e18));
        vault.deposit(_h(), 1_000e18);
        stock.setFeeBps(0);
        vm.prank(M1);
        vault.deposit(_h(), 1_000e18);
        assertEq(vault.freeOf(M1, _h()), 1_000e18);
    }

    /// A covering token that cannot move is not lost and stops nothing: it stays owed to its receiver, `pay` and
    /// `slash` say it was not sent, and anyone settles it once the token moves again.
    function test_aStuckCoveringPaymentIsOwedAndSettlesLater() public {
        vm.prank(M1);
        vault.deposit(_h(), 1_000e18);
        vm.startPrank(BOOK);
        vault.lock(M1, _h(), 600e18);
        stock.setFrozen(true); // the issuer freezes transfers
        bool sent = vault.pay(M1, _h(), 200e18, POOL);
        assertFalse(sent);
        assertEq(vault.owedCover(_h(), POOL), 200e18);
        assertEq(vault.lockedOf(M1, _h()), 400e18, "the maker's lock is spent either way");
        (uint256 taken, bool sent2) = vault.slash(M1, _h(), 50e18, POOL);
        assertEq(taken, 50e18);
        assertFalse(sent2);
        assertEq(vault.owedCover(_h(), POOL), 250e18);
        vm.stopPrank();
        // still frozen: settling reverts and changes nothing
        vm.expectRevert();
        vault.settleCover(_h(), POOL);
        assertEq(vault.owedCover(_h(), POOL), 250e18);
        // unfrozen: anyone settles
        stock.setFrozen(false);
        vm.prank(address(0xA11CE));
        vault.settleCover(_h(), POOL);
        assertEq(stock.balanceOf(POOL), 250e18);
        assertEq(vault.owedCover(_h(), POOL), 0);
        assertEq(vault.owedCoverTotal(_h()), 0);
        vm.expectRevert(CoverLedgerErrors.NothingOwed.selector);
        vault.settleCover(_h(), POOL);
        // USDC never goes through the owed ledger: it moves, or the call reverts
        vm.prank(BOOK);
        assertTrue(vault.pay(M1, _u(), 0, POOL));
    }
}
