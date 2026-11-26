// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MockSessionCalendar} from "./mocks/MockSessionCalendar.sol";
import {MockHedgeRouter} from "./mocks/MockHedgeRouter.sol";
import {HedgeKeeperGate, IPoolHedgeSwap} from "../src/HedgeKeeperGate.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {MockPoolManagerV4} from "./mocks/MockPoolManagerV4.sol";
import {UniswapV4HedgeRouter, IPoolManagerV4, PoolKey} from "../src/UniswapV4HedgeRouter.sol";
import {HedgeSwap} from "../src/HedgeSwap.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {WriterBookBase} from "./WriterBook.t.sol";
import {MainspringPool} from "../src/MainspringPool.sol";
import {EnginePricing} from "../src/EnginePricing.sol";
import {TempoBlend} from "../src/TempoBlend.sol";
import {StrategyMath} from "../src/StrategyMath.sol";

/// M4 step 7b: the pool counts written shapes (NAV at value; coverage 0; the directional cap includes them) and its
/// STK1 stock (NAV at the STK1 mark × 95%; coverage and withdrawals 0).
contract WriterPoolTest is WriterBookBase {
    function _cut(uint256 fee) internal view returns (uint256) {
        return fee * pool.protocolFeeBps() / 10_000;
    }

    /// The buyer's side of the written spread: the same series.
    function _bSpread() internal pure returns (StrategyMath.Leg[] memory) {
        return _l2(_leg(true, 70_000e18, 1e18), _leg(true, 75_000e18, -1e18));
    }

    function _buySpread(uint256 units) internal returns (uint256 id) {
        vm.prank(TRADER);
        (id,) = engine.buyShape(BTC, _bSpread(), _day(), units, ALL, nowT);
    }

    // ---------------------------------------------------------------- 1. a write adds to NAV only the fee share

    /// Owner's test: right after a write, NAV changes only by the pool's share of the fee (the spread around the
    /// value), never by minus the credit: the pool pays the credit and holds a shape worth the same.
    function test_aWriteChangesNavOnlyByThePoolsShareOfTheFee() public {
        // a written call spread: the pool pays a positive credit
        uint256 nav0 = pool.navNow();
        (int256 credit, uint256 fee) = _expectedCredit(BTC, _wSpread(), S, SIG, 3e18);
        assertGt(credit, int256(1_000e6), "a real credit");
        _write(W, BTC, _wSpread(), 3e18, false);
        int256 d = int256(pool.navNow()) - int256(nav0);
        assertApproxEqAbs(d, int256(fee - _cut(fee)), 1, "only the pool's share of the fee");
        assertGt(d, 0);

        // a covered STK1 Rise
        nav0 = pool.navNow();
        (, fee) = _expectedCredit(STK1, _wCovered(), H, HSIG, 20e18);
        _write(W, STK1, _wCovered(), 20e18, true);
        d = int256(pool.navNow()) - int256(nav0);
        assertApproxEqAbs(d, int256(fee - _cut(fee)), 1);

        // a Guard written for a net debit: the pool receives the debit and holds a shape worth less than 0
        marks.set(STK1, 36e18);
        nav0 = pool.navNow();
        (credit, fee) = _expectedCredit(STK1, _wGuard(), 36e18, HSIG, 10e18);
        assertLt(credit, 0);
        _write(W, STK1, _wGuard(), 10e18, true);
        d = int256(pool.navNow()) - int256(nav0);
        assertApproxEqAbs(d, int256(fee - _cut(fee)), 1);
        assertLt(pool.writtenNavBase(STK1), int256(0), "the Guard's pool side is worth less than 0 here");
    }

    // ---------------------------------------------------------------- 2. unwrites

    function test_anUnwriteChangesNavOnlyByThePoolsShareOfTheFee() public {
        (uint256 wid,) = _write(W, BTC, _wSpread(), 3e18, false);
        uint256 nav0 = pool.navNow();
        vm.prank(W);
        (uint256 paid, int256 cost) = wb.unwrite(wid, type(uint256).max, type(int256).max, nowT);
        int256 v = EnginePricing.shapeValue(_neg(_wSpread()), S, SIG, _day(), true);
        (, uint256 fee) = EnginePricing.shapeUnwriteQuote(v, paid, _neg(_wSpread()), S, 200);
        int256 d = int256(pool.navNow()) - int256(nav0);
        // the pool receives the ask and gives up the shape at its value: the fee share, plus at most a couple of
        // units from rounding the ask up and the shape's value down
        assertGe(d, int256(fee - _cut(fee)));
        assertLe(d, int256(fee - _cut(fee)) + 2);
        assertGt(cost, 0);
        assertEq(pool.writtenNavBase(BTC) / 1e12, 0, "nothing written left (wei-level rounding only)");
    }

    /// A covered writer's buyback paid in STK1 stock: NAV counts the STK1 stock at the mark × 95%, so it changes by the fee share
    /// less 5% of the buyback.
    /// RH6: covering stock the pool receives counts in NAV at the router mark (Backend §5, owner G6; was 95% in M4).
    function test_aBuybackPaidInStockCountsAtTheRouterMark() public {
        settlement.mint(BROKE, 100e6); // a 1-day covered Rise this far out is a small net debit at the write
        (uint256 wid,) = _write(BROKE, STK1, _wCovered(), 10e18, true);
        // an hour later STK1 is at 55; an epoch marks the written shape there
        _set(nowT + 1 hours);
        marks.set(STK1, 55e18);
        book.record(STK1, 55e18, HSIG);
        pool.startEpoch();
        while (!pool.markChunk(50)) {}
        uint256 nav0 = pool.navNow();
        uint256 poolStock0 = stock.balanceOf(address(pool));
        vm.prank(BROKE);
        (uint256 paid, int256 cost) = wb.unwrite(wid, type(uint256).max, type(int256).max, nowT);
        uint256 got = stock.balanceOf(address(pool)) - poolStock0;
        assertGt(got, 0, "paid in STK1 stock");
        assertEq(pool.coverTerm(), Math.mulDiv(got, 55e18, 1e18) / 1e12);
        int256 v = EnginePricing.shapeValue(_neg(_wCovered()), 55e18, HSIG, _day(), true);
        (, uint256 fee) = EnginePricing.shapeUnwriteQuote(v, paid, _neg(_wCovered()), 55e18, 200);
        int256 d = int256(pool.navNow()) - int256(nav0);
        int256 expected = int256(fee - _cut(fee)); // the stock arrives at its full value: only the fee moves NAV
        assertApproxEqAbs(d, expected, 3);
    }

    // ---------------------------------------------------------------- 3. STK1 stock in NAV, never in coverage

    function test_stockCountsInNavAtTheMarkAndNeverInCoverage() public {
        uint256 nav0 = pool.navNow();
        uint256 avail0 = pool.available();
        uint256 free0 = pool.freeForWithdrawals();
        uint256 stressed0 = pool.stressedLiability();
        stock.mint(address(pool), 10e18);
        assertEq(pool.coverTerm(), 400e6, "10 x 40 at the router mark");
        assertEq(pool.navNow(), nav0 + 400e6);
        assertEq(pool.available(), avail0, "not USDC: no help to sells");
        assertEq(pool.freeForWithdrawals(), free0, "nor to withdrawals");
        assertEq(pool.stressedLiability(), stressed0);
        // a stale mark: STK1 stock counts 0 until it is fresh again
        marks.setStale(true);
        assertEq(pool.coverTerm(), 0);
        marks.setStale(false);
        // set once
        vm.expectRevert(MainspringPool.CoverAssetsAlreadySet.selector);
        pool.setCoverAssets(covers);
    }

    // ---------------------------------------------------------------- 4. bought and written in one series

    function test_aSeriesWithBoughtAndWrittenRaw() public {
        uint256 stressed0 = pool.stressedLiability();
        uint256 id = _buySpread(5e18);
        uint256 stressedAfterBuy = pool.stressedLiability();
        assertGt(stressedAfterBuy, stressed0);
        (uint256 wid,) = _write(W, BTC, _wSpread(), 5e18, false);
        assertEq(book.idOfShape(BTC, _neg(_wSpread()), _day()), id, "the writer's pool side is the buyer's shape");
        assertEq(pool.openSeries(BTC).length, 1);
        assertEq(pool.seriesRaw(id), 5e18);
        assertEq(pool.writtenRaw(id), 5e18);
        // coverage counts the write 0: the stressed liability is exactly what the buy made it
        assertEq(pool.stressedLiability(), stressedAfterBuy);
        // NAV: what the pool owes the buyer and what it holds from the writer net to about zero
        int256 net = int256(pool.navBase(BTC)) - pool.writtenNavBase(BTC);
        assertGe(net, 0);
        assertLe(net, 1e13, "a wei-level rounding difference");

        // an hour later, an epoch marks both sides at the same units
        _set(nowT + 1 hours);
        pool.startEpoch();
        while (!pool.markChunk(1)) {}
        net = int256(pool.navBase(BTC)) - pool.writtenNavBase(BTC);
        assertGe(net, 0);
        assertLe(net, 1e13);

        // the buyer sells everything: the series stays open for the write; law 3 holds with writes present
        vm.prank(TRADER);
        (, uint256 netOut) = engine.sell(id, ALL, 0, nowT);
        assertGt(netOut, 0);
        assertEq(pool.seriesRaw(id), 0);
        assertEq(pool.openSeries(BTC).length, 1);
        // the writer closes: the series leaves the registry
        vm.prank(W);
        wb.unwrite(wid, type(uint256).max, type(int256).max, nowT);
        assertEq(pool.writtenRaw(id), 0);
        assertEq(pool.openSeries(BTC).length, 0);
    }

    // ---------------------------------------------------------------- 5. the directional cap includes writes

    function test_directionalCapIncludesWrites() public {
        uint256 id = _buySpread(5e18);
        uint256 dirBought = pool.directional(BTC);
        assertGt(dirBought, 0);
        // the offsetting write brings directional exposure to about zero; allowed even under a tight cap
        pool.setCaps(BTC, 1e15, 1e6);
        _write(W, BTC, _wSpread(), 5e18, false);
        assertLe(pool.directional(BTC), 1, "offset");
        assertEq(pool.writtenRaw(id), 5e18);
        // a further write is one-sided again: refused above the cap
        vm.prank(W);
        vm.expectPartialRevert(MainspringPool.DirectionalCapExceeded.selector);
        wb.write(BTC, _wSpread(), _day(), 5e18, false, type(int256).min, nowT);
    }

    /// RH4 (G3): a write is a pool open; its directional cap gets the calendar's share.
    function test_weekendShareAppliesToWrites() public {
        MockSessionCalendar mc = new MockSessionCalendar();
        pool.setSessionCalendar(mc);
        uint256 snap = vm.snapshotState();
        _write(W, BTC, _wSpread(), 5e18, false);
        uint256 dir = pool.directional(BTC); // USDC units, as the cap is set
        vm.revertToState(snap);
        pool.setCaps(BTC, 1e15, dir * 2);
        mc.setCapBps(BTC, 2_500);
        vm.prank(W);
        vm.expectPartialRevert(MainspringPool.DirectionalCapExceeded.selector);
        wb.write(BTC, _wSpread(), _day(), 5e18, false, type(int256).min, nowT);
        mc.setCapBps(BTC, 10_000);
        _write(W, BTC, _wSpread(), 5e18, false);
    }

    // ---------------------------------------------------------------- RH6: the on-chain stock hedge (G7)

    MockHedgeRouter hr;
    address KEEPER = address(0x4ED6E);

    function _hedgeSetup() internal {
        hr = new MockHedgeRouter(settlement, IERC20(address(stock)), 1, H);
        pool.setHedge(address(hr), 100, STK1, 100e18, 50_000e6); // 1% at most; 100 shares; $50k of swaps a day
        pool.grantRole(pool.HEDGER_ROLE(), KEEPER);
    }

    /// The keeper buys and sells the stock through the listed router at the mark; the pool holds the inventory, NAV
    /// moves only by the venue's fee, and the keeper never holds a token.
    function test_hedgeBuysAndSellsAtTheMarkThePoolHoldsTheStock() public {
        _hedgeSetup();
        uint256 nav0 = pool.navNow();
        uint256 floor = HedgeSwap.floorOut(true, 400e6, H, 1, 100);
        assertEq(floor, 9.9e18, "10 shares at $40, less 1%");
        vm.prank(KEEPER);
        uint256 out = pool.hedgeSwap(STK1, true, 400e6, floor);
        assertEq(out, 10e18);
        assertEq(stock.balanceOf(address(pool)), 10e18, "the pool holds the inventory");
        assertEq(stock.balanceOf(KEEPER) + settlement.balanceOf(KEEPER), 0, "the keeper holds nothing");
        assertEq(pool.navNow(), nav0, "USDC out, the same value in stock at the mark");
        assertEq(settlement.allowance(address(pool), address(hr)), 0, "no allowance left behind");
        // back again, with a 0.3% venue fee
        hr.set(H, 30, 0, false);
        uint256 sellFloor = HedgeSwap.floorOut(false, 10e18, H, 1, 100); // computed first: a call in the arguments would take the prank
        vm.prank(KEEPER);
        out = pool.hedgeSwap(STK1, false, 10e18, sellFloor);
        assertEq(out, 398.8e6);
        assertEq(pool.navNow(), nav0 - 1.2e6, "only the venue's fee");
        (,,,, uint256 today) = pool.hedgeLimits(STK1, block.timestamp / 1 days);
        assertEq(today, 400e6 + 398.8e6);
    }

    /// The keeper cannot choose a price, take a short fill, swap without a fresh mark, swap a crypto market, or pass
    /// the caps; anyone else cannot swap at all.
    function test_hedgeRefusals() public {
        bytes32 role = pool.HEDGER_ROLE();
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("AccessControlUnauthorizedAccount(address,bytes32)")), KEEPER, role));
        pool.hedgeSwap(STK1, true, 400e6, 1);
        pool.grantRole(role, KEEPER);
        vm.prank(KEEPER);
        vm.expectRevert(HedgeSwap.NoHedgeRouter.selector);
        pool.hedgeSwap(STK1, true, 400e6, 1);
        _hedgeSetup();
        vm.startPrank(KEEPER);
        // a minOut below the mark less 1% (the keeper "choosing" a worse price)
        vm.expectRevert(abi.encodeWithSelector(HedgeSwap.MinOutBelowFloor.selector, 9.8e18, 9.9e18));
        pool.hedgeSwap(STK1, true, 400e6, 9.8e18);
        // a router that pays short
        hr.set(H, 0, 200, false); // 2% short: below the 1% floor
        vm.expectRevert(abi.encodeWithSelector(HedgeSwap.SwapShort.selector, 9.8e18, 9.9e18));
        pool.hedgeSwap(STK1, true, 400e6, 9.9e18);
        hr.set(H, 0, 0, false);
        // a crypto market has no token
        vm.expectRevert(abi.encodeWithSelector(HedgeSwap.NoCoverToken.selector, BTC));
        pool.hedgeSwap(BTC, true, 400e6, 1);
        // above the inventory cap (100 shares = $4,000)
        vm.expectRevert(abi.encodeWithSelector(HedgeSwap.InventoryCapExceeded.selector, STK1, 101e18, 100e18));
        pool.hedgeSwap(STK1, true, 4_040e6, 100.98e18);
        vm.stopPrank();
        // law 2: no fresh mark, no swap
        marks.setStale(true);
        vm.prank(KEEPER);
        vm.expectRevert();
        pool.hedgeSwap(STK1, true, 400e6, 9.9e18);
        marks.setStale(false);
        // the daily cap
        pool.setHedge(address(hr), 100, STK1, 1_000e18, 1_000e6);
        vm.startPrank(KEEPER);
        pool.hedgeSwap(STK1, true, 800e6, 19.8e18);
        vm.expectRevert(abi.encodeWithSelector(HedgeSwap.DailyCapExceeded.selector, 1_200e6, 1_000e6));
        pool.hedgeSwap(STK1, true, 400e6, 9.9e18);
        vm.stopPrank();
        _set(nowT + 1 days); // a new UTC day
        vm.prank(KEEPER);
        pool.hedgeSwap(STK1, true, 400e6, 9.9e18);
        // governance: slippage at most 3%, only the admin sets the router and limits
        vm.expectRevert(abi.encodeWithSelector(HedgeSwap.SlippageTooHigh.selector, uint256(301)));
        pool.setHedge(address(hr), 301, STK1, 1, 1);
        vm.prank(KEEPER);
        vm.expectRevert();
        pool.setHedge(KEEPER, 300, STK1, 1, 1);
    }

    /// A hedge buy may not spend the USDC that pays sells (law 3) or that is set aside (queued deposits, owed USDC): it
    /// spends only what is free above the stressed liability. Sells of the stock are never held back by it.
    function test_aHedgeBuyNeverSpendsTheSettlementThatPaysSells() public {
        _hedgeSetup();
        _buySpread(5e18); // a liability
        uint256 room = pool.available() - pool.stressedLiability();
        pool.setHedge(address(hr), 100, STK1, type(uint128).max, type(uint128).max);
        uint256 amt = room + 40e6;
        uint256 minOut = HedgeSwap.floorOut(true, amt, H, 1, 100);
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(MainspringPool.AboveFree.selector, amt, room));
        pool.hedgeSwap(STK1, true, amt, minOut);
        // queued deposits are never spent either: a deposit raises the balance, not what a hedge may spend
        settlement.mint(address(0xD3), 1_000_000e6);
        vm.startPrank(address(0xD3));
        settlement.approve(address(pool), type(uint256).max);
        pool.deposit(1_000_000e6);
        vm.stopPrank();
        assertEq(pool.freeForWithdrawals(), room, "queued deposits stay set aside");
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(MainspringPool.AboveFree.selector, amt, room));
        pool.hedgeSwap(STK1, true, amt, minOut);
        // a sell of stock the pool already holds always goes (it brings USDC in)
        stock.mint(address(pool), 10e18);
        vm.prank(KEEPER);
        pool.hedgeSwap(STK1, false, 10e18, 396e6);
        // opens paused: hedging still works (it only lowers risk)
        pool.grantRole(pool.RISK_PAUSER_ROLE(), address(this));
        pool.pauseMarket(STK1);
        vm.prank(KEEPER);
        pool.hedgeSwap(STK1, true, 40e6, 0.99e18);
    }

    /// Fuzz: for any amount, price and decimals, the floor is the value at the mark less the slippage, rounded down,
    /// and a fill at the mark always clears it.
    function testFuzz_hedgeFloorAtTheMark(uint64 amountSeed, uint64 pxSeed, uint8 d, uint16 slip) public pure {
        uint256 amount = bound(amountSeed, 1e6, 1e13); // $1 to $10M
        uint256 px = bound(pxSeed, 1e18, 1e23); // $1 to $100k a share
        d = uint8(bound(d, 0, 18));
        slip = uint16(bound(slip, 0, 300));
        uint256 scale = 10 ** (18 - d);
        uint256 f = HedgeSwap.floorOut(true, amount, px, scale, slip);
        uint256 fair = Math.mulDiv(amount * 1e12, 1e18, px * scale);
        assertLe(f, fair);
        assertEq(f, Math.mulDiv(fair, 10_000 - slip, 10_000));
        uint256 fs = HedgeSwap.floorOut(false, fair, px, scale, slip);
        assertLe(fs, amount, "selling what a buy got back never floors above what it cost");
    }

    /// RH7b (owner Q4): the pool's hedge through the Uniswap v4 adapter and a mock PoolManager: a buy and a sell at
    /// the mark move NAV by the venue's fee only; a venue that pays short is refused by the pool's balance check.
    function test_hedgeThroughUniswapV4() public {
        MockPoolManagerV4 pm = new MockPoolManagerV4();
        UniswapV4HedgeRouter v4 = new UniswapV4HedgeRouter(address(this), IPoolManagerV4(address(pm)));
        v4.listPool(address(settlement), address(stock), 3000, 60);
        PoolKey memory k = v4.poolOf(address(settlement), address(stock));
        uint256 stockPerUnit = 1e18 * 1e18 * 1e18 / (H * 1e6); // WAD: stock base units per settlement base unit at $40
        pm.setRate(k, k.currency0 == address(settlement) ? stockPerUnit : 1e36 / stockPerUnit);
        pm.set(30, 10_000, false); // a 0.3% pool fee
        settlement.mint(address(pm), 1e13);
        stock.mint(address(pm), 1e24);
        pool.setHedge(address(v4), 100, STK1, 100e18, 50_000e6);
        pool.grantRole(pool.HEDGER_ROLE(), KEEPER);
        uint256 nav0 = pool.navNow();
        uint256 minOut = HedgeSwap.floorOut(true, 400e6, H, 1, 100);
        vm.prank(KEEPER);
        uint256 out = pool.hedgeSwap(STK1, true, 400e6, minOut);
        assertEq(out, 9.97e18, "10 shares less the 0.3% fee");
        assertEq(stock.balanceOf(address(pool)), 9.97e18);
        assertApproxEqAbs(pool.navNow(), nav0 - 1.2e6, 1, "only the fee");
        uint256 sellFloor = HedgeSwap.floorOut(false, 9.97e18, H, 1, 100);
        vm.prank(KEEPER);
        pool.hedgeSwap(STK1, false, 9.97e18, sellFloor);
        assertEq(stock.balanceOf(address(pool)), 0);
        pm.set(0, 10_000, true); // the venue sends only half of what it books
        vm.prank(KEEPER);
        vm.expectRevert();
        pool.hedgeSwap(STK1, true, 400e6, minOut);
        assertEq(settlement.balanceOf(address(v4)) + stock.balanceOf(address(v4)), 0, "the adapter holds nothing");
    }

    // ---------------------------------------------------------------- RH8b: the hedge keeper gate (C63)

    address GUARDIAN = address(0x6A2D);
    address SAFE = address(0x5AFE);

    function _gate() internal returns (HedgeKeeperGate g) {
        hr = new MockHedgeRouter(settlement, IERC20(address(stock)), 1, H);
        pool.setHedge(address(hr), 100, STK1, 100e18, 50_000e6);
        g = new HedgeKeeperGate(address(this), IPoolHedgeSwap(address(pool)));
        pool.grantRole(pool.HEDGER_ROLE(), address(g)); // the gate, never a key
        g.grantRole(g.FREEZER_ROLE(), GUARDIAN);
        g.grantRole(g.UNFREEZER_ROLE(), SAFE);
        g.setHedger(KEEPER);
    }

    /// End to end through the gate: the key's buy and sell reach the pool unchanged; the pool holds the stock, the gate
    /// and the key hold nothing; NAV moves by the venue's fee only.
    function test_hedgeThroughTheGate() public {
        HedgeKeeperGate g = _gate();
        hr.set(H, 30, 0, false);
        uint256 nav0 = pool.navNow();
        uint256 minOut = HedgeSwap.floorOut(true, 400e6, H, 1, 100);
        vm.prank(KEEPER);
        uint256 out = g.hedgeSwap(STK1, true, 400e6, minOut);
        assertEq(out, 9.97e18);
        assertEq(stock.balanceOf(address(pool)), 9.97e18);
        assertEq(stock.balanceOf(address(g)) + settlement.balanceOf(address(g)), 0, "the gate holds nothing");
        assertEq(stock.balanceOf(KEEPER) + settlement.balanceOf(KEEPER), 0, "the key holds nothing");
        uint256 sellFloor = HedgeSwap.floorOut(false, 9.97e18, H, 1, 100);
        vm.prank(KEEPER);
        g.hedgeSwap(STK1, false, 9.97e18, sellFloor);
        assertApproxEqAbs(pool.navNow(), nav0 - 2_396_400, 2, "the two venue fees only (1.20 on the buy, 1.1964 on the 398.80 sale)");
    }

    /// A frozen gate refuses every swap, buy or sell; the guardian freezes but cannot unfreeze or change the key; only
    /// the Safe unfreezes; a wrong caller is refused, and the key alone cannot reach the pool around the gate.
    function test_theGateFreezesAndRefuses() public {
        HedgeKeeperGate g = _gate();
        stock.mint(address(pool), 10e18);
        vm.prank(GUARDIAN);
        g.freeze();
        uint256 buyFloor = HedgeSwap.floorOut(true, 400e6, H, 1, 100);
        uint256 sellFloor = HedgeSwap.floorOut(false, 10e18, H, 1, 100);
        vm.startPrank(KEEPER);
        vm.expectRevert(HedgeKeeperGate.Frozen.selector);
        g.hedgeSwap(STK1, true, 400e6, buyFloor);
        vm.expectRevert(HedgeKeeperGate.Frozen.selector);
        g.hedgeSwap(STK1, false, 10e18, sellFloor);
        vm.stopPrank();
        bytes32 unfreezer = g.UNFREEZER_ROLE();
        vm.prank(GUARDIAN);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, GUARDIAN, unfreezer));
        g.unfreeze();
        vm.prank(GUARDIAN);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, GUARDIAN, bytes32(0)));
        g.setHedger(GUARDIAN);
        vm.prank(SAFE);
        g.unfreeze();
        vm.prank(KEEPER);
        g.hedgeSwap(STK1, true, 400e6, buyFloor);
        // a wrong caller: refused by the gate; the key cannot go around it to the pool
        vm.prank(ATTACKER);
        vm.expectRevert(HedgeKeeperGate.NotHedger.selector);
        g.hedgeSwap(STK1, true, 400e6, buyFloor);
        bytes32 role = pool.HEDGER_ROLE();
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, KEEPER, role));
        pool.hedgeSwap(STK1, true, 400e6, buyFloor);
        // no key set: nobody can swap
        g.setHedger(address(0));
        vm.prank(KEEPER);
        vm.expectRevert(HedgeKeeperGate.NotHedger.selector);
        g.hedgeSwap(STK1, true, 400e6, buyFloor);
        vm.expectRevert(HedgeKeeperGate.ZeroAddress.selector);
        new HedgeKeeperGate(address(this), IPoolHedgeSwap(address(0)));
    }

    /// The pool's limits still hold through the gate: the floor at the router mark, a short fill, the inventory and
    /// daily caps, free money only, no fresh mark.
    function test_theSwapLimitsHoldThroughTheGate() public {
        HedgeKeeperGate g = _gate();
        vm.startPrank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(HedgeSwap.MinOutBelowFloor.selector, 9.8e18, 9.9e18));
        g.hedgeSwap(STK1, true, 400e6, 9.8e18);
        vm.stopPrank();
        hr.set(H, 0, 200, false);
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(HedgeSwap.SwapShort.selector, 9.8e18, 9.9e18));
        g.hedgeSwap(STK1, true, 400e6, 9.9e18);
        hr.set(H, 0, 0, false);
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(HedgeSwap.InventoryCapExceeded.selector, STK1, 101e18, 100e18));
        g.hedgeSwap(STK1, true, 4_040e6, 100.98e18);
        pool.setHedge(address(hr), 100, STK1, 1_000e18, 1_000e6);
        vm.prank(KEEPER);
        g.hedgeSwap(STK1, true, 800e6, 19.8e18);
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(HedgeSwap.DailyCapExceeded.selector, 1_200e6, 1_000e6));
        g.hedgeSwap(STK1, true, 400e6, 9.9e18);
        pool.setHedge(address(hr), 100, STK1, type(uint128).max, type(uint128).max);
        _buySpread(5e18);
        uint256 room = pool.freeForWithdrawals();
        uint256 amt = room + 40e6;
        uint256 minOut = HedgeSwap.floorOut(true, amt, H, 1, 100);
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(MainspringPool.AboveFree.selector, amt, room));
        g.hedgeSwap(STK1, true, amt, minOut);
        marks.setStale(true);
        vm.prank(KEEPER);
        vm.expectRevert();
        g.hedgeSwap(STK1, true, 40e6, 0.99e18);
    }

    /// RH5 (owner D3): only the books can pause a market for a stuck covering token; the Safe unpauses as usual.
    function test_onlyTheBooksPauseForAStuckCover() public {
        vm.prank(ATTACKER);
        vm.expectRevert(MainspringPool.NotABook.selector);
        pool.onCoverStuck(STK1);
        vm.prank(address(wb));
        pool.onCoverStuck(STK1);
        assertTrue(pool.marketPaused(STK1));
        pool.unpauseMarket(STK1); // this test holds the unpauser role
        assertFalse(pool.marketPaused(STK1));
    }

    // ---------------------------------------------------------------- 6. marking with writes, in chunks

    function test_markingWrittenSeriesInChunks() public {
        _buySpread(2e18);
        _write(W, BTC, _wSpread(), 3e18, false);
        _write(W, BTC, _wBand(), 2e18, false);
        uint256 idS = book.idOfShape(BTC, _neg(_wSpread()), _day());
        uint256 idB = book.idOfShape(BTC, _neg(_wBand()), _day());
        _set(nowT + 1 hours);
        marks.set(BTC, 71_000e18);
        // expected: each written series at floor(written raw × norm now), valued down at the new mark
        int256 expected;
        uint256[2] memory ids = [idS, idB];
        StrategyMath.Leg[][2] memory shapes = [_neg(_wSpread()), _neg(_wBand())];
        for (uint256 i; i < 2; ++i) {
            uint256 u = Math.mulDiv(pool.writtenRaw(ids[i]), book.normNow(ids[i]), 1e18);
            int256 v = EnginePricing.shapeValue(shapes[i], 71_000e18, SIG, _day(), false);
            expected += v >= 0
                ? int256(Math.mulDiv(u, uint256(v), 1e18))
                : -int256(Math.mulDiv(u, uint256(-v), 1e18, Math.Rounding.Ceil));
        }
        pool.startEpoch();
        while (!pool.markChunk(1)) {}
        assertEq(pool.writtenNavBase(BTC), expected);
        assertEq(pool.openSeries(BTC).length, 2);
    }
}
