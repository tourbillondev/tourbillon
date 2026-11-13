// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Engine} from "../../src/Engine.sol";
import {EnginePricing} from "../../src/EnginePricing.sol";
import {HousePool} from "../../src/HousePool.sol";
import {PathFundingBook} from "../../src/PathFundingBook.sol";
import {PathFunding} from "../../src/PathFunding.sol";
import {TempoBlend} from "../../src/TempoBlend.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockMarks, MockVols} from "../Engine.t.sol";

/// Drives the whole M2 system with random sequences: buys, sells, samples with price moves, stale sources, buy
/// pauses and walks. It owns every contract (admin, pauser, bootstrap recorder) and keeps ghost counters that the
/// invariants read. Every failed action is caught and classified; nothing is allowed to fail silently.
contract EngineHandler is Test {
    bytes32 public constant BTC = "BTC";
    address public constant FEES = address(0xFEE);
    uint256 public constant START_USDC = 1_000_000e6;
    uint256 public constant N_SERIES = 6;

    MockUSDC public usdc;
    MockMarks public marks;
    MockVols public vols;
    HousePool public pool;
    PathFundingBook public book;
    Engine public engine;

    address[3] public actors = [address(0xA1), address(0xA2), address(0xA3)];
    uint256 public nowT = 1_794_182_400;
    uint256 public s = 50_000e18; // the live price; samples and the mark follow it
    bool public markStale;
    bool public volStale;
    bool public paused;

    struct Terms {
        bool isCall;
        uint128 k;
        uint256 kind; // 0: 1 day, 1: 7 days, 2: Movement (1 h / 1 d / 7 d)
    }

    Terms[N_SERIES] internal terms;
    uint256[N_SERIES] public ids;
    mapping(uint256 => uint256) public lastX; // accumulated funding charge (cursor x) per series

    // ghosts
    mapping(address => uint256) public expectedBalance;
    uint256 public expectedFees;
    uint256 public buysOk;
    uint256 public sellsOk;
    uint256 public buysWhileStale; // law 2: must stay 0
    uint256 public buysWhilePaused; // must stay 0
    uint256 public sellFailures; // law 3: must stay 0
    uint256 public insolventSells; // interim blocker: must stay 0 with a well-funded pool
    uint256 public priceMismatches; // law 5: must stay 0
    uint256 public payoutMismatches; // pool outflow must equal seller + fee recipient inflow
    uint256 public normIncreases; // funding never runs backwards (see _checkNorms)
    uint256 public sellsWhilePausedOrStale; // successful sells under adverse conditions (coverage)
    bytes public lastSellError;
    string public lastIncrease; // details of the last norm increase, for the failure message

    constructor() {
        vm.warp(nowT);
        usdc = new MockUSDC();
        marks = new MockMarks();
        vols = new MockVols();
        pool = new HousePool(address(this), usdc, FEES);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        book = new PathFundingBook(predicted, address(this), marks, vols);
        engine = new Engine(address(this), book, pool, marks, vols);
        require(address(engine) == predicted, "prediction");
        pool.setEngine(address(engine));
        engine.setMarket(BTC, 1_000e18, 200);
        engine.grantRole(engine.PAUSER_ROLE(), address(this));
        usdc.mint(address(this), 100_000_000e6);
        usdc.approve(address(pool), type(uint256).max);
        pool.deposit(100_000_000e6);
        pool.setCap(BTC, type(uint256).max);
        marks.set(BTC, s);
        vols.set(BTC, 5000);
        book.record(BTC, s, 5000);

        for (uint256 i; i < 3; ++i) {
            usdc.mint(actors[i], START_USDC);
            expectedBalance[actors[i]] = START_USDC;
            vm.prank(actors[i]);
            usdc.approve(address(engine), type(uint256).max);
        }
        terms[0] = Terms(true, 50_000e18, 0);
        terms[1] = Terms(false, 50_000e18, 0);
        terms[2] = Terms(true, 55_000e18, 1);
        terms[3] = Terms(false, 45_000e18, 1);
        terms[4] = Terms(true, 50_000e18, 2);
        terms[5] = Terms(false, 48_000e18, 2);
        for (uint256 i; i < N_SERIES; ++i) {
            ids[i] = book.idOf(BTC, terms[i].isCall, terms[i].k, _movement(terms[i].kind));
        }
    }

    function _movement(uint256 kind) internal pure returns (TempoBlend.Part[] memory m) {
        if (kind == 0) return TempoBlend.single(1 days);
        if (kind == 1) return TempoBlend.single(7 days);
        m = new TempoBlend.Part[](3);
        m[0] = TempoBlend.Part(1 hours, 0.2e18);
        m[1] = TempoBlend.Part(1 days, 0.5e18);
        m[2] = TempoBlend.Part(7 days, 0.3e18);
    }

    // ---------------------------------------------------------------- actions

    function buy(uint256 actorSeed, uint256 seriesSeed, uint256 unitsSeed) external {
        vm.warp(nowT);
        address a = actors[actorSeed % 3];
        Terms memory t = terms[seriesSeed % N_SERIES];
        TempoBlend.Part[] memory mv = _movement(t.kind);
        uint256 units = bound(unitsSeed, 1e15, 2e18);

        uint256 expectedCost;
        if (!markStale && !volStale) {
            uint256 v = EnginePricing.unitValue(t.isCall, s, t.k, 5000, mv);
            (uint256 p, uint256 f) = EnginePricing.buyQuote(v, units, s, 200);
            expectedCost = p + f;
        }
        uint256 balBefore = usdc.balanceOf(a);
        uint256 feesBefore = usdc.balanceOf(FEES);
        vm.prank(a);
        try engine.buy(BTC, t.isCall, t.k, mv, units, type(uint256).max, nowT) returns (uint256, uint256 cost) {
            buysOk++;
            if (markStale || volStale) buysWhileStale++;
            if (paused) buysWhilePaused++;
            if (cost != expectedCost || balBefore - usdc.balanceOf(a) != cost) priceMismatches++;
            expectedBalance[a] -= cost;
            expectedFees += usdc.balanceOf(FEES) - feesBefore;
        } catch {
            // expected refusals: stale sources, paused, strike out of band, not caught up
        }
        _checkNorms("buy");
    }

    function sell(uint256 actorSeed, uint256 seriesSeed, uint256 unitsSeed, bool all) external {
        vm.warp(nowT);
        address a = actors[actorSeed % 3];
        uint256 id = ids[seriesSeed % N_SERIES];
        if (!book.exists(id) || book.balanceOf(id, a) == 0) return;
        uint256 units = all ? type(uint256).max : bound(unitsSeed, 1, 3e18);

        uint256 balBefore = usdc.balanceOf(a);
        uint256 feesBefore = usdc.balanceOf(FEES);
        uint256 poolBefore = usdc.balanceOf(address(pool));
        vm.prank(a);
        try engine.sell(id, units, 0, nowT) returns (uint256, uint256 net) {
            sellsOk++;
            if (paused || markStale || volStale) sellsWhilePausedOrStale++;
            uint256 toSeller = usdc.balanceOf(a) - balBefore;
            uint256 toFees = usdc.balanceOf(FEES) - feesBefore;
            if (toSeller != net || poolBefore - usdc.balanceOf(address(pool)) != toSeller + toFees) payoutMismatches++;
            expectedBalance[a] += net;
            expectedFees += toFees;
        } catch (bytes memory err) {
            if (bytes4(err) == HousePool.Insolvent.selector) insolventSells++;
            else sellFailures++;
            lastSellError = err;
        }
        _checkNorms("sell");
    }

    /// Time passes (1 to 40 minutes), the price moves up to ±3%, and a sample is recorded.
    function tick(uint256 dtSeed, uint256 moveSeed) external {
        nowT += bound(dtSeed, 1 minutes, 40 minutes);
        vm.warp(nowT);
        uint256 moveBps = bound(moveSeed, 0, 600); // 0..600 → −3%..+3%
        s = s * (9_700 + moveBps) / 10_000;
        if (s < 30_000e18) s = 30_000e18;
        if (s > 80_000e18) s = 80_000e18;
        marks.set(BTC, s);
        book.record(BTC, s, 5000);
        _checkNorms("tick");
    }

    function toggleStale(uint256 which) external {
        if (which % 2 == 0) {
            markStale = !markStale;
            marks.setStale(markStale);
        } else {
            volStale = !volStale;
            vols.setStale(volStale);
        }
    }

    function togglePause() external {
        if (paused) engine.unpauseBuys();
        else engine.pauseBuys();
        paused = !paused;
    }

    function walk(uint256 seriesSeed) external {
        vm.warp(nowT);
        uint256 id = ids[seriesSeed % N_SERIES];
        if (book.exists(id)) book.accrue(id, type(uint256).max);
        _checkNorms("walk");
    }

    // ---------------------------------------------------------------- checks

    /// Funding never runs backwards: the accumulated charge x of every series never decreases; when a series is
    /// caught up, normNow is never above the walked norm factor(x); normNow never goes below the floor.
    /// (normNow of a series that is behind the latest sample is the norm where its last walk stopped, so that
    /// reading can be higher than the extrapolated reading before the new sample landed. That is a view-only
    /// effect; buys and sells always walk first.)
    function _checkNorms(string memory action) internal {
        for (uint256 i; i < N_SERIES; ++i) {
            uint256 id = ids[i];
            if (!book.exists(id)) continue;
            PathFunding.Cursor memory c = book.cursor(id);
            uint256 n = book.normNow(id);
            (uint256 latestT,,) = book.latestSample(BTC);
            bool caughtUp = c.at >= latestT;
            uint256 walked = PathFunding.factor(c.x);
            if (walked < book.MIN_NORM()) walked = book.MIN_NORM();
            if (c.x < lastX[id] || n < book.MIN_NORM() || (caughtUp && n > walked)) {
                normIncreases++;
                lastIncrease = string.concat(
                    action,
                    " series ",
                    vm.toString(i),
                    " x ",
                    vm.toString(c.x),
                    " lastX ",
                    vm.toString(lastX[id]),
                    " normNow ",
                    vm.toString(n),
                    " walked ",
                    vm.toString(walked)
                );
            }
            lastX[id] = c.x;
        }
    }

    function actor(uint256 i) external view returns (address) {
        return actors[i];
    }

    function seriesId(uint256 i) external view returns (uint256) {
        return ids[i];
    }
}

