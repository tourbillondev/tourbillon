// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TempoMath} from "./TempoMath.sol";
import {TempoBlend} from "./TempoBlend.sol";
import {PathFunding} from "./PathFunding.sol";
import {ShapeFunding} from "./ShapeFunding.sol";
import {StrategyMath} from "./StrategyMath.sol";

interface IMarkRouter {
    function markWad(bytes32 market) external view returns (uint256);
}

interface IVolSource {
    function volBps(bytes32 name) external view returns (uint256);
}

/// @title PathFundingBook
/// @notice Ledger of no-expiry option series with funding along the recorded price path.
///         A series is (market, call/put, strike, Movement). Every holder of a series shares its norm;
///         balances are raw, and units = raw · norm. Each market's price path is recorded once and
///         shared by every series on it. The engine is the only minter and burner.
/// @dev    - `poke(name)` is permissionless and reads the mark from the router and σ from the vol board
///           itself, so a caller chooses only when a sample is taken, never what is recorded. A second
///           poke inside the same 5-minute bucket is ignored quietly.
///         - `accrue` walks a series towards the latest sample; anyone may call it, and the result does not
///           depend on who calls or how the walk is split into chunks.
///         - A series is caught up once walked to the latest sample; the time after it accrues at that
///           sample, so `normNow` is exact at the current block.
///         - Buys (`mint`) walk at most TRADE_MAX_STEPS intervals and revert if more remain; sells (`burn`)
///           walk without limit, so a sell never waits for a keeper.
///         - If a series was left unwalked past the daily ring, `accrue` and `mint` revert with HistoryGone,
///           but `burn` charges the lost stretch at the maximum rate and goes on (not in the spec; to confirm).
///         - The norm never goes below MIN_NORM. This safety floor is not in the spec.
///         - σ bounds are TempoMath's defaults (5% to 500%) in M0.
///         - Shapes (M4): a series can also be a shape of 1–4 legs on one market with one shared decay factor
///           (ShapeFunding; M4 decision D2). Its id is tagged "SHAPE" so it never meets a single-leg id, and its
///           legs are spelled one way only: increasing (put before call, then strike), no repeats, first amount ±1.
///           Single-leg series behave exactly as before.
contract PathFundingBook {
    uint256 public constant MIN_NORM = 1e6;
    uint256 public constant DEFAULT_MAX_STEPS = 64;
    uint256 public constant TRADE_MAX_STEPS = 16;
    /// @notice A shape's legs × Movement parts (owner, M4 step 5): no shape costs more to walk than the most complex
    ///         single leg (1 leg × 4 parts), so a sell after 60 days untouched fits in one block. Revisit once
    ///         Elysium's block gas limit is confirmed (U).
    uint256 public constant MAX_SHAPE_EVALS = 4;

    struct Series {
        bytes32 name;
        bool isCall;
        bool exists;
        uint128 kWad;
        PathFunding.Cursor cur;
        TempoBlend.Part[] movement;
        StrategyMath.Leg[] legs; // empty for a single-leg series
    }

    address public immutable engine;
    /// @notice The WriterBook (M4): may open shape series and walk a write's series like a sell. Set once, through the
    ///         Engine's admin.
    address public writer;
    address public immutable recorder; // bootstrap recorder; zero disables `record`
    IMarkRouter public immutable marks;
    IVolSource public immutable vols;

    mapping(bytes32 => PathFunding.History) internal _paths;
    mapping(uint256 => Series) internal _series;
    mapping(uint256 => mapping(address => uint256)) public balanceOf; // raw; units = raw · norm

    event Recorded(bytes32 indexed name, uint256 t, uint256 sWad, uint256 sigmaBps, bool l0, bool l1, bool l2);
    event Opened(uint256 indexed id, bytes32 indexed name, bool isCall, uint128 kWad);
    event ShapeOpened(uint256 indexed id, bytes32 indexed name, uint256 legs);
    event WriterSet(address writer);
    event Accrued(uint256 indexed id, uint256 x, uint256 at, uint256 steps);
    event HistoryFallback(uint256 indexed id, uint256 from, uint256 to, uint256 charged);

    error NotEngine();
    error NotRecorder();
    error Unknown(uint256 id);
    error NotCaughtUp(uint256 id);
    error IsShape(uint256 id);
    error NotShape(uint256 id);
    error LegsNotCanonical(uint256 index);
    error FirstQtyNotOne(int256 qty);
    error ShapeTooComplex(uint256 legs, uint256 parts);
    error WriterAlreadySet();

    constructor(address engine_, address recorder_, IMarkRouter marks_, IVolSource vols_) {
        engine = engine_;
        recorder = recorder_;
        marks = marks_;
        vols = vols_;
    }

    // ---------------------------------------------------------------- samples

    /// @notice Permissionless sampling. Reverts if the mark or the vol is stale or disputed.
    function poke(bytes32 name) external returns (bool l0, bool l1, bool l2) {
        uint256 px = marks.markWad(name);
        uint256 sig = vols.volBps(name);
        return _record(name, px, sig);
    }

    /// @notice Bootstrap sampling (tests, shadow mode before launch) by the fixed recorder. Production
    ///         deploys with no recorder and uses `poke`. Either way samples are only appended.
    function record(bytes32 name, uint256 sWad, uint256 sigmaBps) external returns (bool, bool, bool) {
        if (recorder == address(0) || msg.sender != recorder) revert NotRecorder();
        return _record(name, sWad, sigmaBps);
    }

    function _record(bytes32 name, uint256 s, uint256 sig) internal returns (bool l0, bool l1, bool l2) {
        (l0, l1, l2) = PathFunding.record(_paths[name], block.timestamp, s, sig);
        emit Recorded(name, block.timestamp, s, sig, l0, l1, l2);
    }

    // ---------------------------------------------------------------- series

    function idOf(bytes32 name, bool isCall, uint128 kWad, TempoBlend.Part[] memory movement)
        public
        pure
        returns (uint256)
    {
        return uint256(keccak256(abi.encode(name, isCall, kWad, movement)));
    }

    /// @notice Opens a series if it does not exist yet. Needs a recorded sample (no price, no open).
    /// @dev The terms are checked once against the latest sample, so a series can never be stored with a
    ///      strike, tempo or Movement the maths would later refuse.
    function open(bytes32 name, bool isCall, uint128 kWad, TempoBlend.Part[] calldata movement)
        external
        returns (uint256 id)
    {
        if (msg.sender != engine) revert NotEngine();
        id = idOf(name, isCall, kWad, movement);
        Series storage s = _series[id];
        if (s.exists) return id;

        PathFunding.History storage h = _paths[name];
        PathFunding.Terms memory terms = PathFunding.Terms(isCall, kWad, movement, TempoMath.defaultBounds());
        PathFunding.rateE36(PathFunding.latest(h), terms); // reverts on bad terms or no history
        s.name = name;
        s.isCall = isCall;
        s.kWad = kWad;
        for (uint256 i; i < movement.length; ++i) {
            s.movement.push(movement[i]);
        }
        s.cur = PathFunding.open(h, block.timestamp);
        s.exists = true;
        emit Opened(id, name, isCall, kWad);
    }

    /// @notice Sets the WriterBook once (engine only, on its admin's call).
    function setWriter(address writer_) external {
        if (msg.sender != engine) revert NotEngine();
        if (writer != address(0)) revert WriterAlreadySet();
        writer = writer_;
        emit WriterSet(writer_);
    }

    /// @notice Id of a shape series. Tagged "SHAPE", so it never equals a single-leg id.
    function idOfShape(bytes32 name, StrategyMath.Leg[] memory legs, TempoBlend.Part[] memory movement)
        public
        pure
        returns (uint256)
    {
        return uint256(keccak256(abi.encode("SHAPE", name, legs, movement)));
    }

    /// @notice Opens a shape series if it does not exist yet (engine only). The legs must be spelled the one
    ///         canonical way, and the terms are checked once against the latest sample, as for single legs.
    function openShape(bytes32 name, StrategyMath.Leg[] calldata legs, TempoBlend.Part[] calldata movement)
        external
        returns (uint256 id)
    {
        if (msg.sender != engine && (msg.sender != writer || writer == address(0))) revert NotEngine();
        _checkCanonical(legs);
        if (legs.length * movement.length > MAX_SHAPE_EVALS) revert ShapeTooComplex(legs.length, movement.length);
        id = idOfShape(name, legs, movement);
        Series storage s = _series[id];
        if (s.exists) return id;

        PathFunding.History storage h = _paths[name];
        ShapeFunding.rateAt(PathFunding.latest(h), ShapeFunding.Terms(legs, movement, TempoMath.defaultBounds()));
        s.name = name;
        for (uint256 i; i < movement.length; ++i) {
            s.movement.push(movement[i]);
        }
        for (uint256 j; j < legs.length; ++j) {
            s.legs.push(legs[j]);
        }
        s.cur = PathFunding.open(h, block.timestamp);
        s.exists = true;
        emit ShapeOpened(id, name, legs.length);
    }

    /// @dev One spelling per shape: legs strictly increasing by (put before call, strike), so no repeats, and the
    ///      first amount ±1 (a 2:−2 spread is the 1:−1 series; size is carried by units). Count and amount limits
    ///      are ShapeFunding's.
    function _checkCanonical(StrategyMath.Leg[] calldata legs) internal pure {
        ShapeFunding.validate(legs);
        if (legs[0].qty != 1e18 && legs[0].qty != -1e18) revert FirstQtyNotOne(legs[0].qty);
        for (uint256 j = 1; j < legs.length; ++j) {
            StrategyMath.Leg calldata a = legs[j - 1];
            StrategyMath.Leg calldata b = legs[j];
            bool ordered = a.isCall == b.isCall ? a.kWad < b.kWad : !a.isCall;
            if (!ordered) revert LegsNotCanonical(j);
        }
    }

    /// @notice Walks a series at most `maxSteps` intervals (0 = DEFAULT_MAX_STEPS). Anyone may call.
    /// @return norm The norm now if caught up, else the norm where the walk stopped.
    /// @return done True when caught up with the latest sample.
    function accrue(uint256 id, uint256 maxSteps) public returns (uint256 norm, bool done) {
        return _accrue(id, maxSteps == 0 ? DEFAULT_MAX_STEPS : maxSteps);
    }

    /// @notice Engine-only. A buy walks at most TRADE_MAX_STEPS intervals and must end caught up.
    function mint(uint256 id, address to, uint256 raw) external {
        if (msg.sender != engine) revert NotEngine();
        (, bool done) = _accrue(id, TRADE_MAX_STEPS);
        if (!done) revert NotCaughtUp(id);
        balanceOf[id][to] += raw;
    }

    /// @notice Engine-only. A sell walks without limit, so it never waits for a keeper, and it never
    ///         reverts for lack of history (see `_chargeLostHistory`).
    function burn(uint256 id, address from, uint256 raw) external {
        if (msg.sender != engine) revert NotEngine();
        _accrue(id, type(uint256).max, true);
        balanceOf[id][from] -= raw;
    }

    /// @notice Engine-only. The walk a sell uses (no step limit, lost history charged at the maximum rate, see
    ///         `_chargeLostHistory`), returning the norm at the current block, so the engine knows how much raw to
    ///         burn before calling `burn` (whose own walk then has nothing left to do).
    function accrueForSell(uint256 id) external returns (uint256 norm) {
        if (msg.sender != engine && (msg.sender != writer || writer == address(0))) revert NotEngine();
        (norm,) = _accrue(id, type(uint256).max, true);
    }

    function _accrue(uint256 id, uint256 limit) internal returns (uint256 norm, bool done) {
        return _accrue(id, limit, false);
    }

    function _accrue(uint256 id, uint256 limit, bool sell) internal returns (uint256 norm, bool done) {
        Series storage s = _series[id];
        if (!s.exists) revert Unknown(id);
        PathFunding.History storage h = _paths[s.name];
        PathFunding.Cursor memory c = s.cur;
        uint256 last0 = PathFunding.latest(h).t;
        uint256 steps;
        if (sell && c.at < last0 && PathFunding.factor(c.x) > MIN_NORM && !PathFunding.held(h, c.eff)) {
            c = _chargeLostHistory(id, s, h, c);
        }
        if (PathFunding.factor(c.x) <= MIN_NORM) {
            // at the floor: nothing left to charge, skip straight to the latest sample
            if (c.at < last0) {
                c.at = uint40(last0);
                c.eff = uint40(last0);
            }
        } else {
            (c, steps) = s.legs.length == 0
                ? PathFunding.walk(h, c, _terms(s), limit)
                : ShapeFunding.walk(h, c, _shapeTerms(s), limit);
        }
        s.cur = c;
        done = c.at >= last0;
        norm = done ? _normNow(s, c) : _norm(c.x);
        emit Accrued(id, c.x, c.at, steps);
    }

    /// @dev Sells only, when the rings no longer hold the series' history (untouched past the daily ring).
    ///      The stretch with no history, from the cursor to the oldest sample still held, is charged at the
    ///      highest rate any path could produce: TV ≤ V, so the shrink rate never exceeds 1/(shortest tempo).
    ///      The walk then continues on the history that remains. Not in the spec (to confirm): it keeps law 3
    ///      from depending on the walker, while charging at least as much as any real path would have.
    function _chargeLostHistory(
        uint256 id,
        Series storage s,
        PathFunding.History storage h,
        PathFunding.Cursor memory c
    ) internal returns (PathFunding.Cursor memory) {
        uint256 to = PathFunding.horizon(h);
        uint256 shortest = type(uint256).max;
        for (uint256 i; i < s.movement.length; ++i) {
            if (s.movement[i].tempo < shortest) shortest = s.movement[i].tempo;
        }
        uint256 charged = Math.ceilDiv((to - c.at) * 1e18, shortest);
        if (s.legs.length != 0) {
            // A shape's rate has no 1/shortest-tempo ceiling: charge the larger of that and the shape's rate at
            // the oldest sample still held (owner, M4 step 4). The factor still never rises (law 4).
            uint256 atHeld = ShapeFunding.rateAt(PathFunding._inEffect(h, to), _shapeTerms(s));
            uint256 byHeld = Math.ceilDiv(atHeld * (to - c.at), 1e18);
            if (byHeld > charged) charged = byHeld;
        }
        emit HistoryFallback(id, c.at, to, charged);
        c.x += charged;
        c.at = uint40(to);
        c.eff = uint40(to);
        return c;
    }

    // ---------------------------------------------------------------- reads

    /// @notice Norm at the current block if caught up (time after the latest sample at that sample),
    ///         else the norm where the last walk stopped.
    function normNow(uint256 id) public view returns (uint256) {
        Series storage s = _series[id];
        if (!s.exists) revert Unknown(id);
        PathFunding.Cursor memory c = s.cur;
        if (c.at < PathFunding.latest(_paths[s.name]).t) return _norm(c.x);
        return _normNow(s, c);
    }

    function units(uint256 id, address who) external view returns (uint256) {
        return balanceOf[id][who] * normNow(id) / 1e18;
    }

    /// @notice The latest level-0 sample of `name`: the last good sample, used to price sells when the mark or
    ///         the vol is stale (law 2). Reverts with NoHistory if the market has none.
    function latestSample(bytes32 name) external view returns (uint256 t, uint256 sWad, uint256 sigmaBps) {
        PathFunding.Sample memory s = PathFunding.latest(_paths[name]);
        return (s.t, s.s, s.sigmaBps);
    }

    /// @notice The terms of series `id`. Reverts with Unknown if it does not exist.
    function seriesOf(uint256 id)
        external
        view
        returns (bytes32 name, bool isCall, uint128 kWad, TempoBlend.Part[] memory movement)
    {
        Series storage s = _series[id];
        if (!s.exists) revert Unknown(id);
        if (s.legs.length != 0) revert IsShape(id);
        return (s.name, s.isCall, s.kWad, s.movement);
    }

    /// @notice The terms of shape series `id`. Reverts with Unknown, or NotShape for a single-leg series.
    function shapeOf(uint256 id)
        external
        view
        returns (bytes32 name, StrategyMath.Leg[] memory legs, TempoBlend.Part[] memory movement)
    {
        Series storage s = _series[id];
        if (!s.exists) revert Unknown(id);
        if (s.legs.length == 0) revert NotShape(id);
        return (s.name, s.legs, s.movement);
    }

    function isShape(uint256 id) external view returns (bool) {
        return _series[id].legs.length != 0;
    }

    function exists(uint256 id) external view returns (bool) {
        return _series[id].exists;
    }

    function horizon(bytes32 name) external view returns (uint256) {
        return PathFunding.horizon(_paths[name]);
    }

    function cursor(uint256 id) external view returns (PathFunding.Cursor memory) {
        return _series[id].cur;
    }

    function _normNow(Series storage s, PathFunding.Cursor memory c) internal view returns (uint256) {
        uint256 x = c.x;
        if (block.timestamp > c.at && PathFunding.factor(x) > MIN_NORM) {
            PathFunding.Sample memory smp = PathFunding.latest(_paths[s.name]);
            uint256 r =
                s.legs.length == 0 ? PathFunding.rateE36(smp, _terms(s)) : ShapeFunding.rateAt(smp, _shapeTerms(s));
            x += Math.ceilDiv(r * (block.timestamp - c.at), 1e18);
        }
        return _norm(x);
    }

    function _norm(uint256 x) internal pure returns (uint256) {
        uint256 f = PathFunding.factor(x);
        return f < MIN_NORM ? MIN_NORM : f;
    }

    function _terms(Series storage s) internal view returns (PathFunding.Terms memory) {
        return PathFunding.Terms(s.isCall, s.kWad, s.movement, TempoMath.defaultBounds());
    }

    function _shapeTerms(Series storage s) internal view returns (ShapeFunding.Terms memory) {
        return ShapeFunding.Terms(s.legs, s.movement, TempoMath.defaultBounds());
    }
}
