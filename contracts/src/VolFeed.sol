// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TempoBlend} from "./TempoBlend.sol";
import {PathFunding} from "./PathFunding.sol";

/// @title VolFeed
/// @notice The public vol feed (M6 decision D11; spec: "Free to read on-chain; history and API via the Tourbillon API").
///         Per market and tempo bucket (1 hour, 1 day, 7 days, 30 days) it keeps the σ of the open book's fills: the last
///         fill's σ, a size-weighted average that halves its weights every day, the number of fills, and the board's σ at
///         the last fill. Informational: nothing prices from it, so it never changes the pool's price (law 6).
/// @dev    - Written only by the recorder (the OpenBook router, set once by the admin) on every maker and writer-offer
///           fill; pool fills are at the board's σ already and are not recorded.
///         - A fill's bucket is the one nearest (on a log scale) to its weighted-average tempo; for a single tempo, its
///           own. Boundaries: √(1 h·1 d) ≈ 4.9 h, √(1 d·7 d) ≈ 2.6 d, √(7 d·30 d) ≈ 14.5 d.
///         - Weights are USDC notional; both sums decay by exp(−ln 2 · Δt / 1 day) before a fill is added, so the average
///           is unchanged between fills (a uniform decay does not move a ratio).
contract VolFeed {
    uint256 public constant BUCKETS = 4;
    uint256 internal constant LN2_WAD = 693147180559945309;
    uint256 internal constant HALF_LIFE = 1 days;

    struct Cell {
        uint64 lastSigma; // bps
        uint64 boardSigmaAtLast; // bps, 0 if the board was stale
        uint32 count;
        uint40 updatedAt;
        uint256 wSigma; // Σ weight × σ, decayed
        uint256 w; // Σ weight, decayed
    }

    address public immutable admin;
    address public recorder; // set once

    mapping(bytes32 => mapping(uint256 => Cell)) internal _cells;

    event Fill(
        bytes32 indexed market,
        uint8 indexed bucket,
        uint8 kind,
        uint256 sigmaBps,
        uint256 boardSigmaBps,
        uint256 weight
    );
    event RecorderSet(address recorder);

    error NotAdmin();
    error AlreadySet();
    error ZeroAddress();
    error NotRecorder();

    constructor(address admin_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
    }

    function setRecorder(address recorder_) external {
        if (msg.sender != admin) revert NotAdmin();
        if (recorder != address(0)) revert AlreadySet();
        if (recorder_ == address(0)) revert ZeroAddress();
        recorder = recorder_;
        emit RecorderSet(recorder_);
    }

    /// @notice Recorder only: a fill on `market` with `movement` at `sigmaBps`, weighing `weight` (USDC notional).
    function record(
        bytes32 market,
        TempoBlend.Part[] calldata movement,
        uint256 sigmaBps,
        uint256 boardSigmaBps,
        uint256 weight,
        uint8 kind
    ) external {
        if (msg.sender != recorder || recorder == address(0)) revert NotRecorder();
        uint8 b = bucketOf(movement);
        Cell storage c = _cells[market][b];
        if (c.updatedAt != 0 && block.timestamp > c.updatedAt) {
            uint256 f = PathFunding.factor(LN2_WAD * (block.timestamp - c.updatedAt) / HALF_LIFE);
            c.wSigma = c.wSigma * f / 1e18;
            c.w = c.w * f / 1e18;
        }
        c.wSigma += weight * sigmaBps;
        c.w += weight;
        c.lastSigma = uint64(sigmaBps);
        c.boardSigmaAtLast = uint64(boardSigmaBps);
        c.count += 1;
        c.updatedAt = uint40(block.timestamp);
        emit Fill(market, b, kind, sigmaBps, boardSigmaBps, weight);
    }

    /// @notice The feed for `market` and `bucket`: the last fill's σ, the size-weighted average σ (0 with no fills), the
    ///         board's σ at the last fill, the number of fills and the last update time.
    function read(bytes32 market, uint256 bucket)
        external
        view
        returns (uint256 lastSigma, uint256 avgSigma, uint256 boardSigmaAtLast, uint256 count, uint256 updatedAt)
    {
        Cell storage c = _cells[market][bucket];
        avgSigma = c.w == 0 ? 0 : c.wSigma / c.w;
        return (c.lastSigma, avgSigma, c.boardSigmaAtLast, c.count, c.updatedAt);
    }

    /// @notice The bucket of a movement: nearest (log scale) to its weighted-average tempo.
    function bucketOf(TempoBlend.Part[] calldata movement) public pure returns (uint8) {
        uint256 t;
        for (uint256 i; i < movement.length; ++i) {
            t += movement[i].tempo * movement[i].weight;
        }
        t /= 1e18;
        if (t < 17_636) return 0; // √(3,600 × 86,400)
        if (t < 228_593) return 1; // √(86,400 × 604,800)
        if (t < 1_252_055) return 2; // √(604,800 × 2,592,000)
        return 3;
    }
}
