// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PathFundingBook, IMarkRouter, IVolSource} from "./PathFundingBook.sol";
import {TempoBlend} from "./TempoBlend.sol";
import {EnginePricing} from "./EnginePricing.sol";
import {StrategyMath} from "./StrategyMath.sol";

/// @title PoolLiability
/// @notice The pool's liability to option holders: an open-series registry per market and permissionless, chunked
///         marking each epoch, at the mark (base) and under stress. Used by MainspringPool for NAV and for the
///         coverage rule on opens (M3 decisions 3 and 6).
/// @dev    Every rounding and every shortcut errs towards a higher liability (conservative):
///         - units = raw × normNow, rounded up. For a series behind the latest sample, normNow is the higher norm
///           where its last walk stopped, so liability is overstated, never understated.
///         - Values are rounded up.
///         - Stressed liability per market = max(Σ series at S × (1 + shock), Σ series at S × (1 − shock)), both with
///           σ × volMult capped at 500%: one direction for the whole market, never up and down at once.
///         - Between epochs, a buy adds its base value and the larger of its up and down stressed values at once;
///           a sell subtracts nothing from these bounds until the next epoch is final.
///         - NAV uses a separate, accurate base (`navBase`): buys add their base value and sells subtract theirs at
///           once, each counted once against the epoch that did not see it. A series added while an epoch is marking may be
///           counted twice (in the walk and as an add); a series removed after being marked stays counted.
///         - A buy that would make a 257th open series on a market is refused; sells are never refused here.
///         Deployed as an external library (public entry points, called by DELEGATECALL; storage stays in the pool),
///         so its code does not count against the pool's size limit (M4 decision D4). Private helpers stay inline.
library PoolLiability {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_SERIES_PER_MARKET = 256;
    uint256 internal constant MAX_SIGMA_BPS = 50_000; // TempoMath's upper bound (500%)
    uint256 internal constant EPOCH = 1 hours;

    struct Market {
        bool listed;
        uint16 shockBps;
        uint256 index; // position in State.markets
        uint256[] series; // open series (pool raw > 0)
        // epoch snapshot and running sums while marking
        uint256 sWad;
        uint256 sigmaBps;
        uint256 runBase;
        uint256 runUp;
        uint256 runDown;
        // last final epoch
        uint256 finalBase;
        uint256 finalStressed;
        // adds since the start of the last final epoch (prev) and of the epoch being marked (cur)
        uint256 addBasePrev;
        uint256 addStressedPrev;
        uint256 addBaseCur;
        uint256 addStressedCur;
        // directional exposure: each scenario separately (last final epoch + buys since it started)
        uint256 finalUp;
        uint256 finalDown;
        uint256 addUpPrev;
        uint256 addDownPrev;
        uint256 addUpCur;
        uint256 addDownCur;
        // NAV only (accurate, not conservative): buys' base value added and sells' base value subtracted, each
        // counted once against the epoch that did not see it
        uint256 navAddPrev;
        uint256 navSubPrev;
        uint256 navAddCur;
        uint256 navSubCur;
    }

    /// @dev Written shapes (M4 step 7b): the pool holds them (long), so they add to NAV and offset directional
    ///      exposure; the stressed liability and coverage count them 0 (D9). Signed (a Guard's pool side can be worth
    ///      less than 0), values rounded down. Accurate pattern as navAdd/navSub: a write or unwrite is counted against
    ///      the last final epoch at once (prev), and against the epoch being marked only if its walk has passed the
    ///      series (cur).
    struct Written {
        int256 runBase;
        int256 runUp;
        int256 runDown;
        int256 finalBase;
        int256 finalUp;
        int256 finalDown;
        int256 dBasePrev;
        int256 dUpPrev;
        int256 dDownPrev;
        int256 dBaseCur;
        int256 dUpCur;
        int256 dDownCur;
    }

    struct State {
        PathFundingBook book;
        IMarkRouter marks;
        IVolSource vols;
        uint16 volMultBps; // 15000 = × 1.5
        bytes32[] markets;
        mapping(bytes32 => Market) m;
        mapping(uint256 => uint256) raw; // pool raw per series
        mapping(uint256 => uint256) idx1; // index in its market's list, plus one; 0 = not open
        mapping(uint256 => bytes32) marketOf;
        bool marking;
        uint64 epochStart; // start of the epoch being marked, or of the last final one
        uint64 lastFinal;
        uint256 epoch; // completed epochs
        uint256 mCursor;
        uint256 sCursor;
        mapping(uint256 => uint256) wraw; // written raw per series (the pool long), M4
        mapping(bytes32 => Written) w;
        mapping(uint256 => uint256) mraw; // matched raw per series (M6): buyer raw mirrored by covered matched writes
    }

    error NotListed(bytes32 market);
    error AlreadyListed(bytes32 market);
    error BadShock(uint256 shockBps);
    error BadVolMult(uint256 volMultBps);
    error TooManySeries(bytes32 market);
    error EpochInProgress();
    error EpochTooSoon(uint256 nextAt);
    error NotMarking();
    error WrongMarket(uint256 id, bytes32 market);

    // ---------------------------------------------------------------- configuration

    function init(State storage st, PathFundingBook book, IMarkRouter marks, IVolSource vols, uint16 volMultBps)
        public
    {
        st.book = book;
        st.marks = marks;
        st.vols = vols;
        setVolMult(st, volMultBps);
    }

    function listMarket(State storage st, bytes32 market, uint16 shockBps) public {
        if (st.m[market].listed) revert AlreadyListed(market);
        if (st.marking) revert EpochInProgress();
        st.m[market].index = st.markets.length;
        st.markets.push(market);
        st.m[market].listed = true;
        setShock(st, market, shockBps);
    }

    function setShock(State storage st, bytes32 market, uint16 shockBps) public {
        if (!st.m[market].listed) revert NotListed(market);
        if (shockBps == 0 || shockBps >= BPS) revert BadShock(shockBps);
        st.m[market].shockBps = shockBps;
    }

    function setVolMult(State storage st, uint16 volMultBps) public {
        if (volMultBps < BPS) revert BadVolMult(volMultBps);
        st.volMultBps = volMultBps;
    }

    // ---------------------------------------------------------------- trades

    /// @notice A buy against the pool: registers the series if new (cap 256 per market) and adds its value at once.
    /// @param sWad    the mark the buy was priced at
    /// @param sigmaBps the vol the buy was priced at
    function onBuy(
        State storage st,
        bytes32 market,
        uint256 id,
        uint256 units,
        uint256 raw,
        uint256 sWad,
        uint256 sigmaBps
    ) public {
        Market storage mk = _register(st, market, id);
        st.raw[id] += raw;
        _addValues(st, mk, id, units, sWad, sigmaBps);
    }

    /// @notice A matched open (M6 D1): buyer raw mirrored by the same matched raw. The pool is flat on it: no value is
    ///         added to the base, the stress or the directional exposure (D2).
    function onMatchedBuy(State storage st, bytes32 market, uint256 id, uint256 raw) public {
        _register(st, market, id);
        st.raw[id] += raw;
        st.mraw[id] += raw;
    }

    /// @notice Sets a series' matched raw (synced from the MatchBook after a buyback or an early close), never above
    ///         the buyer raw it mirrors.
    function setMatched(State storage st, uint256 id, uint256 mraw) public {
        uint256 held = st.raw[id];
        st.mraw[id] = mraw < held ? mraw : held;
    }

    /// @notice `units` of series `id` the pool now carries (raw a matched write stopped mirroring: an uncovered buyback,
    ///         an early close): their base, stress and directional values are added at once, at (sWad, σ).
    function addCarried(State storage st, uint256 id, uint256 units, uint256 sWad, uint256 sigmaBps) public {
        if (st.idx1[id] == 0 || units == 0) return;
        _addValues(st, st.m[st.marketOf[id]], id, units, sWad, sigmaBps);
    }

    /// @notice `raw` the pool carried on series `id` becomes matched (an auction fill, M6 step 9): the NAV base drops at
    ///         once by its value at (sWad, σ); the stress and directional bounds drop at the next epoch (conservative, as
    ///         for sells).
    function stopCarrying(State storage st, uint256 id, uint256 raw, uint256 units, uint256 sWad, uint256 sigmaBps)
        public
    {
        if (st.idx1[id] == 0 || raw == 0) return;
        uint256 carried = st.raw[id] - st.mraw[id];
        if (raw > carried) raw = carried;
        st.mraw[id] += raw;
        Market storage mk = st.m[st.marketOf[id]];
        uint256 base = _value(_terms(st, id), sWad, sigmaBps, units);
        mk.navSubPrev += base;
        if (_markedThisEpoch(st, id)) mk.navSubCur += base;
    }

    function matchedRaw(State storage st, uint256 id) public view returns (uint256) {
        return st.mraw[id];
    }

    function _addValues(State storage st, Market storage mk, uint256 id, uint256 units, uint256 sWad, uint256 sigmaBps)
        private
    {
        Terms memory t = _terms(st, id);
        uint256 base = _value(t, sWad, sigmaBps, units);
        uint256 sigS = _stressedSigma(st, sigmaBps);
        uint256 up = _value(t, _up(sWad, mk.shockBps), sigS, units);
        uint256 down = _value(t, _down(sWad, mk.shockBps), sigS, units);
        uint256 stressed = up > down ? up : down;
        mk.addBasePrev += base;
        mk.addStressedPrev += stressed;
        mk.addUpPrev += up;
        mk.addDownPrev += down;
        mk.navAddPrev += base;
        if (st.marking) {
            mk.addBaseCur += base;
            mk.addStressedCur += stressed;
            mk.addUpCur += up;
            mk.addDownCur += down;
            // the walk will see this raw if it has not reached the series yet
            if (_markedThisEpoch(st, id)) mk.navAddCur += base;
        }
    }

    /// @notice A sell against the pool: removes raw and unregisters the series when none is left. Never reverts for
    ///         the registry (law 3). The conservative bounds (liveBase, liveStressed) are not reduced until the next
    ///         epoch; the NAV base is reduced at once by `baseValue`, the value the pool paid for at the sell's S and σ.
    function onSell(State storage st, uint256 id, uint256 raw, uint256 baseValue) public {
        if (st.idx1[id] != 0) {
            Market storage mk = st.m[st.marketOf[id]];
            mk.navSubPrev += baseValue;
            // the walk will not see the sold raw if it has not reached the series yet
            if (st.marking && _markedThisEpoch(st, id)) mk.navSubCur += baseValue;
        }
        uint256 held = st.raw[id];
        if (raw > held) raw = held;
        st.raw[id] = held - raw;
        if (st.mraw[id] > held - raw) st.mraw[id] = held - raw; // matched raw never above the buyer raw it mirrors
        if (held - raw == 0 && st.wraw[id] == 0 && st.idx1[id] != 0) _remove(st, id);
    }

    /// @notice A write: the pool takes `raw` of shape series `id` long, valued at (sWad, σ) at once (accurate).
    function onWrite(
        State storage st,
        bytes32 market,
        uint256 id,
        uint256 units,
        uint256 raw,
        uint256 sWad,
        uint256 sigmaBps
    ) public {
        Market storage mk = _register(st, market, id);
        st.wraw[id] += raw;
        (int256 base, int256 up, int256 down) = _writtenValues(st, mk, id, units, sWad, sigmaBps);
        _addWritten(st, market, id, base, up, down);
    }

    /// @notice An unwrite: removes `raw` of the pool's long and its values at (sWad, σ). Never reverts for the registry.
    function onUnwrite(State storage st, uint256 id, uint256 raw, uint256 units, uint256 sWad, uint256 sigmaBps)
        public
    {
        if (st.idx1[id] != 0) {
            bytes32 market = st.marketOf[id];
            (int256 base, int256 up, int256 down) = _writtenValues(st, st.m[market], id, units, sWad, sigmaBps);
            _addWritten(st, market, id, -base, -up, -down);
        }
        uint256 held = st.wraw[id];
        if (raw > held) raw = held;
        st.wraw[id] = held - raw;
        if (held - raw == 0 && st.raw[id] == 0 && st.idx1[id] != 0) _remove(st, id);
    }

    function _register(State storage st, bytes32 market, uint256 id) private returns (Market storage mk) {
        mk = st.m[market];
        if (!mk.listed) revert NotListed(market);
        if (st.idx1[id] == 0) {
            if (mk.series.length >= MAX_SERIES_PER_MARKET) revert TooManySeries(market);
            mk.series.push(id);
            st.idx1[id] = mk.series.length;
            st.marketOf[id] = market;
        } else if (st.marketOf[id] != market) {
            revert WrongMarket(id, market);
        }
    }

    function _writtenValues(
        State storage st,
        Market storage mk,
        uint256 id,
        uint256 units,
        uint256 sWad,
        uint256 sigmaBps
    ) private view returns (int256 base, int256 up, int256 down) {
        Terms memory t = _terms(st, id);
        uint256 sigS = _stressedSigma(st, sigmaBps);
        base = _wvalue(t, sWad, sigmaBps, units);
        up = _wvalue(t, _up(sWad, mk.shockBps), sigS, units);
        down = _wvalue(t, _down(sWad, mk.shockBps), sigS, units);
    }

    function _addWritten(State storage st, bytes32 market, uint256 id, int256 base, int256 up, int256 down) private {
        Written storage w = st.w[market];
        w.dBasePrev += base;
        w.dUpPrev += up;
        w.dDownPrev += down;
        if (_markedThisEpoch(st, id)) {
            w.dBaseCur += base;
            w.dUpCur += up;
            w.dDownCur += down;
        }
    }

    /// @dev Swap-and-pop that keeps the marked region [0, sCursor) intact while the series' market is being marked:
    ///      an unmarked series never moves into the marked region, so every series is marked exactly once. Markets
    ///      not being marked (already done, or not reached yet) use plain swap-and-pop.
    function _remove(State storage st, uint256 id) private {
        bytes32 market = st.marketOf[id];
        uint256[] storage list = st.m[market].series;
        uint256 i = st.idx1[id] - 1;
        uint256 lastIdx = list.length - 1;
        bool beingMarked = st.marking && st.mCursor < st.markets.length && st.markets[st.mCursor] == market;

        if (beingMarked && i < st.sCursor) {
            // move the last marked series into i, then the last series into the freed marked slot's place
            uint256 lastMarked = st.sCursor - 1;
            _move(st, list, lastMarked, i);
            _move(st, list, lastIdx, lastMarked);
            st.sCursor = lastMarked;
        } else {
            _move(st, list, lastIdx, i);
        }
        list.pop();
        delete st.idx1[id];
        delete st.marketOf[id];
    }

    function _move(State storage st, uint256[] storage list, uint256 from, uint256 to) private {
        if (from == to) return;
        uint256 v = list[from];
        list[to] = v;
        st.idx1[v] = to + 1;
    }

    // ---------------------------------------------------------------- epochs

    /// @notice Permissionless, at most once an hour and only when no epoch is being marked. Reads the mark and vol of
    ///         every market; reverts if any is stale (the previous epoch stays in force).
    function startEpoch(State storage st) public {
        if (st.marking) revert EpochInProgress();
        if (st.epoch > 0 && block.timestamp < uint256(st.epochStart) + EPOCH) {
            revert EpochTooSoon(uint256(st.epochStart) + EPOCH);
        }
        for (uint256 i; i < st.markets.length; ++i) {
            bytes32 name = st.markets[i];
            Market storage mk = st.m[name];
            mk.sWad = st.marks.markWad(name);
            mk.sigmaBps = st.vols.volBps(name);
            mk.runBase = 0;
            mk.runUp = 0;
            mk.runDown = 0;
            mk.addBaseCur = 0;
            mk.addStressedCur = 0;
            mk.addUpCur = 0;
            mk.addDownCur = 0;
            mk.navAddCur = 0;
            mk.navSubCur = 0;
            Written storage w = st.w[name];
            (w.runBase, w.runUp, w.runDown) = (0, 0, 0);
            (w.dBaseCur, w.dUpCur, w.dDownCur) = (0, 0, 0);
        }
        st.marking = true;
        st.epochStart = uint64(block.timestamp);
        st.mCursor = 0;
        st.sCursor = 0;
    }

    /// @notice Permissionless: marks up to `maxSeries` series. Returns true when the epoch is final.
    function markChunk(State storage st, uint256 maxSeries) public returns (bool done) {
        if (!st.marking) revert NotMarking();
        uint256 budget = maxSeries;
        while (st.mCursor < st.markets.length) {
            Market storage mk = st.m[st.markets[st.mCursor]];
            while (st.sCursor < mk.series.length) {
                if (budget == 0) return false;
                _markOne(st, mk, mk.series[st.sCursor]);
                ++st.sCursor;
                --budget;
            }
            ++st.mCursor;
            st.sCursor = 0;
        }
        _finalize(st);
        return true;
    }

    function _markOne(State storage st, Market storage mk, uint256 id) private {
        Terms memory t = _terms(st, id);
        // matched raw is mirrored by covered matched writes: the pool carries only the rest (M6 D2)
        uint256 units = Math.mulDiv(st.raw[id] - st.mraw[id], st.book.normNow(id), WAD, Math.Rounding.Ceil);
        uint256 sigS = _stressedSigma(st, mk.sigmaBps);
        mk.runBase += _value(t, mk.sWad, mk.sigmaBps, units);
        mk.runUp += _value(t, _up(mk.sWad, mk.shockBps), sigS, units);
        mk.runDown += _value(t, _down(mk.sWad, mk.shockBps), sigS, units);
        uint256 wr = st.wraw[id];
        if (wr != 0) {
            uint256 wUnits = Math.mulDiv(wr, st.book.normNow(id), WAD); // rounded down: the pool's asset
            Written storage w = st.w[st.marketOf[id]];
            w.runBase += _wvalue(t, mk.sWad, mk.sigmaBps, wUnits);
            w.runUp += _wvalue(t, _up(mk.sWad, mk.shockBps), sigS, wUnits);
            w.runDown += _wvalue(t, _down(mk.sWad, mk.shockBps), sigS, wUnits);
        }
    }

    function _finalize(State storage st) private {
        for (uint256 i; i < st.markets.length; ++i) {
            Market storage mk = st.m[st.markets[i]];
            mk.finalBase = mk.runBase;
            mk.finalStressed = mk.runUp > mk.runDown ? mk.runUp : mk.runDown;
            mk.finalUp = mk.runUp;
            mk.finalDown = mk.runDown;
            mk.addUpPrev = mk.addUpCur;
            mk.addDownPrev = mk.addDownCur;
            mk.addUpCur = 0;
            mk.addDownCur = 0;
            mk.addBasePrev = mk.addBaseCur;
            mk.addStressedPrev = mk.addStressedCur;
            mk.addBaseCur = 0;
            mk.addStressedCur = 0;
            mk.navAddPrev = mk.navAddCur;
            mk.navSubPrev = mk.navSubCur;
            mk.navAddCur = 0;
            mk.navSubCur = 0;
            Written storage w = st.w[st.markets[i]];
            (w.finalBase, w.finalUp, w.finalDown) = (w.runBase, w.runUp, w.runDown);
            (w.dBasePrev, w.dUpPrev, w.dDownPrev) = (w.dBaseCur, w.dUpCur, w.dDownCur);
            (w.dBaseCur, w.dUpCur, w.dDownCur) = (0, 0, 0);
        }
        st.marking = false;
        st.lastFinal = uint64(block.timestamp);
        ++st.epoch;
    }

    // ---------------------------------------------------------------- reads

    /// @notice Liability at the mark: the last final epoch plus buys since it started (WAD USDC).
    function liveBase(State storage st, bytes32 market) public view returns (uint256) {
        Market storage mk = st.m[market];
        return mk.finalBase + mk.addBasePrev;
    }

    /// @notice Stressed liability: the last final epoch plus buys since it started (WAD USDC).
    function liveStressed(State storage st, bytes32 market) public view returns (uint256) {
        Market storage mk = st.m[market];
        return mk.finalStressed + mk.addStressedPrev;
    }

    /// @notice Liability at the mark for NAV: the last final epoch, plus buys' base value, minus sells' base value at
    ///         their own S and σ (WAD USDC). Accurate rather than conservative, so a round's NAV favours neither
    ///         depositors nor those staying. Never below zero.
    function navBase(State storage st, bytes32 market) public view returns (uint256) {
        Market storage mk = st.m[market];
        uint256 plus = mk.finalBase + mk.navAddPrev;
        return plus > mk.navSubPrev ? plus - mk.navSubPrev : 0;
    }

    function totalNavBase(State storage st) public view returns (uint256 sum) {
        for (uint256 i; i < st.markets.length; ++i) {
            sum += navBase(st, st.markets[i]);
        }
    }

    /// @notice Directional exposure of a market (WAD USDC): |liability at S × (1 + shock) − liability at S × (1 − shock)|,
    ///         from the last final epoch plus buys since it started (sells are not removed until the next epoch). The
    ///         on-chain stand-in for net delta, used by the directional cap on opens; the hedger hedges true delta.
    function liveDirectional(State storage st, bytes32 market) public view returns (uint256) {
        Market storage mk = st.m[market];
        Written storage w = st.w[market];
        // the pool's net position in each scenario: what it owes (short) less what it holds (written)
        int256 up = int256(mk.finalUp + mk.addUpPrev) - (w.finalUp + w.dUpPrev);
        int256 down = int256(mk.finalDown + mk.addDownPrev) - (w.finalDown + w.dDownPrev);
        int256 d = up - down;
        return d >= 0 ? uint256(d) : uint256(-d);
    }

    /// @notice Value of the written shapes the pool holds, at the mark (WAD USDC, signed, rounded down): the last
    ///         final epoch plus writes and less unwrites since, each at its own S and σ.
    function writtenNavBase(State storage st, bytes32 market) public view returns (int256) {
        Written storage w = st.w[market];
        return w.finalBase + w.dBasePrev;
    }

    function totalWrittenNavBase(State storage st) public view returns (int256 sum) {
        for (uint256 i; i < st.markets.length; ++i) {
            sum += writtenNavBase(st, st.markets[i]);
        }
    }

    function writtenRaw(State storage st, uint256 id) public view returns (uint256) {
        return st.wraw[id];
    }

    function totalLiveBase(State storage st) public view returns (uint256 sum) {
        for (uint256 i; i < st.markets.length; ++i) {
            sum += liveBase(st, st.markets[i]);
        }
    }

    function totalLiveStressed(State storage st) public view returns (uint256 sum) {
        for (uint256 i; i < st.markets.length; ++i) {
            sum += liveStressed(st, st.markets[i]);
        }
    }

    /// @dev True when the epoch being marked has already walked series `id` (registered).
    function _markedThisEpoch(State storage st, uint256 id) private view returns (bool) {
        if (!st.marking) return false;
        uint256 mi = st.m[st.marketOf[id]].index;
        if (mi < st.mCursor) return true;
        return mi == st.mCursor && st.idx1[id] - 1 < st.sCursor;
    }

    // ---------------------------------------------------------------- maths

    /// @dev A series' terms: a single leg (isCall, k) or a shape (legs), with its movement.
    struct Terms {
        bool shape;
        bool isCall;
        uint128 k;
        TempoBlend.Part[] mv;
        StrategyMath.Leg[] legs;
    }

    function _terms(State storage st, uint256 id) private view returns (Terms memory t) {
        if (st.book.isShape(id)) {
            t.shape = true;
            (, t.legs, t.mv) = st.book.shapeOf(id);
        } else {
            (, t.isCall, t.k, t.mv) = st.book.seriesOf(id);
        }
    }

    /// @dev Value of `units` at (s, σ), rounded up. A shape held against the pool is one a buyer may hold, worth at
    ///      least 0 (M4 step 6); a rounding below 0 counts as 0. Written shapes (the pool long) come in step 7.
    function _value(Terms memory t, uint256 s, uint256 sigma, uint256 units) private pure returns (uint256) {
        if (units == 0) return 0;
        if (!t.shape) {
            uint256 v = EnginePricing.unitValue(t.isCall, s, t.k, sigma, t.mv);
            return Math.mulDiv(units, v, WAD, Math.Rounding.Ceil);
        }
        int256 sv = EnginePricing.shapeValue(t.legs, s, sigma, t.mv, true);
        return sv > 0 ? Math.mulDiv(units, uint256(sv), WAD, Math.Rounding.Ceil) : 0;
    }

    /// @dev Value of `units` of a written shape at (s, σ), signed, rounded towards −∞ (the pool's asset).
    function _wvalue(Terms memory t, uint256 s, uint256 sigma, uint256 units) private pure returns (int256) {
        if (units == 0) return 0;
        int256 sv = EnginePricing.shapeValue(t.legs, s, sigma, t.mv, false);
        if (sv >= 0) return int256(Math.mulDiv(units, uint256(sv), WAD));
        return -int256(Math.mulDiv(units, uint256(-sv), WAD, Math.Rounding.Ceil));
    }

    /// @notice Units of underlying per unit of series `id` for the notional cap: 1 for a single leg, max(Σ long,
    ///         Σ short) for a shape (the shape fee's basis), WAD.
    function notionalPerUnit(State storage st, uint256 id) public view returns (uint256) {
        if (!st.book.isShape(id)) return WAD;
        (, StrategyMath.Leg[] memory legs,) = st.book.shapeOf(id);
        return EnginePricing.shapeNotionalPerUnit(legs);
    }

    function _stressedSigma(State storage st, uint256 sigmaBps) private view returns (uint256) {
        uint256 s = Math.mulDiv(sigmaBps, st.volMultBps, BPS, Math.Rounding.Ceil);
        return s > MAX_SIGMA_BPS ? MAX_SIGMA_BPS : s;
    }

    function _up(uint256 s, uint256 shockBps) private pure returns (uint256) {
        return Math.mulDiv(s, BPS + shockBps, BPS);
    }

    function _down(uint256 s, uint256 shockBps) private pure returns (uint256) {
        return Math.mulDiv(s, BPS - shockBps, BPS);
    }
}
