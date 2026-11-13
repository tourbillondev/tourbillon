// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PathFundingBook} from "../src/PathFundingBook.sol";
import {MainspringPool, IEquityFeed} from "../src/MainspringPool.sol";
import {QuorumBoard} from "../src/QuorumBoard.sol";
import {TempoBlend} from "../src/TempoBlend.sol";
import {StrategyMath} from "../src/StrategyMath.sol";
import {EnginePricing} from "../src/EnginePricing.sol";
import {MakerVault} from "../src/MakerVault.sol";
import {MatchBook} from "../src/MatchBook.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockWHYPE} from "./mocks/MockWHYPE.sol";
import {MockMarks, MockVols} from "./Engine.t.sol";
import {MockEngineConfig} from "./MatchBook.t.sol";

/// A stand-in MatchBook for the cases real trading cannot produce: a buyback that falls short or reverts.
contract StandInMatchBook {
    mapping(uint256 => uint256) public matchedRaw;
    uint8 public mode; // 0 normal (closes min(sold, matched), pays nothing), 1 short (flags `flag` raw), 2 revert
    uint256 public flag;

    function set(uint256 sid, uint256 m) external {
        matchedRaw[sid] = m;
    }

    function setMode(uint8 m, uint256 f) external {
        mode = m;
        flag = f;
    }

    function buyback(uint256 sid, uint256 rawSold, uint256, uint256) external returns (uint256, uint256, uint256) {
        if (mode == 2) revert("stand-in: buyback reverts");
        uint256 m = matchedRaw[sid];
        uint256 closed = rawSold < m ? rawSold : m;
        m -= closed;
        if (mode == 1) {
            uint256 f = flag < m ? flag : m;
            m -= f; // flagged raw leaves the covered matched raw
            matchedRaw[sid] = m;
            return (0, 0, 1);
        }
        matchedRaw[sid] = m;
        return (0, 0, 0);
    }
}

