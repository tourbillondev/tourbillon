// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PathFundingBook, IMarkRouter, IVolSource} from "./PathFundingBook.sol";
import {TempoBlend} from "./TempoBlend.sol";
import {EnginePricing} from "./EnginePricing.sol";
import {StrategyMath} from "./StrategyMath.sol";
import {MakerVault} from "./MakerVault.sol";

interface IAuctionPool {
    function openSeries(bytes32 market) external view returns (uint256[] memory);
    function seriesRaw(uint256 id) external view returns (uint256);
    function matchedRawOf(uint256 id) external view returns (uint256);
    function onAuctionFill(
        uint256 id,
        uint256 raw,
        uint256 units,
        uint256 sWad,
        uint256 sigmaBps,
        uint256 price,
        address winner
    ) external;
}

interface IAuctionRouter {
    function auctionMatch(address winner, uint256 seriesId, uint256 units, uint256 raw) external returns (bytes32);
}

/// @title RiskAuction
/// @notice The weekly sealed risk auction (M6 decision D12; spec: "Vega goes first to makers and writers, then to a
///         weekly sealed risk auction"). Anyone starts, once a week per market, an auction for a slice of the risk the
///         pool carries; vault makers bid a σ, sealed (commit 3 days, reveal 1 day); the lowest σ within the reserve
///         takes the slice as a matched write with exact collateral (law 4), and the pool stops carrying it.
/// @dev    - The lot (owner, M6 step 9): the series with the largest carried notional ((raw − matched) × norm × S × units
///           of underlying per unit) among those a writer can collateralise (a naked short call cannot be, law 4),
///           capped at $1M of notional; all of that series' carried raw up to the cap.
///         - Bond: 5% of the lot's worst case, locked in the bidder's MakerVault at commit; released to losers and the
///           winner; an unrevealed bond is paid to the pool.
///         - Reserve: the pool pays at most its own value of the slice at the board's σ × 1.10.
///         - Settlement (law 2: a fresh mark and board vol; otherwise it waits): revealed bids in σ order (ties: the
///           earlier commit); a bid above the reserve ends the auction with no fill; a winner who cannot lock its
///           collateral forfeits its bond to the pool and the next revealed bid is tried, only if it is also within the
///           reserve (owner).
contract RiskAuction is ReentrancyGuard {
    uint256 public constant COMMIT_PERIOD = 3 days;
    uint256 public constant REVEAL_PERIOD = 1 days;
    uint256 public constant INTERVAL = 7 days;
    uint256 public constant LOT_CAP = 1_000_000e6; // USDC notional
    uint256 public constant BOND_BPS = 500;
    uint256 public constant RESERVE_BPS = 11_000;
    uint256 public constant MAX_BIDDERS = 32;
    uint256 internal constant WAD = 1e18;

    struct Lot {
        bytes32 market;
        uint256 seriesId;
        uint256 raw;
        uint256 bond; // USDC per bidder
        uint64 commitEnd;
        uint64 revealEnd;
        bool settled;
        address winner;
        uint256 price;
    }

    struct Bid {
        bytes32 hash;
        uint64 sigmaBps;
        bool revealed;
        bool closed; // bond released or forfeited
    }

    PathFundingBook public immutable book;
    IAuctionPool public immutable pool;
    IAuctionRouter public immutable router;
    MakerVault public immutable vault;
    IMarkRouter public immutable marks;
    IVolSource public immutable vols;
    IERC20 public immutable usdc;

    Lot[] internal _lots;
    mapping(uint256 => mapping(address => Bid)) public bids;
    mapping(uint256 => address[]) internal _bidders;
    mapping(bytes32 => uint256) public lastStart;

    event Started(
        uint256 indexed lotId,
        bytes32 indexed market,
        uint256 indexed seriesId,
        uint256 raw,
        uint256 bond,
        uint64 commitEnd,
        uint64 revealEnd
    );
    event Committed(uint256 indexed lotId, address indexed bidder);
    event Revealed(uint256 indexed lotId, address indexed bidder, uint256 sigmaBps);
    event Forfeited(uint256 indexed lotId, address indexed bidder, uint256 bond, string why);
    event Settled(uint256 indexed lotId, address winner, uint256 sigmaBps, uint256 raw, uint256 price, uint256 reserve);

    error TooSoon(uint256 nextAt);
    error NothingToAuction(bytes32 market);
    error Closed(uint256 lotId);
    error NotOpen(uint256 lotId);
    error AlreadyCommitted(uint256 lotId);
    error TooManyBidders(uint256 lotId);
    error BadReveal(uint256 lotId);
    error NotSelf();

    constructor(
        PathFundingBook book_,
        IAuctionPool pool_,
        IAuctionRouter router_,
        MakerVault vault_,
        IMarkRouter marks_,
        IVolSource vols_
    ) {
        book = book_;
        pool = pool_;
        router = router_;
        vault = vault_;
        marks = marks_;
        vols = vols_;
        usdc = vault_.usdc();
    }

    // ---------------------------------------------------------------- start

    /// @notice Anyone, once a week per market: auctions the carried slice with the largest notional (see the lot rule).
    function start(bytes32 market) external returns (uint256 lotId) {
        uint256 last = lastStart[market];
        if (last != 0 && block.timestamp < last + INTERVAL) revert TooSoon(last + INTERVAL);
        uint256 s = marks.markWad(market); // law 2
        (uint256 id, uint256 raw, uint256 worst) = _pickLot(market, s);
        if (raw == 0) revert NothingToAuction(market);
        lastStart[market] = block.timestamp;
        uint256 units = Math.mulDiv(raw, book.normNow(id), WAD, Math.Rounding.Ceil);
        uint256 bond = Math.ceilDiv(
            Math.mulDiv(Math.mulDiv(units, worst, WAD, Math.Rounding.Ceil), BOND_BPS, 10_000, Math.Rounding.Ceil), 1e12
        );
        lotId = _lots.length;
        _lots.push(
            Lot(
                market,
                id,
                raw,
                bond,
                uint64(block.timestamp + COMMIT_PERIOD),
                uint64(block.timestamp + COMMIT_PERIOD + REVEAL_PERIOD),
                false,
                address(0),
                0
            )
        );
        emit Started(
            lotId,
            market,
            id,
            raw,
            bond,
            uint64(block.timestamp + COMMIT_PERIOD),
            uint64(block.timestamp + COMMIT_PERIOD + REVEAL_PERIOD)
        );
    }

    function _pickLot(bytes32 market, uint256 s) internal view returns (uint256 best, uint256 raw, uint256 worst) {
        uint256[] memory ids = pool.openSeries(market);
        uint256 bestNotional;
        for (uint256 i; i < ids.length; ++i) {
            uint256 carried = pool.seriesRaw(ids[i]) - pool.matchedRawOf(ids[i]);
            if (carried == 0) continue;
            (bool ok, uint256 perUnitWorst, uint256 perUnitUnderlying) = _terms(ids[i], market);
            if (!ok) continue; // a writer could not collateralise it (law 4)
            uint256 units = Math.mulDiv(carried, book.normNow(ids[i]), WAD);
            uint256 notional = Math.mulDiv(Math.mulDiv(units, perUnitUnderlying, WAD), s, WAD) / 1e12;
            if (notional > bestNotional) {
                (bestNotional, best, raw, worst) = (notional, ids[i], carried, perUnitWorst);
            }
        }
        if (bestNotional > LOT_CAP) raw = Math.mulDiv(raw, LOT_CAP, bestNotional);
    }

    /// @dev The writer's worst case per unit (WAD USDC) and units of underlying per unit; not ok if unbounded.
    function _terms(uint256 id, bytes32 market) internal view returns (bool ok, uint256 worst, uint256 underlying) {
        (, StrategyMath.Leg[] memory h,) = _holderTerms(id);
        StrategyMath.Leg[] memory w = new StrategyMath.Leg[](h.length);
        int256 slope;
        for (uint256 j; j < h.length; ++j) {
            w[j] = StrategyMath.Leg(h[j].isCall, h[j].kWad, -h[j].qty);
            if (w[j].isCall) slope += w[j].qty;
        }
        uint256 cover = market == StrategyMath.COVER_MARKET && slope < 0 ? uint256(-slope) : 0;
        if (slope + int256(cover) < 0) return (false, 0, 0);
        worst = StrategyMath.writerCollateral(market, w, int256(cover));
        underlying = EnginePricing.shapeNotionalPerUnit(h);
        ok = true;
    }

    function _holderTerms(uint256 id)
        internal
        view
        returns (bytes32 market, StrategyMath.Leg[] memory legs, TempoBlend.Part[] memory mv)
    {
        if (book.isShape(id)) return book.shapeOf(id);
        bool isCall;
        uint128 k;
        (market, isCall, k, mv) = book.seriesOf(id);
        legs = new StrategyMath.Leg[](1);
        legs[0] = StrategyMath.Leg(isCall, k, 1e18);
    }

    // ---------------------------------------------------------------- commit and reveal

    /// @notice A sealed bid: `hash` = keccak256(abi.encode(lotId, bidder, sigmaBps, salt)). Locks the bond in the
    ///         bidder's MakerVault.
    function commit(uint256 lotId, bytes32 hash) external nonReentrant {
        Lot storage l = _lots[lotId];
        if (block.timestamp > l.commitEnd) revert NotOpen(lotId);
        Bid storage b = bids[lotId][msg.sender];
        if (b.hash != bytes32(0)) revert AlreadyCommitted(lotId);
        if (_bidders[lotId].length >= MAX_BIDDERS) revert TooManyBidders(lotId);
        b.hash = hash;
        _bidders[lotId].push(msg.sender);
        emit Committed(lotId, msg.sender);
        if (l.bond > 0) vault.lock(msg.sender, usdc, l.bond);
    }

    function reveal(uint256 lotId, uint64 sigmaBps, bytes32 salt) external {
        Lot storage l = _lots[lotId];
        if (block.timestamp <= l.commitEnd || block.timestamp > l.revealEnd) revert NotOpen(lotId);
        Bid storage b = bids[lotId][msg.sender];
        if (b.hash == bytes32(0) || b.revealed || keccak256(abi.encode(lotId, msg.sender, sigmaBps, salt)) != b.hash) {
            revert BadReveal(lotId);
        }
        if (sigmaBps < 500 || sigmaBps > 50_000) revert BadReveal(lotId);
        b.revealed = true;
        b.sigmaBps = sigmaBps;
        emit Revealed(lotId, msg.sender, sigmaBps);
    }

    // ---------------------------------------------------------------- settle

    struct Ctx {
        uint256 s;
        uint256 sigmaBoard;
        uint256 raw;
        uint256 units;
        uint256 reserve;
        StrategyMath.Leg[] legs;
        TempoBlend.Part[] mv;
    }

    /// @notice Anyone, after the reveal window, with a fresh mark and board vol (law 2; otherwise it waits).
    function settle(uint256 lotId) external nonReentrant {
        Lot storage l = _lots[lotId];
        if (l.settled) revert Closed(lotId);
        if (block.timestamp <= l.revealEnd) revert NotOpen(lotId);
        l.settled = true;
        Ctx memory c = _context(l);
        _run(lotId, l, c);
        _closeBonds(lotId, l.bond);
        uint256 sig = l.winner == address(0) ? 0 : bids[lotId][l.winner].sigmaBps;
        emit Settled(lotId, l.winner, sig, l.winner == address(0) ? 0 : c.raw, l.price, c.reserve);
    }

    function _context(Lot storage l) internal view returns (Ctx memory c) {
        c.s = marks.markWad(l.market);
        c.sigmaBoard = vols.volBps(l.market);
        uint256 carried = pool.seriesRaw(l.seriesId) - pool.matchedRawOf(l.seriesId);
        c.raw = l.raw < carried ? l.raw : carried;
        (, c.legs, c.mv) = _holderTerms(l.seriesId);
        if (c.raw > 0) {
            c.units = Math.mulDiv(c.raw, book.normNow(l.seriesId), WAD);
            c.reserve = _price(c, c.sigmaBoard, true) * RESERVE_BPS / 10_000;
        }
    }

    function _run(uint256 lotId, Lot storage l, Ctx memory c) internal {
        address[] memory order = _byRevealedSigma(lotId);
        for (uint256 i; i < order.length && c.units > 0; ++i) {
            Bid storage b = bids[lotId][order[i]];
            uint256 price = _price(c, b.sigmaBps, false);
            if (price > c.reserve) break; // above the reserve: no fill from this bid or any higher one
            if (l.bond > 0) vault.unlock(order[i], usdc, l.bond);
            b.closed = true;
            // the pool's NAV side uses the board's σ (how it carried the slice); the bid's σ only sets the price
            try this.fillLot(l.seriesId, order[i], c.raw, c.units, c.s, c.sigmaBoard, price) {
                l.winner = order[i];
                l.price = price;
                return;
            } catch {
                // could not lock its collateral: the bond goes to the pool (owner)
                if (l.bond > 0) vault.slash(order[i], usdc, l.bond, address(pool));
                emit Forfeited(lotId, order[i], l.bond, "no collateral");
            }
        }
    }

    /// @notice Self only: the winner's matched write (exact collateral) and the pool's side, atomically.
    function fillLot(uint256 id, address winner, uint256 raw, uint256 units, uint256 s, uint256 sigma, uint256 price)
        external
    {
        if (msg.sender != address(this)) revert NotSelf();
        router.auctionMatch(winner, id, units, raw);
        pool.onAuctionFill(id, raw, units, s, sigma, price, winner);
    }

    /// @dev The slice's value at σ in USDC: rounded up for the reserve (the pool's own value), down for a bid's price.
    function _price(Ctx memory c, uint256 sigma, bool up) internal pure returns (uint256) {
        int256 v = EnginePricing.shapeValue(c.legs, c.s, sigma, c.mv, up);
        if (v <= 0) return 0;
        uint256 w = Math.mulDiv(c.units, uint256(v), WAD, up ? Math.Rounding.Ceil : Math.Rounding.Floor);
        return up ? Math.ceilDiv(w, 1e12) : w / 1e12;
    }

    /// @dev Revealed bidders by σ, ties by commit order (at most 32).
    function _byRevealedSigma(uint256 lotId) internal view returns (address[] memory out) {
        address[] storage all = _bidders[lotId];
        address[] memory tmp = new address[](all.length);
        uint256 n;
        for (uint256 i; i < all.length; ++i) {
            if (bids[lotId][all[i]].revealed) tmp[n++] = all[i];
        }
        out = new address[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = tmp[i];
        }
        for (uint256 i = 1; i < n; ++i) {
            address key = out[i];
            uint64 ks = bids[lotId][key].sigmaBps;
            uint256 j = i;
            while (j > 0 && bids[lotId][out[j - 1]].sigmaBps > ks) {
                out[j] = out[j - 1];
                --j;
            }
            out[j] = key;
        }
    }

    /// @dev Releases revealed losers' bonds; pays unrevealed bonds to the pool.
    function _closeBonds(uint256 lotId, uint256 bond) internal {
        address[] storage all = _bidders[lotId];
        for (uint256 i; i < all.length; ++i) {
            Bid storage b = bids[lotId][all[i]];
            if (b.closed) continue;
            b.closed = true;
            if (bond == 0) continue;
            if (b.revealed) {
                vault.unlock(all[i], usdc, bond);
            } else {
                vault.pay(all[i], usdc, bond, address(pool));
                emit Forfeited(lotId, all[i], bond, "not revealed");
            }
        }
    }

    // ---------------------------------------------------------------- reads

    function lot(uint256 lotId) external view returns (Lot memory) {
        return _lots[lotId];
    }

    function lotCount() external view returns (uint256) {
        return _lots.length;
    }

    function bidders(uint256 lotId) external view returns (address[] memory) {
        return _bidders[lotId];
    }
}
