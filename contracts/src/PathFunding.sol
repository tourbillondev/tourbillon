// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SD59x18, sd} from "@prb/math/src/SD59x18.sol";
import {TempoMath} from "./TempoMath.sol";
import {TempoBlend} from "./TempoBlend.sol";

/// @title PathFunding
/// @notice Funding along the recorded price path. Units shrink in kind:
///         norm(t) = norm₀ · exp(−X), with X = Σ rᵢ·Δtᵢ and rᵢ the shrink rate per second
///         (TempoBlend: Σw·TV/tempo ÷ Σw·V) at sample i. A sample holds until the next one.
/// @dev Samples are kept in three rings per market:
///        level 0: one per 5-minute bucket, 64 slots   (about 5 h 20 min)
///        level 1: one per hour, 96 slots               (4 days)
///        level 2: one per day, 64 slots                (64 days)
///      An hourly (daily) sample is a copy of the first 5-minute sample recorded in that hour (day).
///      Each sample stores the time of the next sample at its level, so a walk never scans gaps.
///
///      A cursor always sits on a recorded sample, except right after `open`, when it sits at
///      the open time with the latest sample in effect. Each walk step takes the sample in effect
///      at the finest level that still holds it, and runs to that level's next sample. So the
///      path walked depends only on what is recorded and what the rings still hold, never on the
///      caller. X is accumulated and exp is applied once at the end, so walking in chunks gives
///      exactly the same X as one walk. If no level still holds the sample in effect, the walk
///      reverts with HistoryGone.
library PathFunding {
    uint256 internal constant P0 = 5 minutes;
    uint256 internal constant N0 = 64;
    uint256 internal constant P1 = 1 hours;
    uint256 internal constant N1 = 96;
    uint256 internal constant P2 = 1 days;
    uint256 internal constant N2 = 64;
    /// @dev exp(−X) is zero in 18-decimal fixed point beyond this.
    uint256 internal constant MAX_EXPONENT = 41_446531673892822322;

    struct Sample {
        uint40 t;
        uint40 next; // time of the next sample at the same level, 0 if none yet
        uint32 sigmaBps;
        uint128 s; // WAD
    }

    struct History {
        mapping(uint256 => Sample)[3] rings; // slot => sample, per level
        uint40[3] last; // time of the latest sample per level
    }

    struct Cursor {
        uint40 at; // walked up to here
        uint40 eff; // time of the level-0 sample in effect at `at`
        uint256 x; // Σ r·Δt, WAD
    }

    struct Terms {
        bool isCall;
        uint256 strike; // WAD
        TempoBlend.Part[] movement;
        TempoMath.SigmaBounds bounds;
    }

    error BadSample();
    error NotIncreasing(uint256 last, uint256 t);
    error NoHistory();
    error OpenBeforeLastSample(uint256 at, uint256 last);
    error HistoryGone(uint256 eff);
    error Inconsistent();

    // ---------------------------------------------------------------- recording

    /// @notice Records a sample at time `t`, at most one per 5-minute bucket.
    /// @dev A second sample in the latest bucket is ignored quietly (two pokers may race);
    ///      a sample for an earlier bucket would rewrite history and reverts.
    /// @return w0 level 0 took it   @return w1 level 1 took it   @return w2 level 2 took it
    function record(History storage h, uint256 t, uint256 s, uint256 sigmaBps)
        internal
        returns (bool w0, bool w1, bool w2)
    {
        if (t == 0 || s == 0 || sigmaBps == 0 || s > TempoMath.MAX_PRICE || sigmaBps > type(uint32).max) {
            revert BadSample();
        }
        uint256 last0 = h.last[0];
        if (last0 != 0) {
            if (t / P0 < last0 / P0) revert NotIncreasing(last0, t);
            if (t / P0 == last0 / P0) return (false, false, false);
        }

        Sample memory smp = Sample(uint40(t), 0, uint32(sigmaBps), uint128(s));
        _append(h, 0, smp);
        w0 = true;
        if (h.last[1] == 0 || t / P1 > uint256(h.last[1]) / P1) {
            _append(h, 1, smp);
            w1 = true;
        }
        if (h.last[2] == 0 || t / P2 > uint256(h.last[2]) / P2) {
            _append(h, 2, smp);
            w2 = true;
        }
    }

    function _append(History storage h, uint256 level, Sample memory smp) private {
        (uint256 period, uint256 size) = _shape(level);
        mapping(uint256 => Sample) storage ring = h.rings[level];
        uint256 prev = h.last[level];
        if (prev != 0) {
            Sample storage p = ring[(prev / period) % size];
            if (p.t == prev) p.next = smp.t; // link, if the previous sample is still held
        }
        ring[(uint256(smp.t) / period) % size] = smp;
        h.last[level] = smp.t;
    }

    // ---------------------------------------------------------------- walking

    /// @notice A new cursor at time `at`, with the latest sample in effect.
    function open(History storage h, uint256 at) internal view returns (Cursor memory) {
        uint256 last0 = h.last[0];
        if (last0 == 0) revert NoHistory();
        if (at < last0) revert OpenBeforeLastSample(at, last0);
        return Cursor(uint40(at), uint40(last0), 0);
    }

    /// @notice Walks `cur` towards the latest recorded sample, at most `maxSteps` intervals.
    /// @return cur     The advanced cursor.
    /// @return steps   Intervals walked.
    function walk(History storage h, Cursor memory cur, Terms memory terms, uint256 maxSteps)
        internal
        view
        returns (Cursor memory, uint256 steps)
    {
        uint256 end = h.last[0];
        while (cur.at < end && steps < maxSteps) {
            Sample memory smp = _inEffect(h, cur.eff);
            uint256 n = smp.next;
            if (n == 0 || n <= cur.at) revert Inconsistent();
            cur.x += Math.ceilDiv(rateE36(smp, terms) * (n - cur.at), 1e18);
            cur.at = uint40(n);
            cur.eff = uint40(n);
            ++steps;
        }
        return (cur, steps);
    }

    /// @notice The latest recorded sample.
    function latest(History storage h) internal view returns (Sample memory) {
        uint256 last0 = h.last[0];
        if (last0 == 0) revert NoHistory();
        return h.rings[0][(last0 / P0) % N0];
    }

    /// @notice Time of the oldest daily sample still held: a cursor whose sample in effect is at or
    ///         after this can still be walked. View only; scans at most N2 slots.
    function horizon(History storage h) internal view returns (uint256) {
        uint256 last2 = h.last[2];
        if (last2 == 0) revert NoHistory();
        uint256 lastDay = last2 / P2;
        for (uint256 d = lastDay >= N2 - 1 ? lastDay - (N2 - 1) : 0; d <= lastDay; ++d) {
            Sample memory smp = h.rings[2][d % N2];
            if (smp.t != 0 && smp.t / P2 == d) return smp.t;
        }
        revert Inconsistent(); // unreachable: the latest daily sample is always held
    }

    /// @notice Shrink rate per second at 36 decimals at a sample. σ is held inside the configured bounds.
    /// @dev Each step adds ceil(rate·Δt/1e18) to X: rounding is per step, not per second, and always up,
    ///      so a non-zero rate never gives a free interval.
    function rateE36(Sample memory smp, Terms memory terms) internal pure returns (uint256) {
        uint256 sigma = smp.sigmaBps;
        if (sigma < terms.bounds.minBps) sigma = terms.bounds.minBps;
        if (sigma > terms.bounds.maxBps) sigma = terms.bounds.maxBps;
        return TempoBlend.rateE36(terms.isCall, smp.s, terms.strike, sigma, terms.movement, terms.bounds);
    }

    /// @notice exp(−x), WAD. Zero once x is past the fixed-point range.
    function factor(uint256 x) internal pure returns (uint256) {
        if (x > MAX_EXPONENT) return 0;
        return uint256(sd(-int256(x)).exp().unwrap());
    }

    /// @dev The sample in effect at `eff` (a level-0 sample time) at the finest level still holding it. Internal so
    ///      ShapeFunding walks the same history the same way.
    ///      At level 1 (2) that is the first sample of eff's hour (day), which always exists.
    function _inEffect(History storage h, uint256 eff) internal view returns (Sample memory smp) {
        bool found;
        (found, smp) = _find(h, eff);
        if (!found) revert HistoryGone(eff);
    }

    /// @notice True when some level still holds the sample in effect at `eff`, so a walk from it can start.
    ///         Once the starting sample is held, every later one is too.
    function held(History storage h, uint256 eff) internal view returns (bool found) {
        (found,) = _find(h, eff);
    }

    function _find(History storage h, uint256 eff) private view returns (bool, Sample memory smp) {
        smp = h.rings[0][(eff / P0) % N0];
        if (smp.t == eff) return (true, smp);
        smp = h.rings[1][(eff / P1) % N1];
        if (smp.t != 0 && smp.t / P1 == eff / P1) return (true, smp);
        smp = h.rings[2][(eff / P2) % N2];
        if (smp.t != 0 && smp.t / P2 == eff / P2) return (true, smp);
        return (false, smp);
    }

    function _shape(uint256 level) private pure returns (uint256 period, uint256 size) {
        if (level == 0) return (P0, N0);
        if (level == 1) return (P1, N1);
        return (P2, N2);
    }
}
