// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MainspringPoolBase} from "./MainspringPool.t.sol";
import {MainspringPool} from "../src/MainspringPool.sol";
import {EnginePricing} from "../src/EnginePricing.sol";
import {TempoBlend} from "../src/TempoBlend.sol";
import {StrategyMath} from "../src/StrategyMath.sol";
import {VolQuoteBook} from "../src/VolQuote.sol";
import {MakerVault} from "../src/MakerVault.sol";
import {MatchBook} from "../src/MatchBook.sol";
import {OpenBook, IEngineOpenFor} from "../src/OpenBook.sol";
import {RiskAuction, IAuctionPool, IAuctionRouter} from "../src/RiskAuction.sol";
import {IEngineConfig} from "../src/WriterBook.sol";
import {MockWHYPE} from "./mocks/MockWHYPE.sol";
import {MockMarks} from "./Engine.t.sol";

/// Pricing in its own call frame (keeps the tests' stacks shallow).
contract SlicePricer {
    function price(StrategyMath.Leg[] memory legs, uint256 s, uint256 units, uint256 sigma, bool up)
        external
        pure
        returns (uint256)
    {
        int256 v = EnginePricing.shapeValue(legs, s, sigma, TempoBlend.single(1 days), up);
        uint256 w = Math.mulDiv(units, uint256(v), 1e18, up ? Math.Rounding.Ceil : Math.Rounding.Floor);
        return up ? Math.ceilDiv(w, 1e12) : w / 1e12;
    }
}