/// The laws and the accounting, checked after every random call.
/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 80
/// forge-config: default.invariant.fail-on-revert = true
contract EngineInvariantTest is Test {
    EngineHandler h;

    function setUp() public {
        h = new EngineHandler();
        targetContract(address(h));
    }

    /// The Engine never holds money.
    function invariant_engineHoldsNothing() public view {
        assertEq(h.usdc().balanceOf(address(h.engine())), 0);
    }

    /// No USDC appears or disappears: actors, the pool and the fee recipient hold all of it.
    function invariant_usdcIsConserved() public view {
        uint256 sum = h.usdc().balanceOf(address(h.pool())) + h.usdc().balanceOf(h.FEES());
        for (uint256 i; i < 3; ++i) {
            sum += h.usdc().balanceOf(h.actor(i));
        }
        assertEq(sum, h.usdc().totalSupply());
    }

    /// Law 1: a buyer's balance is exactly start − Σ costs + Σ sell proceeds. Nothing else is ever taken.
    function invariant_buyersLoseOnlyWhatTheyPaid() public view {
        for (uint256 i; i < 3; ++i) {
            address a = h.actor(i);
            assertEq(h.usdc().balanceOf(a), h.expectedBalance(a));
        }
        assertEq(h.usdc().balanceOf(h.FEES()), h.expectedFees());
    }

    /// Law 2: no buy ever succeeded with a stale mark or vol; no buy while paused.
    function invariant_noBuyWithoutFreshMarkAndVol() public view {
        assertEq(h.buysWhileStale(), 0);
        assertEq(h.buysWhilePaused(), 0);
    }

    /// Law 3: every sell of a real holding succeeded, whatever the pause and staleness state.
    function invariant_sellsAlwaysWork() public view {
        assertEq(h.sellFailures(), 0, string(h.lastSellError()));
        assertEq(h.insolventSells(), 0);
    }

    /// Law 5: every buy cost exactly EnginePricing at the live mark and vol; every sell paid exactly what the pool
    /// sent out.
    function invariant_pricesComeFromTheSources() public view {
        assertEq(h.priceMismatches(), 0);
        assertEq(h.payoutMismatches(), 0);
    }

    /// Funding never runs backwards: accumulated charges never decrease, a caught-up normNow is never above the
    /// walked norm, and no norm goes below the floor.
    function invariant_fundingNeverRunsBackwards() public view {
        assertEq(h.normIncreases(), 0, h.lastIncrease());
    }

    /// Book, pool and actors agree on every series: the pool's raw equals the raw the actors hold, and the pool's
    /// notional totals are the sums of its series.
    function invariant_bookPoolAndActorsAgree() public view {
        uint256 notional;
        for (uint256 i; i < h.N_SERIES(); ++i) {
            uint256 id = h.seriesId(i);
            uint256 held;
            for (uint256 j; j < 3; ++j) {
                held += h.book().balanceOf(id, h.actor(j));
            }
            assertEq(h.pool().seriesRaw(id), held);
            if (held == 0) assertEq(h.pool().seriesNotional(id), 0);
            notional += h.pool().seriesNotional(id);
        }
        assertEq(h.pool().openNotional(h.BTC()), notional);
        assertEq(h.pool().totalOpenNotional(), notional);
    }

    /// Coverage: a fixed sequence that exercises every path the invariants rely on (successful buys and sells,
    /// sells while paused and with stale sources, refused buys while stale and paused, walks), so the invariants
    /// above are known not to pass vacuously.
    function test_handlerCoversEveryPath() public {
        h.buy(0, 0, 1e18);
        h.buy(1, 4, 5e17);
        h.tick(10 minutes, 400);
        h.togglePause();
        h.buy(2, 1, 1e18); // refused: paused
        h.sell(0, 0, 0, true); // sell while paused
        h.togglePause();
        h.toggleStale(0); // mark stale
        h.buy(2, 1, 1e18); // refused: stale mark
        h.sell(1, 4, 1e17, false); // sell with a stale mark: priced at the sample
        h.toggleStale(0);
        h.tick(30 minutes, 100);
        h.walk(4);
        h.sell(1, 4, 0, true);
        assertGe(h.buysOk(), 2);
        assertGe(h.sellsOk(), 3);
        assertGe(h.sellsWhilePausedOrStale(), 2);
        assertEq(h.buysWhileStale() + h.buysWhilePaused() + h.sellFailures() + h.normIncreases(), 0);
        invariant_bookPoolAndActorsAgree();
        invariant_buyersLoseOnlyWhatTheyPaid();
        invariant_usdcIsConserved();
    }
}
