// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {CoveringAssets, ICoverMarks} from "../src/CoveringAssets.sol";
import {MockStockToken} from "./mocks/MockStockToken.sol";
import {MockMarks} from "./Engine.t.sol";

/// RH5: the covering-asset table (Backend §1, §2 F, §5; owner G8, G9).
contract CoveringAssetsTest is Test {
    CoveringAssets covers;
    MockMarks marks;
    MockStockToken aapl;
    address gov = makeAddr("timelock");
    address anyone = makeAddr("anyone");
    address book = makeAddr("book");
    address vault = makeAddr("vault");
    address pool = makeAddr("pool");
    bytes32 constant AAPL = "AAPL";
    bytes32 constant NVDA = "NVDA";
    bytes32 constant BTC = "BTC";

    function setUp() public {
        marks = new MockMarks();
        covers = new CoveringAssets(gov, ICoverMarks(address(marks)));
        aapl = new MockStockToken("Tokenized AAPL", "AAPL", 18);
    }

    function _holders() internal view returns (address[] memory h) {
        h = new address[](3);
        (h[0], h[1], h[2]) = (book, vault, pool);
    }

    function test_aStockCoversItsOwnMarketOnlyAndListingIsForever() public {
        vm.prank(gov);
        covers.list(AAPL, IERC20(address(aapl)), _holders());
        (IERC20 t, uint256 scale) = covers.coverOf(AAPL);
        assertEq(address(t), address(aapl));
        assertEq(scale, 1);
        (t,) = covers.coverOf(NVDA);
        assertEq(address(t), address(0), "tokenized AAPL never covers NVDA");
        (t,) = covers.coverOf(BTC);
        assertEq(address(t), address(0), "crypto has no covering asset");
        assertTrue(covers.isCover(IERC20(address(aapl))));
        assertEq(covers.marketOfToken(IERC20(address(aapl))), AAPL);
        assertEq(covers.listedCount(), 1);
        // a market is listed once, and a token covers one market only
        MockStockToken other = new MockStockToken("x", "x", 18); // made first: a call inside the arguments would take the expectRevert
        address[] memory h = _holders();
        vm.startPrank(gov);
        vm.expectRevert(abi.encodeWithSelector(CoveringAssets.AlreadyListed.selector, AAPL));
        covers.list(AAPL, IERC20(address(other)), h);
        vm.expectRevert(abi.encodeWithSelector(CoveringAssets.TokenTaken.selector, address(aapl)));
        covers.list(NVDA, IERC20(address(aapl)), h);
        vm.stopPrank();
    }

    function test_listingRefusesBadTokens() public {
        vm.startPrank(gov);
        MockStockToken big = new MockStockToken("Big", "BIG", 24);
        vm.expectRevert(abi.encodeWithSelector(CoveringAssets.BadDecimals.selector, uint8(24)));
        covers.list("BIG", IERC20(address(big)), _holders());
        aapl.setPaused(true);
        vm.expectRevert(abi.encodeWithSelector(CoveringAssets.CoverPaused.selector, AAPL));
        covers.list(AAPL, IERC20(address(aapl)), _holders());
        aapl.setPaused(false);
        // G8: every holder pair must be allowed; the pool not whitelisted yet stops the listing
        aapl.setRestricted(true);
        aapl.setAllowed(book, true);
        aapl.setAllowed(vault, true);
        vm.expectRevert(abi.encodeWithSelector(CoveringAssets.CoverRestricted.selector, AAPL, book, pool, uint8(3)));
        covers.list(AAPL, IERC20(address(aapl)), _holders());
        aapl.setAllowed(pool, true);
        covers.list(AAPL, IERC20(address(aapl)), _holders());
        vm.expectRevert(CoveringAssets.ZeroAddress.selector);
        covers.list(bytes32(0), IERC20(address(aapl)), _holders());
        vm.stopPrank();
    }

    function test_checkCoverAtWriteTime() public {
        vm.prank(gov);
        covers.list(AAPL, IERC20(address(aapl)), _holders());
        covers.checkCover(AAPL, anyone, book, 1e18); // unrestricted: fine
        vm.expectRevert(abi.encodeWithSelector(CoveringAssets.NoCover.selector, BTC));
        covers.checkCover(BTC, anyone, book, 1e18);
        aapl.setPaused(true);
        vm.expectRevert(abi.encodeWithSelector(CoveringAssets.CoverPaused.selector, AAPL));
        covers.checkCover(AAPL, anyone, book, 1e18);
        aapl.setPaused(false);
        aapl.setRestricted(true);
        aapl.setAllowed(book, true);
        vm.expectRevert(abi.encodeWithSelector(CoveringAssets.CoverRestricted.selector, AAPL, anyone, book, uint8(2)));
        covers.checkCover(AAPL, anyone, book, 1e18);
    }

    function test_valueAtTheRouterMarkAndZeroWhenStale() public {
        MockStockToken six = new MockStockToken("Six", "SIX", 6);
        vm.startPrank(gov);
        covers.list(AAPL, IERC20(address(aapl)), new address[](0));
        covers.list("SIX", IERC20(address(six)), new address[](0));
        vm.stopPrank();
        marks.set(AAPL, 200e18);
        marks.set("SIX", 50e18);
        aapl.mint(pool, 10e18); // 10 shares × 200 = 2,000 USDC
        six.mint(pool, 4e6); // 4 shares × 50 = 200 USDC
        assertEq(covers.valueOf(pool), 2_200e6);
        marks.setStale(true);
        assertEq(covers.valueOf(pool), 0, "a stale mark counts nothing (the cautious side)");
        assertEq(covers.valueOf(anyone), 0);
    }

    function test_governanceOnly() public {
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, anyone, bytes32(0)));
        covers.list(AAPL, IERC20(address(aapl)), _holders());
        vm.expectRevert(CoveringAssets.ZeroAddress.selector);
        new CoveringAssets(gov, ICoverMarks(address(0)));
    }

    /// Fuzz: for any decimals up to 18, the scale turns token amounts into WAD units of the stock exactly.
    function testFuzz_scaleForAnyDecimals(uint8 d, uint64 amount) public {
        d = uint8(bound(d, 0, 18));
        MockStockToken t = new MockStockToken("T", "T", d);
        vm.prank(gov);
        covers.list("T", IERC20(address(t)), new address[](0));
        (, uint256 scale) = covers.coverOf("T");
        assertEq(scale, 10 ** (18 - d));
        assertEq(uint256(amount) * scale / 1e18, uint256(amount) / 10 ** d, "whole shares agree");
    }
}
