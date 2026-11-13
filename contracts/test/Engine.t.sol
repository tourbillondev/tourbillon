// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Engine} from "../src/Engine.sol";
import {EnginePricing} from "../src/EnginePricing.sol";
import {HousePool} from "../src/HousePool.sol";
import {PathFundingBook, IMarkRouter, IVolSource} from "../src/PathFundingBook.sol";
import {PathFunding} from "../src/PathFunding.sol";
import {TempoBlend} from "../src/TempoBlend.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// Settable mark source that can go stale (reverts like the router does).
contract MockMarks is IMarkRouter {
    mapping(bytes32 => uint256) public px;
    bool public stale;

    error Stale(bytes32 market);

    function set(bytes32 m, uint256 p) external {
        px[m] = p;
    }

    function setStale(bool s) external {
        stale = s;
    }

    function markWad(bytes32 m) external view returns (uint256) {
        if (stale || px[m] == 0) revert Stale(m);
        return px[m];
    }
}

/// Settable vol source that can go stale (reverts like the board does).
contract MockVols is IVolSource {
    mapping(bytes32 => uint256) public bps;
    bool public stale;

    error Stale(bytes32 key);

    function set(bytes32 m, uint256 b) external {
        bps[m] = b;
    }

    function setStale(bool s) external {
        stale = s;
    }

    function volBps(bytes32 m) external view returns (uint256) {
        if (stale || bps[m] == 0) revert Stale(m);
        return bps[m];
    }
}

/// Shared setup for the Engine tests: mocks, a real book (this contract as bootstrap recorder), HousePool, USDC.
abstract contract EngineBase is Test {
    uint256 constant T0 = 1_794_182_400;
    bytes32 constant BTC = "BTC";
    bytes32 constant ETH = "ETH";
    address constant BUYER = address(0xB0B);
    address constant FEES = address(0xFEE);
    address constant PAUSER = address(0x9A05E);
    address constant STRANGER = address(0xBAD);

    MockUSDC usdc;
    MockMarks marks;
    MockVols vols;
    HousePool pool;
    PathFundingBook book;
    Engine engine;
    uint256 nowT;

    /// Tracked clock: with via-IR, block.timestamp can be cached inside one test function.
    function _set(uint256 t) internal {
        nowT = t;
        vm.warp(t);
    }

    function _adv(uint256 dt) internal {
        _set(nowT + dt);
    }

    function setUp() public {
        _set(T0);
        usdc = new MockUSDC();
        marks = new MockMarks();
        vols = new MockVols();
        pool = new HousePool(address(this), usdc, FEES);
        // The book stores its engine permanently: predict the engine's address (deployed right after the book).
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        book = new PathFundingBook(predicted, address(this), marks, vols);
        engine = new Engine(address(this), book, pool, marks, vols);
        assertEq(address(engine), predicted);
        assertEq(book.engine(), address(engine));

        pool.setEngine(address(engine));
        usdc.mint(address(this), 10_000_000e6);
        usdc.approve(address(pool), type(uint256).max);
        pool.deposit(1_000_000e6);
        pool.setCap(BTC, 5_000_000e6);
        pool.setCap(ETH, 5_000_000e6);
        engine.setMarket(BTC, 100e18, 200);
        engine.setMarket(ETH, 5e18, 200);
        engine.grantRole(engine.PAUSER_ROLE(), PAUSER);

        marks.set(BTC, 50_000e18);
        vols.set(BTC, 5000);
        book.record(BTC, 50_000e18, 5000);

        usdc.mint(BUYER, 1_000_000e6);
        vm.prank(BUYER);
        usdc.approve(address(engine), type(uint256).max);
    }

    function _day() internal pure returns (TempoBlend.Part[] memory) {
        return TempoBlend.single(1 days);
    }

    function _buy(bool isCall, uint128 k, TempoBlend.Part[] memory mv, uint256 units)
        internal
        returns (uint256, uint256)
    {
        vm.prank(BUYER);
        return engine.buy(BTC, isCall, k, mv, units, type(uint256).max, nowT);
    }
}

