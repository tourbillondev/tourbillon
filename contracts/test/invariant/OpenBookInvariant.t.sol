// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Engine} from "../../src/Engine.sol";
import {EnginePricing} from "../../src/EnginePricing.sol";
import {MainspringPool, IEquityFeed} from "../../src/MainspringPool.sol";
import {PathFundingBook} from "../../src/PathFundingBook.sol";
import {QuorumBoard} from "../../src/QuorumBoard.sol";
import {TempoBlend} from "../../src/TempoBlend.sol";
import {StrategyMath} from "../../src/StrategyMath.sol";
import {VolQuote, VolQuoteBook} from "../../src/VolQuote.sol";
import {MakerVault} from "../../src/MakerVault.sol";
import {MatchBook} from "../../src/MatchBook.sol";
import {OpenBook, IEngineOpenFor} from "../../src/OpenBook.sol";
import {IEngineConfig} from "../../src/WriterBook.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockWHYPE} from "../mocks/MockWHYPE.sol";
import {MockMarks, MockVols} from "../Engine.t.sol";

/// M6 step 7: the open book on the full stack. Random sequences of routed buys (signed maker quotes, writer offers,
/// the pool), sells, offers posted and cancelled, vault deposits and withdrawals, claims, early closes, hourly price
/// moves with epochs and settlement, and pauses. Every refusal is caught and classified.
contract OpenBookHandler is Test {
    bytes32 public constant BTC = "BTC";
    address public constant PROTO = address(0x9907);
    address public constant LP = address(0x1A1);
    uint256 public constant START = 100_000_000e6;

    MockUSDC public usdc;
    MockWHYPE public whype;
    MockMarks public marks;
    MockVols public vols;
    MainspringPool public pool;
    PathFundingBook public book;
    Engine public engine;
    MakerVault public vault;
    MatchBook public mb;
    VolQuoteBook public qb;
    OpenBook public ob;

    address[2] public traders = [address(0x7A1), address(0x7A2)];
    address[3] public makers;
    uint256[3] internal makerPks;
    address public constant WRITER = address(0x3317);
    uint64[3] internal nonces;
    uint256 public nowT = 1_794_182_400;
    uint256 public s = 70_000e18;

    uint256[] public offerIds;
    uint256[2] public sids;

    // ghosts
    uint256 public buysOk;
    uint256 public routedMaker;
    uint256 public routedOffer;
    uint256 public routedPool;
    uint256 public sellsOk;
    uint256 public sellFailures; // law 3: never
    uint256 public earlyClosesOk;
    uint256 public claimsOk;
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
        vault = new MakerVault(address(this), IERC20(address(usdc)), IERC20(address(whype)));
        mb = new MatchBook(address(this), book, IEngineConfig(address(engine)), vault, marks, vols);
        address obAt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        qb = new VolQuoteBook(obAt);
        ob = new OpenBook(IEngineOpenFor(address(engine)), IEngineConfig(address(engine)), marks, vols, qb, mb);
        require(address(ob) == obAt, "router prediction");
        pool.setEngine(address(engine));
        engine.setOpenBook(address(ob));
        mb.setRouter(address(ob));
        mb.setPool(address(pool));
        vault.setMatchBook(address(mb));
        pool.setMatchBook(address(mb));
        pool.listMarket(BTC, 2000);
        pool.setHedgerDeltaCap(BTC, 1e16);
        pool.setCaps(BTC, 1e15, 1e15);
        pool.setOpenBookCap(BTC, 1e15);
        pool.grantRole(pool.RISK_PAUSER_ROLE(), address(this));
        engine.setMarket(BTC, 100e18, 200);
        engine.grantRole(engine.PAUSER_ROLE(), address(this));
        marks.set(BTC, s);
        vols.set(BTC, 4500);
        book.record(BTC, s, 4500);

        usdc.mint(LP, START);
        vm.startPrank(LP);
        usdc.approve(address(pool), type(uint256).max);
        pool.deposit(10_000_000e6);
        vm.stopPrank();
        pool.startEpoch();
        while (!pool.markChunk(100)) {}
        pool.settle();
        for (uint256 i; i < 2; ++i) {
            usdc.mint(traders[i], START);
            vm.prank(traders[i]);
            usdc.approve(address(engine), type(uint256).max);
        }
        for (uint256 i; i < 3; ++i) {
            (makers[i], makerPks[i]) = makeAddrAndKey(string(abi.encode("maker", i)));
            usdc.mint(makers[i], START);
            vm.startPrank(makers[i]);
            usdc.approve(address(vault), type(uint256).max);
            vault.deposit(IERC20(address(usdc)), 20_000_000e6);
            vm.stopPrank();
        }
        usdc.mint(WRITER, START);
        vm.prank(WRITER);
        usdc.approve(address(mb), type(uint256).max);
        sids[0] = book.idOfShape(BTC, shape(0), _day());
        sids[1] = book.idOfShape(BTC, shape(1), _day());
    }

    // ---------------------------------------------------------------- shapes (the buyer's side)

    function shape(uint256 i) public pure returns (StrategyMath.Leg[] memory l) {
        l = new StrategyMath.Leg[](2);
        if (i == 0) {
            (l[0], l[1]) = (StrategyMath.Leg(true, 70_000e18, 1e18), StrategyMath.Leg(true, 72_000e18, -1e18));
        } else {
            (l[0], l[1]) = (StrategyMath.Leg(false, 68_000e18, -1e18), StrategyMath.Leg(false, 70_000e18, 1e18));
        }
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

    function makerKey(uint256 i) public view returns (bytes32) {
        return keccak256(abi.encode(uint8(1), makers[i], uint256(0)));
    }

    function offerKey(uint256 id) public pure returns (bytes32) {
        return keccak256(abi.encode(uint8(2), WRITER, id));
    }

    function offerCount() external view returns (uint256) {
        return offerIds.length;
    }

    // ---------------------------------------------------------------- actions

    function buy(uint256 seed, uint256 unitsSeed) external {
        uint256 k = seed % 2;
        StrategyMath.Leg[] memory legs = shape(k);
        uint256 units = bound(unitsSeed, 0.01e18, 10e18);
        // up to two signed maker quotes and up to two open offers on this shape
        uint256 nq = (seed >> 8) % 3;
        VolQuote.Quote[] memory qs = new VolQuote.Quote[](nq);
        bytes[] memory ss = new bytes[](nq);
        for (uint256 i; i < nq; ++i) {
            uint256 m = (seed >> (16 + 8 * i)) % 3;
            qs[i] = VolQuote.Quote(
                makers[m],
                BTC,
                VolQuote.SIDE_BOTH,
                50_000e18,
                100_000e18,
                1 hours,
                30 days,
                uint64(3000 + (seed >> (32 + 8 * i)) % 3000),
                uint128(units),
                uint64(nowT + 1 hours),
                ++nonces[m]
            );
            (uint8 v, bytes32 r, bytes32 s_) = vm.sign(makerPks[m], qb.hashQuote(qs[i]));
            ss[i] = abi.encodePacked(r, s_, v);
        }
        uint256[] memory offers = _openOffersFor(k, 2);
        address t = traders[(seed >> 60) % 2];
        vm.prank(t);
        try ob.buy(BTC, legs, _day(), units, type(uint256).max, nowT, qs, ss, offers) returns (
            uint256, uint256, uint8 kind
        ) {
            buysOk++;
            if (kind == 1) routedPool++;
            else if (kind == 2) routedMaker++;
            else routedOffer++;
        } catch (bytes memory err) {
            _classifyOpen(err);
        }
    }

    function sell(uint256 seed) external {
        address t = traders[seed % 2];
        uint256 sid = sids[(seed >> 8) % 2];
        uint256 bal = book.balanceOf(sid, t);
        if (bal == 0) return;
        uint256 units = (seed >> 16) % 3 == 0 ? type(uint256).max : book.units(sid, t) / 2 + 1;
        vm.prank(t);
        try engine.sell(sid, units, 0, nowT) {
            sellsOk++;
        } catch (bytes memory err) {
            sellFailures++;
            lastError = err;
        }
    }

    function postOffer(uint256 seed) external {
        if (offerIds.length >= 12) return;
        uint256 k = seed % 2;
        vm.prank(WRITER);
        try mb.postOffer(
            BTC,
            _neg(shape(k)),
            _day(),
            uint64(3000 + (seed >> 8) % 3000),
            uint128(1e18 + (seed >> 24) % 20e18),
            uint64(nowT + 6 hours),
            false
        ) returns (
            uint256 id
        ) {
            offerIds.push(id);
        } catch (bytes memory err) {
            unexpectedFailures++;
            lastError = err;
        }
    }

    function cancelOffer(uint256 seed) external {
        if (offerIds.length == 0) return;
        uint256 id = offerIds[seed % offerIds.length];
        (,,,,,,, bool closed,,,,,,) = mb.offers(id);
        if (closed) return;
        vm.prank(WRITER);
        mb.cancelOffer(id);
    }

    function vaultMove(uint256 seed) external {
        address m = makers[seed % 3];
        if ((seed >> 8) % 2 == 0) {
            vm.prank(m);
            vault.deposit(IERC20(address(usdc)), 1e6 + (seed >> 16) % 1_000_000e6);
        } else {
            uint256 free = vault.freeOf(m, IERC20(address(usdc)));
            if (free == 0) return;
            vm.prank(m);
            vault.withdraw(IERC20(address(usdc)), 1 + (seed >> 16) % free);
        }
    }

    function claim(uint256 seed) external {
        uint256 sid = sids[seed % 2];
        if ((seed >> 8) % 2 == 0) {
            uint256 i = (seed >> 16) % 3;
            (uint8 kind,,) = mb.sources(makerKey(i));
            if (kind == 0) return;
            vm.prank(makers[i]);
            mb.claim(makerKey(i), sid);
        } else {
            if (offerIds.length == 0) return;
            uint256 id = offerIds[(seed >> 16) % offerIds.length];
            (uint8 kind,,) = mb.sources(offerKey(id));
            if (kind == 0) return;
            vm.prank(WRITER);
            mb.claim(offerKey(id), sid);
        }
        claimsOk++;
    }

    function earlyClose(uint256 seed) external {
        uint256 sid = sids[seed % 2];
        uint256 i = (seed >> 8) % 3;
        (uint256 raw,,,,, bool flagged) = mb.entries(makerKey(i), sid);
        if (raw == 0 || flagged) return;
        vm.prank(makers[i]);
        try mb.earlyClose(makerKey(i), sid, type(uint256).max, type(int256).max, nowT) {
            earlyClosesOk++;
        } catch (bytes memory err) {
            // the pool may refuse to take the side back (D3): pauses, caps, coverage
            bytes4 sel = _sel(err);
            if (
                sel != MainspringPool.MarketIsPaused.selector && sel != MainspringPool.OpensArePaused.selector
                    && sel != MainspringPool.CoverageBreached.selector
                    && sel != MainspringPool.NotionalCapExceeded.selector
                    && sel != MainspringPool.DirectionalCapExceeded.selector
            ) {
                unexpectedFailures++;
                lastError = err;
            }
        }
    }

    function hour(uint256 seed) external {
        nowT += 1 hours;
        vm.warp(nowT);
        s = s * (98_000 + seed % 4_001) / 100_000;
        if (s < 64_000e18) s = 64_000e18;
        if (s > 76_000e18) s = 76_000e18;
        marks.set(BTC, s);
        book.record(BTC, s, 4500);
        pool.startEpoch();
        while (!pool.markChunk(100)) {}
        pool.settle();
        for (uint256 k; k < 2; ++k) {
            if (book.exists(sids[k])) book.accrue(sids[k], type(uint256).max);
        }
    }

    function togglePause(uint256 seed) external {
        if (seed % 2 == 0) {
            if (engine.buysPaused()) engine.unpauseBuys();
            else engine.pauseBuys();
        } else {
            if (pool.marketPaused(BTC)) pool.unpauseMarket(BTC);
            else pool.pauseMarket(BTC);
        }
    }

    function resumeIfPaused() external {
        if (pool.opensPaused()) pool.resumeOpens();
    }

    // ---------------------------------------------------------------- helpers

    function _openOffersFor(uint256 k, uint256 max) internal view returns (uint256[] memory out) {
        uint256[] memory tmp = new uint256[](max);
        uint256 n;
        for (uint256 i = offerIds.length; i > 0 && n < max; --i) {
            uint256 id = offerIds[i - 1];
            (,, uint256 sid,,,,, bool closed,,,,,,) = mb.offers(id);
            if (!closed && sid == sids[k]) tmp[n++] = id;
        }
        out = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = tmp[i];
        }
    }

    function _classifyOpen(bytes memory err) internal {
        bytes4 sel = _sel(err);
        if (
            sel == Engine.BuysArePaused.selector || sel == MainspringPool.MarketIsPaused.selector
                || sel == MainspringPool.OpensArePaused.selector || sel == MainspringPool.CoverageBreached.selector
                || sel == MainspringPool.DirectionalCapExceeded.selector || sel == Engine.NotCaughtUp.selector
                || sel == OpenBook.NoSource.selector || sel == MakerVault.InsufficientFree.selector
                || sel == MatchBook.TooManySources.selector || sel == EnginePricing.StrikeOutOfBand.selector
        ) return;
        unexpectedFailures++;
        lastError = err;
    }

    function _sel(bytes memory err) internal pure returns (bytes4 s_) {
        if (err.length >= 4) s_ = bytes4(err);
    }
}