/// Shared fixture: the test plays the Engine (it opens series, mints and burns positions, moves the buyer's USDC and
/// calls the pool's hooks as the Engine does); the pool, book and (optionally) MatchBook and vault are real.
abstract contract PoolMatchedBase is Test {
    uint256 constant T0 = 1_794_182_400;
    bytes32 constant BTC = "BTC";
    uint256 constant S = 70_000e18;
    uint256 constant SIG = 4500;
    address constant ADMIN = address(0xAD);
    address constant PROTO = address(0x9907);
    address constant LP = address(0x1A);
    address constant BUYER = address(0xB1);

    MockUSDC usdc;
    MockWHYPE whype;
    MockMarks marks;
    MockVols vols;
    PathFundingBook book;
    MainspringPool pool;
    uint256 nowT;

    function _set(uint256 t) internal {
        nowT = t;
        vm.warp(t);
    }

    function _base(uint256 seed) internal {
        _set(T0);
        usdc = new MockUSDC();
        whype = new MockWHYPE();
        marks = new MockMarks();
        vols = new MockVols();
        marks.set(BTC, S);
        vols.set(BTC, SIG);
        address[] memory sg = new address[](3);
        (sg[0], sg[1], sg[2]) = (address(0x51), address(0x52), address(0x53));
        QuorumBoard board = new QuorumBoard(address(this), sg, 2, 30);
        book = new PathFundingBook(address(this), address(this), marks, vols);
        book.record(BTC, S, SIG);
        pool = new MainspringPool(address(this), usdc, book, marks, vols, IEquityFeed(address(board)), PROTO);
        pool.setEngine(address(this));
        pool.listMarket(BTC, 2000);
        pool.setHedgerDeltaCap(BTC, 1e16);
        pool.setCaps(BTC, 1e15, 1e15);
        pool.setOpenBookCap(BTC, 1e15);
        pool.grantRole(pool.RISK_PAUSER_ROLE(), address(this));
        usdc.mint(address(this), 1e15);
        usdc.mint(LP, seed);
        vm.startPrank(LP);
        usdc.approve(address(pool), type(uint256).max);
        pool.deposit(seed);
        vm.stopPrank();
        pool.startEpoch();
        while (!pool.markChunk(100)) {}
        pool.settle();
    }

    function _spread() internal pure returns (StrategyMath.Leg[] memory l) {
        l = new StrategyMath.Leg[](2);
        l[0] = StrategyMath.Leg(true, 70_000e18, 1e18);
        l[1] = StrategyMath.Leg(true, 75_000e18, -1e18);
    }

    function _day() internal pure returns (TempoBlend.Part[] memory) {
        return TempoBlend.single(1 days);
    }

    function _series() internal returns (uint256) {
        return book.openShape(BTC, _spread(), _day());
    }

    /// A pool fill, as the Engine's buyShape does it.
    function _poolBuy(uint256 sid, uint256 units) internal returns (uint256 raw) {
        (uint256 norm,) = book.accrue(sid, 16);
        raw = EnginePricing.rawForBuy(units, norm);
        int256 v = EnginePricing.shapeValue(_spread(), S, SIG, _day(), true);
        (uint256 premium, uint256 fee) = EnginePricing.shapeBuyQuote(v, units, _spread(), S, 200);
        book.mint(sid, BUYER, raw);
        usdc.transfer(address(pool), premium + fee);
        pool.onBuy(BTC, sid, units, raw, S, SIG, premium, fee);
    }

    /// The pool side of a matched open at the source's σ (D6): the buyer pays value + fee, the source gets its value.
    function _matchedPoolSide(uint256 sid, uint256 units, uint256 raw, uint256 sigmaSrc, address payee)
        internal
        returns (uint256 premium, uint256 fee, uint256 credit)
    {
        int256 vUp = EnginePricing.shapeValue(_spread(), S, sigmaSrc, _day(), true);
        int256 vDown = EnginePricing.shapeValue(_spread(), S, sigmaSrc, _day(), false);
        (premium, fee) = EnginePricing.shapeBuyQuote(vUp, units, _spread(), S, 200);
        credit = Math.mulDiv(units, uint256(vDown), 1e18) / 1e12;
        book.mint(sid, BUYER, raw);
        usdc.transfer(address(pool), premium + fee);
        pool.onMatchedOpen(BTC, sid, units, raw, S, premium, fee, credit, payee);
    }

    /// A sell, as the Engine's sell does it (fresh mark and vol).
    function _sell(uint256 sid, uint256 units) internal returns (uint256 net, uint256 gross, uint256 fee) {
        uint256 norm = book.accrueForSell(sid);
        (uint256 raw, uint256 paid) = EnginePricing.rawForSell(units, norm, book.balanceOf(sid, BUYER));
        int256 v = EnginePricing.shapeValue(_spread(), S, SIG, _day(), false);
        (gross, fee) = EnginePricing.shapeSellQuote(v, paid, _spread(), S, 200);
        net = gross - fee;
        book.burn(sid, BUYER, raw);
        pool.onSell(BTC, sid, raw, paid, S, SIG, gross, net, fee, BUYER);
    }

    function _stressedOf(uint256 units) internal pure returns (uint256) {
        uint256 sigS = Math.mulDiv(SIG, 15_000, 10_000, Math.Rounding.Ceil);
        int256 up = EnginePricing.shapeValue(_spread(), S * 12 / 10, sigS, TempoBlend.single(1 days), true);
        int256 dn = EnginePricing.shapeValue(_spread(), S * 8 / 10, sigS, TempoBlend.single(1 days), true);
        uint256 u = up > 0 ? Math.mulDiv(units, uint256(up), 1e18, Math.Rounding.Ceil) : 0;
        uint256 d = dn > 0 ? Math.mulDiv(units, uint256(dn), 1e18, Math.Rounding.Ceil) : 0;
        return u > d ? u : d;
    }
}

