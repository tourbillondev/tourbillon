// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Engine} from "../../src/Engine.sol";
import {EnginePricing} from "../../src/EnginePricing.sol";
import {MainspringPool, IEquityFeed} from "../../src/MainspringPool.sol";
import {PathFundingBook} from "../../src/PathFundingBook.sol";
import {QuorumBoard} from "../../src/QuorumBoard.sol";
import {TempoBlend} from "../../src/TempoBlend.sol";
import {StrategyMath} from "../../src/StrategyMath.sol";
import {WriterBook, IEngineConfig} from "../../src/WriterBook.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockWHYPE} from "../mocks/MockWHYPE.sol";
import {MockMarks, MockVols} from "../Engine.t.sol";

/// M4 step 8b, the T1 gate on the real contracts. Random sequences of writes (eight shapes on BTC and HYPE, USDC and
/// WHYPE cover), claims, partial and full unwrites, buyer shape buys and sells, price moves with samples, hourly epochs
/// and settlement, pauses. Every failed action is caught and classified; ghost counters feed the invariants.
contract WriterHandler is Test {
    bytes32 public constant BTC = "BTC";
    bytes32 public constant HYPE = "HYPE";
    address public constant PROTO = address(0x9907);
    uint256 public constant START_USDC = 50_000_000e6;
    uint256 public constant START_WHYPE = 1_000_000e18;
    uint256 public constant MAX_OPEN_WRITES = 20;
    int256 public constant WEI_TOLERANCE = 1_000; // TempoMath few-wei rounding (M4 step 6 finding), per shape unit

    MockUSDC public usdc;
    MockWHYPE public whype;
    MockMarks public marks;
    MockVols public vols;
    MainspringPool public pool;
    PathFundingBook public book;
    Engine public engine;
    WriterBook public wb;

    address public constant LP = address(0x1A1);
    address[3] public writers = [address(0x3301), address(0x3302), address(0x3303)];
    address[2] public traders = [address(0x7A1), address(0x7A2)];
    uint256 public nowT = 1_794_182_400;
    uint256 public sBtc = 70_000e18;
    uint256 public sHype = 40e18;

    // writes the handler made (open or closed), and the shape each used
    uint256[] public writeIds;
    mapping(uint256 => uint256) public shapeOf; // writeId → shape index
    mapping(uint256 => uint256) public lastRequired; // writeId → USDC required after the last walk
    mapping(uint256 => uint256) public lastRequiredWhype;

    // ghosts
    uint256 public writesOk;
    uint256 public claimsOk;
    uint256 public unwritesOk;
    uint256 public buysOk;
    uint256 public sellsOk;
    uint256 public hours_;
    uint256 public unwriteFailures; // writers can always close: never
    uint256 public sellFailures; // law 3: never
    uint256 public unwriteOverCap; // a buyback above the collateral's value: never
    uint256 public obligationRose; // a write's required collateral rose with no new write: never (D2)
    uint256 public unexpectedFailures;
    bytes public lastError;

    constructor() {
        vm.warp(nowT);
        usdc = new MockUSDC();
        whype = new MockWHYPE();
        marks = new MockMarks();
        vols = new MockVols();
        address[] memory sg = new address[](3);
        (sg[0], sg[1], sg[2]) = (address(0x51), address(0x52), address(0x53));
        QuorumBoard board = new QuorumBoard(address(this), sg, 2, 30);
        uint256 n = vm.getNonce(address(this));
        address bookAt = vm.computeCreateAddress(address(this), n + 1);
        address engineAt = vm.computeCreateAddress(address(this), n + 2);
        pool = new MainspringPool(
            address(this), usdc, PathFundingBook(bookAt), marks, vols, IEquityFeed(address(board)), PROTO
        );
        book = new PathFundingBook(engineAt, address(this), marks, vols);
        engine = new Engine(address(this), book, pool, marks, vols);
        require(address(book) == bookAt && address(engine) == engineAt, "prediction");
        wb = new WriterBook(book, IEngineConfig(address(engine)), pool, marks, vols, usdc, whype);
        pool.setEngine(address(engine));
        engine.setWriterBook(address(wb));
        pool.setWriterBook(address(wb));
        pool.setWhype(whype, HYPE);
        pool.listMarket(BTC, 2000);
        pool.listMarket(HYPE, 3500);
        pool.setHedgerDeltaCap(BTC, 1e16);
        pool.setHedgerDeltaCap(HYPE, 1e16);
        pool.setCaps(BTC, 1e15, 1e15);
        pool.setCaps(HYPE, 1e15, 1e15);
        pool.grantRole(pool.RISK_PAUSER_ROLE(), address(this));
        engine.grantRole(engine.PAUSER_ROLE(), address(this));
        engine.setMarket(BTC, 100e18, 200);
        engine.setMarket(HYPE, 1e18, 200);
        marks.set(BTC, sBtc);
        marks.set(HYPE, sHype);
        vols.set(BTC, 4500);
        vols.set(HYPE, 8000);
        book.record(BTC, sBtc, 4500);
        book.record(HYPE, sHype, 8000);

        usdc.mint(LP, START_USDC);
        vm.startPrank(LP);
        usdc.approve(address(pool), type(uint256).max);
        pool.deposit(10_000_000e6);
        vm.stopPrank();
        pool.startEpoch();
        while (!pool.markChunk(100)) {}
        pool.settle();
        vm.prank(LP);
        pool.claimShares(0);

        for (uint256 i; i < 3; ++i) {
            usdc.mint(writers[i], START_USDC);
            whype.mint(writers[i], START_WHYPE);
            vm.startPrank(writers[i]);
            usdc.approve(address(wb), type(uint256).max);
            whype.approve(address(wb), type(uint256).max);
            vm.stopPrank();
        }
        for (uint256 i; i < 2; ++i) {
            usdc.mint(traders[i], START_USDC);
            vm.prank(traders[i]);
            usdc.approve(address(engine), type(uint256).max);
        }
    }

    // ---------------------------------------------------------------- the shapes (writer's side)

    uint256 public constant N_SHAPES = 8;

    function _leg(bool isCall, uint256 k, int256 q) internal pure returns (StrategyMath.Leg memory) {
        return StrategyMath.Leg(isCall, uint128(k), int128(q));
    }

    /// The writer's legs, market and whether WHYPE covers the net short calls.
    function shape(uint256 i) public pure returns (StrategyMath.Leg[] memory l, bytes32 market, bool cover) {
        if (i == 0) {
            // written call spread
            l = new StrategyMath.Leg[](2);
            (l[0], l[1]) = (_leg(true, 70_000e18, -1e18), _leg(true, 72_000e18, 1e18));
            return (l, BTC, false);
        }
        if (i == 1) {
            // written put spread
            l = new StrategyMath.Leg[](2);
            (l[0], l[1]) = (_leg(false, 68_000e18, 1e18), _leg(false, 70_000e18, -1e18));
            return (l, BTC, false);
        }
        if (i == 2) {
            // written Band (iron condor), uneven wings
            l = new StrategyMath.Leg[](4);
            l[0] = _leg(false, 64_000e18, 1e18);
            l[1] = _leg(false, 66_000e18, -1e18);
            l[2] = _leg(true, 74_000e18, -1e18);
            l[3] = _leg(true, 77_000e18, 1e18);
            return (l, BTC, false);
        }
        if (i == 3) {
            // a written butterfly
            l = new StrategyMath.Leg[](3);
            l[0] = _leg(true, 68_000e18, -1e18);
            l[1] = _leg(true, 70_000e18, 2e18);
            l[2] = _leg(true, 72_000e18, -1e18);
            return (l, BTC, false);
        }
        if (i == 4) {
            // a ratio: short one call, long 1.5 above (bounded, slope up)
            l = new StrategyMath.Leg[](2);
            (l[0], l[1]) = (_leg(true, 70_000e18, -1e18), _leg(true, 73_000e18, 1.5e18));
            return (l, BTC, false);
        }
        if (i == 5) {
            // covered HYPE Rise
            l = new StrategyMath.Leg[](1);
            l[0] = _leg(true, 44e18, -1e18);
            return (l, HYPE, true);
        }
        if (i == 6) {
            // Guard: buy the Fall, write the Rise, covered
            l = new StrategyMath.Leg[](2);
            (l[0], l[1]) = (_leg(false, 36e18, 1e18), _leg(true, 44e18, -1e18));
            return (l, HYPE, true);
        }
        // a written HYPE Fall (cash-secured)
        l = new StrategyMath.Leg[](1);
        l[0] = _leg(false, 38e18, -1e18);
        return (l, HYPE, false);
    }

    function _neg(StrategyMath.Leg[] memory legs) internal pure returns (StrategyMath.Leg[] memory out) {
        out = new StrategyMath.Leg[](legs.length);
        for (uint256 j; j < legs.length; ++j) {
            out[j] = StrategyMath.Leg(legs[j].isCall, legs[j].kWad, -legs[j].qty);
        }
    }

    function _day() internal pure returns (TempoBlend.Part[] memory) {
        return TempoBlend.single(1 days);
    }

    function seriesOfShape(uint256 i) public view returns (uint256) {
        (StrategyMath.Leg[] memory l, bytes32 m,) = shape(i);
        return book.idOfShape(m, _neg(l), _day());
    }

    function mark(bytes32 m) public view returns (uint256) {
        return m == BTC ? sBtc : sHype;
    }

    function writeCount() external view returns (uint256) {
        return writeIds.length;
    }

    // ---------------------------------------------------------------- actions

    function write(uint256 seed, uint256 unitsSeed) external {
        if (_openWrites() >= MAX_OPEN_WRITES) return;
        uint256 i = seed % N_SHAPES;
        (StrategyMath.Leg[] memory l, bytes32 m, bool cover) = shape(i);
        uint256 units = m == BTC ? bound(unitsSeed, 0.01e18, 5e18) : bound(unitsSeed, 1e18, 50e18);
        address w = writers[seed % 3];
        vm.prank(w);
        try wb.write(m, l, _day(), units, cover, type(int256).min, nowT) returns (uint256 wid, int256) {
            writesOk++;
            writeIds.push(wid);
            shapeOf[wid] = i;
            (lastRequired[wid], lastRequiredWhype[wid]) = wb.required(wid);
        } catch (bytes memory err) {
            _classifyOpen(err);
        }
        _afterEach();
    }

    function claim(uint256 seed) external {
        uint256 wid = _pickOpen(seed);
        if (wid == 0) return;
        (address w,,,,,,,) = wb.writes(wid);
        vm.prank(w);
        try wb.claim(wid) {
            claimsOk++;
        } catch (bytes memory err) {
            unexpectedFailures++;
            lastError = err;
        }
        _afterEach();
    }

    function unwrite(uint256 seed, uint256 fracSeed) external {
        uint256 wid = _pickOpen(seed);
        if (wid == 0) return;
        (address w, bytes32 m,, uint256 raw,,, uint256 usdcL, uint256 whypeL) = wb.writes(wid);
        uint256 frac = fracSeed % 3; // 0: all, 1: a third, 2: two thirds of the units now
        uint256 units = type(uint256).max;
        if (frac != 0) {
            uint256 unitsNow = Math.mulDiv(raw, book.normNow(seriesOfShape(shapeOf[wid])), 1e18);
            units = unitsNow * frac / 3;
            if (units == 0) units = type(uint256).max;
        }
        vm.prank(w);
        try wb.unwrite(wid, units, type(int256).max, nowT) returns (uint256, int256 cost) {
            unwritesOk++;
            (,,, uint256 rawAfter,,, uint256 usdcAfter, uint256 whypeAfter) = wb.writes(wid);
            uint256 usdcPart = usdcL - usdcAfter;
            uint256 whypePart = whypeL - whypeAfter;
            uint256 cap = usdcPart + Math.mulDiv(whypePart, mark(m), 1e18) / 1e12;
            if (cost > int256(cap)) unwriteOverCap++;
            rawAfter;
            (lastRequired[wid], lastRequiredWhype[wid]) = wb.required(wid);
        } catch (bytes memory err) {
            // writers can always close; only a pool truly unable to pay a negative cost could refuse
            if (_sel(err) == MainspringPool.Insolvent.selector) {
                (uint256 needed, uint256 avail) = _decode2(err);
                if (avail >= needed) unwriteFailures++;
            } else {
                unwriteFailures++;
            }
            lastError = err;
        }
        _afterEach();
    }

    function buy(uint256 seed, uint256 unitsSeed) external {
        address t = traders[seed % 2];
        StrategyMath.Leg[] memory l = new StrategyMath.Leg[](2);
        if (seed % 2 == 0) {
            (l[0], l[1]) = (_leg(true, 70_000e18, 1e18), _leg(true, 72_000e18, -1e18)); // the written spread's series
        } else {
            (l[0], l[1]) = (_leg(false, 70_000e18, 1e18), _leg(true, 70_000e18, 1e18)); // Swing
        }
        uint256 units = bound(unitsSeed, 0.01e18, 3e18);
        vm.prank(t);
        try engine.buyShape(BTC, l, _day(), units, type(uint256).max, nowT) {
            buysOk++;
        } catch (bytes memory err) {
            _classifyOpen(err);
        }
        _afterEach();
    }

    function sell(uint256 seed) external {
        address t = traders[seed % 2];
        StrategyMath.Leg[] memory l = new StrategyMath.Leg[](2);
        if (seed % 2 == 0) (l[0], l[1]) = (_leg(true, 70_000e18, 1e18), _leg(true, 72_000e18, -1e18));
        else (l[0], l[1]) = (_leg(false, 70_000e18, 1e18), _leg(true, 70_000e18, 1e18));
        uint256 id = book.idOfShape(BTC, l, _day());
        if (!book.exists(id) || book.balanceOf(id, t) == 0) return;
        // read before the prank: a call inside the arguments would use it up
        uint256 units = seed % 3 == 0 ? type(uint256).max : book.units(id, t) / 2 + 1;
        vm.prank(t);
        try engine.sell(id, units, 0, nowT) {
            sellsOk++;
        } catch (bytes memory err) {
            if (_sel(err) == MainspringPool.Insolvent.selector) {
                (uint256 needed, uint256 avail) = _decode2(err);
                if (avail >= needed) sellFailures++;
            } else {
                sellFailures++;
            }
            lastError = err;
        }
        _afterEach();
    }

    /// An hour passes: both prices move up to ±3% (kept inside a band where every strike stays valid), a sample is
    /// recorded, and an epoch is marked and settled.
    function hour(uint256 seed) external {
        nowT += 1 hours;
        vm.warp(nowT);
        sBtc = _move(sBtc, seed, 60_000e18, 80_000e18);
        sHype = _move(sHype, seed >> 64, 34e18, 46e18);
        marks.set(BTC, sBtc);
        marks.set(HYPE, sHype);
        book.record(BTC, sBtc, 4500);
        book.record(HYPE, sHype, 8000);
        try pool.startEpoch() {
            while (!pool.markChunk(100)) {}
            pool.settle();
            hours_++;
        } catch (bytes memory err) {
            unexpectedFailures++;
            lastError = err;
        }
        _afterEach();
    }

    function togglePause(uint256 seed) external {
        uint256 k = seed % 3;
        if (k == 0) {
            if (engine.buysPaused()) engine.unpauseBuys();
            else engine.pauseBuys();
        } else {
            bytes32 m = k == 1 ? BTC : HYPE;
            if (pool.marketPaused(m)) pool.unpauseMarket(m);
            else pool.pauseMarket(m);
        }
    }

    function resumeIfPaused() external {
        if (pool.opensPaused()) pool.resumeOpens();
    }

    // ---------------------------------------------------------------- checks after every action

    /// Walks every write's series (anyone may) and checks the obligation only shrinks (D2): with no new write on it,
    /// a write's required collateral never rises.
    function _afterEach() internal {
        for (uint256 i; i < N_SHAPES; ++i) {
            uint256 sid = seriesOfShape(i);
            if (book.exists(sid)) book.accrue(sid, type(uint256).max);
        }
        for (uint256 j; j < writeIds.length; ++j) {
            uint256 wid = writeIds[j];
            (uint256 u, uint256 h) = wb.required(wid);
            if (u > lastRequired[wid] || h > lastRequiredWhype[wid]) obligationRose++;
            (lastRequired[wid], lastRequiredWhype[wid]) = (u, h);
        }
    }

    // ---------------------------------------------------------------- helpers

    function _openWrites() internal view returns (uint256 n) {
        for (uint256 j; j < writeIds.length; ++j) {
            (,,, uint256 raw,,,,) = wb.writes(writeIds[j]);
            if (raw > 0) n++;
        }
    }

    function _pickOpen(uint256 seed) internal view returns (uint256) {
        uint256 n = writeIds.length;
        if (n == 0) return 0;
        for (uint256 k; k < n; ++k) {
            uint256 wid = writeIds[(seed % n + k) % n]; // seed % n first: seed + k could overflow
            (,,, uint256 raw,,,,) = wb.writes(wid);
            if (raw > 0) return wid;
        }
        return 0;
    }

    function _move(uint256 s, uint256 seed, uint256 lo, uint256 hi) internal pure returns (uint256) {
        uint256 r = seed % 6001; // ±3%
        s = s * (97_000 + r) / 100_000;
        if (s < lo) s = lo;
        if (s > hi) s = hi;
        return s;
    }

    /// Opens (writes and buys) may be refused only for these.
    function _classifyOpen(bytes memory err) internal {
        bytes4 sel = _sel(err);
        if (
            sel == WriterBook.WritesArePaused.selector || sel == Engine.BuysArePaused.selector
                || sel == MainspringPool.MarketIsPaused.selector || sel == MainspringPool.OpensArePaused.selector
                || sel == MainspringPool.CoverageBreached.selector
                || sel == MainspringPool.DirectionalCapExceeded.selector || sel == WriterBook.NotCaughtUp.selector
                || sel == Engine.NotCaughtUp.selector || sel == WriterBook.ZeroRaw.selector
                || sel == Engine.ZeroRaw.selector
        ) return;
        unexpectedFailures++;
        lastError = err;
    }

    function _sel(bytes memory err) internal pure returns (bytes4 s) {
        if (err.length >= 4) s = bytes4(err);
    }

    function _decode2(bytes memory err) internal pure returns (uint256 a, uint256 b) {
        assembly {
            a := mload(add(err, 36))
            b := mload(add(err, 68))
        }
    }
}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 60
/// forge-config: default.invariant.fail-on-revert = true
contract WriterInvariantTest is Test {
    WriterHandler h;

    function setUp() public {
        h = new WriterHandler();
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](8);
        sel[0] = WriterHandler.write.selector;
        sel[1] = WriterHandler.claim.selector;
        sel[2] = WriterHandler.unwrite.selector;
        sel[3] = WriterHandler.buy.selector;
        sel[4] = WriterHandler.sell.selector;
        sel[5] = WriterHandler.hour.selector;
        sel[6] = WriterHandler.togglePause.selector;
        sel[7] = WriterHandler.resumeIfPaused.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    struct W {
        address writer;
        bytes32 market;
        uint256 sid;
        uint256 raw;
        uint256 usdcL;
        uint256 whypeL;
    }

    function _w(uint256 wid) internal view returns (W memory w) {
        (w.writer, w.market, w.sid, w.raw,,, w.usdcL, w.whypeL) = h.wb().writes(wid);
    }

    /// 1. Law 4, checked independently of the WriterBook's own `required`: every open write's locked collateral
    ///    covers the exact worst case (WAD × WAD payoff at 0 and every strike) of the units it owes now.
    function invariant_law4LockedCoversTheExactWorstCase() public view {
        for (uint256 j; j < h.writeCount(); ++j) {
            uint256 wid = h.writeIds(j);
            W memory w = _w(wid);
            if (w.raw == 0) continue;
            (StrategyMath.Leg[] memory l,, bool cover) = h.shape(h.shapeOf(wid));
            uint256 unitsNow = Math.mulDiv(w.raw, h.book().normNow(w.sid), 1e18, Math.Rounding.Ceil);
            int256 coverQty;
            if (cover) {
                for (uint256 k; k < l.length; ++k) {
                    if (l[k].isCall) coverQty -= l[k].qty;
                }
            }
            int256 minS = StrategyMath.payoffAtScaled(l, coverQty, 0);
            for (uint256 k; k < l.length; ++k) {
                int256 p = StrategyMath.payoffAtScaled(l, coverQty, l[k].kWad);
                if (p < minS) minS = p;
            }
            if (minS < 0) {
                // locked USDC (6 decimals → WAD) × 1e18 ≥ |min| (WAD × WAD per unit) × units now (WAD)
                assertGe(w.usdcL * 1e12 * 1e18, Math.mulDiv(uint256(-minS), unitsNow, 1e18), "law 4: USDC");
            }
            if (coverQty > 0) {
                assertGe(w.whypeL, Math.mulDiv(uint256(coverQty), unitsNow, 1e18), "law 4: WHYPE cover");
            }
        }
    }

    /// 2. The gate: no write's buyback value exceeds its collateral's value, at the mark and at ±50%.
    function invariant_noWriteOwesMoreThanItsCollateral() public view {
        for (uint256 j; j < h.writeCount(); ++j) {
            uint256 wid = h.writeIds(j);
            W memory w = _w(wid);
            if (w.raw == 0) continue;
            (StrategyMath.Leg[] memory l, bytes32 m,) = h.shape(h.shapeOf(wid));
            StrategyMath.Leg[] memory poolLegs = new StrategyMath.Leg[](l.length);
            for (uint256 k; k < l.length; ++k) {
                poolLegs[k] = StrategyMath.Leg(l[k].isCall, l[k].kWad, -l[k].qty);
            }
            uint256 unitsNow = Math.mulDiv(w.raw, h.book().normNow(w.sid), 1e18, Math.Rounding.Ceil);
            uint256 sig = m == h.BTC() ? 4500 : 8000;
            for (uint256 g = 50; g <= 150; g += 50) {
                uint256 s = h.mark(m) * g / 100;
                int256 v = EnginePricing.shapeValue(poolLegs, s, sig, TempoBlend.single(1 days), true);
                if (v <= 0) continue;
                uint256 owed = Math.mulDiv(unitsNow, uint256(v), 1e18); // WAD USDC
                uint256 coll = w.usdcL * 1e12 + Math.mulDiv(w.whypeL, s, 1e18); // WAD USDC
                assertLe(
                    owed,
                    coll + uint256(h.WEI_TOLERANCE()) * (unitsNow / 1e18 + 1),
                    "gate: owes more than its collateral"
                );
            }
        }
    }

    /// 3. The obligation only shrinks (D2); 5. writers can always close, never above the collateral's value; 8. buyer
    ///    sells always work (law 3); nothing else failed unexpectedly.
    function invariant_obligationShrinksAndEveryoneCanClose() public view {
        assertEq(h.obligationRose(), 0, "a write's required collateral rose");
        assertEq(h.unwriteFailures(), 0, "an unwrite of a real holding failed");
        assertEq(h.unwriteOverCap(), 0, "a buyback above the collateral's value");
        assertEq(h.sellFailures(), 0, "a buyer's sell failed");
        assertEq(h.unexpectedFailures(), 0, "an unexpected failure");
    }

    /// 4 and 6. Claims never take collateral below what is required (law 4 above); the WriterBook holds exactly what
    ///    is locked; the Engine holds nothing.
    function invariant_writerBookHoldsExactlyWhatIsLocked() public view {
        assertEq(h.usdc().balanceOf(address(h.wb())), h.wb().totalUsdcLocked());
        assertEq(h.whype().balanceOf(address(h.wb())), h.wb().totalWhypeLocked());
        assertEq(h.usdc().balanceOf(address(h.engine())), 0);
        uint256 sumU;
        uint256 sumH;
        for (uint256 j; j < h.writeCount(); ++j) {
            W memory w = _w(h.writeIds(j));
            sumU += w.usdcL;
            sumH += w.whypeL;
        }
        assertEq(sumU, h.wb().totalUsdcLocked());
        assertEq(sumH, h.wb().totalWhypeLocked());
    }

    /// 7. The pool's written raw per series equals the WriterBook's total for it; USDC and WHYPE are conserved.
    function invariant_accountingAgrees() public view {
        for (uint256 i; i < h.N_SHAPES(); ++i) {
            uint256 sid = h.seriesOfShape(i);
            uint256 sum;
            for (uint256 j; j < h.writeCount(); ++j) {
                W memory w = _w(h.writeIds(j));
                if (w.sid == sid) sum += w.raw;
            }
            assertEq(h.pool().writtenRaw(sid), sum, "pool written raw = WriterBook raw");
        }
        uint256 totalUsdc = h.usdc().balanceOf(h.LP()) + h.usdc().balanceOf(address(h.pool()))
            + h.usdc().balanceOf(address(h.wb())) + h.usdc().balanceOf(h.PROTO());
        for (uint256 i; i < 3; ++i) {
            totalUsdc += h.usdc().balanceOf(h.writers(i));
        }
        for (uint256 i; i < 2; ++i) {
            totalUsdc += h.usdc().balanceOf(h.traders(i));
        }
        assertEq(totalUsdc, h.usdc().totalSupply(), "USDC conserved");
        uint256 totalWhype = h.whype().balanceOf(address(h.pool())) + h.whype().balanceOf(address(h.wb()));
        for (uint256 i; i < 3; ++i) {
            totalWhype += h.whype().balanceOf(h.writers(i));
        }
        assertEq(totalWhype, h.whype().totalSupply(), "WHYPE conserved");
    }

    /// The handler reaches every path.
    function test_handlerCoversEveryPath() public {
        for (uint256 i; i < 8; ++i) {
            h.write(i, 3e18 + i);
        }
        h.buy(0, 2e18);
        h.buy(1, 1e18);
        h.hour(12345);
        h.claim(0);
        h.unwrite(1, 1);
        h.unwrite(2, 0);
        h.sell(0);
        h.togglePause(0);
        h.write(3, 1e18); // refused: buys paused
        h.unwrite(3, 0); // works while paused
        h.togglePause(0);
        h.hour(999);
        h.sell(1);
        assertGe(h.writesOk(), 8);
        assertGe(h.unwritesOk(), 3);
        assertGe(h.claimsOk(), 1);
        assertGe(h.buysOk(), 2);
        assertGe(h.sellsOk(), 2);
        assertEq(h.unexpectedFailures(), 0, string(h.lastError()));
        assertEq(h.unwriteFailures(), 0);
        assertEq(h.sellFailures(), 0);
        invariant_law4LockedCoversTheExactWorstCase();
        invariant_noWriteOwesMoreThanItsCollateral();
        invariant_writerBookHoldsExactlyWhatIsLocked();
        invariant_accountingAgrees();
    }
}