/// forge-config: default.invariant.runs = 32
/// forge-config: default.invariant.depth = 40
/// forge-config: default.invariant.fail-on-revert = true
contract OpenBookInvariantTest is Test {
    OpenBookHandler h;

    function setUp() public {
        h = new OpenBookHandler();
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](10);
        sel[0] = OpenBookHandler.buy.selector;
        sel[1] = OpenBookHandler.sell.selector;
        sel[2] = OpenBookHandler.postOffer.selector;
        sel[3] = OpenBookHandler.cancelOffer.selector;
        sel[4] = OpenBookHandler.vaultMove.selector;
        sel[5] = OpenBookHandler.claim.selector;
        sel[6] = OpenBookHandler.earlyClose.selector;
        sel[7] = OpenBookHandler.hour.selector;
        sel[8] = OpenBookHandler.togglePause.selector;
        sel[9] = OpenBookHandler.resumeIfPaused.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    function _keys(uint256 sid) internal view returns (bytes32[] memory) {
        return h.mb().seriesSources(sid);
    }

    /// 1. Law 4 for makers and offers, checked independently: every matched entry's locked USDC covers the exact worst
    ///    case (WAD × WAD at 0 and every strike, the writer's side) of the units it owes now.
    function invariant_law4EveryMatchedEntryCoversItsWorstCase() public view {
        for (uint256 k; k < 2; ++k) {
            uint256 sid = h.sids(k);
            if (!h.book().exists(sid)) continue;
            StrategyMath.Leg[] memory hl = h.shape(k);
            StrategyMath.Leg[] memory w = new StrategyMath.Leg[](2);
            for (uint256 j; j < 2; ++j) {
                w[j] = StrategyMath.Leg(hl[j].isCall, hl[j].kWad, -hl[j].qty);
            }
            int256 minS = StrategyMath.payoffAtScaled(w, 0, 0);
            for (uint256 j; j < 2; ++j) {
                int256 p = StrategyMath.payoffAtScaled(w, 0, w[j].kWad);
                if (p < minS) minS = p;
            }
            uint256 worst = minS < 0 ? uint256(-minS) : 0;
            bytes32[] memory keys = _keys(sid);
            for (uint256 i; i < keys.length; ++i) {
                (uint256 raw,,, uint256 lockedU,,) = h.mb().entries(keys[i], sid);
                if (raw == 0) continue;
                uint256 unitsNow = Math.mulDiv(raw, h.book().normNow(sid), 1e18, Math.Rounding.Ceil);
                assertGe(lockedU * 1e12 * 1e18, Math.mulDiv(worst, unitsNow, 1e18), "law 4");
            }
        }
    }

    /// 2. The pool is flat on matched raw: it mirrors exactly what the MatchBook covers, never above the buyer raw; no
    ///    buyback ever fell short (nothing flagged, nothing uncovered); at most 8 sources per series.
    function invariant_poolMirrorsTheMatchBookAndNothingIsUncovered() public view {
        for (uint256 k; k < 2; ++k) {
            uint256 sid = h.sids(k);
            assertEq(h.pool().matchedRawOf(sid), h.mb().matchedRaw(sid), "the pool mirrors the MatchBook");
            assertLe(h.pool().matchedRawOf(sid), h.pool().seriesRaw(sid), "never above the buyer raw");
            assertEq(h.mb().uncoveredRaw(sid), 0, "no shortfall");
            assertLe(_keys(sid).length, 8);
            uint256 sum;
            bytes32[] memory keys = _keys(sid);
            for (uint256 i; i < keys.length; ++i) {
                (uint256 raw,,,,, bool flagged) = h.mb().entries(keys[i], sid);
                assertFalse(flagged);
                sum += raw;
            }
            assertEq(sum, h.mb().matchedRaw(sid));
        }
    }

    /// 3. Law 3: every sell of a real holding succeeded; nothing else failed unexpectedly.
    function invariant_sellsAlwaysWorkAndNoUnexpectedFailure() public view {
        assertEq(h.sellFailures(), 0, "a sell failed");
        assertEq(h.unexpectedFailures(), 0, "an unexpected failure");
    }

    /// 4. Money: USDC is conserved; the vault holds exactly free + locked; the MatchBook holds exactly what it accounts
    ///    for; the Engine and the router hold nothing.
    function invariant_moneyIsConservedAndHeldWhereItBelongs() public view {
        MockUSDC u = h.usdc();
        uint256 total = u.balanceOf(address(h.pool())) + u.balanceOf(address(h.vault())) + u.balanceOf(address(h.mb()))
            + u.balanceOf(h.PROTO()) + u.balanceOf(h.LP()) + u.balanceOf(h.WRITER()) + u.balanceOf(address(h.engine()))
            + u.balanceOf(address(h.ob()));
        for (uint256 i; i < 2; ++i) {
            total += u.balanceOf(h.traders(i));
        }
        uint256 vaultSum;
        for (uint256 i; i < 3; ++i) {
            total += u.balanceOf(h.makers(i));
            vaultSum += h.vault().freeOf(h.makers(i), IERC20(address(u)))
            + h.vault().lockedOf(h.makers(i), IERC20(address(u)));
        }
        assertEq(total, u.totalSupply(), "USDC conserved");
        assertEq(u.balanceOf(address(h.vault())), vaultSum, "the vault holds free + locked");
        assertEq(u.balanceOf(address(h.mb())), h.mb().heldUsdc(), "the MatchBook holds what it accounts for");
        assertEq(u.balanceOf(address(h.engine())), 0);
        assertEq(u.balanceOf(address(h.ob())), 0);
    }

    function test_handlerCoversEveryPath() public {
        h.postOffer(7);
        h.postOffer(8);
        for (uint256 i; i < 12; ++i) {
            h.buy(i * 0x1010101 + (i << 8), 1e18 + i);
        }
        h.hour(2000);
        h.claim(0);
        h.claim(1 << 8);
        h.earlyClose(0);
        h.sell(0);
        h.sell(1);
        h.sell(1 << 8);
        h.vaultMove(0);
        h.vaultMove(1 << 8);
        h.togglePause(0);
        h.buy(1, 1e18); // refused: buys paused
        h.sell(2);
        h.togglePause(0);
        h.cancelOffer(0);
        assertGt(h.buysOk(), 0);
        assertGt(h.routedPool() + h.routedMaker() + h.routedOffer(), 0);
        assertEq(h.unexpectedFailures(), 0, string(h.lastError()));
        assertEq(h.sellFailures(), 0);
        invariant_law4EveryMatchedEntryCoversItsWorstCase();
        invariant_poolMirrorsTheMatchBookAndNothingIsUncovered();
        invariant_moneyIsConservedAndHeldWhereItBelongs();
        emit log_named_uint("routed pool", h.routedPool());
        emit log_named_uint("routed maker", h.routedMaker());
        emit log_named_uint("routed offer", h.routedOffer());
    }
}
