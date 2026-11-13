// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MainspringPoolBase} from "./MainspringPool.t.sol";
import {MainspringPool} from "../src/MainspringPool.sol";
import {Engine} from "../src/Engine.sol";
import {EnginePricing} from "../src/EnginePricing.sol";
import {TempoBlend} from "../src/TempoBlend.sol";
import {StrategyMath} from "../src/StrategyMath.sol";
import {VolQuote, VolQuoteBook} from "../src/VolQuote.sol";
import {MakerVault} from "../src/MakerVault.sol";
import {MatchBook} from "../src/MatchBook.sol";
import {OpenBook, IEngineOpenFor} from "../src/OpenBook.sol";
import {IEngineConfig} from "../src/WriterBook.sol";
import {MockWHYPE} from "./mocks/MockWHYPE.sol";
import {VolFeed} from "../src/VolFeed.sol";
import {MockMarks, MockVols} from "./Engine.t.sol";

/// M6 step 6: Engine.openFor and the OpenBook best-of-three router, on the full stack.
contract OpenBookTest is MainspringPoolBase {
    uint256 constant S = 70_000e18;
    MockWHYPE whype;
    MakerVault vault;
    MatchBook mb;
    VolQuoteBook qb;
    OpenBook ob;
    address maker;
    uint256 makerPk;
    address maker2;
    uint256 maker2Pk;
    address constant WRITER = address(0x3317);
    VolFeed feed;

    function setUp() public override {
        super.setUp();
        _seed(5_000_000e6);
        whype = new MockWHYPE();
        vault = new MakerVault(address(this), IERC20(address(usdc)), IERC20(address(whype)));
        mb = new MatchBook(address(this), book, IEngineConfig(address(engine)), vault, marks, vols);
        address obAt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        qb = new VolQuoteBook(obAt);
        ob = new OpenBook(IEngineOpenFor(address(engine)), IEngineConfig(address(engine)), marks, vols, qb, mb);
        assertEq(address(ob), obAt);
        engine.setOpenBook(address(ob));
        mb.setRouter(address(ob));
        mb.setPool(address(pool));
        vault.setMatchBook(address(mb));
        pool.setMatchBook(address(mb));
        pool.setOpenBookCap(BTC, 1e15);
        feed = new VolFeed(address(this));
        feed.setRecorder(address(ob));
        ob.setVolFeed(feed);
        (maker, makerPk) = makeAddrAndKey("maker");
        (maker2, maker2Pk) = makeAddrAndKey("maker2");
        address[2] memory ms = [maker, maker2];
        for (uint256 i; i < 2; ++i) {
            usdc.mint(ms[i], 50_000_000e6);
            vm.startPrank(ms[i]);
            usdc.approve(address(vault), type(uint256).max);
            vault.deposit(IERC20(address(usdc)), 10_000_000e6);
            vm.stopPrank();
        }
        usdc.mint(WRITER, 10_000_000e6);
        vm.prank(WRITER);
        usdc.approve(address(mb), type(uint256).max);
    }

    // ---------------------------------------------------------------- helpers

    function _spread() internal pure returns (StrategyMath.Leg[] memory l) {
        l = new StrategyMath.Leg[](2);
        l[0] = StrategyMath.Leg(true, 70_000e18, 1e18);
        l[1] = StrategyMath.Leg(true, 75_000e18, -1e18);
    }

    function _writerSpread() internal pure returns (StrategyMath.Leg[] memory l) {
        l = new StrategyMath.Leg[](2);
        l[0] = StrategyMath.Leg(true, 70_000e18, -1e18);
        l[1] = StrategyMath.Leg(true, 75_000e18, 1e18);
    }

    function _day() internal pure returns (TempoBlend.Part[] memory) {
        return TempoBlend.single(1 days);
    }

    function _quote(address m, uint64 sigma, uint64 nonce, uint128 maxUnits)
        internal
        view
        returns (VolQuote.Quote memory)
    {
        return VolQuote.Quote(
            m,
            BTC,
            VolQuote.SIDE_CALLS,
            60_000e18,
            90_000e18,
            1 hours,
            30 days,
            sigma,
            maxUnits,
            uint64(nowT + 1 hours),
            nonce
        );
    }

    function _sign(VolQuote.Quote memory q, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(pk, qb.hashQuote(q));
        return abi.encodePacked(r, s_, v);
    }

    function _cost(uint256 sigma, uint256 units) internal pure returns (uint256 premium, uint256 fee) {
        int256 v = EnginePricing.shapeValue(_spread(), S, sigma, TempoBlend.single(1 days), true);
        return EnginePricing.shapeBuyQuote(v, units, _spread(), S, 200);
    }

    function _credit(uint256 sigma, uint256 units) internal pure returns (uint256) {
        int256 v = EnginePricing.shapeValue(_spread(), S, sigma, TempoBlend.single(1 days), false);
        return Math.mulDiv(units, uint256(v), 1e18) / 1e12;
    }

    function _none() internal pure returns (VolQuote.Quote[] memory q, bytes[] memory s, uint256[] memory o) {
        q = new VolQuote.Quote[](0);
        s = new bytes[](0);
        o = new uint256[](0);
    }

    function _one(VolQuote.Quote memory q, bytes memory sig)
        internal
        pure
        returns (VolQuote.Quote[] memory qs, bytes[] memory ss)
    {
        qs = new VolQuote.Quote[](1);
        ss = new bytes[](1);
        qs[0] = q;
        ss[0] = sig;
    }

    function _post(uint64 sigma, uint128 maxUnits) internal returns (uint256 id) {
        vm.prank(WRITER);
        id = mb.postOffer(BTC, _writerSpread(), _day(), sigma, maxUnits, uint64(nowT + 1 hours), false);
    }

    function _buy(
        VolQuote.Quote[] memory qs,
        bytes[] memory ss,
        uint256[] memory offers,
        uint256 units,
        uint256 maxCost
    ) internal returns (uint256 id, uint256 cost, uint8 kind) {
        vm.prank(TRADER);
        return ob.buy(BTC, _spread(), _day(), units, maxCost, nowT, qs, ss, offers);
    }

    // ---------------------------------------------------------------- 1. the cheapest source

    function test_routesToTheCheapestSource() public {
        // a maker at 40% beats the pool at 45%
        VolQuote.Quote memory q = _quote(maker, 4000, 1, 100e18);
        (VolQuote.Quote[] memory qs, bytes[] memory ss) = _one(q, _sign(q, makerPk));
        (,, uint256[] memory none) = _none();
        (uint256 premium, uint256 fee) = _cost(4000, 2e18);
        uint256 traderBefore = usdc.balanceOf(TRADER);
        uint256 makerBefore = usdc.balanceOf(maker);
        uint256 protoBefore = usdc.balanceOf(PROTO);
        (uint256 id, uint256 cost, uint8 kind) = _buy(qs, ss, none, 2e18, type(uint256).max);
        assertEq(kind, ob.KIND_QUOTE());
        assertEq(cost, premium + fee);
        assertEq(traderBefore - usdc.balanceOf(TRADER), cost, "the buyer pays the maker's price + fee");
        assertEq(usdc.balanceOf(maker) - makerBefore, _credit(4000, 2e18), "the maker gets its value");
        assertEq(usdc.balanceOf(PROTO) - protoBefore, fee * 1000 / 10_000);
        assertEq(qb.filled(maker, 1), 2e18, "the quote's size is recorded");
        assertEq(pool.matchedRawOf(id), 2e18);
        assertEq(mb.matchedRaw(id), 2e18);

        // a maker at 50% loses to the pool at 45%
        q = _quote(maker, 5000, 2, 100e18);
        (qs, ss) = _one(q, _sign(q, makerPk));
        (, cost, kind) = _buy(qs, ss, none, 1e18, type(uint256).max);
        assertEq(kind, ob.KIND_POOL());
        (premium, fee) = _cost(4500, 1e18);
        assertEq(cost, premium + fee);

        // an offer at 38% beats a maker at 40% and the pool
        uint256[] memory offers = new uint256[](1);
        offers[0] = _post(3800, 10e18);
        q = _quote(maker, 4000, 3, 100e18);
        (qs, ss) = _one(q, _sign(q, makerPk));
        (, cost, kind) = _buy(qs, ss, offers, 1e18, type(uint256).max);
        assertEq(kind, ob.KIND_OFFER());
        (premium, fee) = _cost(3800, 1e18);
        assertEq(cost, premium + fee);
    }

    // ---------------------------------------------------------------- 2. fallback in cost order

    function test_fallsBackInCostOrder() public {
        (,, uint256[] memory none) = _none();
        // the cheapest maker cannot lock its collateral (its vault is nearly empty): the next maker fills
        uint256 free = vault.freeOf(maker, IERC20(address(usdc)));
        vm.prank(maker);
        vault.withdraw(IERC20(address(usdc)), free - 100e6);
        VolQuote.Quote[] memory qs = new VolQuote.Quote[](2);
        bytes[] memory ss = new bytes[](2);
        qs[0] = _quote(maker, 3500, 1, 100e18);
        qs[1] = _quote(maker2, 4000, 1, 100e18);
        ss[0] = _sign(qs[0], makerPk);
        ss[1] = _sign(qs[1], maker2Pk);
        (, uint256 cost, uint8 kind) = _buy(qs, ss, none, 2e18, type(uint256).max);
        assertEq(kind, ob.KIND_QUOTE());
        (uint256 premium, uint256 fee) = _cost(4000, 2e18);
        assertEq(cost, premium + fee, "maker 2 filled at its 40%");
        assertEq(qb.filled(maker, 1), 0, "the failed attempt left nothing behind");
        assertEq(qb.filled(maker2, 1), 2e18);
    }

    function test_fallsBackWhenThePoolRefusesAndRevertsWhenAllRefuse() public {
        (,, uint256[] memory none) = _none();
        VolQuote.Quote[] memory qs = new VolQuote.Quote[](2);
        bytes[] memory ss = new bytes[](2);
        qs[0] = _quote(maker, 3500, 1, 100e18); // too small for the large order below
        qs[1] = _quote(maker2, 4000, 1, 100e18);
        ss[0] = _sign(qs[0], makerPk);
        ss[1] = _sign(qs[1], maker2Pk);
        uint8 kind;
        // the pool is cheapest (board at 30%) but over its coverage for this size: a maker fills
        vm.prank(maker2);
        vault.deposit(IERC20(address(usdc)), 30_000_000e6); // 5,000 spreads need 25,000,000 locked
        vols.set(BTC, 3000);
        book.record(BTC, S, 3000);
        VolQuote.Quote memory q = _quote(maker2, 4000, 2, 10_000e18);
        (VolQuote.Quote[] memory one, bytes[] memory s1) = _one(q, _sign(q, maker2Pk));
        (,, kind) = _buy(one, s1, none, 5_000e18, type(uint256).max);
        assertEq(kind, ob.KIND_QUOTE(), "the pool refused (coverage); the maker took it");

        // every source refuses: the buy reverts with the last reason
        vm.prank(TRADER);
        vm.expectRevert();
        ob.buy(BTC, _spread(), _day(), 5_000e18, type(uint256).max, nowT, qs, ss, none);
    }

    // ---------------------------------------------------------------- 3. law 2

    function test_law2FreshMarkAlwaysBoardOnlyForThePool() public {
        VolQuote.Quote memory q = _quote(maker, 4000, 1, 100e18);
        (VolQuote.Quote[] memory qs, bytes[] memory ss) = _one(q, _sign(q, makerPk));
        (VolQuote.Quote[] memory noQ, bytes[] memory noS, uint256[] memory none) = _none();
        // a stale mark: no fill from anyone
        marks.setStale(true);
        vm.prank(TRADER);
        vm.expectRevert(abi.encodeWithSelector(MockMarks.Stale.selector, BTC));
        ob.buy(BTC, _spread(), _day(), 1e18, type(uint256).max, nowT, qs, ss, none);
        marks.setStale(false);
        // a stale board: the pool is out, the maker still fills
        vols.setStale(true);
        (,, uint8 kind) = _buy(qs, ss, none, 1e18, type(uint256).max);
        assertEq(kind, ob.KIND_QUOTE());
        // a stale board and no quote or offer: nothing can fill
        vm.prank(TRADER);
        vm.expectRevert(OpenBook.NoSource.selector);
        ob.buy(BTC, _spread(), _day(), 1e18, type(uint256).max, nowT, noQ, noS, none);
    }

    // ---------------------------------------------------------------- 4. refusals

    function test_refusals() public {
        (VolQuote.Quote[] memory noQ, bytes[] memory noS, uint256[] memory none) = _none();
        (uint256 premium, uint256 fee) = _cost(4500, 1e18);
        vm.startPrank(TRADER);
        vm.expectRevert(abi.encodeWithSelector(Engine.CostAboveMax.selector, premium + fee, premium + fee - 1));
        ob.buy(BTC, _spread(), _day(), 1e18, premium + fee - 1, nowT, noQ, noS, none);
        vm.expectRevert(abi.encodeWithSelector(OpenBook.Expired.selector, nowT - 1));
        ob.buy(BTC, _spread(), _day(), 1e18, type(uint256).max, nowT - 1, noQ, noS, none);
        StrategyMath.Leg[] memory owe = _writerSpread(); // a short spread can owe
        owe[0].qty = -1e18;
        vm.expectRevert(EnginePricing.ShapeCanOwe.selector);
        ob.buy(BTC, owe, _day(), 1e18, type(uint256).max, nowT, noQ, noS, none);
        VolQuote.Quote[] memory five = new VolQuote.Quote[](5);
        vm.expectRevert(OpenBook.TooManyCandidates.selector);
        ob.buy(BTC, _spread(), _day(), 1e18, type(uint256).max, nowT, five, new bytes[](5), none);
        vm.stopPrank();
        // paused buys stop every source
        engine.grantRole(engine.PAUSER_ROLE(), address(this));
        engine.pauseBuys();
        VolQuote.Quote memory q = _quote(maker, 4000, 1, 100e18);
        (VolQuote.Quote[] memory qs, bytes[] memory ss) = _one(q, _sign(q, makerPk));
        vm.prank(TRADER);
        vm.expectRevert(Engine.BuysArePaused.selector);
        ob.buy(BTC, _spread(), _day(), 1e18, type(uint256).max, nowT, qs, ss, none);
        engine.unpauseBuys();
        // the open-book cap: the maker is refused, the pool fills
        pool.setOpenBookCap(BTC, 1);
        (,, uint8 kind) = _buy(qs, ss, none, 1e18, type(uint256).max);
        assertEq(kind, ob.KIND_POOL());
        pool.setOpenBookCap(BTC, 1e15);
        // a cancelled nonce: skipped
        vm.prank(maker);
        qb.cancel(1);
        (,, kind) = _buy(qs, ss, none, 1e18, type(uint256).max);
        assertEq(kind, ob.KIND_POOL());
    }

    // ---------------------------------------------------------------- 5. law 5 (owner's test)

    /// No OpenBook or Engine input lets the buyer choose σ or a price: σ only ever comes from a valid signed quote, an
    /// on-chain offer, or the board.
    function test_law5SigmaOnlyFromASignedQuoteAnOfferOrTheBoard() public {
        (,, uint256[] memory none) = _none();
        // 1. the Engine's priced entry is the router's alone: a buyer cannot call it with a σ of their own
        vm.prank(TRADER);
        vm.expectRevert(Engine.NotOpenBook.selector);
        engine.openFor(TRADER, BTC, _spread(), _day(), 1e18, 100, type(uint256).max, address(0));
        vm.prank(maker);
        vm.expectRevert(Engine.NotOpenBook.selector);
        engine.openFor(TRADER, BTC, _spread(), _day(), 1e18, 100, type(uint256).max, maker);
        // ...nor call the router's fill path directly with a made-up candidate
        OpenBook.Order memory o = OpenBook.Order(TRADER, BTC, _spread(), _day(), 1e18, type(uint256).max);
        OpenBook.Cand memory c = OpenBook.Cand(1, 0, 500, 0);
        vm.prank(TRADER);
        vm.expectRevert(OpenBook.NotSelf.selector);
        ob.fillOne(o, c, new VolQuote.Quote[](0), new bytes[](0), none);

        // 2. a quote whose σ was changed after signing (signed 60%, shown 5%) is never used: the pool fills at the board
        VolQuote.Quote memory q = _quote(maker, 6000, 1, 100e18);
        bytes memory sig = _sign(q, makerPk);
        q.sigmaBps = 500;
        (VolQuote.Quote[] memory qs, bytes[] memory ss) = _one(q, sig);
        vm.recordLogs();
        (uint256 id, uint256 cost, uint8 kind) = _buy(qs, ss, none, 1e18, type(uint256).max);
        assertEq(kind, ob.KIND_POOL());
        (uint256 p, uint256 f) = _cost(4500, 1e18);
        assertEq(cost, p + f, "priced at the board's 45%");
        assertEq(_boughtSigma(id), 4500);
        assertEq(qb.filled(maker, 1), 0);
        // and with the board stale, the forged quote alone fills nothing
        vols.setStale(true);
        vm.prank(TRADER);
        vm.expectRevert(OpenBook.NoSource.selector);
        ob.buy(BTC, _spread(), _day(), 1e18, type(uint256).max, nowT, qs, ss, none);
        vols.setStale(false);

        // 3. a valid quote fills at exactly its signed σ
        VolQuote.Quote memory good = _quote(maker, 4100, 2, 100e18);
        (qs, ss) = _one(good, _sign(good, makerPk));
        vm.recordLogs();
        (id, cost, kind) = _buy(qs, ss, none, 1e18, type(uint256).max);
        assertEq(kind, ob.KIND_QUOTE());
        (p, f) = _cost(4100, 1e18);
        assertEq(cost, p + f);
        assertEq(_boughtSigma(id), 4100);

        // 4. an offer fills at exactly its posted σ; the buyer names only its id
        uint256[] memory offers = new uint256[](1);
        offers[0] = _post(3900, 5e18);
        (VolQuote.Quote[] memory noQ, bytes[] memory noS,) = _none();
        vm.recordLogs();
        (id, cost, kind) = _buy(noQ, noS, offers, 1e18, type(uint256).max);
        assertEq(kind, ob.KIND_OFFER());
        (p, f) = _cost(3900, 1e18);
        assertEq(cost, p + f);
        assertEq(_boughtSigma(id), 3900);

        // 5. the buyer's only price input is a ceiling: maxCost refuses, it never sets the price
        vm.prank(TRADER);
        vm.expectRevert();
        ob.buy(BTC, _spread(), _day(), 1e18, 1, nowT, noQ, noS, none);
    }

    function _boughtSigma(uint256 id) internal returns (uint256 sigma) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == Engine.ShapeBought.selector && uint256(logs[i].topics[2]) == id) {
                (,,, sigma,,,) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, int256, uint256, uint256));
            }
        }
    }

    // ---------------------------------------------------------------- 6. matched end to end

    function test_aMakerFillEndToEndThenASellBuysItBack() public {
        VolQuote.Quote memory q = _quote(maker, 4000, 1, 100e18);
        (VolQuote.Quote[] memory qs, bytes[] memory ss) = _one(q, _sign(q, makerPk));
        (,, uint256[] memory none) = _none();
        uint256 stressed0 = pool.stressedLiability();
        (uint256 id,,) = _buy(qs, ss, none, 3e18, type(uint256).max);
        bytes32 key = keccak256(abi.encode(uint8(1), maker, uint256(0)));
        (uint256 raw,,, uint256 lockedU,,) = mb.entries(key, id);
        assertEq(raw, pool.matchedRawOf(id), "the MatchBook and the pool agree");
        assertEq(lockedU, 15_000e6, "exact collateral: 3 x the 5,000 width");
        assertEq(pool.stressedLiability(), stressed0, "the pool is flat");
        uint256 makerLockedBefore = vault.lockedOf(maker, IERC20(address(usdc)));
        vm.prank(TRADER);
        engine.sell(id, ALL, 0, nowT);
        assertEq(mb.matchedRaw(id), 0, "bought back");
        assertEq(pool.matchedRawOf(id), 0);
        assertLt(vault.lockedOf(maker, IERC20(address(usdc))), makerLockedBefore);
    }

    // ---------------------------------------------------------------- 7. law 1 fuzz with routed fills

    function testFuzz_routedRoundTripLosesAtMostWhatWasPaid(uint256 which, uint256 units, uint256 move) public {
        units = bound(units, 0.01e18, 20e18);
        move = bound(move, 9_000, 11_000);
        (VolQuote.Quote[] memory qs, bytes[] memory ss, uint256[] memory offers) = _none();
        uint256 k = which % 3;
        if (k == 1) {
            VolQuote.Quote memory q = _quote(maker, 3000, 1, 100e18);
            (qs, ss) = _one(q, _sign(q, makerPk));
        } else if (k == 2) {
            offers = new uint256[](1);
            offers[0] = _post(3000, 100e18);
        }
        uint256 start = usdc.balanceOf(TRADER);
        (uint256 id, uint256 cost, uint8 kind) = _buy(qs, ss, offers, units, type(uint256).max);
        assertEq(kind, k + 1);
        _set(nowT + 3 minutes);
        marks.set(BTC, S * move / 10_000);
        vm.prank(TRADER);
        (, uint256 net) = engine.sell(id, ALL, 0, nowT);
        assertEq(usdc.balanceOf(TRADER), start - cost + net);
        assertGe(usdc.balanceOf(TRADER) + cost, start, "never loses more than paid");
        assertEq(usdc.balanceOf(address(engine)), 0);
        assertEq(usdc.balanceOf(address(ob)), 0, "the router holds nothing");
    }

    // ---------------------------------------------------------------- 8. Engine setup; gas

    function test_openBookSetOnceAndGas() public {
        vm.expectRevert(Engine.OpenBookAlreadySet.selector);
        engine.setOpenBook(address(0x1234));
        (,, uint256[] memory none) = _none();
        (VolQuote.Quote[] memory noQ, bytes[] memory noS,) = _none();
        _buy(noQ, noS, none, 1e18, type(uint256).max); // warm
        uint256 g = gasleft();
        _buy(noQ, noS, none, 1e18, type(uint256).max);
        console2.log("routed pool fill", g - gasleft());
        VolQuote.Quote memory q = _quote(maker, 4000, 1, 100e18);
        (VolQuote.Quote[] memory qs, bytes[] memory ss) = _one(q, _sign(q, makerPk));
        g = gasleft();
        _buy(qs, ss, none, 1e18, type(uint256).max);
        console2.log("routed maker fill", g - gasleft());
        uint256[] memory offers = new uint256[](1);
        offers[0] = _post(3800, 10e18);
        g = gasleft();
        _buy(noQ, noS, offers, 1e18, type(uint256).max);
        console2.log("routed offer fill", g - gasleft());
    }

    // ---------------------------------------------------------------- 9. the vol feed (M6 step 8)

    /// Open-book fills are recorded (maker and offer, with the board's σ at the time); pool fills are not; the pool's
    /// price is unchanged by anything the feed holds.
    function test_volFeedRecordsOpenBookFillsAndNeverMovesThePoolPrice() public {
        (,, uint256[] memory none) = _none();
        (VolQuote.Quote[] memory noQ, bytes[] memory noS,) = _none();
        (, uint256 poolCostBefore,) = _buy(noQ, noS, none, 1e18, type(uint256).max);
        (,,, uint256 count,) = feed.read(BTC, 1);
        assertEq(count, 0, "a pool fill is not recorded");
        VolQuote.Quote memory q = _quote(maker, 4000, 1, 100e18);
        (VolQuote.Quote[] memory qs, bytes[] memory ss) = _one(q, _sign(q, makerPk));
        _buy(qs, ss, none, 2e18, type(uint256).max);
        uint256[] memory offers = new uint256[](1);
        offers[0] = _post(3800, 10e18);
        _buy(noQ, noS, offers, 1e18, type(uint256).max);
        (uint256 last, uint256 avg, uint256 board, uint256 n,) = feed.read(BTC, 1);
        assertEq(n, 2, "a maker fill and an offer fill");
        assertEq(last, 3800);
        assertEq(board, 4500, "the board's sigma at the fill");
        assertEq(avg, (uint256(4000) * 140_000e6 + uint256(3800) * 70_000e6) / 210_000e6, "weighted by notional");
        // the pool still prices at the board
        (, uint256 poolCostAfter, uint8 kind) = _buy(noQ, noS, none, 1e18, type(uint256).max);
        assertEq(kind, ob.KIND_POOL());
        assertEq(poolCostAfter, poolCostBefore);
    }

    function test_aFailingFeedNeverBlocksAFillAndTheFeedIsSetOnce() public {
        (,, uint256[] memory none) = _none();
        vm.mockCallRevert(address(feed), abi.encodeWithSelector(VolFeed.record.selector), "feed down");
        VolQuote.Quote memory q = _quote(maker, 4000, 1, 100e18);
        (VolQuote.Quote[] memory qs, bytes[] memory ss) = _one(q, _sign(q, makerPk));
        (,, uint8 kind) = _buy(qs, ss, none, 1e18, type(uint256).max);
        assertEq(kind, ob.KIND_QUOTE(), "filled anyway");
        vm.clearMockedCalls();
        vm.expectRevert(OpenBook.AlreadySet.selector);
        ob.setVolFeed(feed);
        vm.prank(TRADER);
        vm.expectRevert(OpenBook.NotAdmin.selector);
        ob.setVolFeed(VolFeed(address(0x1234)));
    }
}
