// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PathFundingBook, IMarkRouter, IVolSource} from "./PathFundingBook.sol";
import {TempoBlend} from "./TempoBlend.sol";
import {EnginePricing} from "./EnginePricing.sol";
import {StrategyMath} from "./StrategyMath.sol";
import {IWriteCounterparty} from "./IWriteCounterparty.sol";
import {ICoveringAssets} from "./CoveringAssets.sol";
import {CoverLedger, ICoverOutage} from "./CoverLedger.sol";

interface IEngineConfig {
    function markets(bytes32 market) external view returns (bool listed, uint16 spreadBps, uint128 strikeStepWad);
    function buysPaused() external view returns (bool);
}

/// @title WriterBook
/// @notice Writing any shape against exact collateral (M4). The writer locks the exact worst case of what they sell:
///         settlement token, and on a tokenized-stock market optionally that stock covering short calls (CoveringAssets: a stock
///         covers Rises on its own market only). The pool takes the other side at its bid (D1).
/// @dev    - Legs are the writer's own position (+ long, − short). The book series is the pool's side (the legs
///           negated), opened through the book's `openShape` (one spelling per shape, the complexity cap).
///         - Collateral per shape unit is StrategyMath's exact worst case: `settlementPerUnit` (WAD settlement token) given
///           `coverPerUnit` covering units (WAD of the stock), which is exactly the net short calls when the writer asks
///           for cover. Locked = units × per unit, rounded up, in the token's own units (law 4).
///         - Covering tokens move through CoverLedger: a pull must arrive exactly; at write time the token must not be
///           paused and its restriction check (where it has one) must allow writer → book and book → pool. A covering
///           token that cannot move later is kept owed (anyone settles it once transfers work) and opens on that
///           market pause (owner D3); settlement token payments go on.
///         - A write's obligation is raw × the series' shared decay factor. The factor never rises (D2), so the
///           obligation only shrinks; `claim` sends back what is no longer required (the funding received).
///         - `unwrite` buys back at the pool's ask, capped at the collateral's value at the unwrite's mark, paid from
///           locked settlement token, then the locked cover at that mark, then the writer's wallet. Never paused; the last recorded
///           sample prices it when the mark or vol is stale (as a sell).
///         - Writes follow the Engine's markets, spreads and buy pause; the pool refuses writes while opens or the
///           market are paused.
contract WriterBook is CoverLedger {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant WAD_PER_SETTLEMENT_UNIT = 1e12;
    uint256 public constant TRADE_MAX_STEPS = 16;

    struct Write {
        address writer;
        bytes32 market;
        uint256 seriesId;
        uint256 raw;
        uint256 settlementPerUnit; // WAD settlement token per shape unit
        uint256 coverPerUnit; // WAD covering units (of the stock) per shape unit
        uint256 settlementLocked; // settlement token (6 decimals)
        uint256 coverLocked; // the market's covering token, in its own units
    }

    PathFundingBook public immutable book;
    IEngineConfig public immutable engine;
    IWriteCounterparty public immutable pool;
    IMarkRouter public immutable marks;
    IVolSource public immutable vols;
    IERC20 public immutable settlement;
    ICoveringAssets public immutable covers;

    mapping(uint256 => Write) public writes;
    uint256 public nextWriteId = 1;
    uint256 public totalSettlementLocked;
    mapping(IERC20 => uint256) public totalCoverLocked;

    event Written(
        address indexed writer,
        uint256 indexed writeId,
        uint256 indexed seriesId,
        bytes32 market,
        uint256 units,
        uint256 raw,
        uint256 sWad,
        uint256 sigmaBps,
        uint256 settlementLocked,
        uint256 coverLocked,
        int256 credit,
        uint256 fee
    );
    event Claimed(uint256 indexed writeId, uint256 settlementReleased, uint256 coverReleased);
    event Unwritten(
        uint256 indexed writeId,
        uint256 units,
        uint256 raw,
        uint256 sWad,
        uint256 sigmaBps,
        int256 cost,
        uint256 fee,
        uint256 settlementPaid,
        uint256 coverPaid,
        uint256 walletPaid,
        bool capped,
        bool markFromSample,
        bool volFromSample
    );

    error ZeroAddress();
    error WritesArePaused();
    error Expired(uint256 deadline);
    error ZeroUnits();
    error NotListed(bytes32 market);
    error NotCaughtUp(uint256 seriesId);
    error ZeroRaw();
    error NoCoverNeeded();
    error CreditBelowMin(int256 credit, int256 minCredit);
    error CostAboveMax(int256 cost, int256 maxCost);
    error NotWriter(uint256 writeId);
    error NothingToUnwrite(uint256 writeId);

    constructor(
        PathFundingBook book_,
        IEngineConfig engine_,
        IWriteCounterparty pool_,
        IMarkRouter marks_,
        IVolSource vols_,
        IERC20 settlement_,
        ICoveringAssets covers_
    ) {
        if (
            address(book_) == address(0) || address(engine_) == address(0) || address(pool_) == address(0)
                || address(marks_) == address(0) || address(vols_) == address(0) || address(settlement_) == address(0)
                || address(covers_) == address(0)
        ) revert ZeroAddress();
        book = book_;
        engine = engine_;
        pool = pool_;
        marks = marks_;
        vols = vols_;
        settlement = settlement_;
        covers = covers_;
    }

    // ---------------------------------------------------------------- write

    struct WriteCtx {
        uint256 s;
        uint256 sigma;
        uint16 spreadBps;
        uint256 seriesId;
        uint256 raw;
        int256 credit;
        uint256 fee;
        uint256 settlementPerUnit;
        uint256 coverPerUnit;
        IERC20 coverToken;
        uint256 coverScale;
    }

    /// @notice Writes `units` (WAD) of a shape on `market`: `legs` from the writer's side, spelled the book's one way,
    ///         with `movement`. With `useCover` (a market with a covering asset) the writer locks the market's stock
    ///         for exactly the net short calls.
    ///         Receives at least `minCredit` settlement token (signed: negative = the writer pays at most −minCredit).
    function write(
        bytes32 market,
        StrategyMath.Leg[] calldata legs,
        TempoBlend.Part[] calldata movement,
        uint256 units,
        bool useCover,
        int256 minCredit,
        uint256 deadline
    ) external nonReentrant returns (uint256 writeId, int256 credit) {
        if (engine.buysPaused()) revert WritesArePaused();
        if (block.timestamp > deadline) revert Expired(deadline);
        if (units == 0) revert ZeroUnits();
        WriteCtx memory c = _prepare(market, legs, movement, units, useCover);
        if (c.credit < minCredit) revert CreditBelowMin(c.credit, minCredit);
        credit = c.credit;

        writeId = nextWriteId++;
        Write storage w = writes[writeId];
        w.writer = msg.sender;
        w.market = market;
        w.seriesId = c.seriesId;
        w.raw = c.raw;
        w.settlementPerUnit = c.settlementPerUnit;
        w.coverPerUnit = c.coverPerUnit;
        w.settlementLocked = _settlementFor(units, c.settlementPerUnit);
        w.coverLocked = _coverFor(units, c.coverPerUnit, c.coverScale);
        totalSettlementLocked += w.settlementLocked;
        if (w.coverLocked > 0) {
            totalCoverLocked[c.coverToken] += w.coverLocked;
            covers.checkCover(market, msg.sender, address(this), w.coverLocked);
            covers.checkCover(market, address(this), address(pool), w.coverLocked);
        }
        emit Written(
            msg.sender,
            writeId,
            c.seriesId,
            market,
            units,
            c.raw,
            c.s,
            c.sigma,
            w.settlementLocked,
            w.coverLocked,
            c.credit,
            c.fee
        );

        if (w.settlementLocked > 0) settlement.safeTransferFrom(msg.sender, address(this), w.settlementLocked);
        _pullCoverExact(c.coverToken, msg.sender, w.coverLocked);
        if (c.credit < 0) settlement.safeTransferFrom(msg.sender, address(pool), uint256(-c.credit));
        pool.onWrite(market, c.seriesId, writeId, units, c.raw, c.s, c.sigma, c.credit, c.fee, msg.sender);
    }

    /// @dev Market, sources, strikes, the exact collateral per unit, the series (opened and caught up), raw and price.
    function _prepare(
        bytes32 market,
        StrategyMath.Leg[] calldata legs,
        TempoBlend.Part[] calldata movement,
        uint256 units,
        bool useCover
    ) internal returns (WriteCtx memory c) {
        uint128 step;
        bool listed;
        (listed, c.spreadBps, step) = engine.markets(market);
        if (!listed) revert NotListed(market);

        // Law 2 and law 5: price and vol from the router and the board, never passed in.
        c.s = marks.markWad(market);
        c.sigma = vols.volBps(market);
        EnginePricing.checkShapeStrikes(legs, c.s, step);

        // Law 4: the exact worst case of what is sold, per shape unit.
        (c.coverToken, c.coverScale) = covers.coverOf(market);
        c.coverPerUnit = useCover ? _netShortCalls(legs) : 0;
        if (useCover && c.coverPerUnit == 0) revert NoCoverNeeded();
        c.settlementPerUnit = StrategyMath.writerCollateral(address(c.coverToken) != address(0), legs, int256(c.coverPerUnit));

        StrategyMath.Leg[] memory poolLegs = _negate(legs);
        c.seriesId = _openAndWalk(market, poolLegs, movement);
        c.raw = EnginePricing.rawForBuy(units, book.normNow(c.seriesId));
        if (c.raw == 0) revert ZeroRaw();
        _priceWrite(c, poolLegs, movement, units);
    }

    function _openAndWalk(bytes32 market, StrategyMath.Leg[] memory poolLegs, TempoBlend.Part[] calldata movement)
        internal
        returns (uint256 seriesId)
    {
        seriesId = book.idOfShape(market, poolLegs, movement);
        if (!book.exists(seriesId)) book.openShape(market, poolLegs, movement);
        (, bool done) = book.accrue(seriesId, TRADE_MAX_STEPS);
        if (!done) revert NotCaughtUp(seriesId);
    }

    function _priceWrite(
        WriteCtx memory c,
        StrategyMath.Leg[] memory poolLegs,
        TempoBlend.Part[] calldata movement,
        uint256 units
    ) internal pure {
        int256 v = EnginePricing.shapeValue(poolLegs, c.s, c.sigma, movement, false);
        (c.credit, c.fee) = EnginePricing.shapeWriteQuote(v, units, poolLegs, c.s, c.spreadBps);
    }

    // ---------------------------------------------------------------- claim

    /// @notice Sends back to the writer the collateral no longer required as the shape decays (the funding received).
    ///         Required = units now (raw × the series' factor, rounded up) × the per-unit worst case. While the series
    ///         is behind the latest sample the factor where its last walk stopped is used: higher, so conservative.
    function claim(uint256 writeId) external nonReentrant returns (uint256 settlementOut, uint256 coverOut) {
        Write storage w = writes[writeId];
        if (msg.sender != w.writer) revert NotWriter(writeId);
        (uint256 settlementReq, uint256 coverReq) = required(writeId);
        if (w.settlementLocked > settlementReq) settlementOut = w.settlementLocked - settlementReq;
        if (w.coverLocked > coverReq) coverOut = w.coverLocked - coverReq;
        w.settlementLocked -= settlementOut;
        w.coverLocked -= coverOut;
        totalSettlementLocked -= settlementOut;
        emit Claimed(writeId, settlementOut, coverOut);
        if (settlementOut > 0) settlement.safeTransfer(w.writer, settlementOut);
        if (coverOut > 0) {
            (IERC20 t,) = covers.coverOf(w.market);
            totalCoverLocked[t] -= coverOut;
            _coverOut(w.market, t, w.writer, coverOut);
        }
    }

    /// @notice The collateral write `writeId` requires now: settlement token (6 decimals) and the covering token (its own units),
    ///         both rounded up.
    function required(uint256 writeId) public view returns (uint256 settlementReq, uint256 coverReq) {
        Write storage w = writes[writeId];
        if (w.raw == 0) return (0, 0);
        uint256 unitsNow = Math.mulDiv(w.raw, book.normNow(w.seriesId), WAD, Math.Rounding.Ceil);
        settlementReq = _settlementFor(unitsNow, w.settlementPerUnit);
        if (w.coverPerUnit > 0) {
            (, uint256 scale) = covers.coverOf(w.market);
            coverReq = _coverFor(unitsNow, w.coverPerUnit, scale);
        }
        // never more than what was locked for the units written (rounding)
        if (settlementReq > w.settlementLocked) settlementReq = w.settlementLocked;
        if (coverReq > w.coverLocked) coverReq = w.coverLocked;
    }

    // ---------------------------------------------------------------- unwrite

    struct UnwriteCtx {
        uint256 s;
        uint256 sigma;
        bool markFromSample;
        bool volFromSample;
        uint256 raw;
        uint256 units;
        int256 cost;
        uint256 fee;
        uint256 settlementPart;
        uint256 coverPart;
        bool capped;
        uint256 fromSettlement;
        uint256 fromCover;
        uint256 fromWallet;
        IERC20 coverToken;
        uint256 coverScale;
    }

    /// @notice Buys back `units` (WAD; `type(uint256).max` = all) of write `writeId` at the pool's ask, paying at most
    ///         `maxCost` settlement token (signed). Never paused (law 3 for writers).
    function unwrite(uint256 writeId, uint256 units, int256 maxCost, uint256 deadline)
        external
        nonReentrant
        returns (uint256 paidUnits, int256 cost)
    {
        Write storage w = writes[writeId];
        if (msg.sender != w.writer) revert NotWriter(writeId);
        if (block.timestamp > deadline) revert Expired(deadline);
        if (units == 0) revert ZeroUnits();
        UnwriteCtx memory c;
        (c.s, c.sigma, c.markFromSample, c.volFromSample) = _unwriteInputs(w.market);

        uint256 norm = book.accrueForSell(w.seriesId);
        (c.raw, c.units) = EnginePricing.rawForSell(units, norm, w.raw);
        if (c.raw == 0 || c.units == 0) revert NothingToUnwrite(writeId);
        _quoteUnwrite(w, c);
        if (c.cost > maxCost) revert CostAboveMax(c.cost, maxCost);
        _settleUnwrite(writeId, w, c);
        return (c.units, c.cost);
    }

    /// @dev The buyback quote, capped at the collateral released for these units valued at the unwrite's mark.
    function _quoteUnwrite(Write storage w, UnwriteCtx memory c) internal view {
        (, StrategyMath.Leg[] memory poolLegs, TempoBlend.Part[] memory mv) = book.shapeOf(w.seriesId);
        (, uint16 spreadBps,) = engine.markets(w.market);
        int256 v = EnginePricing.shapeValue(poolLegs, c.s, c.sigma, mv, true);
        (c.cost, c.fee) = EnginePricing.shapeUnwriteQuote(v, c.units, poolLegs, c.s, spreadBps);
        bool all = c.raw == w.raw;
        c.settlementPart = all ? w.settlementLocked : Math.mulDiv(w.settlementLocked, c.raw, w.raw);
        c.coverPart = all ? w.coverLocked : Math.mulDiv(w.coverLocked, c.raw, w.raw);
        (c.coverToken, c.coverScale) = covers.coverOf(w.market);
        uint256 cap = c.settlementPart + _coverToSettlement(c.coverPart, c.coverScale, c.s);
        if (c.cost > int256(cap)) {
            c.cost = int256(cap);
            c.capped = true;
        }
    }

    /// @dev Pays the buyback from locked settlement token, then the locked cover at the unwrite's mark, then the wallet; sends the
    ///      rest of the released collateral back to the writer. Cover that cannot move is kept owed (CoverLedger).
    function _settleUnwrite(uint256 writeId, Write storage w, UnwriteCtx memory c) internal {
        if (c.cost > 0) {
            uint256 due = uint256(c.cost);
            c.fromSettlement = due < c.settlementPart ? due : c.settlementPart;
            due -= c.fromSettlement;
            if (due > 0 && c.coverPart > 0) {
                c.fromCover = _settlementToCover(due, c.coverScale, c.s);
                if (c.fromCover > c.coverPart) c.fromCover = c.coverPart;
                uint256 covered = _coverToSettlement(c.fromCover, c.coverScale, c.s);
                due = covered >= due ? 0 : due - covered;
            }
            c.fromWallet = due;
        }
        w.raw -= c.raw;
        w.settlementLocked -= c.settlementPart;
        w.coverLocked -= c.coverPart;
        totalSettlementLocked -= c.settlementPart;
        if (c.coverPart > 0) totalCoverLocked[c.coverToken] -= c.coverPart;
        emit Unwritten(
            writeId,
            c.units,
            c.raw,
            c.s,
            c.sigma,
            c.cost,
            c.fee,
            c.fromSettlement,
            c.fromCover,
            c.fromWallet,
            c.capped,
            c.markFromSample,
            c.volFromSample
        );

        if (c.fromSettlement > 0) settlement.safeTransfer(address(pool), c.fromSettlement);
        _coverOut(w.market, c.coverToken, address(pool), c.fromCover);
        if (c.fromWallet > 0) settlement.safeTransferFrom(w.writer, address(pool), c.fromWallet);
        if (c.settlementPart > c.fromSettlement) settlement.safeTransfer(w.writer, c.settlementPart - c.fromSettlement);
        _coverOut(w.market, c.coverToken, w.writer, c.coverPart - c.fromCover);
        pool.onUnwrite(
            w.market,
            w.seriesId,
            writeId,
            c.raw,
            c.units,
            c.s,
            c.sigma,
            c.cost,
            c.fee,
            c.fromSettlement + c.fromWallet,
            c.fromCover,
            w.writer
        );
    }

    /// @dev Fresh mark and vol when the router and board answer; otherwise the book's last recorded sample, each
    ///      input separately (as the Engine's sells).
    function _unwriteInputs(bytes32 market)
        internal
        view
        returns (uint256 s, uint256 sigma, bool markFromSample, bool volFromSample)
    {
        try marks.markWad(market) returns (uint256 px) {
            s = px;
        } catch {
            markFromSample = true;
        }
        try vols.volBps(market) returns (uint256 b) {
            sigma = b;
        } catch {
            volFromSample = true;
        }
        if (markFromSample || volFromSample) {
            (, uint256 sampleS, uint256 sampleSigma) = book.latestSample(market);
            if (markFromSample) s = sampleS;
            if (volFromSample) sigma = sampleSigma;
        }
    }

    // ---------------------------------------------------------------- maths

    /// @dev Sends cover out; if it cannot move, it stays owed here and opens on the market pause (owner D3).
    function _coverOut(bytes32 market, IERC20 token, address to, uint256 amount) internal {
        if (!_sendCover(token, to, amount)) ICoverOutage(address(pool)).onCoverStuck(market);
    }

    /// @dev Covering units that exactly cover the net short calls (Σ short − Σ long call amounts), 0 if none.
    function _netShortCalls(StrategyMath.Leg[] calldata legs) internal pure returns (uint256) {
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

    /// @dev settlement token (6 decimals) for `units` at `perUnit` WAD settlement token, rounded up.
    function _settlementFor(uint256 units, uint256 perUnit) internal pure returns (uint256) {
        return Math.ceilDiv(Math.mulDiv(units, perUnit, WAD, Math.Rounding.Ceil), WAD_PER_SETTLEMENT_UNIT);
    }

    /// @dev Covering tokens (own units) for `units` at `perUnit` WAD covering units, rounded up.
    function _coverFor(uint256 units, uint256 perUnit, uint256 scale) internal pure returns (uint256) {
        if (perUnit == 0) return 0;
        return Math.ceilDiv(Math.mulDiv(units, perUnit, WAD, Math.Rounding.Ceil), scale);
    }

    /// @dev Value of `amount` covering tokens (own units) at mark `s` in settlement token, rounded down.
    function _coverToSettlement(uint256 amount, uint256 scale, uint256 s) internal pure returns (uint256) {
        return Math.mulDiv(amount * scale, s, WAD) / WAD_PER_SETTLEMENT_UNIT;
    }

    /// @dev Covering tokens (own units) worth `settlementAmount` at mark `s`, rounded up.
    function _settlementToCover(uint256 settlementAmount, uint256 scale, uint256 s) internal pure returns (uint256) {
        return Math.ceilDiv(Math.mulDiv(settlementAmount * WAD_PER_SETTLEMENT_UNIT, WAD, s, Math.Rounding.Ceil), scale);
    }
}
