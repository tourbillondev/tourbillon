// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PathFundingBook, IMarkRouter, IVolSource} from "./PathFundingBook.sol";
import {TempoBlend} from "./TempoBlend.sol";
import {EnginePricing} from "./EnginePricing.sol";
import {StrategyMath} from "./StrategyMath.sol";
import {IWriteCounterparty} from "./IWriteCounterparty.sol";

interface IEngineConfig {
    function markets(bytes32 market) external view returns (bool listed, uint16 spreadBps, uint128 strikeStepWad);
    function buysPaused() external view returns (bool);
}

/// @title WriterBook
/// @notice Writing any shape against exact collateral (M4). The writer locks the exact worst case of what they sell:
///         USDC, and on HYPE optionally WHYPE covering short calls. The pool takes the other side at its bid (D1).
/// @dev    - Legs are the writer's own position (+ long, − short). The book series is the pool's side (the legs
///           negated), opened through the book's `openShape` (one spelling per shape, the complexity cap).
///         - Collateral per shape unit is StrategyMath's exact worst case: `usdcPerUnit` (WAD USDC) given
///           `coverPerUnit` WHYPE (WAD), which is exactly the net short calls when the writer asks for cover.
///           Locked = units × per unit, rounded up (law 4).
///         - A write's obligation is raw × the series' shared decay factor. The factor never rises (D2), so the
///           obligation only shrinks; `claim` returns what is no longer required (the funding received).
///         - `unwrite` buys back at the pool's ask, capped at the collateral's value at the unwrite's mark, paid from
///           locked USDC, then locked WHYPE at that mark, then the writer's wallet. Never paused; the last recorded
///           sample prices it when the mark or vol is stale (as a sell).
///         - Writes follow the Engine's markets, spreads and buy pause; the pool refuses writes while opens or the
///           market are paused.
contract WriterBook is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant WAD_PER_USDC_UNIT = 1e12;
    uint256 public constant TRADE_MAX_STEPS = 16;

    struct Write {
        address writer;
        bytes32 market;
        uint256 seriesId;
        uint256 raw;
        uint256 usdcPerUnit; // WAD USDC per shape unit
        uint256 coverPerUnit; // WAD WHYPE per shape unit
        uint256 usdcLocked; // USDC (6 decimals)
        uint256 whypeLocked; // WHYPE (18 decimals)
    }

    PathFundingBook public immutable book;
    IEngineConfig public immutable engine;
    IWriteCounterparty public immutable pool;
    IMarkRouter public immutable marks;
    IVolSource public immutable vols;
    IERC20 public immutable usdc;
    IERC20 public immutable whype;

    mapping(uint256 => Write) public writes;
    uint256 public nextWriteId = 1;
    uint256 public totalUsdcLocked;
    uint256 public totalWhypeLocked;

    event Written(
        address indexed writer,
        uint256 indexed writeId,
        uint256 indexed seriesId,
        bytes32 market,
        uint256 units,
        uint256 raw,
        uint256 sWad,
        uint256 sigmaBps,
        uint256 usdcLocked,
        uint256 whypeLocked,
        int256 credit,
        uint256 fee
    );
    event Claimed(uint256 indexed writeId, uint256 usdcReleased, uint256 whypeReleased);
    event Unwritten(
        uint256 indexed writeId,
        uint256 units,
        uint256 raw,
        uint256 sWad,
        uint256 sigmaBps,
        int256 cost,
        uint256 fee,
        uint256 usdcPaid,
        uint256 whypePaid,
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
        IERC20 usdc_,
        IERC20 whype_
    ) {
        if (
            address(book_) == address(0) || address(engine_) == address(0) || address(pool_) == address(0)
                || address(marks_) == address(0) || address(vols_) == address(0) || address(usdc_) == address(0)
                || address(whype_) == address(0)
        ) revert ZeroAddress();
        book = book_;
        engine = engine_;
        pool = pool_;
        marks = marks_;
        vols = vols_;
        usdc = usdc_;
        whype = whype_;
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
        uint256 usdcPerUnit;
        uint256 coverPerUnit;
    }

    /// @notice Writes `units` (WAD) of a shape on `market`: `legs` from the writer's side, spelled the book's one way,
    ///         with `movement`. With `useCover` (HYPE only) the writer locks WHYPE for exactly the net short calls.
    ///         Receives at least `minCredit` USDC (signed: negative = the writer pays at most −minCredit).
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
        w.usdcPerUnit = c.usdcPerUnit;
        w.coverPerUnit = c.coverPerUnit;
        w.usdcLocked = _usdcFor(units, c.usdcPerUnit);
        w.whypeLocked = Math.mulDiv(units, c.coverPerUnit, WAD, Math.Rounding.Ceil);
        totalUsdcLocked += w.usdcLocked;
        totalWhypeLocked += w.whypeLocked;
        emit Written(
            msg.sender,
            writeId,
            c.seriesId,
            market,
            units,
            c.raw,
            c.s,
            c.sigma,
            w.usdcLocked,
            w.whypeLocked,
            c.credit,
            c.fee
        );

        if (w.usdcLocked > 0) usdc.safeTransferFrom(msg.sender, address(this), w.usdcLocked);
        if (w.whypeLocked > 0) whype.safeTransferFrom(msg.sender, address(this), w.whypeLocked);
        if (c.credit < 0) usdc.safeTransferFrom(msg.sender, address(pool), uint256(-c.credit));
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
        c.coverPerUnit = useCover ? _netShortCalls(legs) : 0;
        if (useCover && c.coverPerUnit == 0) revert NoCoverNeeded();
        c.usdcPerUnit = StrategyMath.writerCollateral(market, legs, int256(c.coverPerUnit));

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

    /// @notice Returns to the writer the collateral no longer required as the shape decays (the funding received).
    ///         Required = units now (raw × the series' factor, rounded up) × the per-unit worst case. While the series
    ///         is behind the latest sample the factor where its last walk stopped is used: higher, so conservative.
    function claim(uint256 writeId) external nonReentrant returns (uint256 usdcOut, uint256 whypeOut) {
        Write storage w = writes[writeId];
        if (msg.sender != w.writer) revert NotWriter(writeId);
        (uint256 usdcReq, uint256 whypeReq) = required(writeId);
        if (w.usdcLocked > usdcReq) usdcOut = w.usdcLocked - usdcReq;
        if (w.whypeLocked > whypeReq) whypeOut = w.whypeLocked - whypeReq;
        w.usdcLocked -= usdcOut;
        w.whypeLocked -= whypeOut;
        totalUsdcLocked -= usdcOut;
        totalWhypeLocked -= whypeOut;
        emit Claimed(writeId, usdcOut, whypeOut);
        if (usdcOut > 0) usdc.safeTransfer(w.writer, usdcOut);
        if (whypeOut > 0) whype.safeTransfer(w.writer, whypeOut);
    }

    /// @notice The collateral write `writeId` requires now: USDC (6 decimals) and WHYPE (18), both rounded up.
    function required(uint256 writeId) public view returns (uint256 usdcReq, uint256 whypeReq) {
        Write storage w = writes[writeId];
        if (w.raw == 0) return (0, 0);
        uint256 unitsNow = Math.mulDiv(w.raw, book.normNow(w.seriesId), WAD, Math.Rounding.Ceil);
        usdcReq = _usdcFor(unitsNow, w.usdcPerUnit);
        whypeReq = Math.mulDiv(unitsNow, w.coverPerUnit, WAD, Math.Rounding.Ceil);
        // never more than what was locked for the units written (rounding)
        if (usdcReq > w.usdcLocked) usdcReq = w.usdcLocked;
        if (whypeReq > w.whypeLocked) whypeReq = w.whypeLocked;
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
        uint256 usdcPart;
        uint256 whypePart;
        bool capped;
        uint256 fromUsdc;
        uint256 fromWhype;
        uint256 fromWallet;
    }

    /// @notice Buys back `units` (WAD; `type(uint256).max` = all) of write `writeId` at the pool's ask, paying at most
    ///         `maxCost` USDC (signed). Never paused (law 3 for writers).
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
        c.usdcPart = all ? w.usdcLocked : Math.mulDiv(w.usdcLocked, c.raw, w.raw);
        c.whypePart = all ? w.whypeLocked : Math.mulDiv(w.whypeLocked, c.raw, w.raw);
        uint256 cap = c.usdcPart + _whypeToUsdc(c.whypePart, c.s);
        if (c.cost > int256(cap)) {
            c.cost = int256(cap);
            c.capped = true;
        }
    }

    /// @dev Pays the buyback from locked USDC, then locked WHYPE at the unwrite's mark, then the wallet; returns the
    ///      rest of the released collateral to the writer.
    function _settleUnwrite(uint256 writeId, Write storage w, UnwriteCtx memory c) internal {
        if (c.cost > 0) {
            uint256 due = uint256(c.cost);
            c.fromUsdc = due < c.usdcPart ? due : c.usdcPart;
            due -= c.fromUsdc;
            if (due > 0 && c.whypePart > 0) {
                c.fromWhype = _usdcToWhype(due, c.s);
                if (c.fromWhype > c.whypePart) c.fromWhype = c.whypePart;
                uint256 covered = _whypeToUsdc(c.fromWhype, c.s);
                due = covered >= due ? 0 : due - covered;
            }
            c.fromWallet = due;
        }
        w.raw -= c.raw;
        w.usdcLocked -= c.usdcPart;
        w.whypeLocked -= c.whypePart;
        totalUsdcLocked -= c.usdcPart;
        totalWhypeLocked -= c.whypePart;
        emit Unwritten(
            writeId,
            c.units,
            c.raw,
            c.s,
            c.sigma,
            c.cost,
            c.fee,
            c.fromUsdc,
            c.fromWhype,
            c.fromWallet,
            c.capped,
            c.markFromSample,
            c.volFromSample
        );

        if (c.fromUsdc > 0) usdc.safeTransfer(address(pool), c.fromUsdc);
        if (c.fromWhype > 0) whype.safeTransfer(address(pool), c.fromWhype);
        if (c.fromWallet > 0) usdc.safeTransferFrom(w.writer, address(pool), c.fromWallet);
        if (c.usdcPart > c.fromUsdc) usdc.safeTransfer(w.writer, c.usdcPart - c.fromUsdc);
        if (c.whypePart > c.fromWhype) whype.safeTransfer(w.writer, c.whypePart - c.fromWhype);
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
            c.fromUsdc + c.fromWallet,
            c.fromWhype,
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

    /// @dev WHYPE that exactly covers the net short calls (Σ short − Σ long call amounts), 0 if none.
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

    /// @dev USDC (6 decimals) for `units` at `perUnit` WAD USDC, rounded up.
    function _usdcFor(uint256 units, uint256 perUnit) internal pure returns (uint256) {
        return Math.ceilDiv(Math.mulDiv(units, perUnit, WAD, Math.Rounding.Ceil), WAD_PER_USDC_UNIT);
    }

    /// @dev Value of `amount` WHYPE at mark `s` in USDC, rounded down.
    function _whypeToUsdc(uint256 amount, uint256 s) internal pure returns (uint256) {
        return Math.mulDiv(amount, s, WAD) / WAD_PER_USDC_UNIT;
    }

    /// @dev WHYPE worth `usdcAmount` at mark `s`, rounded up.
    function _usdcToWhype(uint256 usdcAmount, uint256 s) internal pure returns (uint256) {
        return Math.mulDiv(usdcAmount * WAD_PER_USDC_UNIT, WAD, s, Math.Rounding.Ceil);
    }
}
