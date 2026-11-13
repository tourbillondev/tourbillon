// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {StrategyMath} from "./StrategyMath.sol";
import {TempoBlend} from "./TempoBlend.sol";
import {TempoMath} from "./TempoMath.sol";

/// @title VolQuote
/// @notice Open book: outside vol makers quote volatility, not prices. A maker signs (EIP-712) the σ at which it will
///         write a band of strikes and tempos on one market, up to a size, until a deadline. The router prices the
///         buyer's whole order with the maker's σ through the same closed form as the pool and fills at the best of
///         makers, writers and the pool. Quotes are asks only: the maker writes, the buyer buys. The maker's side is
///         collateralised exactly (StrategyMath) when it fills.
/// @dev    Quote v2 (M6 decision D7): `sides` (calls, puts or both) replaces `isCall`, so one quote can cover a Swing or
///         a Band; one quote covers every leg of an order, and its tempo band must cover every Movement part; units
///         are the order's (shape) units; σ must sit inside the maths bounds (5%–500%) so pricing at it cannot revert.
///         Makers sign as externally owned accounts (contract signers carried forward).
library VolQuote {
    uint8 internal constant SIDE_CALLS = 1;
    uint8 internal constant SIDE_PUTS = 2;
    uint8 internal constant SIDE_BOTH = 3;

    struct Quote {
        address maker;
        bytes32 name;
        uint8 sides; // 1 calls, 2 puts, 3 both
        uint128 kLoWad; // strike band (inclusive)
        uint128 kHiWad;
        uint32 tauLo; // tempo band, seconds (inclusive), for every Movement part
        uint32 tauHi;
        uint64 sigmaBps; // the maker's vol for this band
        uint128 maxUnits; // WAD, order units
        uint64 validUntil;
        uint64 nonce;
    }

    bytes32 internal constant QUOTE_TYPEHASH = keccak256(
        "Quote(address maker,bytes32 name,uint8 sides,uint128 kLoWad,uint128 kHiWad,uint32 tauLo,uint32 tauHi,uint64 sigmaBps,uint128 maxUnits,uint64 validUntil,uint64 nonce)"
    );

    error BadSignature();
    error Expired();
    error OutOfBand();
    error TooLarge();
    error BadSides(uint8 sides);
    error SigmaOutOfRange(uint64 sigmaBps);

    function structHash(Quote memory q) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                QUOTE_TYPEHASH,
                q.maker,
                q.name,
                q.sides,
                q.kLoWad,
                q.kHiWad,
                q.tauLo,
                q.tauHi,
                q.sigmaBps,
                q.maxUnits,
                q.validUntil,
                q.nonce
            )
        );
    }

    function digest(bytes32 domainSeparator, Quote memory q) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash(q)));
    }

    /// @notice Checks the signature (EOA only), the quote's own terms, the deadline, and that the whole order (every
    ///         leg's side and strike, every Movement part's tempo, the units given the size already filled) fits.
    function check(
        bytes32 domainSeparator,
        Quote memory q,
        bytes memory sig,
        bytes32 name,
        StrategyMath.Leg[] memory legs,
        TempoBlend.Part[] memory movement,
        uint128 units,
        uint128 alreadyFilled,
        uint256 nowTs
    ) internal pure {
        if (ECDSA.recover(digest(domainSeparator, q), sig) != q.maker) revert BadSignature();
        if (q.sides == 0 || q.sides > SIDE_BOTH) revert BadSides(q.sides);
        if (q.sigmaBps < TempoMath.DEFAULT_MIN_SIGMA_BPS || q.sigmaBps > TempoMath.DEFAULT_MAX_SIGMA_BPS) {
            revert SigmaOutOfRange(q.sigmaBps);
        }
        if (nowTs > q.validUntil) revert Expired();
        if (q.name != name || legs.length == 0 || movement.length == 0) revert OutOfBand();
        for (uint256 j; j < legs.length; ++j) {
            uint8 side = legs[j].isCall ? SIDE_CALLS : SIDE_PUTS;
            if (q.sides & side == 0 || legs[j].kWad < q.kLoWad || legs[j].kWad > q.kHiWad) revert OutOfBand();
        }
        for (uint256 i; i < movement.length; ++i) {
            if (movement[i].tempo < q.tauLo || movement[i].tempo > q.tauHi) revert OutOfBand();
        }
        if (uint256(alreadyFilled) + units > q.maxUnits) revert TooLarge();
    }
}

/// @title VolQuoteBook
/// @notice Keeps the state of maker quotes: cumulative fills per (maker, nonce) and cancelled nonces. EIP-712 domain:
///         name "Tourbillon", version "1", chain id from the current chain, this contract as verifying contract. Only
///         the filler (the OpenBook router, M6) records fills; a maker cancels its own nonces.
contract VolQuoteBook is EIP712 {
    address public immutable filler;

    mapping(address => mapping(uint64 => uint128)) public filled; // maker => nonce => units filled
    mapping(address => mapping(uint64 => bool)) public cancelled; // maker => nonce => cancelled

    event Filled(address indexed maker, uint64 indexed nonce, uint128 units, uint128 totalFilled, uint64 sigmaBps);
    event Cancelled(address indexed maker, uint64 indexed nonce);

    error NotFiller();
    error NonceCancelled(address maker, uint64 nonce);
    error ZeroUnits();

    constructor(address filler_) EIP712("Tourbillon", "1") {
        filler = filler_;
    }

    function domainSeparator() public view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice The EIP-712 digest a maker signs for `q`.
    function hashQuote(VolQuote.Quote memory q) public view returns (bytes32) {
        return VolQuote.digest(_domainSeparatorV4(), q);
    }

    /// @notice Reverts unless an order of `units` (legs and movement on `name`) can fill against `q` now.
    function check(
        VolQuote.Quote memory q,
        bytes memory sig,
        bytes32 name,
        StrategyMath.Leg[] memory legs,
        TempoBlend.Part[] memory movement,
        uint128 units
    ) public view {
        if (units == 0) revert ZeroUnits();
        if (cancelled[q.maker][q.nonce]) revert NonceCancelled(q.maker, q.nonce);
        VolQuote.check(
            _domainSeparatorV4(), q, sig, name, legs, movement, units, filled[q.maker][q.nonce], block.timestamp
        );
    }

    /// @notice Filler only: checks and records a fill; returns the maker's σ to price it with.
    function fill(
        VolQuote.Quote memory q,
        bytes memory sig,
        bytes32 name,
        StrategyMath.Leg[] memory legs,
        TempoBlend.Part[] memory movement,
        uint128 units
    ) external returns (uint64 sigmaBps) {
        if (msg.sender != filler) revert NotFiller();
        check(q, sig, name, legs, movement, units);
        uint128 total = filled[q.maker][q.nonce] + units;
        filled[q.maker][q.nonce] = total;
        emit Filled(q.maker, q.nonce, units, total, q.sigmaBps);
        return q.sigmaBps;
    }

    /// @notice Cancels the caller's quotes signed with `nonce`.
    function cancel(uint64 nonce) external {
        cancelled[msg.sender][nonce] = true;
        emit Cancelled(msg.sender, nonce);
    }
}
