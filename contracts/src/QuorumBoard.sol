// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ISessionCalendar} from "./SessionCalendar.sol";

/// @title QuorumBoard
/// @notice m-of-n signer board for marks and vols. Each key runs numbered rounds:
///         signers vote, the round finalises at the median of all votes received,
///         then the step clamp and, if set, the anchor band are applied.
/// @dev A round finalises when all n signers have voted, or once at least m have voted
///      and `window` seconds have passed since its oldest vote (anyone may then call
///      `finalize`). A key's first round has no step clamp, so it needs all n votes.
///      Votes older than the key's heartbeat are dropped from the open round and never
///      enter a median; their signers may vote again. Votes for a finalised round are refused.
///      Values are WAD: a mark is a WAD price, a vol is a WAD fraction (0.5e18 = 50%).
///      All configuration sits behind DEFAULT_ADMIN_ROLE, meant to be the timelock.
///      Session rule (Backend §4, tokenized stocks; owner G1): a MARK key bound to the session calendar records every
///      value finalised during the regular session; a round finalised outside it is clamped to ±sessionBandBps (at most
///      10%) of that last in-session value. The trigger is the round's own finalisation, which anyone can call: no key
///      chooses a price or a time. With no in-session value yet, an out-of-session round does not finalise, so the
///      key stays stale and opens stay closed (law 2). Crypto keys are never bound.
contract QuorumBoard is AccessControl {
    uint8 public constant DECIMALS = 8;
    uint256 public constant MIN_QUORUM = 2; // no single key can set a value
    uint256 public constant MAX_VALUE = 1e36; // same ceiling as TempoMath.MAX_PRICE; keeps every read and clamp in range
    uint256 internal constant BPS = 10_000;
    uint16 public constant MAX_SESSION_BAND_BPS = 1_000; // ±10% (Backend §4)

    struct Feed {
        bool listed;
        uint16 stepBps; // max move per round vs the last final value
        uint32 heartbeat; // a final value is fresh for this many seconds
    }

    struct Anchor {
        bool active;
        uint16 bandBps;
        uint256 value;
    }

    struct Final {
        uint80 round;
        uint64 startedAt; // first vote of the round
        uint64 updatedAt; // finalisation time
        uint256 value;
    }

    struct Vote {
        address signer;
        uint64 at;
        uint256 value;
    }

    uint256 public quorum; // m
    uint256 public signerCount; // n
    uint256 public window; // seconds after the first vote before m votes can finalise

    mapping(address => bool) public isSigner;
    mapping(bytes32 => Feed) public feeds;
    mapping(bytes32 => Anchor) public anchors;
    mapping(bytes32 => Final) internal _latest;
    mapping(bytes32 => Final) internal _previous; // the final before the latest (round 0 if none)
    mapping(bytes32 => Vote[]) internal _open; // open round votes, in arrival order
    mapping(bytes32 => mapping(uint80 => mapping(address => bool))) public hasVoted;
    ISessionCalendar public calendar;
    mapping(bytes32 => uint16) public sessionBandBps; // 0: no session rule (crypto, and every VOL key)
    mapping(bytes32 => uint256) public sessionValue; // the last value finalised during the regular session

    event Voted(bytes32 indexed key, uint80 indexed round, address indexed signer, uint256 value);
    event VoteDropped(bytes32 indexed key, uint80 indexed round, address indexed signer, uint256 value);
    event Finalised(bytes32 indexed key, uint80 indexed round, uint256 median, uint256 published, uint256 votes);
    event SignerSet(address indexed signer, bool active);
    event QuorumSet(uint256 quorum);
    event WindowSet(uint256 window);
    event FeedSet(bytes32 indexed key, uint16 stepBps, uint32 heartbeat);
    event AnchorSet(bytes32 indexed key, uint256 value, uint16 bandBps);
    event AnchorCleared(bytes32 indexed key);
    event CalendarSet(address calendar);
    event SessionKeySet(bytes32 indexed key, uint16 bandBps);
    event SessionValueRecorded(bytes32 indexed key, uint80 indexed round, uint256 value);

    error NotSigner(address account);
    error UnknownKey(bytes32 key);
    error WrongRound(uint80 expected, uint80 given);
    error AlreadyVoted(address signer);
    error ZeroValue();
    error ValueTooLarge(uint256 value);
    error NotReady(bytes32 key);
    error NoData(bytes32 key);
    error Stale(bytes32 key, uint256 updatedAt);
    error BadQuorum(uint256 quorum, uint256 signers);
    error BadSigner(address signer);
    error BadConfig();

    constructor(address admin, address[] memory signers, uint256 quorum_, uint256 window_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        for (uint256 i; i < signers.length; ++i) {
            _setSigner(signers[i], true);
        }
        _setQuorum(quorum_);
        window = window_;
        emit WindowSet(window_);
    }

    // ---------------------------------------------------------------- keys

    function markKey(bytes32 name) public pure returns (bytes32) {
        return keccak256(abi.encode("MARK", name));
    }

    function volKey(bytes32 name) public pure returns (bytes32) {
        return keccak256(abi.encode("VOL", name));
    }

    // ---------------------------------------------------------------- voting

    /// @notice Vote a value for the open round of `key` (the round after the latest final).
    function vote(bytes32 key, uint80 round, uint256 value) external {
        if (!isSigner[msg.sender]) revert NotSigner(msg.sender);
        if (!feeds[key].listed) revert UnknownKey(key);
        uint80 expected = _latest[key].round + 1;
        if (round != expected) revert WrongRound(expected, round);
        if (value == 0) revert ZeroValue();
        if (value > MAX_VALUE) revert ValueTooLarge(value);

        Vote[] storage vs = _open[key];
        _dropStale(key, round, vs);
        if (hasVoted[key][round][msg.sender]) revert AlreadyVoted(msg.sender);

        hasVoted[key][round][msg.sender] = true;
        vs.push(Vote(msg.sender, uint64(block.timestamp), value));
        emit Voted(key, round, msg.sender, value);

        if (_ready(key, vs)) _finalise(key, round, vs);
    }

    /// @notice Finalise the open round once at least m fresh votes are in and the window has passed.
    function finalize(bytes32 key) external {
        uint80 round = _latest[key].round + 1;
        Vote[] storage vs = _open[key];
        _dropStale(key, round, vs);
        if (vs.length == 0 || !_ready(key, vs)) revert NotReady(key);
        _finalise(key, round, vs);
    }

    function _ready(bytes32 key, Vote[] storage vs) internal view returns (bool) {
        uint256 n = vs.length;
        if (n >= signerCount) return _sessionAllows(key);
        if (_latest[key].round == 0) return false; // first round: no step clamp, so all n
        if (n < quorum || block.timestamp < vs[0].at + window) return false;
        return _sessionAllows(key);
    }

    /// @dev Out of session, a session-bound key finalises only once it has an in-session value to anchor to.
    function _sessionAllows(bytes32 key) internal view returns (bool) {
        if (sessionBandBps[key] == 0 || sessionValue[key] != 0) return true;
        return calendar.isRegularSession(block.timestamp);
    }

    /// @dev Removes votes older than the key's heartbeat; their signers may vote again.
    function _dropStale(bytes32 key, uint80 round, Vote[] storage vs) internal {
        uint256 n = vs.length;
        uint256 maxAge = feeds[key].heartbeat;
        uint256 kept;
        for (uint256 i; i < n; ++i) {
            Vote memory v = vs[i];
            if (block.timestamp - v.at > maxAge) {
                hasVoted[key][round][v.signer] = false;
                emit VoteDropped(key, round, v.signer, v.value);
            } else {
                if (kept != i) vs[kept] = v;
                ++kept;
            }
        }
        while (vs.length > kept) {
            vs.pop();
        }
    }

    function _finalise(bytes32 key, uint80 round, Vote[] storage vs) internal {
        uint256 votes = vs.length;
        uint256[] memory values = new uint256[](votes);
        for (uint256 i; i < votes; ++i) {
            values[i] = vs[i].value;
        }
        uint64 startedAt = vs[0].at;
        uint256 med = _median(values);
        uint256 out = med;
        Final storage last = _latest[key];

        // step clamp against the previous final value (none for the first round)
        if (last.round != 0) {
            uint256 step = feeds[key].stepBps;
            out = _clamp(out, last.value * (BPS - step) / BPS, last.value * (BPS + step) / BPS);
        }
        // anchor band
        Anchor storage a = anchors[key];
        if (a.active) {
            out = _clamp(out, a.value * (BPS - a.bandBps) / BPS, a.value * (BPS + a.bandBps) / BPS);
        }
        // session rule: in session, record; out of session, clamp to the last in-session value
        uint256 band = sessionBandBps[key];
        if (band != 0) {
            if (calendar.isRegularSession(block.timestamp)) {
                sessionValue[key] = out;
                emit SessionValueRecorded(key, round, out);
            } else {
                uint256 sv = sessionValue[key];
                out = _clamp(out, sv * (BPS - band) / BPS, sv * (BPS + band) / BPS);
            }
        }

        if (last.round != 0) _previous[key] = last;
        _latest[key] = Final(round, startedAt, uint64(block.timestamp), out);
        delete _open[key];
        emit Finalised(key, round, med, out, votes);
    }

    // ---------------------------------------------------------------- reads

    /// @notice AggregatorV3-style read at 8 decimals. Reverts if the key has no final value.
    function latestRoundData(bytes32 key)
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        Final storage f = _latest[key];
        if (f.round == 0) revert NoData(key);
        return (f.round, int256(f.value / 1e10), f.startedAt, f.updatedAt, f.round);
    }

    function decimals() external pure returns (uint8) {
        return DECIMALS;
    }

    /// @notice Latest final value in WAD with its finalisation time. Reverts if none.
    function latestValue(bytes32 key) public view returns (uint256 value, uint256 updatedAt) {
        Final storage f = _latest[key];
        if (f.round == 0) revert NoData(key);
        return (f.value, f.updatedAt);
    }

    /// @notice The final before the latest, in WAD, with its finalisation time. Reverts if fewer than two finals
    ///         exist. (Used by MainspringPool, which counts the lower of the latest and previous EQUITY finals.)
    function previousValue(bytes32 key) external view returns (uint256 value, uint256 updatedAt) {
        Final storage f = _previous[key];
        if (f.round == 0) revert NoData(key);
        return (f.value, f.updatedAt);
    }

    /// @notice True when the key has a final value no older than its heartbeat.
    function fresh(bytes32 key) public view returns (bool) {
        Final storage f = _latest[key];
        return f.round != 0 && block.timestamp - f.updatedAt <= feeds[key].heartbeat;
    }

    /// @notice Vol of market `name` in basis points. Reverts unless fresh.
    function volBps(bytes32 name) external view returns (uint256) {
        bytes32 key = volKey(name);
        (uint256 v, uint256 updatedAt) = latestValue(key);
        if (!fresh(key)) revert Stale(key, updatedAt);
        return v / 1e14;
    }

    /// @notice Number of votes held in the open round of `key` (stale ones included until dropped).
    function openVotes(bytes32 key) external view returns (uint256) {
        return _open[key].length;
    }

    // ---------------------------------------------------------------- governance

    function setSigner(address signer, bool active) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setSigner(signer, active);
        if (quorum > signerCount) revert BadQuorum(quorum, signerCount);
    }

    function setQuorum(uint256 quorum_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setQuorum(quorum_);
    }

    function setWindow(uint256 window_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        window = window_;
        emit WindowSet(window_);
    }

    function setFeed(bytes32 key, uint16 stepBps, uint32 heartbeat) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (stepBps == 0 || stepBps >= BPS || heartbeat == 0) revert BadConfig();
        feeds[key] = Feed(true, stepBps, heartbeat);
        emit FeedSet(key, stepBps, heartbeat);
    }

    /// @notice Anchor `key` to its current final value, with a ±bandBps band.
    /// @dev Takes no value: the anchor is whatever the quorum last published, so no key
    ///      ever supplies a price. Used for weekend marks (last regular-session mark).
    function setAnchor(bytes32 key, uint16 bandBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bandBps == 0 || bandBps >= BPS) revert BadConfig();
        (uint256 v,) = latestValue(key);
        anchors[key] = Anchor(true, bandBps, v);
        emit AnchorSet(key, v, bandBps);
    }

    function setCalendar(ISessionCalendar calendar_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(calendar_).code.length == 0) revert BadConfig();
        calendar = calendar_;
        emit CalendarSet(address(calendar_));
    }

    /// @notice Binds a listed MARK key to the session rule with a band of at most 10%; 0 unbinds it.
    function setSessionKey(bytes32 key, uint16 bandBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!feeds[key].listed || bandBps > MAX_SESSION_BAND_BPS || (bandBps != 0 && address(calendar) == address(0))) {
            revert BadConfig();
        }
        sessionBandBps[key] = bandBps;
        if (bandBps == 0) delete sessionValue[key];
        emit SessionKeySet(key, bandBps);
    }

    function clearAnchor(bytes32 key) external onlyRole(DEFAULT_ADMIN_ROLE) {
        delete anchors[key];
        emit AnchorCleared(key);
    }

    function _setSigner(address signer, bool active) internal {
        if (signer == address(0) || isSigner[signer] == active) revert BadSigner(signer);
        isSigner[signer] = active;
        if (active) ++signerCount;
        else --signerCount;
        emit SignerSet(signer, active);
    }

    function _setQuorum(uint256 quorum_) internal {
        if (quorum_ < MIN_QUORUM || quorum_ > signerCount) revert BadQuorum(quorum_, signerCount);
        quorum = quorum_;
        emit QuorumSet(quorum_);
    }

    // ---------------------------------------------------------------- maths

    /// @dev Median of a small array (at most n values). Even count: mean of the middle two.
    function _median(uint256[] memory v) internal pure returns (uint256) {
        uint256 n = v.length;
        for (uint256 i = 1; i < n; ++i) {
            uint256 x = v[i];
            uint256 j = i;
            while (j > 0 && v[j - 1] > x) {
                v[j] = v[j - 1];
                --j;
            }
            v[j] = x;
        }
        return n % 2 == 1 ? v[n / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
    }

    function _clamp(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        return x < lo ? lo : (x > hi ? hi : x);
    }
}
