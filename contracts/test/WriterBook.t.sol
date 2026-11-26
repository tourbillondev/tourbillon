// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CoverLedger} from "../src/CoverLedger.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {console2} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MainspringPoolBase} from "./MainspringPool.t.sol";
import {MainspringPool} from "../src/MainspringPool.sol";
import {Engine} from "../src/Engine.sol";
import {EnginePricing} from "../src/EnginePricing.sol";
import {PathFundingBook} from "../src/PathFundingBook.sol";
import {TempoBlend} from "../src/TempoBlend.sol";
import {StrategyMath} from "../src/StrategyMath.sol";
import {WriterBook, IEngineConfig} from "../src/WriterBook.sol";
import {MockStockToken} from "./mocks/MockStockToken.sol";
import {CoverFixture} from "./mocks/CoverFixture.sol";
import {CoveringAssets} from "../src/CoveringAssets.sol";
import {MockMarks, MockVols} from "./Engine.t.sol";

/// Shared setup for the WriterBook tests: a STK1 market, STK1 stock, a writer with USDC and a covered writer.
abstract contract WriterBookBase is MainspringPoolBase {
    bytes32 constant STK1 = "STK1";
    address constant W = address(0x3317); // a writer
    address constant BROKE = address(0xB40C); // a covered writer who keeps no USDC
    uint256 constant S = 70_000e18;
    uint256 constant H = 40e18; // STK1 mark
    uint256 constant SIG = 4500;
    uint256 constant HSIG = 8000;

    MockStockToken stock;
    CoveringAssets covers;
    WriterBook wb;

    function setUp() public override {
        super.setUp();
        stock = new MockStockToken("Mock Stock One", "STK1", 18);
        covers = CoverFixture.listed(address(this), address(marks), IERC20(address(stock)));
        wb = new WriterBook(book, IEngineConfig(address(engine)), pool, marks, vols, settlement, covers);
        engine.setWriterBook(address(wb));
        pool.setWriterBook(address(wb));
        pool.setCoverAssets(covers);
        pool.listMarket(STK1, 3500);
        pool.setHedgerDeltaCap(STK1, 1e16);
        pool.setCaps(STK1, 1e15, 1e15);
        engine.setMarket(STK1, 1e18, 200);
        marks.set(STK1, H);
        vols.set(STK1, HSIG);
        book.record(STK1, H, HSIG);
        address[2] memory who = [W, BROKE];
        for (uint256 i; i < 2; ++i) {
            stock.mint(who[i], 1_000_000e18);
            vm.startPrank(who[i]);
            settlement.approve(address(wb), type(uint256).max);
            stock.approve(address(wb), type(uint256).max);
            vm.stopPrank();
        }
        settlement.mint(W, 100_000_000e6);
        _seed(5_000_000e6);
    }

    // ---------------------------------------------------------------- helpers

    function _leg(bool isCall, uint256 k, int256 q) internal pure returns (StrategyMath.Leg memory) {
        return StrategyMath.Leg(isCall, uint128(k), int128(q));
    }

    function _l1(StrategyMath.Leg memory a) internal pure returns (StrategyMath.Leg[] memory l) {
        l = new StrategyMath.Leg[](1);
        l[0] = a;
    }

    function _l2(StrategyMath.Leg memory a, StrategyMath.Leg memory b)
        internal
        pure
        returns (StrategyMath.Leg[] memory l)
    {
        l = new StrategyMath.Leg[](2);
        (l[0], l[1]) = (a, b);
    }

    /// A written call spread: short 70,000, long 75,000 (worst case: the width, 5,000 per unit).
    function _wSpread() internal pure returns (StrategyMath.Leg[] memory) {
        return _l2(_leg(true, 70_000e18, -1e18), _leg(true, 75_000e18, 1e18));
    }

    /// A written Band (iron condor): long put 60,000, short put 65,000, short call 75,000, long call 85,000.
    function _wBand() internal pure returns (StrategyMath.Leg[] memory l) {
        l = new StrategyMath.Leg[](4);
        l[0] = _leg(false, 60_000e18, 1e18);
        l[1] = _leg(false, 65_000e18, -1e18);
        l[2] = _leg(true, 75_000e18, -1e18);
        l[3] = _leg(true, 85_000e18, 1e18);
    }

    function _wCovered() internal pure returns (StrategyMath.Leg[] memory) {
        return _l1(_leg(true, 45e18, -1e18)); // a covered STK1 Rise at 45
    }

    function _wGuard() internal pure returns (StrategyMath.Leg[] memory) {
        return _l2(_leg(false, 35e18, 1e18), _leg(true, 45e18, -1e18)); // buy the Fall at 35, write the Rise at 45
    }

    function _day() internal pure returns (TempoBlend.Part[] memory) {
        return TempoBlend.single(1 days);
    }

    function _neg(StrategyMath.Leg[] memory legs) internal pure returns (StrategyMath.Leg[] memory out) {
        out = new StrategyMath.Leg[](legs.length);
        for (uint256 j; j < legs.length; ++j) {
            out[j] = _leg(legs[j].isCall, legs[j].kWad, -int256(legs[j].qty));
        }
    }

    function _write(address who, bytes32 m, StrategyMath.Leg[] memory legs, uint256 units, bool cover)
        internal
        returns (uint256 wid, int256 credit)
    {
        vm.prank(who);
        return wb.write(m, legs, _day(), units, cover, type(int256).min, nowT);
    }

    function _expectedCredit(bytes32 m, StrategyMath.Leg[] memory legs, uint256 s, uint256 sig, uint256 units)
        internal
        pure
        returns (int256 credit, uint256 fee)
    {
        StrategyMath.Leg[] memory poolLegs = _neg(legs);
        int256 v = EnginePricing.shapeValue(poolLegs, s, sig, TempoBlend.single(1 days), false);
        m;
        return EnginePricing.shapeWriteQuote(v, units, poolLegs, s, 200);
    }

    function _locked(uint256 wid) internal view returns (uint256 settlementL, uint256 coverL, uint256 raw) {
        (,,, raw,,, settlementL, coverL) = wb.writes(wid);
    }

    function _balancesHeld() internal view {
        assertEq(settlement.balanceOf(address(wb)), wb.totalSettlementLocked(), "the WriterBook holds exactly what is locked");
        assertEq(stock.balanceOf(address(wb)), wb.totalCoverLocked(IERC20(address(stock))));
        assertEq(settlement.balanceOf(address(engine)), 0);
    }

}