/// M6 step 9: the weekly sealed risk auction, on the full stack.
contract RiskAuctionTest is MainspringPoolBase {
    uint256 constant S = 70_000e18;
    MockWHYPE whype;
    MakerVault vault;
    MatchBook mb;
    OpenBook ob;
    RiskAuction ra;
    address[3] mk = [address(0x4D1), address(0x4D2), address(0x4D3)];

    function setUp() public override {
        super.setUp();
        _seed(10_000_000e6);
        whype = new MockWHYPE();
        vault = new MakerVault(address(this), IERC20(address(usdc)), IERC20(address(whype)));
        mb = new MatchBook(address(this), book, IEngineConfig(address(engine)), vault, marks, vols);
        address obAt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        VolQuoteBook qb = new VolQuoteBook(obAt);
        ob = new OpenBook(IEngineOpenFor(address(engine)), IEngineConfig(address(engine)), marks, vols, qb, mb);
        ra = new RiskAuction(book, IAuctionPool(address(pool)), IAuctionRouter(address(ob)), vault, marks, vols);
        engine.setOpenBook(address(ob));
        mb.setRouter(address(ob));
        mb.setPool(address(pool));
        vault.setMatchBook(address(mb));
        vault.setAuction(address(ra));
        pool.setMatchBook(address(mb));
        vm.expectEmit(address(pool));
        emit MainspringPool.AuctionSet(address(ra)); // the wiring is visible to monitoring
        pool.setAuction(address(ra));
        vm.expectEmit(address(ob));
        emit OpenBook.AuctionSet(address(ra));
        ob.setAuction(address(ra));
        pool.setOpenBookCap(BTC, 1e15);
        for (uint256 i; i < 3; ++i) {
            usdc.mint(mk[i], 50_000_000e6);
            vm.startPrank(mk[i]);
            usdc.approve(address(vault), type(uint256).max);
            vault.deposit(IERC20(address(usdc)), 20_000_000e6);
            vm.stopPrank();
        }
    }

    // ---------------------------------------------------------------- helpers

    function _spread(uint256 k1, uint256 k2) internal pure returns (StrategyMath.Leg[] memory l) {
        l = new StrategyMath.Leg[](2);
        l[0] = StrategyMath.Leg(true, uint128(k1), 1e18);
        l[1] = StrategyMath.Leg(true, uint128(k2), -1e18);
    }

    function _day() internal pure returns (TempoBlend.Part[] memory) {
        return TempoBlend.single(1 days);
    }

    function _poolSells(StrategyMath.Leg[] memory legs, uint256 units) internal returns (uint256 id) {
        vm.prank(TRADER);
        (id,) = engine.buyShape(BTC, legs, _day(), units, ALL, nowT);
    }

    function _hash(uint256 lotId, address bidder, uint64 sigma) internal pure returns (bytes32) {
        return keccak256(abi.encode(lotId, bidder, sigma, bytes32(uint256(uint160(bidder)))));
    }

    function _commit(uint256 lotId, uint256 i, uint64 sigma) internal {
        bytes32 h = _hash(lotId, mk[i], sigma); // computed first: a call inside the arguments would use up the prank
        vm.prank(mk[i]);
        ra.commit(lotId, h);
    }

    function _reveal(uint256 lotId, uint256 i, uint64 sigma) internal {
        vm.prank(mk[i]);
        ra.reveal(lotId, sigma, bytes32(uint256(uint160(mk[i]))));
    }

    function _locked(uint256 i) internal view returns (uint256) {
        return vault.lockedOf(mk[i], IERC20(address(usdc)));
    }

    SlicePricer pricer;

    function _price(StrategyMath.Leg[] memory legs, uint256 units, uint256 sigma, bool up) internal returns (uint256) {
        if (address(pricer) == address(0)) pricer = new SlicePricer();
        return pricer.price(legs, S, units, sigma, up);
    }

    // ---------------------------------------------------------------- 1. the lot

    function test_lotIsTheLargestCarriedNotionalCappedAndWeekly() public {
        _poolSells(_spread(70_000e18, 75_000e18), 5e18); // 350,000 notional
        uint256 big = _poolSells(_spread(72_000e18, 76_000e18), 10e18); // 700,000
        vm.prank(TRADER);
        engine.buy(BTC, true, 70_000e18, _day(), 20e18, ALL, nowT); // 1,400,000, but a naked short call: not auctionable
        uint256 lotId = ra.start(BTC);
        RiskAuction.Lot memory l = ra.lot(lotId);
        assertEq(l.seriesId, big, "the largest carried notional a writer can collateralise");
        assertEq(l.raw, 10e18);
        // bond: 5% of the worst case (the 4,000 width x 10)
        assertEq(l.bond, 2_000e6);
        // once a week per market
        vm.expectRevert(abi.encodeWithSelector(RiskAuction.TooSoon.selector, nowT + 7 days));
        ra.start(BTC);
    }

    function test_aLotIsCappedAtOneMillionOfNotional() public {
        uint256 id = _poolSells(_spread(72_000e18, 76_000e18), 20e18); // 1,400,000 carried
        RiskAuction.Lot memory l = ra.lot(ra.start(BTC));
        assertEq(l.seriesId, id);
        uint256 units = Math.mulDiv(l.raw, book.normNow(id), 1e18);
        assertApproxEqRel(Math.mulDiv(units, S, 1e18) / 1e12, 1_000_000e6, 1e12, "capped at $1M");
        assertLt(l.raw, 20e18);
    }

    // ---------------------------------------------------------------- 2–3. commit, reveal, settle; bonds

    function test_sealedBidsLowestSigmaWinsBondsAndSettlement() public {
        StrategyMath.Leg[] memory legs = _spread(72_000e18, 76_000e18);
        uint256 id = _poolSells(legs, 10e18);
        uint256 lotId = ra.start(BTC);
        uint256 bond = ra.lot(lotId).bond;
        _commit(lotId, 0, 4000);
        _commit(lotId, 1, 3500);
        _commit(lotId, 2, 3000); // never revealed
        assertEq(_locked(0), bond, "bond locked at commit");
        vm.prank(mk[0]);
        vm.expectRevert(abi.encodeWithSelector(RiskAuction.AlreadyCommitted.selector, lotId));
        ra.commit(lotId, bytes32(uint256(1)));
        // reveal only after the commit window; a wrong σ refused
        vm.prank(mk[0]);
        vm.expectRevert(abi.encodeWithSelector(RiskAuction.NotOpen.selector, lotId));
        ra.reveal(lotId, 4000, bytes32(uint256(uint160(mk[0]))));
        _set(nowT + 3 days + 1);
        vm.prank(mk[0]);
        vm.expectRevert(abi.encodeWithSelector(RiskAuction.BadReveal.selector, lotId));
        ra.reveal(lotId, 4100, bytes32(uint256(uint160(mk[0]))));
        _reveal(lotId, 0, 4000);
        _reveal(lotId, 1, 3500);
        vm.expectRevert(abi.encodeWithSelector(RiskAuction.NotOpen.selector, lotId));
        ra.settle(lotId);
        // after the reveal window, fresh sources
        _set(nowT + 1 days);
        marks.set(BTC, S);
        book.record(BTC, S, 4500);
        book.accrue(id, type(uint256).max);
        uint256 units = Math.mulDiv(10e18, book.normNow(id), 1e18);
        uint256 price = _price(legs, units, 3500, false);
        uint256 poolBefore = usdc.balanceOf(address(pool));
        uint256 winnerBefore = usdc.balanceOf(mk[1]);
        ra.settle(lotId);
        RiskAuction.Lot memory l = ra.lot(lotId);
        assertEq(l.winner, mk[1], "the lowest revealed sigma");
        assertEq(l.price, price);
        assertEq(usdc.balanceOf(mk[1]) - winnerBefore, price, "the pool pays the winner its price");
        // bonds: the loser's released, the unrevealed one paid to the pool, the winner's replaced by exact collateral
        assertEq(_locked(0), 0);
        assertEq(_locked(2), 0);
        assertEq(usdc.balanceOf(address(pool)), poolBefore - price + bond, "the unrevealed bond went to the pool");
        bytes32 key = keccak256(abi.encode(uint8(1), mk[1], uint256(0)));
        (uint256 raw,,, uint256 lockedU,,) = mb.entries(key, id);
        assertEq(raw, 10e18);
        assertEq(
            lockedU, Math.ceilDiv(Math.mulDiv(units, 4_000e18, 1e18, Math.Rounding.Ceil), 1e12), "exact collateral"
        );
        assertEq(pool.matchedRawOf(id), 10e18, "the pool no longer carries it");
        vm.expectRevert(abi.encodeWithSelector(RiskAuction.Closed.selector, lotId));
        ra.settle(lotId);
    }

    function test_settlementMovesNavAndLaterStressAndASellBuysBackFromTheWinner() public {
        StrategyMath.Leg[] memory legs = _spread(72_000e18, 76_000e18);
        uint256 id = _poolSells(legs, 10e18);
        uint256 lotId = ra.start(BTC);
        _commit(lotId, 0, 4200);
        _set(nowT + 3 days + 1);
        _reveal(lotId, 0, 4200);
        _set(nowT + 1 days);
        marks.set(BTC, S);
        book.record(BTC, S, 4500);
        book.accrue(id, type(uint256).max);
        // an epoch first, so the carried raw's values are fresh
        pool.startEpoch();
        while (!pool.markChunk(100)) {}
        pool.settle();
        uint256 stressed0 = pool.stressedLiability();
        uint256 nav0 = pool.navNow();
        uint256 units = Math.mulDiv(10e18, book.normNow(id), 1e18);
        uint256 price = _price(legs, units, 4200, false);
        uint256 base = _price(legs, units, 4500, true); // the pool's value of the slice at the board, USDC
        ra.settle(lotId);
        // NAV: the pool stops carrying the slice (its value at the board) and pays the winner's price
        int256 d = int256(pool.navNow()) - int256(nav0);
        assertApproxEqAbs(d, int256(base) - int256(price), 2);
        assertEq(pool.stressedLiability(), stressed0, "stress drops at the next epoch, not before (conservative)");
        _set(nowT + 1 hours);
        pool.startEpoch();
        while (!pool.markChunk(100)) {}
        assertLt(pool.stressedLiability(), stressed0, "the next epoch no longer counts the slice");
        // the trader sells: the winner buys back
        vm.prank(TRADER);
        engine.sell(id, ALL, 0, nowT);
        assertEq(mb.matchedRaw(id), 0);
    }

    // ---------------------------------------------------------------- 4. the reserve

    function test_aBidAboveTheReserveFillsNothingAndBondsComeBack() public {
        uint256 id = _poolSells(_spread(72_000e18, 76_000e18), 10e18);
        uint256 lotId = ra.start(BTC);
        _commit(lotId, 0, 20_000); // 200%: priced far above the pool's value at 45% x 1.10
        _commit(lotId, 1, 25_000);
        _set(nowT + 3 days + 1);
        _reveal(lotId, 0, 20_000);
        _reveal(lotId, 1, 25_000);
        _set(nowT + 1 days);
        marks.set(BTC, S);
        book.record(BTC, S, 4500);
        ra.settle(lotId);
        assertEq(ra.lot(lotId).winner, address(0));
        assertEq(_locked(0), 0);
        assertEq(_locked(1), 0);
        assertEq(pool.matchedRawOf(id), 0, "still the pool's");
    }

    // ---------------------------------------------------------------- 5. a winner who cannot collateralise

    function test_aWinnerWithoutCollateralForfeitsAndTheNextWinsOnlyWithinTheReserve() public {
        StrategyMath.Leg[] memory legs = _spread(72_000e18, 76_000e18);
        _poolSells(legs, 10e18);
        uint256 lotId = ra.start(BTC);
        uint256 bond = ra.lot(lotId).bond;
        _commit(lotId, 0, 3500); // the lowest, but will empty its vault
        _commit(lotId, 1, 4000);
        _set(nowT + 3 days + 1);
        _reveal(lotId, 0, 3500);
        _reveal(lotId, 1, 4000);
        uint256 free0 = vault.freeOf(mk[0], IERC20(address(usdc)));
        vm.prank(mk[0]);
        vault.withdraw(IERC20(address(usdc)), free0);
        _set(nowT + 1 days);
        marks.set(BTC, S);
        book.record(BTC, S, 4500);
        uint256 poolBefore = usdc.balanceOf(address(pool));
        ra.settle(lotId);
        assertEq(ra.lot(lotId).winner, mk[1], "the next revealed bid, within the reserve");
        assertEq(_locked(0), 0);
        assertEq(vault.freeOf(mk[0], IERC20(address(usdc))), 0, "maker 0's bond went to the pool");
        assertEq(usdc.balanceOf(address(pool)), poolBefore + bond - ra.lot(lotId).price);

        // the same, but the next bid is above the reserve: no fill
        _set(nowT + 7 days);
        marks.set(BTC, S);
        book.record(BTC, S, 4500);
        _poolSells(_spread(70_000e18, 76_000e18), 20e18); // a new largest carried series
        lotId = ra.start(BTC);
        vm.prank(mk[0]);
        vault.deposit(IERC20(address(usdc)), 1_000_000e6); // maker 0 funds its vault again
        _commit(lotId, 2, 3500);
        _commit(lotId, 0, 30_000);
        _set(nowT + 3 days + 1);
        _reveal(lotId, 2, 3500);
        _reveal(lotId, 0, 30_000);
        uint256 free2 = vault.freeOf(mk[2], IERC20(address(usdc)));
        vm.prank(mk[2]);
        vault.withdraw(IERC20(address(usdc)), free2);
        _set(nowT + 1 days);
        marks.set(BTC, S);
        book.record(BTC, S, 4500);
        ra.settle(lotId);
        assertEq(ra.lot(lotId).winner, address(0), "the next bid was above the reserve");
        assertEq(_locked(0), 0, "its bond released");
    }

    // ---------------------------------------------------------------- 6–7. law 2; ties

    function test_settleWaitsForFreshSourcesAndTiesGoToTheEarlierCommit() public {
        _poolSells(_spread(72_000e18, 76_000e18), 10e18);
        uint256 lotId = ra.start(BTC);
        _commit(lotId, 1, 4000);
        _commit(lotId, 0, 4000); // same σ, later commit
        _set(nowT + 3 days + 1);
        _reveal(lotId, 0, 4000);
        _reveal(lotId, 1, 4000);
        _set(nowT + 1 days);
        marks.setStale(true);
        vm.expectRevert(abi.encodeWithSelector(MockMarks.Stale.selector, BTC));
        ra.settle(lotId);
        marks.setStale(false);
        marks.set(BTC, S);
        book.record(BTC, S, 4500);
        ra.settle(lotId);
        assertEq(ra.lot(lotId).winner, mk[1], "the earlier commit");
    }

    // ---------------------------------------------------------------- 8. gas

    function test_auctionGas() public {
        _poolSells(_spread(70_000e18, 75_000e18), 5e18);
        _poolSells(_spread(72_000e18, 76_000e18), 10e18);
        uint256 g = gasleft();
        uint256 lotId = ra.start(BTC);
        console2.log("start (2 series)", g - gasleft());
        bytes32 h = _hash(lotId, mk[0], 4000);
        g = gasleft();
        vm.prank(mk[0]);
        ra.commit(lotId, h);
        console2.log("commit", g - gasleft());
        _commit(lotId, 1, 4500);
        _set(nowT + 3 days + 1);
        g = gasleft();
        _reveal(lotId, 0, 4000);
        console2.log("reveal", g - gasleft());
        _reveal(lotId, 1, 4500);
        _set(nowT + 1 days);
        marks.set(BTC, S);
        book.record(BTC, S, 4500);
        g = gasleft();
        ra.settle(lotId);
        console2.log("settle (2 bidders)", g - gasleft());
    }
}
