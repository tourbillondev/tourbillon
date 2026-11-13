// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {StrategyMath} from "./StrategyMath.sol";
import {TempoBlend} from "./TempoBlend.sol";
import {VolQuote} from "./VolQuote.sol";
import {ShapeGreeks} from "./ShapeGreeks.sol";
import {IMarkRouter, IVolSource} from "./PathFundingBook.sol";

interface IAgentOpenBook {
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
    ) external returns (uint256 id, uint256 cost, uint8 kind);
}

interface IAgentEngine {
    function sell(uint256 id, uint256 units, uint256 minOut, uint256 deadline)
        external
        returns (uint256 paidUnits, uint256 net);
}

interface IAgentBook {
    function balanceOf(uint256 id, address holder) external view returns (uint256);
    function accrue(uint256 id, uint256 maxSteps) external returns (uint256 norm, bool done);
    function isShape(uint256 id) external view returns (bool);
    function shapeOf(uint256 id)
        external
        view
        returns (bytes32 name, StrategyMath.Leg[] memory legs, TempoBlend.Part[] memory movement);
}

/// @title AgentRouter
/// @notice Agents trade for owners under owner-signed mandates (spec: "Owner mandate: markets, shapes, premium caps, USD
///         delta/vega budget, expiry, close-only"; "Multi-leg positions in one transaction, under owner-signed mandates").
///         M7 decisions G12, G13, G15, G16:
///         - A mandate is an EIP-712 message the owner signs (domain "Tourbillon AgentRouter", version "1"): the agent,
///           the markets, the allowed shape families, a premium cap per trade and in total, USD delta and vega budgets,
///           an expiry, close-only, a nonce. The owner revokes a nonce on-chain at any time.
///         - The agent buys through the OpenBook (the cheapest of the pool, maker quotes and writer offers): it supplies
///           legs, units and signed maker quotes or offer ids, never a price or a σ (law 5). The owner's USDC pays,
///           through an allowance to this router, at most the caps; any unused amount goes straight back.
///         - Positions sit in this router in per-owner sub-accounts. The agent can sell only what it opened under the
///           same mandate (close-only included); **the owner can always sell any of its sub-account, whatever the
///           mandate, after expiry or revocation (law 3).** Sale proceeds go to the owner.
///         - No writes in M7 (G15): buyer shapes only, as the Engine enforces (law 1).
///         - Budgets (G14): each fill's USD delta (|Δ| × S × units) and vega (|∂V/∂σ| per vol point × units) at the fresh
///           mark and the board's σ, accumulated per mandate at open and released pro rata when the position closes
///           (an agent sell releases its own mandate; an owner sell releases every mandate that opened the series, pro
///           rata). The drift of the live portfolio against these figures is accepted (G14). With the board stale, a
///           mandate with a finite budget cannot buy (`GreeksUnavailable`); unlimited budgets skip the computation.
contract AgentRouter is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant RISE = 1 << 0; // one long call
    uint256 public constant FALL = 1 << 1; // one long put
    uint256 public constant CALL_SPREAD = 1 << 2; // two calls, +1 / −1
    uint256 public constant PUT_SPREAD = 1 << 3; // two puts, +1 / −1
    uint256 public constant SWING = 1 << 4; // a long call and a long put
    uint256 public constant OTHER = 1 << 5; // any other buyer shape (flies, bands, condors…)
    uint256 public constant UNLIMITED = type(uint256).max;

    struct Mandate {
        address owner;
        address agent;
        bytes32[] markets;
        uint256 shapes; // bitmask of families
        uint256 maxPremiumPerTrade; // USDC (6 decimals), premium + fee
        uint256 maxPremiumTotal; // USDC, over the mandate's life
        uint256 deltaBudgetUsd; // USDC units of USD delta; UNLIMITED for none
        uint256 vegaBudgetUsd; // USDC units per vol point; UNLIMITED for none
        uint64 expiry;
        bool closeOnly;
        uint64 nonce;
    }

    struct BuyArgs {
        bytes32 market;
        StrategyMath.Leg[] legs;
        TempoBlend.Part[] movement;
        uint256 units;
        uint256 maxCost;
        uint256 deadline;
        VolQuote.Quote[] quotes;
        bytes[] sigs;
        uint256[] offerIds;
    }

    bytes32 public constant MANDATE_TYPEHASH = keccak256(
        "Mandate(address owner,address agent,bytes32[] markets,uint256 shapes,uint256 maxPremiumPerTrade,uint256 maxPremiumTotal,uint256 deltaBudgetUsd,uint256 vegaBudgetUsd,uint64 expiry,bool closeOnly,uint64 nonce)"
    );

    IAgentOpenBook public immutable openBook;
    IAgentEngine public immutable engine;
    IAgentBook public immutable book;
    IERC20 public immutable usdc;
    IMarkRouter public immutable marks;
    IVolSource public immutable vols;

    mapping(address => mapping(uint64 => bool)) public revoked; // owner => nonce
    mapping(bytes32 => uint256) public premiumUsed; // mandate hash => USDC spent
    mapping(address => mapping(uint256 => uint256)) public rawOf; // owner => series => raw held here
    mapping(uint256 => uint256) public totalRaw; // series => Σ owners' raw (= this router's book balance)
    mapping(bytes32 => mapping(uint256 => uint256)) public mandateRaw; // mandate => series => raw it opened, still held
    mapping(bytes32 => uint256) public deltaUsed; // mandate => USD delta of open positions (at their opens)
    mapping(bytes32 => uint256) public vegaUsed; // mandate => USD vega of open positions (at their opens)
    mapping(bytes32 => mapping(uint256 => uint256)) public mandateDelta; // mandate => series => its share of deltaUsed
    mapping(bytes32 => mapping(uint256 => uint256)) public mandateVega;
    mapping(address => mapping(uint256 => bytes32[])) internal _mandatesOf; // owner => series => mandates that opened it

    event AgentBought(
        bytes32 indexed mandate, address indexed owner, uint256 indexed id, uint256 raw, uint256 cost, uint8 kind
    );
    event PositionSold(
        address indexed owner, uint256 indexed id, uint256 raw, uint256 units, uint256 net, bytes32 mandate
    );
    event Revoked(address indexed owner, uint64 nonce);

    error NotAgent();
    error BadMandateSignature();
    error MandateRevoked();
    error MandateExpired(uint64 expiry);
    error CloseOnly();
    error MarketNotAllowed(bytes32 market);
    error ShapeNotAllowed(uint256 family);
    error OverTotalCap(uint256 used, uint256 cap);
    error NothingHeld(uint256 id);
    error GreeksUnavailable(bytes32 market);
    error OverDeltaBudget(uint256 wouldBe, uint256 budget);
    error OverVegaBudget(uint256 wouldBe, uint256 budget);

    constructor(
        IAgentOpenBook openBook_,
        IAgentEngine engine_,
        IAgentBook book_,
        IERC20 usdc_,
        IMarkRouter marks_,
        IVolSource vols_
    ) EIP712("Tourbillon AgentRouter", "1") {
        openBook = openBook_;
        marks = marks_;
        vols = vols_;
        engine = engine_;
        book = book_;
        usdc = usdc_;
        usdc_.forceApprove(address(engine_), type(uint256).max); // the Engine pulls each routed buy's cost from here
    }

    // ---------------------------------------------------------------- mandates

    function hashMandate(Mandate calldata m) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    MANDATE_TYPEHASH,
                    m.owner,
                    m.agent,
                    keccak256(abi.encodePacked(m.markets)),
                    m.shapes,
                    m.maxPremiumPerTrade,
                    m.maxPremiumTotal,
                    m.deltaBudgetUsd,
                    m.vegaBudgetUsd,
                    m.expiry,
                    m.closeOnly,
                    m.nonce
                )
            )
        );
    }

    /// @notice The owner revokes every mandate it signed with `nonce`.
    function revoke(uint64 nonce) external {
        revoked[msg.sender][nonce] = true;
        emit Revoked(msg.sender, nonce);
    }

    /// @dev The mandate's hash, if the caller is its agent and it is signed, unrevoked and unexpired.
    function _checkMandate(Mandate calldata m, bytes calldata sig) internal view returns (bytes32 h) {
        if (msg.sender != m.agent) revert NotAgent();
        h = hashMandate(m);
        if (ECDSA.recover(h, sig) != m.owner) revert BadMandateSignature();
        if (revoked[m.owner][m.nonce]) revert MandateRevoked();
        if (block.timestamp > m.expiry) revert MandateExpired(m.expiry);
    }

    /// @notice The shape family of a buyer shape (see the constants).
    function familyOf(StrategyMath.Leg[] calldata legs) public pure returns (uint256) {
        if (legs.length == 1) return legs[0].isCall ? RISE : FALL;
        if (legs.length == 2) {
            bool c0 = legs[0].isCall;
            bool c1 = legs[1].isCall;
            if (c0 && c1) return CALL_SPREAD;
            if (!c0 && !c1) return PUT_SPREAD;
            if (legs[0].qty > 0 && legs[1].qty > 0) return SWING;
        }
        return OTHER;
    }

    // ---------------------------------------------------------------- agent

    /// @notice The agent buys `a` for the mandate's owner through the OpenBook. The owner pays the routed cost (premium +
    ///         fee), within the caps; the position goes to the owner's sub-account.
    function agentBuy(Mandate calldata m, bytes calldata sig, BuyArgs calldata a)
        external
        nonReentrant
        returns (uint256 id, uint256 raw, uint256 cost)
    {
        bytes32 h = _checkMandate(m, sig);
        if (m.closeOnly) revert CloseOnly();
        if (!_listed(m.markets, a.market)) revert MarketNotAllowed(a.market);
        uint256 fam = familyOf(a.legs);
        if (m.shapes & fam == 0) revert ShapeNotAllowed(fam);
        uint256 used = premiumUsed[h];
        if (used >= m.maxPremiumTotal) revert OverTotalCap(used, m.maxPremiumTotal);
        uint256 cap = _min(a.maxCost, _min(m.maxPremiumPerTrade, m.maxPremiumTotal - used));

        usdc.safeTransferFrom(m.owner, address(this), cap);
        uint8 kind;
        // the Engine pulls exactly `cost` (≤ cap) from this router
        (id, cost, kind) =
            openBook.buy(a.market, a.legs, a.movement, a.units, cap, a.deadline, a.quotes, a.sigs, a.offerIds);
        raw = book.balanceOf(id, address(this)) - totalRaw[id];
        premiumUsed[h] = used + cost;
        rawOf[m.owner][id] += raw;
        totalRaw[id] += raw;
        if (mandateRaw[h][id] == 0) _mandatesOf[m.owner][id].push(h);
        mandateRaw[h][id] += raw;
        _charge(m, h, id, a);
        emit AgentBought(h, m.owner, id, raw, cost, kind);
        if (cap > cost) usdc.safeTransfer(m.owner, cap - cost);
    }

    /// @notice The agent sells up to `units` of what it opened on series `id` under this mandate (also when close-only).
    ///         The proceeds go to the owner.
    function agentSell(
        Mandate calldata m,
        bytes calldata sig,
        uint256 id,
        uint256 units,
        uint256 minOut,
        uint256 deadline
    ) external nonReentrant returns (uint256 raw, uint256 net) {
        bytes32 h = _checkMandate(m, sig);
        uint256 mr = mandateRaw[h][id];
        if (mr == 0) revert NothingHeld(id);
        (raw, net) = _sell(m.owner, id, mr, units, minOut, deadline, h);
        _release(h, id, raw, mr);
    }

    // ---------------------------------------------------------------- owner (law 3: always)

    /// @notice The owner sells up to `units` of its sub-account on series `id`, whatever any mandate says.
    function ownerSell(uint256 id, uint256 units, uint256 minOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 raw, uint256 net)
    {
        uint256 held = rawOf[msg.sender][id];
        if (held == 0) revert NothingHeld(id);
        (raw, net) = _sell(msg.sender, id, held, units, minOut, deadline, bytes32(0));
        _releaseOwner(msg.sender, id, raw);
    }

    /// @notice The owner's units on series `id` at the current norm (a read-only walk; may be a few wei above the
    ///         units a sell pays, which rounds down).
    function unitsOf(address owner, uint256 id, uint256 norm) external view returns (uint256) {
        return rawOf[owner][id] * norm / 1e18;
    }

    // ---------------------------------------------------------------- internals

    /// @dev Adds the fill's USD delta and vega to the mandate, within its budgets (skipped when both are unlimited).
    function _charge(Mandate calldata m, bytes32 h, uint256 id, BuyArgs calldata a) internal {
        if (m.deltaBudgetUsd == UNLIMITED && m.vegaBudgetUsd == UNLIMITED) return;
        uint256 s = marks.markWad(a.market); // fresh: the fill just used it
        uint256 sigma;
        try vols.volBps(a.market) returns (uint256 b) {
            sigma = b;
        } catch {
            revert GreeksUnavailable(a.market);
        }
        StrategyMath.Leg[] memory legs = a.legs;
        TempoBlend.Part[] memory mv = a.movement;
        uint256 d = ShapeGreeks.deltaUsd(ShapeGreeks.delta(legs, s, sigma, mv), s, a.units);
        uint256 v = ShapeGreeks.vegaUsd(ShapeGreeks.vega(legs, s, sigma, mv), a.units);
        uint256 dNew = deltaUsed[h] + d;
        uint256 vNew = vegaUsed[h] + v;
        if (dNew > m.deltaBudgetUsd) revert OverDeltaBudget(dNew, m.deltaBudgetUsd);
        if (vNew > m.vegaBudgetUsd) revert OverVegaBudget(vNew, m.vegaBudgetUsd);
        deltaUsed[h] = dNew;
        vegaUsed[h] = vNew;
        mandateDelta[h][id] += d;
        mandateVega[h][id] += v;
    }

    /// @dev Releases `raw` of the `mr` raw mandate `h` holds on `id`: its raw and the same share of its delta and vega.
    function _release(bytes32 h, uint256 id, uint256 raw, uint256 mr) internal {
        if (raw > mr) raw = mr;
        uint256 dRel = raw == mr ? mandateDelta[h][id] : mandateDelta[h][id] * raw / mr;
        uint256 vRel = raw == mr ? mandateVega[h][id] : mandateVega[h][id] * raw / mr;
        mandateRaw[h][id] = mr - raw;
        mandateDelta[h][id] -= dRel;
        mandateVega[h][id] -= vRel;
        deltaUsed[h] -= dRel;
        vegaUsed[h] -= vRel;
    }

    /// @dev An owner's sell of `raw` on `id`: every mandate that opened the series gives up its pro-rata share (the last
    ///      one takes the rounding), so Σ mandate raw stays equal to the owner's raw.
    function _releaseOwner(address owner, uint256 id, uint256 raw) internal {
        bytes32[] storage list = _mandatesOf[owner][id];
        uint256 total;
        for (uint256 i; i < list.length; ++i) {
            total += mandateRaw[list[i]][id];
        }
        if (total == 0) return;
        if (raw > total) raw = total;
        uint256 left = raw;
        for (uint256 i; i < list.length; ++i) {
            bytes32 h = list[i];
            uint256 mr = mandateRaw[h][id];
            uint256 share = raw * mr / total; // rounded down: never more than the mandate holds
            if (share == 0) continue;
            _release(h, id, share, mr);
            left -= share;
        }
        // the rounding (a few wei) from the first mandates that still hold raw
        for (uint256 i; i < list.length && left > 0; ++i) {
            bytes32 h = list[i];
            uint256 mr = mandateRaw[h][id];
            if (mr == 0) continue;
            uint256 share = left < mr ? left : mr;
            _release(h, id, share, mr);
            left -= share;
        }
    }

    /// @dev Sells at most `maxRaw` of `owner`'s raw on `id` (capped at `units`), pays the owner, debits its sub-account.
    function _sell(
        address owner,
        uint256 id,
        uint256 maxRaw,
        uint256 units,
        uint256 minOut,
        uint256 deadline,
        bytes32 mandate
    ) internal returns (uint256 raw, uint256 net) {
        uint256 held = rawOf[owner][id];
        if (maxRaw > held) maxRaw = held;
        (uint256 norm,) = book.accrue(id, type(uint256).max);
        // units the owner's raw pays for, rounded down: the Engine's raw for them (rounded up) never exceeds `maxRaw`
        uint256 cap = maxRaw * norm / 1e18;
        uint256 ask = units < cap ? units : cap;
        uint256 total = totalRaw[id];
        // the last holder of a series takes it all (no dust left behind)
        if (maxRaw == total && units >= cap) ask = type(uint256).max;
        if (ask == 0) revert NothingHeld(id);
        uint256 bal0 = book.balanceOf(id, address(this));
        uint256 paid;
        (paid, net) = engine.sell(id, ask, minOut, deadline);
        raw = bal0 - book.balanceOf(id, address(this));
        rawOf[owner][id] = held - raw;
        totalRaw[id] = total - raw;
        emit PositionSold(owner, id, raw, paid, net, mandate);
        usdc.safeTransfer(owner, net);
    }

    function _listed(bytes32[] calldata markets, bytes32 market) internal pure returns (bool) {
        for (uint256 i; i < markets.length; ++i) {
            if (markets[i] == market) return true;
        }
        return false;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
