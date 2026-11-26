// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PathFundingBook, IMarkRouter, IVolSource} from "./PathFundingBook.sol";
import {TempoBlend} from "./TempoBlend.sol";
import {TempoMath} from "./TempoMath.sol";
import {EnginePricing} from "./EnginePricing.sol";
import {StrategyMath} from "./StrategyMath.sol";
import {ICoveringAssets} from "./CoveringAssets.sol";
import {CoverLedger, ICoverOutage} from "./CoverLedger.sol";
import {ShapeQuote} from "./ShapeQuote.sol";
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
///           the series' legs; on a tokenized-stock market a maker's net short calls are covered with that stock from
///           its vault (CoveringAssets: a stock covers Rises on its own market only).
///         - `buyback` (pool only, on every sell): the matched raw closed is min(raw sold, matched raw), pro rata across
///           every source on the series; each pays the pool the seller's gross per raw (rounded up) from the collateral
///           released for those units (settlement token, then the cover at the sell's mark); the rest goes back to the source. Backstop: a
///           shortfall is slashed from the maker's free vault balance, then left to the pool; the source is flagged and its
///           remaining raw on the series is reported uncovered (the pool counts it in coverage from then on). A shortfall
///           of at most `DUST` (1 micro-settlement token) per source is rounding: the pool absorbs it, nothing is flagged.
///           The raw closed is exactly min(raw sold, matched raw): pro rata rounded down, the few wei left closed from the
///           first source that holds them.
///         - `claim`: collateral above units now (raw × the series' factor) × worst case goes back to the source.
///         - `earlyClose` (D3): the source buys back at the pool's ask, capped at its collateral; the pool may refuse.
///         - Writer offers (D9): `postOffer` locks collateral for `maxUnits` here (plus a few micro-units of slack for
///           per-fill rounding); fills consume it; `cancelOffer` sends back the rest.
///         - Covering tokens (owner D3): a covering token that cannot move during a buyback, a claim, a close or a cancel
///           stays owed (here or in the vault; anyone settles it once transfers work), and opens on that market pause.
///           settlement token payments and the buyer's sell go on (law 3).
contract MatchBook is CoverLedger {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant WAD_PER_SETTLEMENT_UNIT = 1e12;
    uint256 public constant MAX_SOURCES = 8;
    uint256 public constant MAX_OFFER_FILLS = 64; // per offer; each fill may round its lock up by one smallest unit
    uint8 public constant KIND_MAKER = 1;
    uint8 public constant KIND_OFFER = 2;
    uint256 public constant DUST = 1; // settlement token units: a buyback shortfall up to this per source is rounding, not a default

    struct Source {
        uint8 kind;
        address owner; // the maker, or the offer's writer
        uint256 offerId;
    }

    struct Entry {
        uint256 raw;
        uint256 settlementPerUnit; // WAD settlement token per unit
        uint256 coverPerUnit; // WAD covering units (of the stock) per unit
        uint256 settlementLocked; // settlement token (6 decimals)
        uint256 coverLocked; // the market's covering token, in its own units
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
        uint256 settlementPerUnit;
        uint256 coverPerUnit;
        uint256 settlementEscrow;
        uint256 coverEscrow;
    }

    PathFundingBook public immutable book;
    IEngineConfig public immutable engine;
    MakerVault public immutable vault;
    IMarkRouter public immutable marks;
    IVolSource public immutable vols;
    IERC20 public immutable settlement;
    ICoveringAssets public immutable covers;
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
    uint256 public heldSettlement; // settlement token this contract holds for offers (escrow + offer entries)
    mapping(IERC20 => uint256) public heldCover; // covering tokens held for offers, per token
    mapping(uint256 => bytes32) public seriesMarket; // set at a series' first match

    event Matched(
        bytes32 indexed key,
        uint256 indexed seriesId,
        uint256 units,
        uint256 raw,
        uint256 settlementLocked,
        uint256 coverLocked
    );
    event BoughtBack(
        bytes32 indexed key,
        uint256 indexed seriesId,
        uint256 raw,
        uint256 paidSettlement,
        uint256 paidCover,
        uint256 shortfall
    );
    event Flagged(bytes32 indexed key, uint256 indexed seriesId, uint256 uncoveredRaw);
    event DustAbsorbed(bytes32 indexed key, uint256 indexed seriesId, uint256 settlement);
    event Claimed(bytes32 indexed key, uint256 indexed seriesId, uint256 settlementReleased, uint256 coverReleased);
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
    event OfferCancelled(uint256 indexed offerId, uint256 settlementReturned, uint256 coverReturned);
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
        settlement = vault_.settlement();
        covers = vault_.covers();
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
        (IERC20 t, uint256 scale) = covers.coverOf(market);
        uint256 cover = address(t) != address(0) ? _netShortCalls(wLegs) : 0;
        uint256 perUnit = StrategyMath.writerCollateral(address(t) != address(0), wLegs, int256(cover));
        uint256 u = _settlementFor(units, perUnit);
        uint256 h = _coverFor(units, cover, scale);
        _add(key, seriesId, market, raw, perUnit, cover, u, h);
        if (u > 0) vault.lock(maker, settlement, u);
        if (h > 0) {
            covers.checkCover(market, address(vault), pool, h);
            vault.lock(maker, t, h);
        }
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
        uint256 u = _settlementFor(units, o.settlementPerUnit);
        (, uint256 scale) = covers.coverOf(o.market);
        uint256 h = _coverFor(units, o.coverPerUnit, scale);
        o.settlementEscrow -= u; // the slack posted with the offer covers per-fill rounding
        o.coverEscrow -= h;
        o.filled += uint128(units);
        o.fills += 1;
        key = keccak256(abi.encode(KIND_OFFER, o.writer, offerId));
        if (sources[key].kind == 0) sources[key] = Source(KIND_OFFER, o.writer, offerId);
        _add(key, seriesId, o.market, raw, o.settlementPerUnit, o.coverPerUnit, u, h);
        emit OfferFilled(offerId, units, raw);
        emit Matched(key, seriesId, units, raw, u, h);
        return (key, o.sigmaBps);
    }

    function _add(
        bytes32 key,
        uint256 seriesId,
        bytes32 market,
        uint256 raw,
        uint256 perUnit,
        uint256 cover,
        uint256 u,
        uint256 h
    ) internal {
        Entry storage e = entries[key][seriesId];
        if (e.flagged) revert SourceFlagged(key);
        if (seriesMarket[seriesId] == bytes32(0)) seriesMarket[seriesId] = market;
        if (e.raw == 0 && e.settlementLocked == 0 && e.coverLocked == 0) {
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
        e.settlementPerUnit = perUnit;
        e.coverPerUnit = cover;
        e.settlementLocked += u;
        e.coverLocked += h;
        matchedRaw[seriesId] += raw;
    }

    // ---------------------------------------------------------------- buyback (pool, on every sell)

    struct Closing {
        uint256 rawSold;
        uint256 gross; // settlement token the pool paid the seller for rawSold
        uint256 sWad;
        uint256 closeTotal;
        uint256 total;
        bool all;
    }

    /// @dev The covering token of the series being settled, and whether any of it could not move.
    struct Cov {
        bytes32 market;
        IERC20 token;
        uint256 scale;
        bool stuck;
    }

    /// @notice On a sell of `rawSold` (the pool paid `gross` settlement token at mark `sWad`): closes min(rawSold, matched raw)
    ///         pro rata across every source on the series, each paying the pool the seller's gross per raw.
    /// @return paidSettlement   settlement token paid to the pool.
    /// @return paidCover  covering tokens paid to the pool (own units, valued at `sWad`); a part that could not move is
    ///                    owed to the pool and settles later.
    /// @return shortfall  settlement token the sources could not pay (the pool absorbs it).
    function buyback(uint256 seriesId, uint256 rawSold, uint256 gross, uint256 sWad)
        external
        nonReentrant
        onlyPool
        returns (uint256 paidSettlement, uint256 paidCover, uint256 shortfall)
    {
        Closing memory c = Closing(rawSold, gross, sWad, 0, matchedRaw[seriesId], false);
        Cov memory cv = _cov(seriesId);
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
                (uint256 pu, uint256 ph, uint256 sf) = _closeRaw(key, seriesId, rc, c, cv);
                paidSettlement += pu;
                paidCover += ph;
                shortfall += sf;
                if (e.raw == 0 && e.settlementLocked == 0 && e.coverLocked == 0) {
                    list[i - 1] = list[list.length - 1];
                    list.pop();
                }
            }
            if (c.all) break;
        }
        if (cv.stuck) ICoverOutage(pool).onCoverStuck(cv.market);
    }

    function _closeRaw(bytes32 key, uint256 seriesId, uint256 rc, Closing memory c, Cov memory cv)
        internal
        returns (uint256 pu, uint256 ph, uint256 sf)
    {
        Entry storage e = entries[key][seriesId];
        uint256 due = Math.mulDiv(c.gross, rc, c.rawSold, Math.Rounding.Ceil);
        uint256 partU = rc == e.raw ? e.settlementLocked : Math.mulDiv(e.settlementLocked, rc, e.raw);
        uint256 partH = rc == e.raw ? e.coverLocked : Math.mulDiv(e.coverLocked, rc, e.raw);
        e.raw -= rc;
        e.settlementLocked -= partU;
        e.coverLocked -= partH;
        matchedRaw[seriesId] -= rc;
        (pu, ph, sf) = _settle(sources[key], partU, partH, due, c.sWad, pool, cv);
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

    /// @dev Pays `due` settlement token to `to` from the released collateral (settlement token, then the cover at `sWad`), sends the rest back to
    ///      the source, and for a maker slashes free vault balance for any shortfall (settlement token, then cover). Cover that cannot
    ///      move is kept owed and marks `cv.stuck`.
    function _settle(
        Source memory src,
        uint256 partU,
        uint256 partH,
        uint256 due,
        uint256 sWad,
        address to,
        Cov memory cv
    ) internal returns (uint256 pu, uint256 ph, uint256 left) {
        pu = due < partU ? due : partU;
        left = due - pu;
        if (left > 0 && partH > 0) {
            ph = _settlementToCover(left, cv.scale, sWad);
            if (ph > partH) ph = partH;
            uint256 covered = _coverToSettlement(ph, cv.scale, sWad);
            left = covered >= left ? 0 : left - covered;
        }
        _move(src, settlement, pu, partU - pu, to);
        if (!_move(src, cv.token, ph, partH - ph, to)) cv.stuck = true;
        if (left > 0 && src.kind == KIND_MAKER) {
            (uint256 takenU,) = vault.slash(src.owner, settlement, left, to);
            pu += takenU;
            left -= takenU;
            if (left > 0 && address(cv.token) != address(0)) {
                (uint256 takenH, bool sent) = vault.slash(src.owner, cv.token, _settlementToCover(left, cv.scale, sWad), to);
                if (!sent) cv.stuck = true;
                ph += takenH;
                uint256 covered = _coverToSettlement(takenH, cv.scale, sWad);
                left = covered >= left ? 0 : left - covered;
            }
        }
    }

    /// @dev Pays `pay` of `token` to `to` and sends `rest` back to the source: a maker's from its vault (pay / unlock), an
    ///      offer's from here (to the pool / to the writer). False when a covering token could not move (kept owed).
    function _move(Source memory src, IERC20 token, uint256 pay, uint256 rest, address to) internal returns (bool ok) {
        ok = true;
        if (pay == 0 && rest == 0) return true;
        if (src.kind == KIND_MAKER) {
            if (pay > 0) ok = vault.pay(src.owner, token, pay, to);
            if (rest > 0) vault.unlock(src.owner, token, rest);
        } else if (token == settlement) {
            heldSettlement -= pay + rest;
            if (pay > 0) token.safeTransfer(to, pay);
            if (rest > 0) token.safeTransfer(src.owner, rest);
        } else {
            heldCover[token] -= pay + rest;
            ok = _sendCover(token, to, pay);
            ok = _sendCover(token, src.owner, rest) && ok;
        }
    }

    // ---------------------------------------------------------------- claims

    /// @notice Sends back the collateral no longer required as the series decays (the funding received) to the source.
    function claim(bytes32 key, uint256 seriesId) external nonReentrant returns (uint256 settlementOut, uint256 coverOut) {
        Source memory src = sources[key];
        if (msg.sender != src.owner) revert NotOwner();
        Entry storage e = entries[key][seriesId];
        (uint256 reqU, uint256 reqH) = required(key, seriesId);
        if (e.settlementLocked > reqU) settlementOut = e.settlementLocked - reqU;
        if (e.coverLocked > reqH) coverOut = e.coverLocked - reqH;
        e.settlementLocked -= settlementOut;
        e.coverLocked -= coverOut;
        emit Claimed(key, seriesId, settlementOut, coverOut);
        _move(src, settlement, 0, settlementOut, address(0));
        Cov memory cv = _cov(seriesId);
        if (!_move(src, cv.token, 0, coverOut, address(0))) ICoverOutage(pool).onCoverStuck(cv.market);
    }

    /// @notice The collateral an entry requires now: units now (raw × the series' factor, rounded up) × per unit.
    function required(bytes32 key, uint256 seriesId) public view returns (uint256 settlementReq, uint256 coverReq) {
        Entry storage e = entries[key][seriesId];
        if (e.raw == 0) return (0, 0);
        uint256 unitsNow = Math.mulDiv(e.raw, book.normNow(seriesId), WAD, Math.Rounding.Ceil);
        settlementReq = _settlementFor(unitsNow, e.settlementPerUnit);
        if (e.coverPerUnit > 0) coverReq = _coverFor(unitsNow, e.coverPerUnit, _cov(seriesId).scale);
        if (settlementReq > e.settlementLocked) settlementReq = e.settlementLocked;
        if (coverReq > e.coverLocked) coverReq = e.coverLocked;
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
        e.settlementLocked -= c.partU;
        e.coverLocked -= c.partH;
        matchedRaw[seriesId] -= c.raw;
        uint256 due = c.cost > 0 ? uint256(c.cost) : 0;
        Cov memory cv = _cov(seriesId);
        (,, uint256 left) = _settle(src, c.partU, c.partH, due, c.s, pool, cv);
        if (left > 0) revert CostAboveMax(c.cost, maxCost); // unreachable: the cost is capped at the collateral
        if (cv.stuck) ICoverOutage(pool).onCoverStuck(cv.market);
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
        (c.cost, c.fee) = ShapeQuote.unwriteQuote(poolLegs, c.s, c.sigma, mv, c.units, spreadBps);
        bool all = c.raw == e.raw;
        c.partU = all ? e.settlementLocked : Math.mulDiv(e.settlementLocked, c.raw, e.raw);
        c.partH = all ? e.coverLocked : Math.mulDiv(e.coverLocked, c.raw, e.raw);
        uint256 cap = c.partU + _coverToSettlement(c.partH, _cov(seriesId).scale, c.s);
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
        (IERC20 t, uint256 scale) = covers.coverOf(market);
        uint256 cover = useCover ? _netShortCallsCd(legs) : 0;
        if (useCover && cover == 0) revert BadOffer();
        uint256 perUnit = StrategyMath.writerCollateral(address(t) != address(0), legs, int256(cover));
        offerId = nextOfferId++;
        Offer storage o = offers[offerId];
        o.writer = msg.sender;
        o.market = market;
        o.seriesId = book.idOfShape(market, _negate(legs), movement);
        o.sigmaBps = sigmaBps;
        o.validUntil = validUntil;
        o.cover = useCover;
        o.maxUnits = maxUnits;
        o.settlementPerUnit = perUnit;
        o.coverPerUnit = cover;
        o.settlementEscrow = perUnit > 0 ? _settlementFor(maxUnits, perUnit) + MAX_OFFER_FILLS : 0;
        o.coverEscrow = cover > 0 ? _coverFor(maxUnits, cover, scale) + MAX_OFFER_FILLS : 0;
        for (uint256 j; j < legs.length; ++j) {
            _offerLegs[offerId].push(legs[j]);
        }
        for (uint256 i; i < movement.length; ++i) {
            _offerMovement[offerId].push(movement[i]);
        }
        heldSettlement += o.settlementEscrow;
        if (o.coverEscrow > 0) {
            heldCover[t] += o.coverEscrow;
            covers.checkCover(market, msg.sender, address(this), o.coverEscrow);
            covers.checkCover(market, address(this), pool, o.coverEscrow);
        }
        emit OfferPosted(offerId, msg.sender, o.seriesId, sigmaBps, maxUnits, validUntil);
        if (o.settlementEscrow > 0) settlement.safeTransferFrom(msg.sender, address(this), o.settlementEscrow);
        _pullCoverExact(t, msg.sender, o.coverEscrow);
    }

    /// @notice Closes an offer (the writer, any time) and sends back its unfilled escrow. Filled parts stay matched.
    function cancelOffer(uint256 offerId) external nonReentrant {
        Offer storage o = offers[offerId];
        if (msg.sender != o.writer) revert NotOwner();
        if (o.closed) revert OfferClosed(offerId);
        o.closed = true;
        (uint256 u, uint256 h) = (o.settlementEscrow, o.coverEscrow);
        o.settlementEscrow = 0;
        o.coverEscrow = 0;
        heldSettlement -= u;
        emit OfferCancelled(offerId, u, h);
        if (u > 0) settlement.safeTransfer(o.writer, u);
        if (h > 0) {
            (IERC20 t,) = covers.coverOf(o.market);
            heldCover[t] -= h;
            if (!_sendCover(t, o.writer, h)) ICoverOutage(pool).onCoverStuck(o.market);
        }
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

    function _settlementFor(uint256 units, uint256 perUnit) internal pure returns (uint256) {
        return Math.ceilDiv(Math.mulDiv(units, perUnit, WAD, Math.Rounding.Ceil), WAD_PER_SETTLEMENT_UNIT);
    }

    /// @dev The series' market, its covering token and scale (none on a market without cover).
    function _cov(uint256 seriesId) internal view returns (Cov memory cv) {
        cv.market = seriesMarket[seriesId];
        (cv.token, cv.scale) = covers.coverOf(cv.market);
    }

    /// @dev Covering tokens (own units) for `units` at `perUnit` WAD covering units, rounded up.
    function _coverFor(uint256 units, uint256 perUnit, uint256 scale) internal pure returns (uint256) {
        if (perUnit == 0) return 0;
        return Math.ceilDiv(Math.mulDiv(units, perUnit, WAD, Math.Rounding.Ceil), scale);
    }

    function _coverToSettlement(uint256 amount, uint256 scale, uint256 s) internal pure returns (uint256) {
        return Math.mulDiv(amount * scale, s, WAD) / WAD_PER_SETTLEMENT_UNIT;
    }

    function _settlementToCover(uint256 settlementAmount, uint256 scale, uint256 s) internal pure returns (uint256) {
        return Math.ceilDiv(Math.mulDiv(settlementAmount * WAD_PER_SETTLEMENT_UNIT, WAD, s, Math.Rounding.Ceil), scale);
    }
}
