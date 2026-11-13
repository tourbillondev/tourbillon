// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IMarkRouter, IVolSource} from "./PathFundingBook.sol";
import {TempoBlend} from "./TempoBlend.sol";
import {EnginePricing} from "./EnginePricing.sol";
import {StrategyMath} from "./StrategyMath.sol";
import {VolQuote, VolQuoteBook} from "./VolQuote.sol";
import {MatchBook} from "./MatchBook.sol";
import {IEngineConfig} from "./WriterBook.sol";
import {VolFeed} from "./VolFeed.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

interface IEngineOpenFor {
    function openFor(
        address buyer,
        bytes32 market,
        StrategyMath.Leg[] calldata legs,
        TempoBlend.Part[] calldata movement,
        uint256 units,
        uint256 sigmaBps,
        uint256 maxCost,
        address payee
    ) external returns (uint256 id, uint256 raw, uint256 cost);
}

/// @title OpenBook
/// @notice The best-of-three router (M6, spec: "Every buy fills at the cheapest of signed maker quotes, users' written
///         offers and the Mainspring pool").
/// @dev    - Law 2 (D8): a fresh mark always (the Engine reads it for every fill); the board vol only when the pool is a
///           candidate (a stale board leaves the pool out; makers and offers can still fill).
///         - Law 5: no input here sets a σ or a price. σ comes only from a valid signed quote (`VolQuoteBook.fill`
///           returns the maker's signed σ), an on-chain offer (its posted σ), or the board.
///         - Candidates (at most 4 quotes and 4 offers per call) are priced at their σ; the buyer's total cost (premium +
///           fee) orders them; the cheapest is tried first and, if it refuses (the pool's coverage or caps, a quote's
///           size, an offer's escrow), the next, in the same transaction (D5, owner: fallback in cost order). A failed
///           attempt leaves nothing behind (a self-call under try / catch). One source fills the whole order.
///         - Every routed order fills a shape series (even one leg), so every source fills the same series.
contract OpenBook is ReentrancyGuard {
    uint8 public constant KIND_POOL = 1;
    uint8 public constant KIND_QUOTE = 2;
    uint8 public constant KIND_OFFER = 3;
    uint256 public constant MAX_QUOTES = 4;
    uint256 public constant MAX_OFFERS = 4;

    IEngineOpenFor public immutable engine;
    IEngineConfig public immutable config;
    IMarkRouter public immutable marks;
    IVolSource public immutable vols;
    VolQuoteBook public immutable quoteBook;
    MatchBook public immutable matchBook;
    VolFeed public volFeed; // M6 D11: set once by the Engine's admin; informational, never blocks a fill
    address public auction; // M6 step 9: the risk auction, set once by the Engine's admin

    struct Order {
        address buyer;
        bytes32 market;
        StrategyMath.Leg[] legs;
        TempoBlend.Part[] movement;
        uint256 units;
        uint256 maxCost;
    }

    struct Cand {
        uint8 kind;
        uint256 index; // into quotes or offerIds
        uint256 sigmaBps;
        uint256 cost;
    }

    event Routed(address indexed buyer, uint256 indexed id, uint8 kind, uint256 sigmaBps, uint256 cost, address source);
    event Skipped(uint8 kind, uint256 index, bytes reason);

    error Expired(uint256 deadline);
    error TooManyCandidates();
    error NoSource();
    error NotSelf();
    error NotAdmin();
    error AlreadySet();
    event VolFeedSet(address volFeed);
    event AuctionSet(address auction);

    constructor(
        IEngineOpenFor engine_,
        IEngineConfig config_,
        IMarkRouter marks_,
        IVolSource vols_,
        VolQuoteBook quoteBook_,
        MatchBook matchBook_
    ) {
        engine = engine_;
        config = config_;
        marks = marks_;
        vols = vols_;
        quoteBook = quoteBook_;
        matchBook = matchBook_;
    }

    /// @notice Buys `units` of the shape `legs` (the buyer's side, spelled the book's one way) with `movement`, paying at
    ///         most `maxCost` USDC (approved to the Engine), from the cheapest of the pool, the given signed quotes and
    ///         the given offers that can fill it.
    function buy(
        bytes32 market,
        StrategyMath.Leg[] calldata legs,
        TempoBlend.Part[] calldata movement,
        uint256 units,
        uint256 maxCost,
        uint256 deadline,
        VolQuote.Quote[] calldata quotes,
        bytes[] calldata sigs,
        uint256[] calldata offerIds
    ) external nonReentrant returns (uint256 id, uint256 cost, uint8 kind) {
        if (block.timestamp > deadline) revert Expired(deadline);
        if (quotes.length > MAX_QUOTES || offerIds.length > MAX_OFFERS || sigs.length != quotes.length) {
            revert TooManyCandidates();
        }
        Order memory o = Order(msg.sender, market, legs, movement, units, maxCost);
        Cand[] memory cands = _candidates(o, quotes, sigs, offerIds);
        bytes memory last;
        for (uint256 i; i < cands.length; ++i) {
            Cand memory c = cands[i];
            try this.fillOne(o, c, quotes, sigs, offerIds) returns (uint256 id_, uint256 cost_) {
                emit Routed(msg.sender, id_, c.kind, c.sigmaBps, cost_, _sourceOf(c, quotes, offerIds));
                if (c.kind != KIND_POOL) _feed(o, c);
                return (id_, cost_, c.kind);
            } catch (bytes memory err) {
                emit Skipped(c.kind, c.index, err);
                last = err;
            }
        }
        if (last.length == 0) revert NoSource();
        assembly {
            revert(add(last, 32), mload(last))
        }
    }

    /// @notice Self only: fills the order from one candidate (a failed attempt reverts and leaves nothing behind).
    function fillOne(
        Order calldata o,
        Cand calldata c,
        VolQuote.Quote[] calldata quotes,
        bytes[] calldata sigs,
        uint256[] calldata offerIds
    ) external returns (uint256 id, uint256 cost) {
        if (msg.sender != address(this)) revert NotSelf();
        uint256 raw;
        if (c.kind == KIND_POOL) {
            (id,, cost) =
                engine.openFor(o.buyer, o.market, o.legs, o.movement, o.units, c.sigmaBps, o.maxCost, address(0));
        } else if (c.kind == KIND_QUOTE) {
            VolQuote.Quote calldata q = quotes[c.index];
            // records the size used and returns the maker's signed σ (law 5)
            uint64 sigma = quoteBook.fill(q, sigs[c.index], o.market, o.legs, o.movement, uint128(o.units));
            (id, raw, cost) = engine.openFor(o.buyer, o.market, o.legs, o.movement, o.units, sigma, o.maxCost, q.maker);
            matchBook.matchMaker(q.maker, id, o.units, raw);
        } else {
            uint256 offerId = offerIds[c.index];
            (address writer,,, uint64 sigma,,,,,,,,,,) = matchBook.offers(offerId);
            (id, raw, cost) = engine.openFor(o.buyer, o.market, o.legs, o.movement, o.units, sigma, o.maxCost, writer);
            matchBook.fillOffer(offerId, id, o.units, raw);
        }
    }

    /// @notice Sets the risk auction once; only the Engine's admin.
    function setAuction(address auction_) external {
        if (!IAccessControl(address(engine)).hasRole(bytes32(0), msg.sender)) revert NotAdmin();
        if (auction != address(0)) revert AlreadySet();
        auction = auction_;
        emit AuctionSet(auction_);
    }

    /// @notice The auction only: locks an auction winner's exact collateral as a matched write (this router holds the
    ///         MatchBook's router role).
    function auctionMatch(address winner, uint256 seriesId, uint256 units, uint256 raw) external returns (bytes32) {
        if (msg.sender != auction || auction == address(0)) revert NotSelf();
        return matchBook.matchMaker(winner, seriesId, units, raw);
    }

    /// @notice Sets the vol feed once; only the Engine's admin.
    function setVolFeed(VolFeed volFeed_) external {
        if (!IAccessControl(address(engine)).hasRole(bytes32(0), msg.sender)) revert NotAdmin();
        if (address(volFeed) != address(0)) revert AlreadySet();
        volFeed = volFeed_;
        emit VolFeedSet(address(volFeed_));
    }

    /// @dev Records an open-book fill in the vol feed (D11); a failing feed never blocks the fill.
    function _feed(Order memory o, Cand memory c) internal {
        if (address(volFeed) == address(0)) return;
        uint256 board;
        try vols.volBps(o.market) returns (uint256 b) {
            board = b;
        } catch {}
        uint256 s;
        try marks.markWad(o.market) returns (uint256 px) {
            s = px;
        } catch {}
        uint256 weight = o.units * s / 1e36 * 1e6; // USDC notional, whole dollars
        try volFeed.record(o.market, o.movement, c.sigmaBps, board, weight, c.kind) {} catch {}
    }

    /// @dev Every candidate that can price the order, ordered by the buyer's total cost (cheapest first).
    function _candidates(
        Order memory o,
        VolQuote.Quote[] calldata quotes,
        bytes[] calldata sigs,
        uint256[] calldata offerIds
    ) internal returns (Cand[] memory out) {
        uint256 s = marks.markWad(o.market); // law 2: no fresh mark, no fill from anyone
        (, uint16 spreadBps,) = config.markets(o.market);
        Cand[] memory tmp = new Cand[](1 + quotes.length + offerIds.length);
        uint256 n;
        try vols.volBps(o.market) returns (uint256 sigma) {
            tmp[n++] = Cand(KIND_POOL, 0, sigma, _cost(o, s, sigma, spreadBps));
        } catch (bytes memory err) {
            emit Skipped(KIND_POOL, 0, err); // a stale board: the pool is not a candidate (D8)
        }
        for (uint256 i; i < quotes.length; ++i) {
            try quoteBook.check(quotes[i], sigs[i], o.market, o.legs, o.movement, uint128(o.units)) {
                tmp[n++] = Cand(KIND_QUOTE, i, quotes[i].sigmaBps, _cost(o, s, quotes[i].sigmaBps, spreadBps));
            } catch (bytes memory err) {
                emit Skipped(KIND_QUOTE, i, err);
            }
        }
        for (uint256 i; i < offerIds.length; ++i) {
            (bool ok, uint64 sigma) = _offerFits(o, offerIds[i]);
            if (ok) tmp[n++] = Cand(KIND_OFFER, i, sigma, _cost(o, s, sigma, spreadBps));
            else emit Skipped(KIND_OFFER, i, "");
        }
        out = new Cand[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = tmp[i];
        }
        // insertion sort by cost (at most 9 candidates)
        for (uint256 i = 1; i < n; ++i) {
            Cand memory key = out[i];
            uint256 j = i;
            while (j > 0 && out[j - 1].cost > key.cost) {
                out[j] = out[j - 1];
                --j;
            }
            out[j] = key;
        }
    }

    /// @dev An offer fits when it is open, unexpired, has enough left, and its pool side is exactly the order's shape.
    function _offerFits(Order memory o, uint256 offerId) internal view returns (bool, uint64) {
        (
            address writer,
            bytes32 market,,
            uint64 sigma,
            uint64 validUntil,,,
            bool closed,
            uint128 maxUnits,
            uint128 filled,,,,
        ) = matchBook.offers(offerId);
        if (writer == address(0) || closed || market != o.market || block.timestamp > validUntil) return (false, 0);
        if (uint256(maxUnits) - filled < o.units) return (false, 0);
        (StrategyMath.Leg[] memory wLegs, TempoBlend.Part[] memory mv) = matchBook.offerTerms(offerId);
        if (wLegs.length != o.legs.length || mv.length != o.movement.length) return (false, 0);
        for (uint256 j; j < wLegs.length; ++j) {
            if (
                wLegs[j].isCall != o.legs[j].isCall || wLegs[j].kWad != o.legs[j].kWad || -wLegs[j].qty != o.legs[j].qty
            ) {
                return (false, 0);
            }
        }
        for (uint256 i; i < mv.length; ++i) {
            if (mv[i].tempo != o.movement[i].tempo || mv[i].weight != o.movement[i].weight) return (false, 0);
        }
        return (true, sigma);
    }

    function _cost(Order memory o, uint256 s, uint256 sigma, uint16 spreadBps) internal pure returns (uint256) {
        int256 v = EnginePricing.shapeValue(o.legs, s, sigma, o.movement, true);
        (uint256 premium, uint256 fee) = EnginePricing.shapeBuyQuote(v, o.units, o.legs, s, spreadBps);
        return premium + fee;
    }

    function _sourceOf(Cand memory c, VolQuote.Quote[] calldata quotes, uint256[] calldata offerIds)
        internal
        view
        returns (address)
    {
        if (c.kind == KIND_QUOTE) return quotes[c.index].maker;
        if (c.kind == KIND_OFFER) {
            (address writer,,,,,,,,,,,,,) = matchBook.offers(offerIds[c.index]);
            return writer;
        }
        return address(0);
    }
}
