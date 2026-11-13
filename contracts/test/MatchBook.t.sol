// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PathFundingBook, IMarkRouter, IVolSource} from "../src/PathFundingBook.sol";
import {TempoBlend} from "../src/TempoBlend.sol";
import {StrategyMath} from "../src/StrategyMath.sol";
import {EnginePricing} from "../src/EnginePricing.sol";
import {MakerVault} from "../src/MakerVault.sol";
import {MatchBook, IMatchPool} from "../src/MatchBook.sol";
import {IEngineConfig} from "../src/WriterBook.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockWHYPE} from "./mocks/MockWHYPE.sol";
import {MockMarks, MockVols} from "./Engine.t.sol";

contract MockEngineConfig is IEngineConfig {
    function markets(bytes32 m) external pure returns (bool, uint16, uint128) {
        if (m == "BTC") return (true, 200, 100e18);
        if (m == "HYPE") return (true, 200, 1e18);
        return (false, 0, 0);
    }

    function buysPaused() external pure returns (bool) {
        return false;
    }
}

/// Plays the pool: receives buybacks, can refuse an early close, and calls the MatchBook's pool-only buyback.
contract MockPool is IMatchPool {
    MatchBook public mb;
    bool public refuse;
    uint256 public lastRaw;
    int256 public lastCost;

    error Refused();

    function setBook(MatchBook mb_) external {
        mb = mb_;
    }

    function setRefuse(bool r) external {
        refuse = r;
    }

    function buyback(uint256 sid, uint256 rawSold, uint256 gross, uint256 s)
        external
        returns (uint256, uint256, uint256)
    {
        return mb.buyback(sid, rawSold, gross, s);
    }

    function onEarlyClose(bytes32, uint256, uint256 raw, uint256, uint256, uint256, int256 cost, uint256, address)
        external
    {
        if (refuse) revert Refused();
        lastRaw = raw;
        lastCost = cost;
    }
}