/// M6 step 5 with the real MatchBook and MakerVault.
contract PoolMatchedTest is PoolMatchedBase {
    MakerVault vault;
    MatchBook mb;
    address constant M1 = address(0x4D1);
    address constant M2 = address(0x4D2);

    function setUp() public {
        _base(5_000_000e6);
        vault = new MakerVault(ADMIN, IERC20(address(usdc)), IERC20(address(whype)));
        mb = new MatchBook(ADMIN, book, new MockEngineConfig(), vault, marks, vols);
        vm.startPrank(ADMIN);
        vault.setMatchBook(address(mb));
        mb.setRouter(address(this));
        mb.setPool(address(pool));
        vm.stopPrank();
        pool.setMatchBook(address(mb));
        address[2] memory ms = [M1, M2];
        for (uint256 i; i < 2; ++i) {
            usdc.mint(ms[i], 10_000_000e6);
            vm.startPrank(ms[i]);
            usdc.approve(address(vault), type(uint256).max);
            vault.deposit(IERC20(address(usdc)), 1_000_000e6);
            vm.stopPrank();
        }
    }

    function _matched(address maker, uint256 sid, uint256 units)
        internal
        returns (uint256 premium, uint256 fee, uint256 credit)
    {
        (uint256 norm,) = book.accrue(sid, 16);
        uint256 raw = EnginePricing.rawForBuy(units, norm);
        mb.matchMaker(maker, sid, units, raw);
        return _matchedPoolSide(sid, units, raw, 4000, maker);
    }

    function _key(address maker) internal pure returns (bytes32) {
        return keccak256(abi.encode(uint8(1), maker, uint256(0)));
    }

    // ---------------------------------------------------------------- 1. a matched open

    function test_aMatchedOpenMovesNavOnlyByTheFeeShareAndUsesNoPoolCapacity() public {
        uint256 sid = _series();
        uint256 nav0 = pool.navNow();
        uint256 stressed0 = pool.stressedLiability();
        uint256 dir0 = pool.directional(BTC);
        uint256 makerBefore = usdc.balanceOf(M1);
        (uint256 premium, uint256 fee, uint256 credit) = _matched(M1, sid, 2e18);
        uint256 cut = fee * pool.protocolFeeBps() / 10_000;
        assertEq(usdc.balanceOf(M1) - makerBefore, credit, "the source gets its value at its sigma");
        assertEq(pool.navNow() - nav0, premium - credit + fee - cut, "NAV moves by the fee share (and the rounding)");
        assertLe(premium - credit, 1, "value up vs down: at most a unit");
        assertEq(pool.stressedLiability(), stressed0, "no stress");
        assertEq(pool.directional(BTC), dir0, "no directional exposure");
        assertEq(pool.openNotional(BTC), 0, "the pool's notional cap untouched");
        assertEq(pool.openBookNotional(BTC), 140_000e6, "2 x 70,000 on the open-book cap");
        assertEq(pool.matchedRawOf(sid), 2e18);
        assertEq(pool.seriesRaw(sid), 2e18);
        // the open-book cap refuses beyond its limit; pauses stop matched opens too
        pool.setOpenBookCap(BTC, 150_000e6);
        mb.matchMaker(M2, sid, 1e18, 1e18);
        book.mint(sid, BUYER, 1e18);
        vm.expectRevert(abi.encodeWithSelector(MainspringPool.OpenBookCapExceeded.selector, BTC, 210_000e6, 150_000e6));
        pool.onMatchedOpen(BTC, sid, 1e18, 1e18, S, 0, 0, 0, M2);
        pool.setOpenBookCap(BTC, 1e15);
        pool.pauseMarket(BTC);
        vm.expectRevert(abi.encodeWithSelector(MainspringPool.MarketIsPaused.selector, BTC));
        pool.onMatchedOpen(BTC, sid, 1e18, 1e18, S, 0, 0, 0, M2);
        // only the Engine
        vm.prank(address(0xBAD));
        vm.expectRevert(MainspringPool.NotEngine.selector);
        pool.onMatchedOpen(BTC, sid, 1e18, 1e18, S, 0, 0, 0, M2);
    }

    /// Matched opens are not limited by the pool's coverage: a thin pool refuses a pool fill but takes a matched one.
    function test_aThinPoolTakesMatchedFillsItCouldNotTakeItself() public {
        // the fixture's pool holds 5,000,000; a pool fill of 5,000 spreads (stressed value ~3,000 each) breaches coverage
        uint256 sid = _series();
        uint256 units = 5_000e18;
        int256 v = EnginePricing.shapeValue(_spread(), S, SIG, _day(), true);
        (uint256 premium, uint256 fee) = EnginePricing.shapeBuyQuote(v, units, _spread(), S, 200);
        book.mint(sid, BUYER, units);
        usdc.transfer(address(pool), premium + fee);
        vm.expectPartialRevert(MainspringPool.CoverageBreached.selector);
        pool.onBuy(BTC, sid, units, units, S, SIG, premium, fee);
        book.burn(sid, BUYER, units);
        // matched: the makers carry it; the pool's stress does not move
        usdc.mint(M1, 100_000_000e6);
        vm.startPrank(M1);
        vault.deposit(IERC20(address(usdc)), 100_000_000e6);
        vm.stopPrank();
        uint256 stressed0 = pool.stressedLiability();
        _matched(M1, sid, units);
        assertEq(pool.stressedLiability(), stressed0);
    }

    // ---------------------------------------------------------------- 2–3. sells on matched series

    function test_aSellOnAMatchedSeriesIsBoughtBackAndThePoolStaysFlat() public {
        uint256 sid = _series();
        _matched(M1, sid, 1e18);
        _matched(M2, sid, 1e18);
        uint256 nav0 = pool.navNow();
        uint256 stressed0 = pool.stressedLiability();
        uint256 buyerBefore = usdc.balanceOf(BUYER);
        (uint256 net, uint256 gross, uint256 fee) = _sell(sid, 2e18);
        assertEq(usdc.balanceOf(BUYER) - buyerBefore, net, "the seller gets exactly the quote");
        assertEq(mb.matchedRaw(sid), 0);
        assertEq(pool.matchedRawOf(sid), 0);
        assertEq(pool.seriesRaw(sid), 0);
        assertEq(pool.openBookNotional(BTC), 0, "released");
        assertEq(pool.stressedLiability(), stressed0);
        uint256 cut = fee * pool.protocolFeeBps() / 10_000;
        // the pool paid gross (net + fee less its cut) and got the buyback (gross, rounded up per source)
        int256 d = int256(pool.navNow()) - int256(nav0);
        assertGe(d, int256(fee - cut));
        assertLe(d, int256(fee - cut) + 2);
        gross;
    }

    function test_aSellLargerThanTheMatchedRawClosesItAndTheRestIsThePoolsOwn() public {
        uint256 sid = _series();
        _poolBuy(sid, 3e18); // the pool's own short
        _matched(M1, sid, 1e18); // matched
        assertEq(pool.seriesRaw(sid), 4e18);
        assertEq(pool.matchedRawOf(sid), 1e18);
        uint256 notional0 = pool.openNotional(BTC);
        assertEq(notional0, 210_000e6);
        _sell(sid, 4e18);
        assertEq(mb.matchedRaw(sid), 0, "the matched raw is closed in full");
        assertEq(pool.seriesRaw(sid), 0);
        assertEq(pool.openNotional(BTC), 0, "the pool's own notional released");
        assertEq(pool.openBookNotional(BTC), 0);
        assertEq(pool.openSeries(BTC).length, 0);
    }

    // ---------------------------------------------------------------- 5. early close

    function test_earlyCloseRunsThePoolsOpenChecks() public {
        uint256 sid = _series();
        _matched(M1, sid, 2e18);
        bytes32 key = _key(M1);
        // a paused market refuses
        pool.pauseMarket(BTC);
        vm.prank(M1);
        vm.expectRevert(abi.encodeWithSelector(MainspringPool.MarketIsPaused.selector, BTC));
        mb.earlyClose(key, sid, type(uint256).max, type(int256).max, nowT);
        pool.unpauseMarket(BTC);
        // the pool's notional cap refuses
        pool.setCaps(BTC, 100_000e6, 1e15);
        vm.prank(M1);
        vm.expectRevert(abi.encodeWithSelector(MainspringPool.NotionalCapExceeded.selector, BTC, 140_000e6, 100_000e6));
        mb.earlyClose(key, sid, type(uint256).max, type(int256).max, nowT);
        pool.setCaps(BTC, 1e15, 1e15);
        // accepted: the pool now carries the raw; its stress rises by that raw's stressed value
        uint256 stressed0 = pool.stressedLiability();
        uint256 nav0 = pool.navNow();
        vm.prank(M1);
        (uint256 units, int256 cost) = mb.earlyClose(key, sid, type(uint256).max, type(int256).max, nowT);
        assertEq(units, 2e18);
        assertEq(pool.matchedRawOf(sid), 0);
        assertEq(pool.stressedLiability() - stressed0, Math.ceilDiv(_stressedOf(2e18), 1e12));
        assertEq(pool.openNotional(BTC), 140_000e6);
        int256 v = EnginePricing.shapeValue(_spread(), S, SIG, _day(), true);
        (, uint256 fee) = EnginePricing.shapeUnwriteQuote(v, 2e18, _spread(), S, 200);
        uint256 cut = fee * pool.protocolFeeBps() / 10_000;
        int256 d = int256(pool.navNow()) - int256(nav0);
        assertApproxEqAbs(d, int256(fee - cut), 2, "the cost covers the value it now carries, plus the fee");
        assertGt(cost, 0);
        // only the MatchBook calls the hook
        vm.expectRevert(MainspringPool.NotMatchBook.selector);
        pool.onEarlyClose(BTC, sid, 1, 1, S, SIG, 0, 0, M1);
    }

    function test_earlyCloseRefusedWhenCoverageWouldBreach() public {
        // a thin pool: the makers carry a large matched book; taking it back would breach coverage
        uint256 sid = _series();
        usdc.mint(M1, 100_000_000e6);
        vm.startPrank(M1);
        vault.deposit(IERC20(address(usdc)), 100_000_000e6);
        vm.stopPrank();
        _matched(M1, sid, 5_000e18);
        vm.prank(M1);
        vm.expectPartialRevert(MainspringPool.CoverageBreached.selector);
        mb.earlyClose(_key(M1), sid, type(uint256).max, type(int256).max, nowT);
    }

    // ---------------------------------------------------------------- 6. marking

    function test_epochMarksOnlyWhatThePoolCarries() public {
        uint256 sid = _series();
        _poolBuy(sid, 3e18);
        _matched(M1, sid, 2e18);
        _set(nowT + 1 hours);
        uint256 own = pool.seriesRaw(sid) - pool.matchedRawOf(sid);
        assertEq(own, 3e18);
        uint256 units = Math.mulDiv(own, book.normNow(sid), 1e18, Math.Rounding.Ceil);
        pool.startEpoch();
        while (!pool.markChunk(1)) {}
        int256 v = EnginePricing.shapeValue(_spread(), S, SIG, _day(), true);
        assertEq(pool.navBase(BTC), Math.mulDiv(units, uint256(v), 1e18, Math.Rounding.Ceil));
        assertEq(pool.liveStressed(BTC), _stressedOf(units));
    }
}

