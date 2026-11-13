// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PathFundingBook, IMarkRouter, IVolSource} from "./PathFundingBook.sol";
import {TempoBlend} from "./TempoBlend.sol";
import {EnginePricing} from "./EnginePricing.sol";
import {StrategyMath} from "./StrategyMath.sol";
import {ICounterparty} from "./ICounterparty.sol";

/// @notice The pool's matched-open hook (M6), for routed fills from makers and writer offers.
interface IMatchedCounterparty {
    function onMatchedOpen(
        bytes32 market,
        uint256 id,
        uint256 units,
        uint256 raw,
        uint256 sWad,
        uint256 premium,
        uint256 fee,
        uint256 credit,
        address payee
    ) external;
}

/// @title Engine
/// @notice Buys and sells of no-expiry calls and puts at any tempo or Movement, and of shapes (up to four legs held as
///         one position, M4), on PathFundingBook.
/// @dev    - The Engine holds no money: in the same transaction the premium and the fee go to the counterparty, which
///           decides where fees go (ICounterparty).
///         - A buy needs a fresh, cross-checked mark from the router and a fresh vol from the board; both revert
///           when stale (law 2). No argument carries a price (law 5).
///         - A buy walks the series at most 16 intervals (the book's rule) and refuses if more remain.
///         - The pauser can pause buys; only the admin unpauses. Nothing pauses a sell (law 3).
///         - A shape buy is open only for shapes whose payoff can never go below 0 (law 1); every leg's strike is
///           checked; the book enforces one spelling per shape and the complexity cap.
///         - Admin: the single testnet key, which breaks law 6 until the Safe and guardian (M7).
contract Engine is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    /// @notice Lifts the buy pause (M7 decision G4: the Safe directly, no timelock delay).
    bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");
    uint256 public constant TRADE_MAX_STEPS = 16;

    struct Market {
        bool listed;
        uint16 spreadBps;
        uint128 strikeStepWad;
    }

    PathFundingBook public immutable book;
    ICounterparty public immutable counterparty;
    IMarkRouter public immutable marks;
    IVolSource public immutable vols;
    IERC20 public immutable usdc;

    bool public buysPaused;
    address public openBook; // M6: the best-of-three router, set once
    mapping(bytes32 => Market) public markets;

    event Sold(
        address indexed seller,
        uint256 indexed id,
        bytes32 indexed market,
        uint256 units,
        uint256 raw,
        uint256 sWad,
        uint256 sigmaBps,
        uint256 unitValueWad,
        uint256 gross,
        uint256 fee,
        uint256 net,
        bool markFromSample,
        bool volFromSample
    );
    event OpenBookSet(address openBook);
    event MarketSet(bytes32 indexed market, uint256 strikeStepWad, uint256 spreadBps);
    event BuysPaused(address by);
    event BuysUnpaused(address by);
    event Bought(
        address indexed buyer,
        uint256 indexed id,
        bytes32 indexed market,
        uint256 units,
        uint256 raw,
        uint256 sWad,
        uint256 sigmaBps,
        uint256 unitValueWad,
        uint256 premium,
        uint256 fee
    );

    event ShapeBought(
        address indexed buyer,
        uint256 indexed id,
        bytes32 indexed market,
        uint256 units,
        uint256 raw,
        uint256 sWad,
        uint256 sigmaBps,
        int256 unitValueWad,
        uint256 premium,
        uint256 fee
    );

    error ZeroAddress();
    error NotOpenBook();
    error OpenBookAlreadySet();
    error NotSixDecimals(uint8 decimals);
    error BuysArePaused();
    error Expired(uint256 deadline);
    error NotListed(bytes32 market);
    error CostAboveMax(uint256 cost, uint256 maxCost);
    error NotCaughtUp(uint256 id);
    error ZeroRaw();
    error ZeroUnits();
    error NothingToSell(uint256 id);
    error NetBelowMin(uint256 net, uint256 minOut);

    constructor(
        address admin,
        PathFundingBook book_,
        ICounterparty counterparty_,
        IMarkRouter marks_,
        IVolSource vols_
    ) {
        if (
            admin == address(0) || address(book_) == address(0) || address(counterparty_) == address(0)
                || address(marks_) == address(0) || address(vols_) == address(0)
        ) revert ZeroAddress();
        IERC20 token = counterparty_.asset();
        uint8 d = IERC20Metadata(address(token)).decimals();
        if (d != EnginePricing.USDC_DECIMALS) revert NotSixDecimals(d);
        book = book_;
        counterparty = counterparty_;
        marks = marks_;
        vols = vols_;
        usdc = token;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UNPAUSER_ROLE, admin); // until the M7 handover moves it to the Safe
    }

    // ---------------------------------------------------------------- trading

    /// @notice Buys `units` (WAD) of the call or put on `market` at strike `kWad` with `movement` (a single tempo is
    ///         a one-part Movement), paying at most `maxCost` USDC (6 decimals) before `deadline`.
    /// @return id   The book series.
    /// @return cost Premium plus fee, USDC.
    function buy(
        bytes32 market,
        bool isCall,
        uint128 kWad,
        TempoBlend.Part[] calldata movement,
        uint256 units,
        uint256 maxCost,
        uint256 deadline
    ) external nonReentrant returns (uint256 id, uint256 cost) {
        if (buysPaused) revert BuysArePaused();
        if (block.timestamp > deadline) revert Expired(deadline);
        if (units == 0) revert ZeroUnits();
        Market memory m = markets[market];
        if (!m.listed) revert NotListed(market);

        // Law 2 and law 5: the price and the vol are read here, from the router and the board, never passed in.
        uint256 s = marks.markWad(market);
        uint256 sigma = vols.volBps(market);
        EnginePricing.checkStrike(kWad, s, m.strikeStepWad);

        id = book.idOf(market, isCall, kWad, movement);
        if (!book.exists(id)) book.open(market, isCall, kWad, movement);
        (uint256 norm, bool done) = book.accrue(id, TRADE_MAX_STEPS);
        if (!done) revert NotCaughtUp(id);

        uint256 v = EnginePricing.unitValue(isCall, s, kWad, sigma, movement);
        (uint256 premium, uint256 fee) = EnginePricing.buyQuote(v, units, s, m.spreadBps);
        cost = premium + fee;
        if (cost > maxCost) revert CostAboveMax(cost, maxCost);

        uint256 raw = EnginePricing.rawForBuy(units, norm);
        if (raw == 0) revert ZeroRaw();
        book.mint(id, msg.sender, raw);
        emit Bought(msg.sender, id, market, units, raw, s, sigma, v, premium, fee);

        usdc.safeTransferFrom(msg.sender, address(counterparty), premium + fee);
        counterparty.onBuy(market, id, units, raw, s, sigma, premium, fee);
    }

    /// @notice Buys `units` (WAD) of a shape on `market`: `legs` from the buyer's side (+ long, − short), spelled the
    ///         book's one way, with `movement`, paying at most `maxCost` USDC before `deadline`.
    /// @return id   The book's shape series.
    /// @return cost Premium plus fee, USDC.
    function buyShape(
        bytes32 market,
        StrategyMath.Leg[] calldata legs,
        TempoBlend.Part[] calldata movement,
        uint256 units,
        uint256 maxCost,
        uint256 deadline
    ) external nonReentrant returns (uint256 id, uint256 cost) {
        if (buysPaused) revert BuysArePaused();
        if (block.timestamp > deadline) revert Expired(deadline);
        if (units == 0) revert ZeroUnits();
        Market memory m = markets[market];
        if (!m.listed) revert NotListed(market);

        uint256 s = marks.markWad(market);
        uint256 sigma = vols.volBps(market);
        EnginePricing.checkShapeStrikes(legs, s, m.strikeStepWad);
        EnginePricing.checkBuyerShape(legs);

        id = book.idOfShape(market, legs, movement);
        if (!book.exists(id)) book.openShape(market, legs, movement);
        (uint256 norm, bool done) = book.accrue(id, TRADE_MAX_STEPS);
        if (!done) revert NotCaughtUp(id);

        int256 v = EnginePricing.shapeValue(legs, s, sigma, movement, true);
        uint256 premium;
        uint256 fee;
        (premium, fee) = EnginePricing.shapeBuyQuote(v, units, legs, s, m.spreadBps);
        cost = premium + fee;
        if (cost > maxCost) revert CostAboveMax(cost, maxCost);

        uint256 raw = EnginePricing.rawForBuy(units, norm);
        if (raw == 0) revert ZeroRaw();
        book.mint(id, msg.sender, raw);
        emit ShapeBought(msg.sender, id, market, units, raw, s, sigma, v, premium, fee);

        usdc.safeTransferFrom(msg.sender, address(counterparty), cost);
        counterparty.onBuy(market, id, units, raw, s, sigma, premium, fee);
    }

    /// @notice Sells `units` (WAD; `type(uint256).max` = all held) of series `id`, receiving at least `minOut` USDC
    ///         before `deadline`. Never paused (law 3). Priced at the fresh mark and vol when available, else at the
    ///         book's last recorded sample, each input separately (law 2: sells use the last good sample).
    /// @return paidUnits Units paid for (at most `units`, capped at the holding).
    /// @return net       USDC received.
    function sell(uint256 id, uint256 units, uint256 minOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 paidUnits, uint256 net)
    {
        if (block.timestamp > deadline) revert Expired(deadline);
        if (units == 0) revert ZeroUnits();
        bool shape = book.isShape(id);
        bytes32 market = _marketOf(id, shape);
        (uint256 s, uint256 sigma, bool markFromSample, bool volFromSample) = _sellInputs(market);

        uint256 norm = book.accrueForSell(id);
        uint256 raw;
        (raw, paidUnits) = EnginePricing.rawForSell(units, norm, book.balanceOf(id, msg.sender));
        if (raw == 0 || paidUnits == 0) revert NothingToSell(id);

        (uint256 v, uint256 gross, uint256 fee) = _sellQuote(id, shape, s, sigma, paidUnits, markets[market].spreadBps);
        net = gross - fee;
        if (net < minOut) revert NetBelowMin(net, minOut);

        book.burn(id, msg.sender, raw);
        emit Sold(msg.sender, id, market, paidUnits, raw, s, sigma, v, gross, fee, net, markFromSample, volFromSample);
        counterparty.onSell(market, id, raw, paidUnits, s, sigma, gross, net, fee, msg.sender);
    }

    function _marketOf(uint256 id, bool shape) internal view returns (bytes32 market) {
        if (shape) (market,,) = book.shapeOf(id);
        else (market,,,) = book.seriesOf(id);
    }

    /// @dev The sell's unit value (a shape's, rounded down and at least 0), gross and fee.
    function _sellQuote(uint256 id, bool shape, uint256 s, uint256 sigma, uint256 units, uint256 spreadBps)
        internal
        view
        returns (uint256 v, uint256 gross, uint256 fee)
    {
        if (shape) {
            (, StrategyMath.Leg[] memory legs, TempoBlend.Part[] memory mv) = book.shapeOf(id);
            int256 sv = EnginePricing.shapeValue(legs, s, sigma, mv, false);
            v = sv > 0 ? uint256(sv) : 0;
            (gross, fee) = EnginePricing.shapeSellQuote(sv, units, legs, s, spreadBps);
        } else {
            (, bool isCall, uint128 kWad, TempoBlend.Part[] memory mv) = book.seriesOf(id);
            v = EnginePricing.unitValue(isCall, s, kWad, sigma, mv);
            (gross, fee) = EnginePricing.sellQuote(v, units, s, spreadBps);
        }
    }

    /// @dev Fresh mark and vol when the router and board answer; otherwise the book's last recorded sample, each
    ///      input separately. A stale or disputed source never blocks a sell.
    function _sellInputs(bytes32 market)
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

    // ---------------------------------------------------------------- admin

    function setMarket(bytes32 market, uint128 strikeStepWad, uint16 spreadBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        EnginePricing.checkSpread(spreadBps);
        if (strikeStepWad == 0) revert EnginePricing.ZeroStep();
        markets[market] = Market(true, spreadBps, strikeStepWad);
        emit MarketSet(market, strikeStepWad, spreadBps);
    }

    /// @notice Stops new buys. Sells are never affected.
    function pauseBuys() external onlyRole(PAUSER_ROLE) {
        buysPaused = true;
        emit BuysPaused(msg.sender);
    }

    /// @notice Sets the OpenBook router (once): the only caller of `openFor`.
    function setOpenBook(address openBook_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (openBook != address(0)) revert OpenBookAlreadySet();
        if (openBook_ == address(0)) revert ZeroAddress();
        openBook = openBook_;
        emit OpenBookSet(openBook_);
    }

    /// @notice Router only (M6): a routed fill for `buyer` of the shape `legs` at `sigmaBps`, which the router took from a
    ///         valid signed quote, an on-chain offer or the board (law 5: no buyer input sets it). The same checks as
    ///         `buyShape` (buys paused, a listed market, a fresh mark, every leg's strike, a shape that cannot owe). With
    ///         no `payee` it is a pool fill (`onBuy`); otherwise a matched fill (`onMatchedOpen`): the pool pays `payee`
    ///         the value at `sigmaBps` and the router locks the source's collateral in the same transaction.
    /// @return id   The shape series.
    /// @return raw  The book balance minted to the buyer.
    /// @return cost Premium plus fee, USDC, pulled from the buyer.
    function openFor(
        address buyer,
        bytes32 market,
        StrategyMath.Leg[] calldata legs,
        TempoBlend.Part[] calldata movement,
        uint256 units,
        uint256 sigmaBps,
        uint256 maxCost,
        address payee
    ) external nonReentrant returns (uint256 id, uint256 raw, uint256 cost) {
        if (msg.sender != openBook || openBook == address(0)) revert NotOpenBook();
        if (buysPaused) revert BuysArePaused();
        if (units == 0) revert ZeroUnits();
        Market memory m = markets[market];
        if (!m.listed) revert NotListed(market);
        uint256 s = marks.markWad(market); // law 2: a fresh, cross-checked mark for every routed fill
        EnginePricing.checkShapeStrikes(legs, s, m.strikeStepWad);
        EnginePricing.checkBuyerShape(legs);
        id = book.idOfShape(market, legs, movement);
        if (!book.exists(id)) book.openShape(market, legs, movement);
        uint256 norm;
        {
            bool done;
            (norm, done) = book.accrue(id, TRADE_MAX_STEPS);
            if (!done) revert NotCaughtUp(id);
        }
        int256 v = EnginePricing.shapeValue(legs, s, sigmaBps, movement, true);
        (uint256 premium, uint256 fee) = EnginePricing.shapeBuyQuote(v, units, legs, s, m.spreadBps);
        cost = premium + fee;
        if (cost > maxCost) revert CostAboveMax(cost, maxCost);
        raw = EnginePricing.rawForBuy(units, norm);
        if (raw == 0) revert ZeroRaw();
        book.mint(id, buyer, raw);
        emit ShapeBought(buyer, id, market, units, raw, s, sigmaBps, v, premium, fee);
        usdc.safeTransferFrom(buyer, address(counterparty), cost);
        if (payee == address(0)) {
            counterparty.onBuy(market, id, units, raw, s, sigmaBps, premium, fee);
        } else {
            int256 vDown = EnginePricing.shapeValue(legs, s, sigmaBps, movement, false);
            uint256 credit = vDown > 0 ? Math.mulDiv(units, uint256(vDown), 1e18) / EnginePricing.WAD_PER_USDC_UNIT : 0;
            IMatchedCounterparty(address(counterparty))
                .onMatchedOpen(market, id, units, raw, s, premium, fee, credit, payee);
        }
    }

    /// @notice Lets the WriterBook open shape series in the book (once). Writes then follow this Engine's markets,
    ///         spreads and buy pause.
    function setWriterBook(address writerBook) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (writerBook == address(0)) revert ZeroAddress();
        book.setWriter(writerBook);
    }

    /// @notice The unpauser only (M7 G4), never the pauser.
    function unpauseBuys() external onlyRole(UNPAUSER_ROLE) {
        buysPaused = false;
        emit BuysUnpaused(msg.sender);
    }
}