/// M6 step 4: the MatchBook.
contract MatchBookTest is Test {
    uint256 constant T0 = 1_794_182_400;
    bytes32 constant BTC = "BTC";
    bytes32 constant HYPE = "HYPE";
    address constant ADMIN = address(0xAD);
    address constant WRITER = address(0x3317);

    MockUSDC usdc;
    MockWHYPE whype;
    MockMarks marks;
    MockVols vols;
    PathFundingBook book;
    MakerVault vault;
    MatchBook mb;
    MockPool pool;
    address[9] makers;
    uint256 nowT;

    function _set(uint256 t) internal {
        nowT = t;
        vm.warp(t);
    }

    function setUp() public {
        _set(T0);
        usdc = new MockUSDC();
        whype = new MockWHYPE();
        marks = new MockMarks();
        vols = new MockVols();
        marks.set(BTC, 70_000e18);
        marks.set(HYPE, 40e18);
        vols.set(BTC, 4500);
        vols.set(HYPE, 8000);
        // the test plays the Engine (it opens series) and the recorder
        book = new PathFundingBook(address(this), address(this), marks, vols);
        book.record(BTC, 70_000e18, 4500);
        book.record(HYPE, 40e18, 8000);
        vault = new MakerVault(ADMIN, IERC20(address(usdc)), IERC20(address(whype)));
        pool = new MockPool();
        mb = new MatchBook(ADMIN, book, new MockEngineConfig(), vault, marks, vols);
        pool.setBook(mb);
        vm.startPrank(ADMIN);
        vault.setMatchBook(address(mb));
        mb.setRouter(address(this)); // the test plays the router
        mb.setPool(address(pool));
        vm.stopPrank();
        for (uint256 i; i < 9; ++i) {
            makers[i] = address(uint160(0x4D00 + i));
            usdc.mint(makers[i], 10_000_000e6);
            whype.mint(makers[i], 100_000e18);
            vm.startPrank(makers[i]);
            usdc.approve(address(vault), type(uint256).max);
            whype.approve(address(vault), type(uint256).max);
            vault.deposit(IERC20(address(usdc)), 1_000_000e6);
            vault.deposit(IERC20(address(whype)), 10_000e18);
            vm.stopPrank();
        }
        usdc.mint(WRITER, 10_000_000e6);
        whype.mint(WRITER, 100_000e18);
        vm.startPrank(WRITER);
        usdc.approve(address(mb), type(uint256).max);
        whype.approve(address(mb), type(uint256).max);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- helpers

    function _u() internal view returns (IERC20) {
        return IERC20(address(usdc));
    }

    function _h() internal view returns (IERC20) {
        return IERC20(address(whype));
    }

    function _leg(bool isCall, uint256 k, int256 q) internal pure returns (StrategyMath.Leg memory) {
        return StrategyMath.Leg(isCall, uint128(k), int128(q));
    }

    /// The buyer's (holder's) call spread 70,000 / 75,000: the writer's worst case is the 5,000 width.
    function _spread() internal pure returns (StrategyMath.Leg[] memory l) {
        l = new StrategyMath.Leg[](2);
        l[0] = _leg(true, 70_000e18, 1e18);
        l[1] = _leg(true, 75_000e18, -1e18);
    }

    function _condor() internal pure returns (StrategyMath.Leg[] memory l) {
        l = new StrategyMath.Leg[](4);
        l[0] = _leg(true, 65_000e18, 1e18);
        l[1] = _leg(true, 70_000e18, -1e18);
        l[2] = _leg(true, 75_000e18, -1e18);
        l[3] = _leg(true, 80_000e18, 1e18);
    }

    function _day() internal pure returns (TempoBlend.Part[] memory) {
        return TempoBlend.single(1 days);
    }

    function _spreadSeries() internal returns (uint256) {
        return book.openShape(BTC, _spread(), _day());
    }

    /// Pure: an external read here would use up a pending prank.
    function _key(address maker) internal pure returns (bytes32) {
        return keccak256(abi.encode(uint8(1), maker, uint256(0))); // KIND_MAKER
    }

    function _locked(address m) internal view returns (uint256) {
        return vault.lockedOf(m, _u());
    }

    function _entry(bytes32 key, uint256 sid) internal view returns (uint256 raw, uint256 u, uint256 h, bool flagged) {
        (raw,,, u, h, flagged) = mb.entries(key, sid);
    }

    // ---------------------------------------------------------------- 1. law 4 per source

    function test_exactCollateralPerSource() public {
        uint256 sp = _spreadSeries();
        mb.matchMaker(makers[0], sp, 2e18, 2e18);
        assertEq(_locked(makers[0]), 10_000e6, "2 x the 5,000 width");
        uint256 co = book.openShape(BTC, _condor(), _day());
        mb.matchMaker(makers[1], co, 3e18, 3e18);
        assertEq(_locked(makers[1]), 15_000e6, "the condor's 5,000 wing x 3");
        uint256 put = book.open(BTC, false, 70_000e18, _day());
        mb.matchMaker(makers[2], put, 0.5e18, 0.5e18);
        assertEq(_locked(makers[2]), 35_000e6, "a written put locks its strike");
        // a HYPE call: covered by the maker's WHYPE, no USDC
        uint256 hc = book.open(HYPE, true, 44e18, _day());
        mb.matchMaker(makers[3], hc, 10e18, 10e18);
        assertEq(_locked(makers[3]), 0);
        assertEq(vault.lockedOf(makers[3], _h()), 10e18);
        // a BTC call: a naked short call for the maker, refused (law 4)
        uint256 bc = book.open(BTC, true, 70_000e18, _day());
        vm.expectRevert(StrategyMath.Unbounded.selector);
        mb.matchMaker(makers[4], bc, 1e18, 1e18);
        // not enough free funds in the vault: refused
        vm.expectRevert(
            abi.encodeWithSelector(MakerVault.InsufficientFree.selector, 1_000_005e6, 1_000_000e6 - 10_000e6)
        );
        mb.matchMaker(makers[0], sp, 200.001e18, 200.001e18);
        // router only
        vm.prank(address(0xBAD));
        vm.expectRevert(MatchBook.NotRouter.selector);
        mb.matchMaker(makers[0], sp, 1e18, 1e18);
        assertEq(mb.matchedRaw(sp), 2e18);
    }

    // ---------------------------------------------------------------- 2. buyback across sources; 8 at most

    function test_buybackProRataAllEightSourcesAndANinthRefused() public {
        uint256 sid = _spreadSeries();
        uint256 total;
        for (uint256 i; i < 8; ++i) {
            uint256 units = (i + 1) * 0.25e18;
            mb.matchMaker(makers[i], sid, units, units);
            total += units;
        }
        assertEq(mb.matchedRaw(sid), total);
        assertEq(mb.seriesSources(sid).length, 8);
        // a 9th distinct source on the series is refused; an existing source may add more
        vm.expectRevert(abi.encodeWithSelector(MatchBook.TooManySources.selector, sid));
        mb.matchMaker(makers[8], sid, 1e18, 1e18);
        mb.matchMaker(makers[0], sid, 0.25e18, 0.25e18);
        total += 0.25e18;

        // a sell of half the matched raw at 3,000 USDC per raw: each source pays pro rata at the seller's price
        uint256 rawSold = total / 2;
        uint256 gross = Math.mulDiv(rawSold, 3_000e6, 1e18);
        uint256[8] memory lockedBefore;
        uint256[8] memory rawBefore;
        for (uint256 i; i < 8; ++i) {
            lockedBefore[i] = _locked(makers[i]);
            (rawBefore[i],,,) = _entry(_key(makers[i]), sid);
        }
        (uint256 paid,, uint256 shortfall) = pool.buyback(sid, rawSold, gross, 70_000e18);
        assertEq(shortfall, 0);
        assertEq(usdc.balanceOf(address(pool)), paid);
        assertGe(paid, gross - 8, "every source paid its share (rounded up for the pool)");
        assertLe(paid, gross + 8);
        for (uint256 i; i < 8; ++i) {
            (uint256 rawAfter,,,) = _entry(_key(makers[i]), sid);
            uint256 rc = Math.mulDiv(rawSold, rawBefore[i], total);
            assertEq(rawBefore[i] - rawAfter, rc, "pro rata");
            uint256 part = Math.mulDiv(lockedBefore[i], rc, rawBefore[i]);
            assertEq(_locked(makers[i]), lockedBefore[i] - part, "the released part leaves the lock");
        }

        // a sell larger than every matched unit closes them all, from all 8 sources, in one transaction
        uint256 left = mb.matchedRaw(sid);
        pool.buyback(sid, left * 3, Math.mulDiv(left * 3, 3_000e6, 1e18), 70_000e18);
        assertEq(mb.matchedRaw(sid), 0);
        assertEq(mb.seriesSources(sid).length, 0);
        for (uint256 i; i < 8; ++i) {
            assertEq(_locked(makers[i]), 0, "nothing left locked");
        }
        // only the pool calls buyback
        vm.expectRevert(MatchBook.NotPool.selector);
        mb.buyback(sid, 1, 1, 70_000e18);
        // now a 9th maker fits
        mb.matchMaker(makers[8], sid, 1e18, 1e18);
    }

    // ---------------------------------------------------------------- 3. shortfall: vault, then pool; flagged

    /// Forced with a gross above the worst case (impossible in real trading, where a value never exceeds the payoff's
    /// maximum): the vault's free funds are slashed, then the pool absorbs; the source is flagged and its remaining raw
    /// counts as uncovered.
    function test_shortfallSlashesTheVaultThenThePoolAndFlags() public {
        uint256 sid = _spreadSeries();
        mb.matchMaker(makers[0], sid, 2e18, 2e18); // locks 10,000
        mb.matchMaker(makers[1], sid, 2e18, 2e18);
        // maker 0 keeps only 500 USDC free
        uint256 free0 = vault.freeOf(makers[0], _u());
        vm.prank(makers[0]);
        vault.withdraw(_u(), free0 - 500e6);
        uint256 freeH = vault.freeOf(makers[0], _h()); // read first: a call inside the arguments would use up the prank
        vm.prank(makers[0]);
        vault.withdraw(_h(), freeH);
        // sell 2 raw at 6,000 per raw: each source owes 6,000 for 1 raw but released only 5,000
        (uint256 paid,, uint256 shortfall) = pool.buyback(sid, 2e18, 12_000e6, 70_000e18);
        // maker 0: 5,000 from the lock + 500 slashed; 500 short. Maker 1: 5,000 + 1,000 slashed
        assertEq(shortfall, 500e6);
        assertEq(paid, 11_500e6);
        (uint256 raw0,,, bool flagged0) = _entry(_key(makers[0]), sid);
        (uint256 raw1,,, bool flagged1) = _entry(_key(makers[1]), sid);
        assertTrue(flagged0);
        assertFalse(flagged1);
        assertEq(mb.uncoveredRaw(sid), raw0, "maker 0's remaining raw is uncovered from now on");
        assertEq(mb.matchedRaw(sid), raw1);
        assertEq(vault.freeOf(makers[0], _u()), 0);
        // a flagged source takes no new matches on the series; the next buyback skips it
        vm.expectRevert(abi.encodeWithSelector(MatchBook.SourceFlagged.selector, _key(makers[0])));
        mb.matchMaker(makers[0], sid, 1e18, 1e18);
        pool.buyback(sid, 10e18, 30_000e6, 70_000e18);
        assertEq(mb.matchedRaw(sid), 0);
        assertEq(mb.uncoveredRaw(sid), raw0);
    }

    /// Rounding is not a default (owner, M6 step 7): on a writer offer (no vault to slash), a shortfall of 1 micro-USDC
    /// is absorbed by the pool with an event and nothing flagged; 2 micro-USDC triggers the backstop.
    function test_aOneUnitShortfallIsAbsorbedATwoUnitOneIsNot() public {
        uint256 sid = _spreadSeries();
        vm.prank(WRITER);
        uint256 id = mb.postOffer(BTC, _writerSpread(), _day(), 4200, 10e18, uint64(nowT + 1 hours), false);
        (bytes32 key,) = mb.fillOffer(id, sid, 2e18, 2e18); // locks exactly 10,000
        // 1 raw at 5,000 + 1 micro: the released 5,000 falls 1 short
        vm.expectEmit(true, true, false, true, address(mb));
        emit MatchBook.DustAbsorbed(key, sid, 1);
        (,, uint256 sf) = pool.buyback(sid, 1e18, 5_000e6 + 1, 70_000e18);
        assertEq(sf, 1);
        (uint256 raw,,, bool flagged) = _entry(key, sid);
        assertFalse(flagged, "rounding is not a default");
        assertEq(raw, 1e18);
        assertEq(mb.uncoveredRaw(sid), 0);
        // the next raw at 5,000 + 2 micro: a real shortfall, the backstop
        pool.buyback(sid, 0.5e18, 2_500e6 + 1, 70_000e18); // 0.5 raw: due 2,500 + 1 vs 2,500 released, absorbed
        (raw,,, flagged) = _entry(key, sid);
        assertFalse(flagged);
        (,, sf) = pool.buyback(sid, 0.5e18, 2_500e6 + 2, 70_000e18);
        assertEq(sf, 2);
        (raw,,, flagged) = _entry(key, sid);
        assertTrue(flagged);
    }

    // ---------------------------------------------------------------- 4. claims

    function test_claimsReleaseWhatDecayFreed() public {
        uint256 sid = _spreadSeries();
        mb.matchMaker(makers[0], sid, 4e18, 4e18);
        uint256 freeBefore = vault.freeOf(makers[0], _u());
        for (uint256 i = 1; i <= 120; ++i) {
            _set(nowT + 5 minutes);
            book.record(BTC, 70_000e18 + (i % 5) * 50e18, 4500);
        }
        book.accrue(sid, type(uint256).max);
        (uint256 reqU,) = mb.required(_key(makers[0]), sid);
        assertLt(reqU, 20_000e6, "decayed");
        vm.prank(makers[0]);
        (uint256 out,) = mb.claim(_key(makers[0]), sid);
        assertEq(out, 20_000e6 - reqU);
        assertEq(vault.freeOf(makers[0], _u()) - freeBefore, out, "back to the vault's free balance");
        assertEq(_locked(makers[0]), reqU);
        vm.prank(address(0xBAD));
        vm.expectRevert(MatchBook.NotOwner.selector);
        mb.claim(_key(makers[0]), sid);
    }

    // ---------------------------------------------------------------- 5. writer offers

    function _writerSpread() internal pure returns (StrategyMath.Leg[] memory l) {
        l = new StrategyMath.Leg[](2);
        l[0] = _leg(true, 70_000e18, -1e18);
        l[1] = _leg(true, 75_000e18, 1e18);
    }

    function test_offersPostFillCancel() public {
        vm.prank(WRITER);
        uint256 id = mb.postOffer(BTC, _writerSpread(), _day(), 4200, 10e18, uint64(nowT + 1 hours), false);
        (,, uint256 sid,,,,,,,,,, uint256 escrowU,) = mb.offers(id);
        assertEq(sid, book.idOfShape(BTC, _spread(), _day()), "the pool's side is the buyer's spread");
        assertEq(escrowU, 50_000e6 + 64, "10 x 5,000 plus the rounding slack");
        assertEq(usdc.balanceOf(address(mb)), escrowU);
        assertEq(mb.heldUsdc(), escrowU);

        book.openShape(BTC, _spread(), _day());
        (bytes32 key, uint64 sigma) = mb.fillOffer(id, sid, 3e18, 3e18);
        assertEq(sigma, 4200);
        (uint256 raw, uint256 lockedU,,) = _entry(key, sid);
        assertEq(raw, 3e18);
        assertEq(lockedU, 15_000e6);
        // more than is left, the wrong series, after expiry: refused
        vm.expectRevert(abi.encodeWithSelector(MatchBook.OfferTooSmall.selector, id, 7e18));
        mb.fillOffer(id, sid, 8e18, 8e18);
        vm.expectRevert(abi.encodeWithSelector(MatchBook.OfferSeries.selector, id, 123));
        mb.fillOffer(id, 123, 1e18, 1e18);
        // a buyback pays the pool from the offer's collateral here and returns the rest to the writer
        uint256 writerBefore = usdc.balanceOf(WRITER);
        pool.buyback(sid, 1e18, 3_000e6, 70_000e18);
        assertEq(usdc.balanceOf(address(pool)), 3_000e6);
        assertEq(usdc.balanceOf(WRITER) - writerBefore, 2_000e6, "the 5,000 released less the 3,000 paid");
        // the writer cancels: the unfilled escrow comes back; the filled part stays matched
        writerBefore = usdc.balanceOf(WRITER);
        vm.prank(WRITER);
        mb.cancelOffer(id);
        assertEq(usdc.balanceOf(WRITER) - writerBefore, 35_000e6 + 64);
        (raw, lockedU,,) = _entry(key, sid);
        assertEq(raw, 2e18);
        assertEq(lockedU, 10_000e6);
        assertEq(usdc.balanceOf(address(mb)), mb.heldUsdc(), "the book holds exactly what it accounts for");
        vm.expectRevert(abi.encodeWithSelector(MatchBook.OfferClosed.selector, id));
        mb.fillOffer(id, sid, 1e18, 1e18);
        // offers: a naked call, a bad σ, an unlisted market, an expiry in the past
        vm.startPrank(WRITER);
        StrategyMath.Leg[] memory naked = new StrategyMath.Leg[](1);
        naked[0] = _leg(true, 70_000e18, -1e18);
        vm.expectRevert(StrategyMath.Unbounded.selector);
        mb.postOffer(BTC, naked, _day(), 4200, 1e18, uint64(nowT + 1), false);
        vm.expectRevert(MatchBook.BadOffer.selector);
        mb.postOffer(BTC, _writerSpread(), _day(), 499, 1e18, uint64(nowT + 1), false);
        vm.expectRevert(abi.encodeWithSelector(MatchBook.NotListed.selector, bytes32("SOL")));
        mb.postOffer("SOL", _writerSpread(), _day(), 4200, 1e18, uint64(nowT + 1), false);
        vm.expectRevert(MatchBook.BadOffer.selector);
        mb.postOffer(BTC, _writerSpread(), _day(), 4200, 1e18, uint64(nowT - 1), false);
        vm.stopPrank();
        // an expired offer cannot fill
        vm.prank(WRITER);
        uint256 id2 = mb.postOffer(BTC, _writerSpread(), _day(), 4200, 1e18, uint64(nowT + 60), false);
        _set(nowT + 61);
        vm.expectRevert(abi.encodeWithSelector(MatchBook.OfferExpired.selector, id2));
        mb.fillOffer(id2, sid, 1e18, 1e18);
    }

    // ---------------------------------------------------------------- 6. early close

    function test_earlyCloseNeedsThePoolAndIsCappedAtTheCollateral() public {
        uint256 sid = _spreadSeries();
        mb.matchMaker(makers[0], sid, 2e18, 2e18);
        bytes32 key = _key(makers[0]);
        pool.setRefuse(true);
        vm.prank(makers[0]);
        vm.expectRevert(MockPool.Refused.selector);
        mb.earlyClose(key, sid, type(uint256).max, type(int256).max, nowT);
        pool.setRefuse(false);
        int256 v = EnginePricing.shapeValue(_spread(), 70_000e18, 4500, _day(), true);
        (int256 ask,) = EnginePricing.shapeUnwriteQuote(v, 2e18, _spread(), 70_000e18, 200);
        uint256 freeBefore = vault.freeOf(makers[0], _u());
        vm.prank(makers[0]);
        (uint256 units, int256 cost) = mb.earlyClose(key, sid, type(uint256).max, type(int256).max, nowT);
        assertEq(units, 2e18);
        assertEq(cost, ask);
        assertEq(pool.lastCost(), ask);
        assertEq(usdc.balanceOf(address(pool)), uint256(ask));
        assertEq(vault.freeOf(makers[0], _u()) - freeBefore, 10_000e6 - uint256(ask));
        assertEq(mb.matchedRaw(sid), 0);
        // far above the upper strike the ask would exceed the width: capped at the collateral
        mb.matchMaker(makers[1], sid, 1e18, 1e18);
        marks.set(BTC, 150_000e18);
        vm.prank(makers[1]);
        (, cost) = mb.earlyClose(_key(makers[1]), sid, type(uint256).max, type(int256).max, nowT);
        assertEq(cost, int256(5_000e6), "the collateral");
        vm.prank(address(0xBAD));
        vm.expectRevert(MatchBook.NotOwner.selector);
        mb.earlyClose(key, sid, 1, type(int256).max, nowT);
    }

    // ---------------------------------------------------------------- 7. fuzz: law 4 and conservation

    function testFuzz_lockedCoversTheWorstCaseAndEverythingAddsUp(uint256 seed) public {
        uint256 sid = _spreadSeries();
        uint256 co = book.openShape(BTC, _condor(), _day());
        uint256[2] memory sids = [sid, co];
        for (uint256 step; step < 40; ++step) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            uint256 s_ = sids[r % 2];
            uint256 action = (r >> 8) % 4;
            if (action <= 1) {
                address m = makers[(r >> 16) % 8];
                uint256 units = 0.01e18 + (r >> 32) % 3e18;
                mb.matchMaker(m, s_, units, units);
            } else if (action == 2) {
                uint256 matched = mb.matchedRaw(s_);
                if (matched > 0) {
                    uint256 rawSold = 1 + (r >> 32) % (matched * 2);
                    // a gross the collateral always covers: at most 4,000 per raw against a 5,000 worst case
                    uint256 gross = Math.mulDiv(rawSold, (r >> 64) % 4_000e6, 1e18);
                    (,, uint256 sf) = pool.buyback(s_, rawSold, gross, 70_000e18);
                    assertEq(sf, 0, "no shortfall within the worst case");
                }
            } else {
                _set(nowT + 5 minutes);
                book.record(BTC, 70_000e18 + ((r >> 40) % 9) * 100e18, 4500);
                book.accrue(s_, type(uint256).max);
                address m = makers[(r >> 16) % 8];
                (uint8 kind,,) = mb.sources(_key(m));
                if (kind != 0) {
                    vm.prank(m);
                    mb.claim(_key(m), s_);
                }
            }
            // law 4 per entry, and the totals
            for (uint256 k; k < 2; ++k) {
                uint256 sum;
                for (uint256 i; i < 8; ++i) {
                    (uint256 raw, uint256 lockedU,, bool flagged) = _entry(_key(makers[i]), sids[k]);
                    assertFalse(flagged);
                    sum += raw;
                    if (raw == 0) continue;
                    uint256 unitsNow = Math.mulDiv(raw, book.normNow(sids[k]), 1e18, Math.Rounding.Ceil);
                    assertGe(lockedU * 1e12, Math.mulDiv(unitsNow, 5_000e18, 1e18), "law 4");
                }
                assertEq(sum, mb.matchedRaw(sids[k]));
            }
            uint256 vaultSum;
            for (uint256 i; i < 9; ++i) {
                vaultSum += vault.freeOf(makers[i], _u()) + vault.lockedOf(makers[i], _u());
            }
            assertEq(usdc.balanceOf(address(vault)), vaultSum, "the vault holds free + locked");
        }
    }

    // ---------------------------------------------------------------- 8. gas

    function test_matchBookGas() public {
        uint256 sid = _spreadSeries();
        mb.matchMaker(makers[0], sid, 1e18, 1e18); // warm
        uint256 g = gasleft();
        mb.matchMaker(makers[1], sid, 1e18, 1e18);
        console2.log("match, a new source", g - gasleft());
        for (uint256 i = 2; i < 8; ++i) {
            mb.matchMaker(makers[i], sid, 1e18, 1e18);
        }
        g = gasleft();
        pool.buyback(sid, 8e18, 24_000e6, 70_000e18);
        console2.log("buyback, all 8 sources", g - gasleft());
        mb.matchMaker(makers[0], sid, 2e18, 2e18);
        g = gasleft();
        pool.buyback(sid, 1e18, 3_000e6, 70_000e18);
        console2.log("buyback, 1 source", g - gasleft());
        _set(nowT + 1 hours);
        book.record(BTC, 70_000e18, 4500);
        book.accrue(sid, type(uint256).max);
        g = gasleft();
        vm.prank(makers[0]);
        mb.claim(_key(makers[0]), sid);
        console2.log("claim", g - gasleft());
    }
}
