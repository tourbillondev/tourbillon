// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PathFundingBook, IMarkRouter, IVolSource} from "./PathFundingBook.sol";
import {TempoBlend} from "./TempoBlend.sol";
import {TempoMath} from "./TempoMath.sol";
import {EnginePricing} from "./EnginePricing.sol";
import {StrategyMath} from "./StrategyMath.sol";
import {MakerVault} from "./MakerVault.sol";
import {IEngineConfig} from "./WriterBook.sol";

/// @notice The pool side of matched writes: an early close is a re-open for the pool, so it may refuse (D3).
interface IMatchPool {
    function onEarlyClose(
        bytes32 market,
        uint256 seriesId,
        uint256 raw,
        uint256 units,
        uint256 sWad,
        uint256 sigmaBps,
        int256 cost,
        uint256 fee,
        address payee
    ) external;
}

/// @title MatchBook
/// @notice Matched writes of the open book (M6 decision D1). A maker fill or a writer-offer fill is a matched pair: the
///         buyer's ordinary position against the pool, plus the source writing the same series and units to the pool
///         with M4's exact collateral (law 4). Matched writes are aggregated per (source, series); a source is one maker
///         (its MakerVault account) or one writer offer (collateral held here). A series holds at most 8 sources.
/// @dev    - `match` / `fillOffer` (router only) lock the exact worst case × units: StrategyMath on the writer's side of
///           the series' legs; on HYPE a maker's net short calls are covered with WHYPE from its vault.
///         - `buyback` (pool only, on every sell): the matched raw closed is min(raw sold, matched raw), pro rata across
///           every source on the series; each pays the pool the seller's gross per raw (rounded up) from the collateral
///           released for those units (USDC, then WHYPE at the sell's mark); the rest returns to the source. Backstop: a
///           shortfall is slashed from the maker's free vault funds, then left to the pool; the source is flagged and its
///           remaining raw on the series is reported uncovered (the pool counts it in coverage from then on). A shortfall
///           of at most `DUST` (1 micro-USDC) per source is rounding: the pool absorbs it, nothing is flagged.
///           The raw closed is exactly min(raw sold, matched raw): pro rata rounded down, the few wei left closed from the
///           first source that holds them.
///         - `claim`: collateral above units now (raw × the series' factor) × worst case returns to the source.
///         - `earlyClose` (D3): the source buys back at the pool's ask, capped at its collateral; the pool may refuse.
///         - Writer offers (D9): `postOffer` locks collateral for `maxUnits` here (plus a few micro-units of slack for
///           per-fill rounding); fills consume it; `cancelOffer` returns the rest.
contract MatchBook is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant WAD_PER_USDC_UNIT = 1e12;
    uint256 public constant MAX_SOURCES = 8;
    uint256 public constant MAX_OFFER_FILLS = 64; // per offer; each fill may round its lock up by one smallest unit
    uint8 public constant KIND_MAKER = 1;
    uint8 public constant KIND_OFFER = 2;
    uint256 public constant DUST = 1; // USDC units: a buyback shortfall up to this per source is rounding, not a default

    struct Source {
        uint8 kind;
        address owner; // the maker, or the offer's writer
        uint256 offerId;
    }

    struct Entry {
        uint256 raw;
        uint256 usdcPerUnit; // WAD USDC per unit
        uint256 coverPerUnit; // WAD WHYPE per unit
        uint256 usdcLocked; // USDC (6 decimals)
        uint256 whypeLocked; // WHYPE (18 decimals)
        bool flagged; // a buyback fell short: its raw is uncovered
    }

    struct Offer {
        address writer;
        bytes32 market;
        uint256 seriesId;
        uint64 sigmaBps;
        uint64 validUntil;
        uint32 fills;
        bool cover;
        bool closed;
        uint128 maxUnits;
        uint128 filled;
        uint256 usdcPerUnit;
        uint256 coverPerUnit;
        uint256 usdcEscrow;
        uint256 whypeEscrow;
    }

    PathFundingBook public immutable book;
    IEngineConfig public immutable engine;
    MakerVault public immutable vault;
    IMarkRouter public immutable marks;
    IVolSource public immutable vols;
    IERC20 public immutable usdc;
    IERC20 public immutable whype;
    address public immutable admin;

    address public router; // set once
    address public pool; // set once

    mapping(bytes32 => Source) public sources;
    mapping(bytes32 => mapping(uint256 => Entry)) public entries; // source key => series => entry
    mapping(uint256 => bytes32[]) internal _seriesSources;
    mapping(uint256 => uint256) public matchedRaw; // covered matched raw per series (sources not flagged)
    mapping(uint256 => uint256) public uncoveredRaw; // matched raw of flagged sources

    mapping(uint256 => Offer) public offers;
    mapping(uint256 => StrategyMath.Leg[]) internal _offerLegs; // the writer's side
    mapping(uint256 => TempoBlend.Part[]) internal _offerMovement;
    uint256 public nextOfferId = 1;
    uint256 public heldUsdc; // USDC this contract holds for offers (escrow + offer entries)
    uint256 public heldWhype;

    event Matched(
        bytes32 indexed key,
        uint256 indexed seriesId,
        uint256 units,
        uint256 raw,
        uint256 usdcLocked,
        uint256 whypeLocked
    );
    event BoughtBack(
        bytes32 indexed key,
        uint256 indexed seriesId,
        uint256 raw,
        uint256 paidUsdc,
        uint256 paidWhype,
        uint256 shortfall
    );
    event Flagged(bytes32 indexed key, uint256 indexed seriesId, uint256 uncoveredRaw);
    event DustAbsorbed(bytes32 indexed key, uint256 indexed seriesId, uint256 usdc);
    event Claimed(bytes32 indexed key, uint256 indexed seriesId, uint256 usdcReleased, uint256 whypeReleased);
    event EarlyClosed(
        bytes32 indexed key, uint256 indexed seriesId, uint256 raw, uint256 units, int256 cost, uint256 fee
    );
    event OfferPosted(
        uint256 indexed offerId,
        address indexed writer,
        uint256 indexed seriesId,
        uint64 sigmaBps,
        uint128 maxUnits,
        uint64 validUntil
    );
    event OfferFilled(uint256 indexed offerId, uint256 units, uint256 raw);
    event OfferCancelled(uint256 indexed offerId, uint256 usdcReturned, uint256 whypeReturned);
    event RoleSet(string role, address who);

    error ZeroAddress();
    error NotAdmin();
    error AlreadySet();
    error NotRouter();
    error NotPool();
    error NotOwner();
    error TooManySources(uint256 seriesId);
    error SourceFlagged(bytes32 key);
    error NothingMatched();
    error NotListed(bytes32 market);
    error BadOffer();
    error OfferClosed(uint256 offerId);
    error OfferExpired(uint256 offerId);
    error OfferTooSmall(uint256 offerId, uint256 left);
    error OfferSeries(uint256 offerId, uint256 seriesId);
    error Expired(uint256 deadline);
    error CostAboveMax(int256 cost, int256 maxCost);

    constructor(
        address admin_,
        PathFundingBook book_,
        IEngineConfig engine_,
        MakerVault vault_,
        IMarkRouter marks_,
        IVolSource vols_
    ) {
        if (
            admin_ == address(0) || address(book_) == address(0) || address(engine_) == address(0)
                || address(vault_) == address(0) || address(marks_) == address(0) || address(vols_) == address(0)
        ) revert ZeroAddress();
        admin = admin_;
        book = book_;
        engine = engine_;
        vault = vault_;
        marks = marks_;
        vols = vols_;
        usdc = vault_.usdc();
        whype = vault_.whype();
    }

    modifier onlyRouter() {
        if (msg.sender != router || router == address(0)) revert NotRouter();
        _;
    }

    modifier onlyPool() {
        if (msg.sender != pool || pool == address(0)) revert NotPool();
        _;
    }

    // ---------------------------------------------------------------- matching (router)

    /// @notice A maker fill: locks the maker's exact collateral in its vault for `units` of series `seriesId`.
    function matchMaker(address maker, uint256 seriesId, uint256 units, uint256 raw)
        external
        nonReentrant
        onlyRouter
        returns (bytes32 key)
    {
        key = keccak256(abi.encode(KIND_MAKER, maker, uint256(0)));
        if (sources[key].kind == 0) sources[key] = Source(KIND_MAKER, maker, 0);
        (bytes32 market, StrategyMath.Leg[] memory wLegs) = _writerTerms(seriesId);
        uint256 cover = market == StrategyMath.COVER_MARKET ? _netShortCalls(wLegs) : 0;
        uint256 perUnit = StrategyMath.writerCollateral(market, wLegs, int256(cover));
        uint256 u = _usdcFor(units, perUnit);
        uint256 h = Math.mulDiv(units, cover, WAD, Math.Rounding.Ceil);
        _add(key, seriesId, raw, perUnit, cover, u, h);
        if (u > 0) vault.lock(maker, usdc, u);
        if (h > 0) vault.lock(maker, whype, h);
        emit Matched(key, seriesId, units, raw, u, h);
    }

    /// @notice A writer-offer fill: moves exact collateral for `units` from the offer's escrow to its matched entry.
    function fillOffer(uint256 offerId, uint256 seriesId, uint256 units, uint256 raw)
        external
        nonReentrant
        onlyRouter
        returns (bytes32 key, uint64 sigmaBps)
    {
        Offer storage o = offers[offerId];
        if (o.writer == address(0) || o.closed) revert OfferClosed(offerId);
        if (block.timestamp > o.validUntil) revert OfferExpired(offerId);
        if (seriesId != o.seriesId) revert OfferSeries(offerId, seriesId);
        uint256 left = o.maxUnits - o.filled;
        if (units > left || o.fills >= MAX_OFFER_FILLS) revert OfferTooSmall(offerId, left);
        uint256 u = _usdcFor(units, o.usdcPerUnit);
        uint256 h = Math.mulDiv(units, o.coverPerUnit, WAD, Math.Rounding.Ceil);
        o.usdcEscrow -= u; // the slack posted with the offer covers per-fill rounding
        o.whypeEscrow -= h;
        o.filled += uint128(units);
        o.fills += 1;
        key = keccak256(abi.encode(KIND_OFFER, o.writer, offerId));
        if (sources[key].kind == 0) sources[key] = Source(KIND_OFFER, o.writer, offerId);
        _add(key, seriesId, raw, o.usdcPerUnit, o.coverPerUnit, u, h);
        emit OfferFilled(offerId, units, raw);
        emit Matched(key, seriesId, units, raw, u, h);
        return (key, o.sigmaBps);
    }

    function _add(bytes32 key, uint256 seriesId, uint256 raw, uint256 perUnit, uint256 cover, uint256 u, uint256 h)
        internal
    {
        Entry storage e = entries[key][seriesId];
        if (e.flagged) revert SourceFlagged(key);
        if (e.raw == 0 && e.usdcLocked == 0 && e.whypeLocked == 0) {
            bytes32[] storage list = _seriesSources[seriesId];
            bool listed;
            for (uint256 i; i < list.length; ++i) {
                if (list[i] == key) listed = true;
            }
            if (!listed) {
                if (list.length >= MAX_SOURCES) revert TooManySources(seriesId);
                list.push(key);
            }
        }
        e.raw += raw;
        e.usdcPerUnit = perUnit;
        e.coverPerUnit = cover;
        e.usdcLocked += u;
        e.whypeLocked += h;
        matchedRaw[seriesId] += raw;
    }

    // ---------------------------------------------------------------- buyback (pool, on every sell)

    struct Closing {
        uint256 rawSold;
        uint256 gross; // USDC the pool paid the seller for rawSold
        uint256 sWad;
        uint256 closeTotal;
        uint256 total;
        bool all;
    }

    /// @notice On a sell of `rawSold` (the pool paid `gross` USDC at mark `sWad`): closes min(rawSold, matched raw)
    ///         pro rata across every source on the series, each paying the pool the seller's gross per raw.
    /// @return paidUsdc   USDC paid to the pool.
    /// @return paidWhype  WHYPE paid to the pool (valued at `sWad`).
    /// @return shortfall  USDC the sources could not pay (the pool absorbs it).
    function buyback(uint256 seriesId, uint256 rawSold, uint256 gross, uint256 sWad)
        external
        nonReentrant
        onlyPool
        returns (uint256 paidUsdc, uint256 paidWhype, uint256 shortfall)
    {
        Closing memory c = Closing(rawSold, gross, sWad, 0, matchedRaw[seriesId], false);
        if (c.total == 0 || rawSold == 0) return (0, 0, 0);
        c.all = rawSold >= c.total;
        c.closeTotal = c.all ? c.total : rawSold;
        bytes32[] storage list = _seriesSources[seriesId];
        uint256 closed;
        // pro rata, rounded down per source; then the few wei left go to the first source that holds them, so the raw
        // closed is exactly min(rawSold, matched raw)
        for (uint256 pass; pass < 2; ++pass) {
            for (uint256 i = list.length; i > 0; --i) {
                bytes32 key = list[i - 1];
                Entry storage e = entries[key][seriesId];
                if (e.flagged || e.raw == 0) continue;
                uint256 rc;
                if (pass == 0) {
                    rc = c.all ? e.raw : Math.mulDiv(c.closeTotal, e.raw, c.total);
                } else {
                    uint256 left = c.closeTotal - closed;
                    if (left == 0) break;
                    rc = left < e.raw ? left : e.raw;
                }
                if (rc == 0) continue;
                closed += rc;
                (uint256 pu, uint256 ph, uint256 sf) = _closeRaw(key, seriesId, rc, c);
                paidUsdc += pu;
                paidWhype += ph;
                shortfall += sf;
                if (e.raw == 0 && e.usdcLocked == 0 && e.whypeLocked == 0) {
                    list[i - 1] = list[list.length - 1];
                    list.pop();
                }
            }
            if (c.all) break;
        }
    }

    function _closeRaw(bytes32 key, uint256 seriesId, uint256 rc, Closing memory c)
        internal
        returns (uint256 pu, uint256 ph, uint256 sf)
    {
        Entry storage e = entries[key][seriesId];
        uint256 due = Math.mulDiv(c.gross, rc, c.rawSold, Math.Rounding.Ceil);
        uint256 partU = rc == e.raw ? e.usdcLocked : Math.mulDiv(e.usdcLocked, rc, e.raw);
        uint256 partH = rc == e.raw ? e.whypeLocked : Math.mulDiv(e.whypeLocked, rc, e.raw);
        e.raw -= rc;
        e.usdcLocked -= partU;
        e.whypeLocked -= partH;
        matchedRaw[seriesId] -= rc;
        (pu, ph, sf) = _settle(sources[key], partU, partH, due, c.sWad, pool);
        if (sf > 0 && sf <= DUST) {
            // rounding (the source's due rounds up, its released collateral down): the pool absorbs it (owner, M6 step 7)
            emit DustAbsorbed(key, seriesId, sf);
        } else if (sf > 0) {
            // the backstop: whatever this source still holds on the series is uncovered from now on
            e.flagged = true;
            matchedRaw[seriesId] -= e.raw;
            uncoveredRaw[seriesId] += e.raw;
            emit Flagged(key, seriesId, e.raw);
        }
        emit BoughtBack(key, seriesId, rc, pu, ph, sf);
    }

    /// @dev Pays `due` USDC to `to` from the released collateral (USDC, then WHYPE at `sWad`), returns the rest to the
    ///      source, and for a maker slashes free vault funds for any shortfall (USDC, then WHYPE).
    function _settle(Source memory src, uint256 partU, uint256 partH, uint256 due, uint256 sWad, address to)
        internal
        returns (uint256 pu, uint256 ph, uint256 left)
    {
        pu = due < partU ? due : partU;
        left = due - pu;
        if (left > 0 && partH > 0) {
            ph = _usdcToWhype(left, sWad);
            if (ph > partH) ph = partH;
            uint256 covered = _whypeToUsdc(ph, sWad);
            left = covered >= left ? 0 : left - covered;
        }
        _move(src, usdc, pu, partU - pu, to);
        _move(src, whype, ph, partH - ph, to);
        if (left > 0 && src.kind == KIND_MAKER) {
            uint256 takenU = vault.slash(src.owner, usdc, left, to);
            pu += takenU;
            left -= takenU;
            if (left > 0) {
                uint256 takenH = vault.slash(src.owner, whype, _usdcToWhype(left, sWad), to);
                ph += takenH;
                uint256 covered = _whypeToUsdc(takenH, sWad);
                left = covered >= left ? 0 : left - covered;
            }
        }
    }

    /// @dev Pays `pay` of `token` to `to` and returns `rest` to the source: a maker's from its vault (pay / unlock), an
    ///      offer's from here (to the pool / to the writer).
    function _move(Source memory src, IERC20 token, uint256 pay, uint256 rest, address to) internal {
        if (src.kind == KIND_MAKER) {
            if (pay > 0) vault.pay(src.owner, token, pay, to);
            if (rest > 0) vault.unlock(src.owner, token, rest);
        } else {
            if (token == usdc) heldUsdc -= pay + rest;
            else heldWhype -= pay + rest;
            if (pay > 0) token.safeTransfer(to, pay);
            if (rest > 0) token.safeTransfer(src.owner, rest);
        }
    }

    // ---------------------------------------------------------------- claims

    /// @notice Returns the collateral no longer required as the series decays (the funding received) to the source.
    function claim(bytes32 key, uint256 seriesId) external nonReentrant returns (uint256 usdcOut, uint256 whypeOut) {
        Source memory src = sources[key];
        if (msg.sender != src.owner) revert NotOwner();
        Entry storage e = entries[key][seriesId];
        (uint256 reqU, uint256 reqH) = required(key, seriesId);
        if (e.usdcLocked > reqU) usdcOut = e.usdcLocked - reqU;
        if (e.whypeLocked > reqH) whypeOut = e.whypeLocked - reqH;
        e.usdcLocked -= usdcOut;
        e.whypeLocked -= whypeOut;
        emit Claimed(key, seriesId, usdcOut, whypeOut);
        _move(src, usdc, 0, usdcOut, address(0));
        _move(src, whype, 0, whypeOut, address(0));
    }

    /// @notice The collateral an entry requires now: units now (raw × the series' factor, rounded up) × per unit.
    function required(bytes32 key, uint256 seriesId) public view returns (uint256 usdcReq, uint256 whypeReq) {
        Entry storage e = entries[key][seriesId];
        if (e.raw == 0) return (0, 0);
        uint256 unitsNow = Math.mulDiv(e.raw, book.normNow(seriesId), WAD, Math.Rounding.Ceil);
        usdcReq = _usdcFor(unitsNow, e.usdcPerUnit);
        whypeReq = Math.mulDiv(unitsNow, e.coverPerUnit, WAD, Math.Rounding.Ceil);
        if (usdcReq > e.usdcLocked) usdcReq = e.usdcLocked;
        if (whypeReq > e.whypeLocked) whypeReq = e.whypeLocked;
    }

    // ---------------------------------------------------------------- early close (D3)

    struct CloseCtx {
        bytes32 market;
        uint256 s;
        uint256 sigma;
        uint256 raw;
        uint256 units;
        int256 cost;
        uint256 fee;
        uint256 partU;
        uint256 partH;
    }

    /// @notice The source buys back `units` (WAD; max = all) of its matched write at the pool's ask, capped at the
    ///         collateral released for them; the pool takes the buyer's side back and may refuse (its open checks).
    function earlyClose(bytes32 key, uint256 seriesId, uint256 units, int256 maxCost, uint256 deadline)
        external
        nonReentrant
        returns (uint256 paidUnits, int256 cost)
    {
        Source memory src = sources[key];
        if (msg.sender != src.owner) revert NotOwner();
        if (block.timestamp > deadline) revert Expired(deadline);
        Entry storage e = entries[key][seriesId];
        if (e.flagged) revert SourceFlagged(key);
        if (e.raw == 0) revert NothingMatched();
        CloseCtx memory c;
        (uint256 norm,) = book.accrue(seriesId, type(uint256).max);
        (c.raw, c.units) = EnginePricing.rawForSell(units, norm, e.raw);
        if (c.raw == 0 || c.units == 0) revert NothingMatched();
        _quoteClose(seriesId, e, c);
        if (c.cost > maxCost) revert CostAboveMax(c.cost, maxCost);
        e.raw -= c.raw;
        e.usdcLocked -= c.partU;
        e.whypeLocked -= c.partH;
        matchedRaw[seriesId] -= c.raw;
        uint256 due = c.cost > 0 ? uint256(c.cost) : 0;
        (,, uint256 left) = _settle(src, c.partU, c.partH, due, c.s, pool);
        if (left > 0) revert CostAboveMax(c.cost, maxCost); // unreachable: the cost is capped at the collateral
        IMatchPool(pool).onEarlyClose(c.market, seriesId, c.raw, c.units, c.s, c.sigma, c.cost, c.fee, src.owner);
        emit EarlyClosed(key, seriesId, c.raw, c.units, c.cost, c.fee);
        return (c.units, c.cost);
    }

    function _quoteClose(uint256 seriesId, Entry storage e, CloseCtx memory c) internal view {
        StrategyMath.Leg[] memory poolLegs;
        TempoBlend.Part[] memory mv;
        (c.market, poolLegs, mv) = _holderTerms(seriesId);
        (c.s, c.sigma) = _inputs(c.market);
        (, uint16 spreadBps,) = engine.markets(c.market);
        int256 v = EnginePricing.shapeValue(poolLegs, c.s, c.sigma, mv, true);
        (c.cost, c.fee) = EnginePricing.shapeUnwriteQuote(v, c.units, poolLegs, c.s, spreadBps);
        bool all = c.raw == e.raw;
        c.partU = all ? e.usdcLocked : Math.mulDiv(e.usdcLocked, c.raw, e.raw);
        c.partH = all ? e.whypeLocked : Math.mulDiv(e.whypeLocked, c.raw, e.raw);
        uint256 cap = c.partU + _whypeToUsdc(c.partH, c.s);
        if (c.cost > int256(cap)) c.cost = int256(cap);
    }

    // ---------------------------------------------------------------- writer offers (D9)

    /// @notice Posts an offer to write `legs` (the writer's side, spelled so the pool's side is the book's one
    ///         spelling) with `movement` at `sigmaBps`, up to `maxUnits`, until `validUntil`; locks the collateral for all
    ///         of it here (plus a few micro-units of slack for per-fill rounding).
    function postOffer(
        bytes32 market,
        StrategyMath.Leg[] calldata legs,
        TempoBlend.Part[] calldata movement,
        uint64 sigmaBps,
        uint128 maxUnits,
        uint64 validUntil,
        bool useCover
    ) external nonReentrant returns (uint256 offerId) {
        (bool listed,,) = engine.markets(market);
        if (!listed) revert NotListed(market);
        if (
            maxUnits == 0 || validUntil < block.timestamp || sigmaBps < TempoMath.DEFAULT_MIN_SIGMA_BPS
                || sigmaBps > TempoMath.DEFAULT_MAX_SIGMA_BPS
        ) revert BadOffer();
        uint256 cover = useCover ? _netShortCallsCd(legs) : 0;
        if (useCover && cover == 0) revert BadOffer();
        uint256 perUnit = StrategyMath.writerCollateral(market, legs, int256(cover));
        offerId = nextOfferId++;
        Offer storage o = offers[offerId];
        o.writer = msg.sender;
        o.market = market;
        o.seriesId = book.idOfShape(market, _negate(legs), movement);
        o.sigmaBps = sigmaBps;
        o.validUntil = validUntil;
        o.cover = useCover;
        o.maxUnits = maxUnits;
        o.usdcPerUnit = perUnit;
        o.coverPerUnit = cover;
        o.usdcEscrow = perUnit > 0 ? _usdcFor(maxUnits, perUnit) + MAX_OFFER_FILLS : 0;
        o.whypeEscrow = cover > 0 ? Math.mulDiv(maxUnits, cover, WAD, Math.Rounding.Ceil) + MAX_OFFER_FILLS : 0;
        for (uint256 j; j < legs.length; ++j) {
            _offerLegs[offerId].push(legs[j]);
        }
        for (uint256 i; i < movement.length; ++i) {
            _offerMovement[offerId].push(movement[i]);
        }
        heldUsdc += o.usdcEscrow;
        heldWhype += o.whypeEscrow;
        emit OfferPosted(offerId, msg.sender, o.seriesId, sigmaBps, maxUnits, validUntil);
        if (o.usdcEscrow > 0) usdc.safeTransferFrom(msg.sender, address(this), o.usdcEscrow);
        if (o.whypeEscrow > 0) whype.safeTransferFrom(msg.sender, address(this), o.whypeEscrow);
    }

    /// @notice Closes an offer (the writer, any time) and returns its unfilled escrow. Filled parts stay matched.
    function cancelOffer(uint256 offerId) external nonReentrant {
        Offer storage o = offers[offerId];
        if (msg.sender != o.writer) revert NotOwner();
        if (o.closed) revert OfferClosed(offerId);
        o.closed = true;
        (uint256 u, uint256 h) = (o.usdcEscrow, o.whypeEscrow);
        o.usdcEscrow = 0;
        o.whypeEscrow = 0;
        heldUsdc -= u;
        heldWhype -= h;
        emit OfferCancelled(offerId, u, h);
        if (u > 0) usdc.safeTransfer(o.writer, u);
        if (h > 0) whype.safeTransfer(o.writer, h);
    }

    /// @notice An offer's legs (the writer's side) and movement, for the router.
    function offerTerms(uint256 offerId)
        external
        view
        returns (StrategyMath.Leg[] memory legs, TempoBlend.Part[] memory movement)
    {
        return (_offerLegs[offerId], _offerMovement[offerId]);
    }

    function seriesSources(uint256 seriesId) external view returns (bytes32[] memory) {
        return _seriesSources[seriesId];
    }

    // ---------------------------------------------------------------- admin (once each)

    function setRouter(address router_) external {
        _setOnce(router_, router);
        router = router_;
        emit RoleSet("router", router_);
    }

    function setPool(address pool_) external {
        _setOnce(pool_, pool);
        pool = pool_;
        emit RoleSet("pool", pool_);
    }

    function _setOnce(address next, address current) internal view {
        if (msg.sender != admin) revert NotAdmin();
        if (current != address(0)) revert AlreadySet();
        if (next == address(0)) revert ZeroAddress();
    }

    // ---------------------------------------------------------------- helpers

    /// @dev The series' market and legs from the holder's (the pool's) side, and its movement.
    function _holderTerms(uint256 seriesId)
        internal
        view
        returns (bytes32 market, StrategyMath.Leg[] memory legs, TempoBlend.Part[] memory mv)
    {
        if (book.isShape(seriesId)) return book.shapeOf(seriesId);
        bool isCall;
        uint128 k;
        (market, isCall, k, mv) = book.seriesOf(seriesId);
        legs = new StrategyMath.Leg[](1);
        legs[0] = StrategyMath.Leg(isCall, k, 1e18);
    }

    /// @dev The series' market and legs from the writer's side (the holder's negated).
    function _writerTerms(uint256 seriesId) internal view returns (bytes32 market, StrategyMath.Leg[] memory w) {
        StrategyMath.Leg[] memory h;
        (market, h,) = _holderTerms(seriesId);
        w = new StrategyMath.Leg[](h.length);
        for (uint256 j; j < h.length; ++j) {
            w[j] = StrategyMath.Leg(h[j].isCall, h[j].kWad, -h[j].qty);
        }
    }

    function _inputs(bytes32 market) internal view returns (uint256 s, uint256 sigma) {
        bool fromSampleS;
        bool fromSampleV;
        try marks.markWad(market) returns (uint256 px) {
            s = px;
        } catch {
            fromSampleS = true;
        }
        try vols.volBps(market) returns (uint256 b) {
            sigma = b;
        } catch {
            fromSampleV = true;
        }
        if (fromSampleS || fromSampleV) {
            (, uint256 sampleS, uint256 sampleSigma) = book.latestSample(market);
            if (fromSampleS) s = sampleS;
            if (fromSampleV) sigma = sampleSigma;
        }
    }

    function _netShortCalls(StrategyMath.Leg[] memory legs) internal pure returns (uint256) {
        int256 slope;
        for (uint256 j; j < legs.length; ++j) {
            if (legs[j].isCall) slope += legs[j].qty;
        }
        return slope < 0 ? uint256(-slope) : 0;
    }

    function _netShortCallsCd(StrategyMath.Leg[] calldata legs) internal pure returns (uint256) {
        int256 slope;
        for (uint256 j; j < legs.length; ++j) {
            if (legs[j].isCall) slope += legs[j].qty;
        }
        return slope < 0 ? uint256(-slope) : 0;
    }

    function _negate(StrategyMath.Leg[] calldata legs) internal pure returns (StrategyMath.Leg[] memory out) {
        out = new StrategyMath.Leg[](legs.length);
        for (uint256 j; j < legs.length; ++j) {
            out[j] = StrategyMath.Leg(legs[j].isCall, legs[j].kWad, -legs[j].qty);
        }
    }

    function _usdcFor(uint256 units, uint256 perUnit) internal pure returns (uint256) {
        return Math.ceilDiv(Math.mulDiv(units, perUnit, WAD, Math.Rounding.Ceil), WAD_PER_USDC_UNIT);
    }

    function _whypeToUsdc(uint256 amount, uint256 s) internal pure returns (uint256) {
        return Math.mulDiv(amount, s, WAD) / WAD_PER_USDC_UNIT;
    }

    function _usdcToWhype(uint256 usdcAmount, uint256 s) internal pure returns (uint256) {
        return Math.mulDiv(usdcAmount * WAD_PER_USDC_UNIT, WAD, s, Math.Rounding.Ceil);
    }
}