contract EngineTest is EngineBase {
    // ---------------------------------------------------------------- happy path

    function test_buyPaysExactlyPremiumPlusFee() public {
        uint256 v = EnginePricing.unitValue(true, 50_000e18, 50_000e18, 5000, _day());
        (uint256 premium, uint256 fee) = EnginePricing.buyQuote(v, 2e18, 50_000e18, 200);
        uint256 id = book.idOf(BTC, true, 50_000e18, _day());

        vm.expectEmit(true, true, true, true, address(engine));
        emit Engine.Bought(BUYER, id, BTC, 2e18, 2e18, 50_000e18, 5000, v, premium, fee);
        (uint256 gotId, uint256 cost) = _buy(true, 50_000e18, _day(), 2e18);

        assertEq(gotId, id);
        assertEq(cost, premium + fee);
        assertEq(usdc.balanceOf(BUYER), 1_000_000e6 - cost);
        assertEq(usdc.balanceOf(address(pool)), 1_000_000e6 + premium);
        assertEq(usdc.balanceOf(FEES), fee);
        assertEq(usdc.balanceOf(address(engine)), 0, "the engine holds no money");
        assertEq(book.balanceOf(id, BUYER), 2e18); // fresh series: norm 1
        assertEq(pool.openNotional(BTC), 100_000e6); // 2 units × $50,000
        // ATM 1-day call at σ 50% is worth about 0.92525% of S: about $462.6 per unit
        assertApproxEqRel(v, 462.625e18, 1e14);
    }

    function test_movementBuyAndSeriesReuse() public {
        TempoBlend.Part[] memory mv = new TempoBlend.Part[](2);
        mv[0] = TempoBlend.Part(1 days, 0.5e18);
        mv[1] = TempoBlend.Part(7 days, 0.5e18);
        (uint256 id1,) = _buy(false, 48_000e18, mv, 1e18);
        assertTrue(book.exists(id1));
        (uint256 id2,) = _buy(false, 48_000e18, mv, 3e18);
        assertEq(id1, id2, "same terms, same series");
        assertEq(book.balanceOf(id1, BUYER), 4e18);
        (bytes32 name, bool isCall, uint128 k, TempoBlend.Part[] memory got) = book.seriesOf(id1);
        assertEq(name, BTC);
        assertFalse(isCall);
        assertEq(k, 48_000e18);
        assertEq(got.length, 2);
    }

    // ---------------------------------------------------------------- law 2

    function test_noBuyWithoutFreshMarkVolOrSample() public {
        marks.setStale(true);
        vm.expectRevert(abi.encodeWithSelector(MockMarks.Stale.selector, BTC));
        _buy(true, 50_000e18, _day(), 1e18);
        marks.setStale(false);

        vols.setStale(true);
        vm.expectRevert(abi.encodeWithSelector(MockVols.Stale.selector, BTC));
        _buy(true, 50_000e18, _day(), 1e18);
        vols.setStale(false);

        // ETH is listed, with a fresh mark and vol, but no recorded sample: the book refuses to open a series
        marks.set(ETH, 3_000e18);
        vols.set(ETH, 6000);
        vm.prank(BUYER);
        vm.expectRevert(PathFunding.NoHistory.selector);
        engine.buy(ETH, true, 3_000e18, _day(), 1e18, type(uint256).max, nowT);
    }

    // ---------------------------------------------------------------- pause

    function test_pauserPausesBuysOnlyTheUnpauserUnpauses() public {
        bytes32 pauserRole = engine.PAUSER_ROLE(); // read first: a call inside the arguments would take the prank
        vm.prank(STRANGER);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, STRANGER, pauserRole)
        );
        engine.pauseBuys();

        vm.prank(PAUSER);
        engine.pauseBuys();
        vm.expectRevert(Engine.BuysArePaused.selector);
        _buy(true, 50_000e18, _day(), 1e18);

        bytes32 unpauser = engine.UNPAUSER_ROLE(); // M7 step 3: unpausing is its own role (the admin holds it here)
        vm.prank(PAUSER);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, PAUSER, unpauser)
        );
        engine.unpauseBuys();

        engine.unpauseBuys();
        _buy(true, 50_000e18, _day(), 1e18);
    }

    // ---------------------------------------------------------------- refusals

    function test_refusals() public {
        TempoBlend.Part[] memory day = _day();
        vm.startPrank(BUYER);
        vm.expectRevert(abi.encodeWithSelector(Engine.Expired.selector, nowT - 1));
        engine.buy(BTC, true, 50_000e18, day, 1e18, type(uint256).max, nowT - 1);

        vm.expectRevert(Engine.ZeroUnits.selector);
        engine.buy(BTC, true, 50_000e18, day, 0, type(uint256).max, nowT);

        vm.expectRevert(abi.encodeWithSelector(Engine.NotListed.selector, bytes32("HYPE")));
        engine.buy("HYPE", true, 70e18, day, 1e18, type(uint256).max, nowT);

        vm.expectRevert(abi.encodeWithSelector(EnginePricing.StrikeOffStep.selector, 50_050e18, 100e18));
        engine.buy(BTC, true, 50_050e18, day, 1e18, type(uint256).max, nowT);

        vm.expectRevert(abi.encodeWithSelector(EnginePricing.StrikeOutOfBand.selector, 100_100e18, 50_000e18));
        engine.buy(BTC, true, 100_100e18, day, 1e18, type(uint256).max, nowT);
        vm.stopPrank();

        // one micro-USDC under the cost is refused
        uint256 v = EnginePricing.unitValue(true, 50_000e18, 50_000e18, 5000, day);
        (uint256 premium, uint256 fee) = EnginePricing.buyQuote(v, 1e18, 50_000e18, 200);
        vm.prank(BUYER);
        vm.expectRevert(abi.encodeWithSelector(Engine.CostAboveMax.selector, premium + fee, premium + fee - 1));
        engine.buy(BTC, true, 50_000e18, day, 1e18, premium + fee - 1, nowT);
        vm.prank(BUYER);
        engine.buy(BTC, true, 50_000e18, day, 1e18, premium + fee, nowT); // exactly the cost passes

        vm.expectRevert(abi.encodeWithSelector(EnginePricing.SpreadOutOfRange.selector, 401));
        engine.setMarket(BTC, 100e18, 401);
        vm.expectRevert(abi.encodeWithSelector(EnginePricing.SpreadOutOfRange.selector, 149));
        engine.setMarket(BTC, 100e18, 149);
        vm.expectRevert(EnginePricing.ZeroStep.selector);
        engine.setMarket(BTC, 0, 200);
    }

    function test_overCapRevertsAndMovesNoMoney() public {
        pool.setCap(BTC, 49_999e6);
        uint256 before = usdc.balanceOf(BUYER);
        vm.expectRevert(abi.encodeWithSelector(HousePool.CapExceeded.selector, BTC, 50_000e6, 49_999e6));
        _buy(true, 50_000e18, _day(), 1e18);
        assertEq(usdc.balanceOf(BUYER), before);
        assertEq(usdc.balanceOf(FEES), 0);
        assertEq(book.balanceOf(book.idOf(BTC, true, 50_000e18, _day()), BUYER), 0);
    }

    /// A series more than 16 intervals behind refuses buys until anyone walks it.
    function test_notCaughtUpUntilWalked() public {
        (uint256 id,) = _buy(true, 50_000e18, _day(), 1e18);
        for (uint256 i = 1; i <= 24; i++) {
            _adv(5 minutes);
            book.record(BTC, 50_000e18 + i * 10e18, 5000);
        }
        vm.prank(BUYER);
        vm.expectRevert(abi.encodeWithSelector(Engine.NotCaughtUp.selector, id));
        engine.buy(BTC, true, 50_000e18, _day(), 1e18, type(uint256).max, nowT);

        vm.prank(STRANGER);
        (, bool done) = book.accrue(id, 0);
        assertTrue(done);
        uint256 norm = book.normNow(id);
        assertLt(norm, 1e18, "funding has been charged");
        _buy(true, 50_000e18, _day(), 1e18);
        assertEq(book.balanceOf(id, BUYER), 1e18 + EnginePricing.rawForBuy(1e18, norm));
    }

    // ---------------------------------------------------------------- law 5

    /// Whatever the price and vol, the amount charged is exactly EnginePricing at the router's mark and the
    /// board's vol. No input to buy carries a price.
    function testFuzz_chargeIsAlwaysPricingAtTheRouterMark(uint256 s, uint256 sigma, bool isCall, uint256 units)
        public
    {
        s = bound(s, 10_000e18, 200_000e18);
        sigma = bound(sigma, 1000, 20_000);
        units = bound(units, 1e15, 5e18);
        uint128 k = uint128((s / 100e18) * 100e18);
        marks.set(BTC, s);
        vols.set(BTC, sigma);
        pool.setCap(BTC, type(uint256).max);

        uint256 v = EnginePricing.unitValue(isCall, s, k, sigma, _day());
        (uint256 premium, uint256 fee) = EnginePricing.buyQuote(v, units, s, 200);
        uint256 before = usdc.balanceOf(BUYER);
        (, uint256 cost) = _buy(isCall, k, _day(), units);
        assertEq(cost, premium + fee);
        assertEq(before - usdc.balanceOf(BUYER), premium + fee);
    }

    // ---------------------------------------------------------------- gas

    function test_buyGas() public {
        vm.prank(BUYER);
        uint256 g = gasleft();
        engine.buy(BTC, true, 50_000e18, _day(), 1e18, type(uint256).max, nowT);
        uint256 fresh = g - gasleft();
        vm.prank(BUYER);
        g = gasleft();
        engine.buy(BTC, true, 50_000e18, _day(), 1e18, type(uint256).max, nowT);
        uint256 existing = g - gasleft();
        emit log_named_uint("buy gas, new series", fresh);
        emit log_named_uint("buy gas, existing series", existing);
        assertLt(fresh, 1_000_000);
        assertLt(existing, 500_000);
    }
}