/// M6 step 5, the backstop, with a stand-in MatchBook.
contract PoolMatchedBackstopTest is PoolMatchedBase {
    StandInMatchBook mb;

    function setUp() public {
        _base(5_000_000e6);
        mb = new StandInMatchBook();
        pool.setMatchBook(address(mb));
    }

    function _matchedOnly(uint256 sid, uint256 units) internal {
        mb.set(sid, mb.matchedRaw(sid) + units);
        _matchedPoolSide(sid, units, units, 4000, address(0x4D1));
    }

    function test_aShortBuybackStillPaysTheSellerAndTheUncoveredRawCountsAtOnce() public {
        uint256 sid = _series();
        _matchedOnly(sid, 4e18);
        uint256 stressed0 = pool.stressedLiability();
        mb.setMode(1, 1e18); // the sell closes 2 and leaves 1 more uncovered
        uint256 buyerBefore = usdc.balanceOf(BUYER);
        (uint256 net,,) = _sell(sid, 2e18);
        assertEq(usdc.balanceOf(BUYER) - buyerBefore, net, "the seller is paid in full (law 3)");
        assertEq(pool.matchedRawOf(sid), 1e18);
        assertEq(pool.seriesRaw(sid), 2e18);
        assertEq(pool.stressedLiability() - stressed0, Math.ceilDiv(_stressedOf(1e18), 1e12), "counted at once");
    }

    /// Owner's test: after a buyback that reverts, the pool's matched raw is never larger than the buyer raw it
    /// mirrors, and coverage counts whatever the pool now carries.
    function test_aRevertingBuybackNeverLeavesMatchedAboveBuyerRaw() public {
        uint256 sid = _series();
        _poolBuy(sid, 2e18); // the pool's own
        _matchedOnly(sid, 4e18);
        assertEq(pool.seriesRaw(sid), 6e18);
        mb.setMode(2, 0); // the buyback reverts
        uint256 buyerBefore = usdc.balanceOf(BUYER);
        (uint256 net,,) = _sell(sid, 5e18);
        assertEq(usdc.balanceOf(BUYER) - buyerBefore, net, "the seller is paid in full anyway (law 3)");
        uint256 raw = pool.seriesRaw(sid);
        uint256 m = pool.matchedRawOf(sid);
        assertEq(raw, 1e18);
        assertLe(m, raw, "matched raw never above the buyer raw it mirrors");
        // coverage: the stressed liability after a fresh epoch is exactly what the pool carries (raw - matched)
        _set(nowT + 1 hours);
        pool.startEpoch();
        while (!pool.markChunk(100)) {}
        uint256 carried = Math.mulDiv(raw - m, book.normNow(sid), 1e18, Math.Rounding.Ceil);
        assertEq(pool.liveStressed(BTC), _stressedOf(carried));
        // a second reverting sell of everything: still never above
        _sell(sid, type(uint256).max);
        assertEq(pool.seriesRaw(sid), 0);
        assertEq(pool.matchedRawOf(sid), 0);
        // and when the matched raw had outlived its buyer raw, the clamp holds on the way down too
        _matchedOnly(sid, 3e18);
        _sell(sid, 2e18);
        assertLe(pool.matchedRawOf(sid), pool.seriesRaw(sid));
    }
}