/// M4 step 7a: writing shapes against exact collateral.
contract WriterBookTest is WriterBookBase {
    // ---------------------------------------------------------------- 1. exact collateral

    function test_exactCollateralPerShape() public {
        // written call spread: the width
        uint256 before = settlement.balanceOf(W);
        (int256 expect,) = _expectedCredit(BTC, _wSpread(), S, SIG, 2e18);
        (uint256 wid, int256 credit) = _write(W, BTC, _wSpread(), 2e18, false);
        assertEq(credit, expect);
        (uint256 u, uint256 h,) = _locked(wid);
        assertEq(u, 10_000e6, "2 x the 5,000 width");
        assertEq(h, 0);
        assertEq(int256(settlement.balanceOf(W)) - int256(before), credit - int256(10_000e6));

        // Band: the wider wing (10,000 on the call side)
        (wid,) = _write(W, BTC, _wBand(), 1e18, false);
        (u, h,) = _locked(wid);
        assertEq(u, 10_000e6);

        // covered STK1 Rise: the STK1 stock, no USDC
        (wid,) = _write(W, STK1, _wCovered(), 3e18, true);
        (u, h,) = _locked(wid);
        assertEq(u, 0);
        assertEq(h, 3e18);

        // Guard: 0 USDC and the STK1 stock for the written Rise
        (wid,) = _write(W, STK1, _wGuard(), 5e18, true);
        (u, h,) = _locked(wid);
        assertEq(u, 0);
        assertEq(h, 5e18);
        _balancesHeld();
        assertEq(stock.balanceOf(address(wb)), 8e18);
    }

    // ---------------------------------------------------------------- 2. refusals

    function test_writeRefusals() public {
        TempoBlend.Part[] memory day = _day();
        vm.startPrank(W);
        vm.expectRevert(WriterBook.ZeroUnits.selector);
        wb.write(BTC, _wSpread(), day, 0, false, type(int256).min, nowT);
        vm.expectRevert(abi.encodeWithSelector(WriterBook.Expired.selector, nowT - 1));
        wb.write(BTC, _wSpread(), day, 1e18, false, type(int256).min, nowT - 1);
        vm.expectRevert(abi.encodeWithSelector(WriterBook.NotListed.selector, bytes32("SOL")));
        wb.write("SOL", _wSpread(), day, 1e18, false, type(int256).min, nowT);
        // a naked short call; cover off STK1; asking for cover with nothing to cover
        vm.expectRevert(StrategyMath.Unbounded.selector);
        wb.write(STK1, _wCovered(), day, 1e18, false, type(int256).min, nowT);
        vm.expectRevert(StrategyMath.CoverNotAllowed.selector); // BTC has no covering asset
        wb.write(BTC, _l1(_leg(true, 75_000e18, -1e18)), day, 1e18, true, type(int256).min, nowT);
        vm.expectRevert(WriterBook.NoCoverNeeded.selector);
        wb.write(BTC, _wSpread(), day, 1e18, true, type(int256).min, nowT);
        // strikes, spelling, cap
        StrategyMath.Leg[] memory off = _wSpread();
        off[1].kWad = 75_050e18;
        vm.expectRevert(abi.encodeWithSelector(EnginePricing.StrikeOffStep.selector, 75_050e18, 100e18));
        wb.write(BTC, off, day, 1e18, false, type(int256).min, nowT);
        vm.expectRevert(abi.encodeWithSelector(PathFundingBook.LegsNotCanonical.selector, 1));
        wb.write(
            BTC,
            _l2(_leg(true, 75_000e18, 1e18), _leg(true, 70_000e18, -1e18)),
            day,
            1e18,
            false,
            type(int256).min,
            nowT
        );
        TempoBlend.Part[] memory two = new TempoBlend.Part[](2);
        two[0] = TempoBlend.Part(1 days, 0.5e18);
        two[1] = TempoBlend.Part(7 days, 0.5e18);
        vm.expectRevert(abi.encodeWithSelector(PathFundingBook.ShapeTooComplex.selector, 4, 2));
        wb.write(BTC, _wBand(), two, 1e18, false, type(int256).min, nowT);
        // minimum credit
        (int256 expect,) = _expectedCredit(BTC, _wSpread(), S, SIG, 1e18);
        vm.expectRevert(abi.encodeWithSelector(WriterBook.CreditBelowMin.selector, expect, expect + 1));
        wb.write(BTC, _wSpread(), day, 1e18, false, expect + 1, nowT);
        vm.stopPrank();

        // law 2
        marks.setStale(true);
        vm.prank(W);
        vm.expectRevert(abi.encodeWithSelector(MockMarks.Stale.selector, BTC));
        wb.write(BTC, _wSpread(), day, 1e18, false, type(int256).min, nowT);
        marks.setStale(false);
        vols.setStale(true);
        vm.prank(W);
        vm.expectRevert(abi.encodeWithSelector(MockVols.Stale.selector, BTC));
        wb.write(BTC, _wSpread(), day, 1e18, false, type(int256).min, nowT);
        vols.setStale(false);

        // pauses: the Engine's buy pause and the pool's market pause stop writes (opens)
        engine.grantRole(engine.PAUSER_ROLE(), address(this));
        engine.pauseBuys();
        vm.prank(W);
        vm.expectRevert(WriterBook.WritesArePaused.selector);
        wb.write(BTC, _wSpread(), day, 1e18, false, type(int256).min, nowT);
        engine.unpauseBuys();
        pool.grantRole(pool.RISK_PAUSER_ROLE(), address(this));
        pool.pauseMarket(BTC);
        vm.prank(W);
        vm.expectRevert(abi.encodeWithSelector(MainspringPool.MarketIsPaused.selector, BTC));
        wb.write(BTC, _wSpread(), day, 1e18, false, type(int256).min, nowT);
        pool.unpauseMarket(BTC);

        // wiring: only the WriterBook calls the pool's hooks; the book's writer is set once, through the Engine
        vm.prank(ATTACKER);
        vm.expectRevert(MainspringPool.NotWriterBook.selector);
        pool.onWrite(BTC, 1, 1, 1, 1, S, SIG, 1e6, 0, ATTACKER);
        vm.expectRevert(PathFundingBook.WriterAlreadySet.selector);
        engine.setWriterBook(address(0x1234));
        vm.expectRevert(PathFundingBook.NotEngine.selector);
        book.setWriter(address(0x1234));
        vm.expectRevert(MainspringPool.WriterBookAlreadySet.selector);
        pool.setWriterBook(address(0x1234));
        // the writer is not the Engine: it cannot mint or burn book balances
        vm.prank(address(wb));
        vm.expectRevert(PathFundingBook.NotEngine.selector);
        book.mint(1, W, 1);
    }

    // ---------------------------------------------------------------- 3. claims

    function test_claimReleasesExactlyWhatDecayFreed() public {
        (uint256 wid,) = _write(W, BTC, _wSpread(), 4e18, false);
        (uint256 u0,,) = _locked(wid);
        uint256 sid = book.idOfShape(BTC, _neg(_wSpread()), _day());
        // nothing to release at once
        vm.prank(W);
        (uint256 out,) = wb.claim(wid);
        assertEq(out, 0);
        // twelve hours of samples near the lower strike: the spread decays
        for (uint256 i = 1; i <= 144; ++i) {
            _set(nowT + 5 minutes);
            book.record(BTC, S + (i % 7) * 50e18, SIG);
        }
        // behind the latest sample, the factor where the last walk stopped counts: nothing yet
        (uint256 reqBehind,) = wb.required(wid);
        assertEq(reqBehind, u0, "not walked: still the full width");
        book.accrue(sid, type(uint256).max);
        (,, uint256 raw) = _locked(wid);
        uint256 unitsNow = Math.mulDiv(raw, book.normNow(sid), 1e18, Math.Rounding.Ceil);
        uint256 req = Math.ceilDiv(Math.mulDiv(unitsNow, 5_000e18, 1e18, Math.Rounding.Ceil), 1e12);
        assertLt(req, u0);
        uint256 before = settlement.balanceOf(W);
        vm.prank(W);
        (out,) = wb.claim(wid);
        assertEq(out, u0 - req, "released exactly what decay freed");
        assertEq(settlement.balanceOf(W) - before, out);
        (uint256 u1,,) = _locked(wid);
        assertEq(u1, req);
        // law 4: what stays locked covers the worst case of the units owed now
        assertGe(u1 * 1e12, Math.mulDiv(unitsNow, 5_000e18, 1e18));
        vm.prank(W);
        (out,) = wb.claim(wid);
        assertEq(out, 0, "nothing more until it decays further");
        vm.prank(ATTACKER);
        vm.expectRevert(abi.encodeWithSelector(WriterBook.NotWriter.selector, wid));
        wb.claim(wid);
        _balancesHeld();
    }

    // ---------------------------------------------------------------- 4. unwrites

    function test_unwriteCostPartialPausedAndStale() public {
        (uint256 wid,) = _write(W, BTC, _wSpread(), 4e18, false);
        (,, uint256 raw0) = _locked(wid);
        // everything paused: an unwrite still works (law 3 for writers)
        engine.grantRole(engine.PAUSER_ROLE(), address(this));
        engine.pauseBuys();
        pool.grantRole(pool.RISK_PAUSER_ROLE(), address(this));
        pool.pauseMarket(BTC);

        _set(nowT + 2 minutes);
        int256 v = EnginePricing.shapeValue(_neg(_wSpread()), S, SIG, _day(), true);
        uint256 before = settlement.balanceOf(W);
        vm.prank(W);
        (uint256 paid, int256 cost) = wb.unwrite(wid, 1e18, type(int256).max, nowT);
        (int256 expect,) = EnginePricing.shapeUnwriteQuote(v, paid, _neg(_wSpread()), S, 200);
        assertEq(cost, expect, "the pool's ask");
        (uint256 u,, uint256 raw) = _locked(wid);
        // the collateral released is pro rata to the raw burned (a little more than a quarter: raw rounds up for the
        // pool after two minutes of decay), the cost paid from it, the rest back to the writer
        uint256 part = Math.mulDiv(20_000e6, raw0 - raw, raw0);
        assertGt(raw0 - raw, raw0 / 4);
        assertEq(u, 20_000e6 - part);
        assertEq(int256(settlement.balanceOf(W)) - int256(before), int256(part) - cost);

        // stale mark and vol: the last recorded sample prices the unwrite
        marks.setStale(true);
        vols.setStale(true);
        (, uint256 sampleS, uint256 sampleSig) = book.latestSample(BTC);
        v = EnginePricing.shapeValue(_neg(_wSpread()), sampleS, sampleSig, _day(), true);
        vm.prank(W);
        (paid, cost) = wb.unwrite(wid, 1e18, type(int256).max, nowT);
        (expect,) = EnginePricing.shapeUnwriteQuote(v, paid, _neg(_wSpread()), sampleS, 200);
        assertEq(cost, expect);
        marks.setStale(false);
        vols.setStale(false);

        // max cost, then everything
        vm.prank(W);
        vm.expectPartialRevert(WriterBook.CostAboveMax.selector);
        wb.unwrite(wid, type(uint256).max, 0, nowT);
        vm.prank(W);
        wb.unwrite(wid, type(uint256).max, type(int256).max, nowT);
        (u,, raw) = _locked(wid);
        assertEq(u, 0);
        assertEq(raw, 0);
        vm.prank(W);
        vm.expectRevert(abi.encodeWithSelector(WriterBook.NothingToUnwrite.selector, wid));
        wb.unwrite(wid, type(uint256).max, type(int256).max, nowT);
        _balancesHeld();
    }

    function test_unwriteCostCappedAtTheCollateral() public {
        (uint256 wid,) = _write(W, BTC, _wSpread(), 2e18, false);
        // far above the upper strike the spread is worth almost its width; plus the fee, the ask exceeds the width
        marks.set(BTC, 120_000e18);
        int256 v = EnginePricing.shapeValue(_neg(_wSpread()), 120_000e18, SIG, _day(), true);
        (int256 ask,) = EnginePricing.shapeUnwriteQuote(v, 2e18, _neg(_wSpread()), 120_000e18, 200);
        assertGt(ask, int256(10_000e6), "the uncapped ask is above the collateral");
        uint256 before = settlement.balanceOf(W);
        vm.prank(W);
        (, int256 cost) = wb.unwrite(wid, type(uint256).max, type(int256).max, nowT);
        assertEq(cost, int256(10_000e6), "capped at the locked collateral");
        assertEq(settlement.balanceOf(W), before, "paid entirely from the collateral");
        _balancesHeld();
    }

    /// Owner's test: a covered STK1 writer with no USDC at all fully unwrites after the price rises, the buyback paid
    /// from locked STK1 stock at the STK1 mark.
    function test_coveredWriterWithNoSettlementUnwritesAfterARise() public {
        settlement.mint(BROKE, 100e6); // enough for a small fee or debit at the write
        (uint256 wid,) = _write(BROKE, STK1, _wCovered(), 10e18, true);
        uint256 bal = settlement.balanceOf(BROKE); // read first: a call inside the arguments would use up the prank
        vm.prank(BROKE);
        settlement.transfer(address(0xDEAD), bal); // keeps no USDC
        assertEq(settlement.balanceOf(BROKE), 0);

        marks.set(STK1, 55e18); // well above the 45 strike
        _set(nowT + 1 minutes);
        uint256 stockBefore = stock.balanceOf(BROKE);
        uint256 poolStockBefore = stock.balanceOf(address(pool));
        vm.prank(BROKE);
        (uint256 paid, int256 cost) = wb.unwrite(wid, type(uint256).max, type(int256).max, nowT);
        assertGt(cost, int256(100e6), "about 10 x (55 - 45) plus funding and the fee");
        assertEq(settlement.balanceOf(BROKE), 0, "no USDC needed");
        uint256 toPool = stock.balanceOf(address(pool)) - poolStockBefore;
        assertEq(toPool, Math.mulDiv(uint256(cost) * 1e12, 1e18, 55e18, Math.Rounding.Ceil), "STK1 stock at the STK1 mark");
        assertEq(stock.balanceOf(BROKE) - stockBefore, 10e18 - toPool, "the rest of the STK1 stock back");
        (uint256 u, uint256 h, uint256 raw) = _locked(wid);
        assertEq(u + h + raw, 0);
        assertLe(paid, 10e18);
        _balancesHeld();
    }

    // ---------------------------------------------------------------- RH5: covering tokens that misbehave (owner D3, G9)

    /// A frozen covering token at an unwrite: the unwrite still goes through, the cover owed to the pool and the rest
    /// owed to the writer stay in the book, opens on STK1 pause, and anyone settles both once the token moves.
    function test_aFrozenCoverAtUnwriteIsOwedPausesOpensAndSettlesLater() public {
        settlement.mint(BROKE, 100e6);
        (uint256 wid,) = _write(BROKE, STK1, _wCovered(), 10e18, true);
        marks.set(STK1, 55e18);
        _set(nowT + 1 minutes);
        stock.setFrozen(true);
        uint256 w0 = stock.balanceOf(BROKE);
        vm.prank(BROKE);
        (, int256 cost) = wb.unwrite(wid, type(uint256).max, type(int256).max, nowT);
        uint256 toPool = Math.mulDiv(uint256(cost) * 1e12, 1e18, 55e18, Math.Rounding.Ceil);
        IERC20 st = IERC20(address(stock));
        assertEq(wb.owedCover(st, address(pool)), toPool, "owed to the pool");
        assertEq(wb.owedCover(st, BROKE), 10e18 - toPool, "the rest owed to the writer");
        assertEq(stock.balanceOf(BROKE), w0, "nothing moved");
        assertTrue(pool.marketPaused(STK1), "opens on STK1 pause (an outage)");
        assertFalse(pool.marketPaused(BTC), "only that market");
        assertEq(stock.balanceOf(address(wb)), wb.totalCoverLocked(st) + wb.owedCoverTotal(st), "held = locked + owed");
        // a buyer can still sell on the paused market (law 3): opens stop, sells go on
        (uint256 id,) = _buy(BTC, true, 70_000e18, 1e18);
        _sell(id, type(uint256).max);
        // once the token moves, anyone settles
        stock.setFrozen(false);
        vm.startPrank(address(0xA11CE));
        wb.settleCover(st, address(pool));
        wb.settleCover(st, BROKE);
        vm.stopPrank();
        assertEq(stock.balanceOf(BROKE) - w0, 10e18 - toPool);
        assertEq(wb.owedCoverTotal(st), 0);
        _balancesHeld();
    }

    /// A frozen covering token at a claim: the claim goes through, the released cover stays owed, opens pause.
    function test_aFrozenCoverAtClaimIsOwed() public {
        settlement.mint(BROKE, 100e6);
        (uint256 wid,) = _write(BROKE, STK1, _wCovered(), 10e18, true);
        // twelve hours of samples, then a walk: decay frees part of the cover (as the claim test above)
        for (uint256 i = 1; i <= 144; ++i) {
            _set(nowT + 5 minutes);
            book.record(STK1, H, HSIG);
        }
        book.accrue(book.idOfShape(STK1, _neg(_wCovered()), _day()), type(uint256).max);
        stock.setFrozen(true);
        vm.prank(BROKE);
        (, uint256 coverOut) = wb.claim(wid);
        assertGt(coverOut, 0);
        assertEq(wb.owedCover(IERC20(address(stock)), BROKE), coverOut);
        assertTrue(pool.marketPaused(STK1));
    }

    /// At write time the covering token must not be paused, must allow writer → book and book → pool, and must arrive
    /// exactly; each failure refuses the write and changes nothing.
    function test_coveredWritesRefusedForAPausedRestrictedOrFeeTakingToken() public {
        settlement.mint(W, 100e6);
        stock.setPaused(true);
        vm.prank(W);
        vm.expectRevert(abi.encodeWithSelector(CoveringAssets.CoverPaused.selector, STK1));
        wb.write(STK1, _wCovered(), _day(), 1e18, true, type(int256).min, nowT);
        stock.setPaused(false);
        stock.setRestricted(true);
        stock.setAllowed(W, true);
        stock.setAllowed(address(wb), true); // the pool is not whitelisted: book → pool would fail later
        vm.prank(W);
        vm.expectRevert(abi.encodeWithSelector(CoveringAssets.CoverRestricted.selector, STK1, address(wb), address(pool), uint8(3)));
        wb.write(STK1, _wCovered(), _day(), 1e18, true, type(int256).min, nowT);
        stock.setRestricted(false);
        stock.setFeeBps(10);
        vm.prank(W);
        vm.expectRevert(abi.encodeWithSelector(CoverLedger.CoverNotExact.selector, 1e18, 0.999e18));
        wb.write(STK1, _wCovered(), _day(), 1e18, true, type(int256).min, nowT);
        stock.setFeeBps(0);
        _write(W, STK1, _wCovered(), 1e18, true); // a well-behaved token: accepted
        _balancesHeld();
    }

    /// A stock token with 6 decimals: cover is kept in its own units, rounded up at the lock (law 4), and an unwrite
    /// pays the pool at the mark in those units.
    function test_aSixDecimalStockCoversExactlyInItsOwnUnits() public {
        MockStockToken six = new MockStockToken("Six", "SIX", 6);
        bytes32 SIX = "SIX";
        covers.list(SIX, IERC20(address(six)), new address[](0));
        pool.listMarket(SIX, 3500);
        pool.setHedgerDeltaCap(SIX, 1e16);
        pool.setCaps(SIX, 1e15, 1e15);
        engine.setMarket(SIX, 1e18, 200);
        marks.set(SIX, H);
        vols.set(SIX, HSIG);
        book.record(SIX, H, HSIG);
        six.mint(W, 1_000e6);
        vm.prank(W);
        six.approve(address(wb), type(uint256).max);
        settlement.mint(W, 100e6);
        (uint256 wid,) = _write(W, SIX, _wCovered(), 2.5e18, true);
        (, uint256 h,) = _locked(wid);
        assertEq(h, 2.5e6, "2.5 shares at 6 decimals");
        (, uint256 req) = wb.required(wid);
        assertEq(req, 2.5e6);
        // a fraction of a smallest unit rounds up, never down
        (uint256 wid2,) = _write(W, SIX, _wCovered(), 1e18 + 1, true);
        (, uint256 h2,) = _locked(wid2);
        assertEq(h2, 1e6 + 1, "rounded up to the next smallest unit");
        marks.set(SIX, 55e18);
        _set(nowT + 1 minutes);
        uint256 p0 = six.balanceOf(address(pool));
        vm.prank(W);
        (, int256 cost) = wb.unwrite(wid, type(uint256).max, type(int256).max, nowT);
        uint256 expected = Math.ceilDiv(Math.mulDiv(uint256(cost) * 1e12, 1e18, 55e18, Math.Rounding.Ceil), 1e12);
        assertEq(six.balanceOf(address(pool)) - p0, expected, "paid in the token's own units at the mark");
    }

    // ---------------------------------------------------------------- 5. Guard as a net debit

    function test_guardWrittenForANetDebit() public {
        // below the middle the Fall the writer buys is worth more than the Rise they write: the writer pays
        marks.set(STK1, 36e18);
        book.record(STK1, 36e18, HSIG);
        (int256 expect, uint256 fee) = _expectedCredit(STK1, _wGuard(), 36e18, HSIG, 5e18);
        assertLt(expect, 0);
        vm.prank(W);
        vm.expectRevert(abi.encodeWithSelector(WriterBook.CreditBelowMin.selector, expect, expect + 1));
        wb.write(STK1, _wGuard(), _day(), 5e18, true, expect + 1, nowT);
        uint256 before = settlement.balanceOf(W);
        uint256 poolBefore = settlement.balanceOf(address(pool));
        uint256 protoBefore = settlement.balanceOf(PROTO);
        vm.prank(W);
        (, int256 credit) = wb.write(STK1, _wGuard(), _day(), 5e18, true, expect, nowT);
        assertEq(credit, expect);
        assertEq(before - settlement.balanceOf(W), uint256(-credit), "the writer paid the debit; no USDC locked");
        uint256 cut = fee * pool.protocolFeeBps() / 10_000;
        assertEq(settlement.balanceOf(PROTO) - protoBefore, cut);
        assertEq(settlement.balanceOf(address(pool)) - poolBefore, uint256(-credit) - cut);
        _balancesHeld();
    }

    // ---------------------------------------------------------------- 6. gas

    function test_writerGas() public {
        _write(W, BTC, _wSpread(), 1e18, false); // warm
        uint256 g = gasleft();
        (uint256 wid,) = _write(W, BTC, _wBand(), 1e18, false);
        console2.log("write a Band (4 legs, new series)", g - gasleft());
        g = gasleft();
        (uint256 wid2,) = _write(W, BTC, _wSpread(), 1e18, false);
        console2.log("write a spread (existing series)", g - gasleft());
        g = gasleft();
        vm.prank(W);
        wb.claim(wid2);
        console2.log("claim", g - gasleft());
        g = gasleft();
        vm.prank(W);
        wb.unwrite(wid, type(uint256).max, type(int256).max, nowT);
        console2.log("unwrite a Band, all", g - gasleft());
    }
}
