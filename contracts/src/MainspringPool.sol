// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ICounterparty} from "./ICounterparty.sol";
import {IWriteCounterparty} from "./IWriteCounterparty.sol";
import {IMatchPool} from "./MatchBook.sol";

/// @notice What the pool needs from the MatchBook (M6).
interface IMatchBookForPool {
    function buyback(uint256 seriesId, uint256 rawSold, uint256 gross, uint256 sWad)
        external
        returns (uint256 paidUsdc, uint256 paidWhype, uint256 shortfall);
    function matchedRaw(uint256 seriesId) external view returns (uint256);
}
import {PoolLiability} from "./PoolLiability.sol";
import {PathFundingBook, IMarkRouter, IVolSource} from "./PathFundingBook.sol";

/// The QuorumBoard reads the pool needs for the EQUITY key.
interface IEquityFeed {
    function latestValue(bytes32 key) external view returns (uint256 value, uint256 updatedAt);
    function previousValue(bytes32 key) external view returns (uint256 value, uint256 updatedAt);
}

/// @title MainspringPool
/// @notice The USDC pool that takes the other side of every Engine trade. LPs hold shares; deposits and withdrawals
///         are queued and settled once per liability epoch, at that hour's NAV (M3 decision 4).
/// @dev    NAV = available USDC + equity term − NAV base liability, where
///         - available USDC = balance − queued deposits − USDC owed to settled withdrawals and refunds;
///         - the equity term counts the pool's capital outside Elysium (M3 step 4): max(0, (sentOut − receivedBack)
///           + P), P = lower of the latest and previous EQUITY finals − EQUITY_OFFSET, P at 95% when positive and at
///           100% when negative (capital in transit or on HyperCore at par). EQUITY is posted by the
///           signer quorum as Hyperliquid P&L only (account value − deposits credited + withdrawals sent home, net of
///           fee) plus a fixed offset, so transfers never pass through it; the in-transit part comes from the pool's
///           own counters. Gains count one round late, losses at once. 0 until two finals exist or once the latest is
///           2 h old; treasury sends need two finals and a latest under 2 h old;
///         - the NAV base liability is accurate (PoolLiability.navBase: buys add their base value, sells subtract
///           theirs at their own S and σ), so a round's NAV favours neither depositors nor those staying.
///         Withdrawals are filled only from available USDC above the stressed liability (sells first, decision 6),
///         pro rata when short; unfilled shares go back to their owners. If NAV is not positive, a round's deposits
///         are refunded and its withdrawals go unfilled. Shares use a virtual offset (as OpenZeppelin's ERC-4626),
///         so donations cannot skew the share price.
///         As counterparty: buys register their series and liability (256 open series per market); sells are paid
///         from available USDC only, else `Insolvent` (decision 7: residual risk beyond the stress scenario, an
///         alarm); 10% of every trade fee goes to the protocol, the rest stays in the pool (decision 8).
///         Risk rules on opens (M3 step 5), all in onBuy so that a refusal undoes the buy and never touches sells,
///         withdrawals or settlement (law 3):
///         - coverage: available Elysium USDC ≥ stressed liability after the buy (equity, queued deposits and owed
///           USDC do not count);
///         - per-market caps on open entry notional (units × S, released pro rata on sells) and on directional
///           exposure (|stressed up − stressed down|); a buy that lowers directional exposure is never refused by it;
///         - a drawdown pause: NAV per share more than 15% below its 30-day high (a ring of daily highs, updated at
///           each settlement) refuses every open until the admin resumes;
///         - per-market open pauses by the risk-pauser key (pause only; the admin unpauses).
///         Admin: the single testnet key, which breaks law 6 until the Safe and guardian (M7).
contract MainspringPool is IWriteCounterparty, IMatchPool, ICounterparty, ERC20, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolLiability for PoolLiability.State;

    uint256 internal constant WAD_PER_USDC_UNIT = 1e12;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant VIRTUAL_SHARES = 1e12; // shares are 18 decimals, USDC 6
    uint256 internal constant VIRTUAL_ASSETS = 1;
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 2000;
    /// Fixed offset added by the signers to the (possibly negative) P&L-only EQUITY value: 10^12 USDC in WAD.
    uint256 public constant EQUITY_OFFSET = 1e30;
    uint256 public constant EQUITY_MAX_AGE = 2 hours;
    uint256 public constant EQUITY_HAIRCUT_BPS = 9500;
    bytes32 public constant RISK_PAUSER_ROLE = keccak256("RISK_PAUSER_ROLE");
    /// @notice Pauses deposits (M7 G3: the guardian; not the automated risk key).
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    /// @notice Lifts market, drawdown and deposit pauses (M7 G4: the Safe directly, no timelock delay).
    bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");
    /// @notice Moves USDC to and from the treasury within the daily cap (M7 G6: the Safe directly).
    bytes32 public constant TREASURER_ROLE = keccak256("TREASURER_ROLE");
    uint256 public constant DRAWDOWN_BPS = 1500;
    uint256 public constant DRAWDOWN_DAYS = 30;

    struct Round {
        uint256 deposits; // USDC queued
        uint256 withdrawShares; // shares escrowed
        bool settled;
        bool refunded; // NAV was not positive: deposits refunded
        uint256 sharesMinted; // for the round's deposits, held by the pool until claimed
        uint256 sharesFilled; // of withdrawShares, burned
        uint256 assetsPaid; // USDC owed to the round's withdrawals
        uint256 nav; // USDC, at settlement
        uint256 navPerShare; // USDC (6 decimals) per 1e18 shares, at settlement
        uint64 at;
    }

    IERC20 internal immutable _usdc;
    IEquityFeed public immutable equityFeed;
    address public engine;
    address public writerBook; // M4: the WriterBook, set once
    IERC20 public whype; // M4: WHYPE received in buybacks, counted in NAV at the HYPE mark × 95% (owner decision A)
    bytes32 public whypeMarket; // the market whose mark values WHYPE (HYPE)
    uint256 public constant WHYPE_HAIRCUT_BPS = 9500;
    address public matchBook; // M6: matched writes of the open book, set once
    address public auction; // M6: the weekly risk auction, set once
    mapping(bytes32 => uint256) public openBookCap; // USDC; matched notional allowed per market (testnet cap, D2)
    mapping(bytes32 => uint256) public openBookNotional; // USDC, entry notional of matched raw per market
    mapping(uint256 => uint256) public openBookSeriesNotional;
    address public protocolRecipient;
    uint16 public protocolFeeBps = 1000;

    PoolLiability.State internal liab;

    uint256 public queuedDeposits; // USDC of the open round
    uint256 public owed; // USDC owed to settled withdrawals and refunds, not yet claimed
    uint256 public round; // the open round
    uint256 public lastSettledEpoch;
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(address => uint256)) public depositOf;
    mapping(uint256 => mapping(address => uint256)) public withdrawOf;

    // treasury (manual capital moves to and from the pool's Hyperliquid account, M3 decision 1)
    address public treasury;
    uint16 public treasuryDailyCapBps = 2000; // of NAV per UTC day
    uint256 public sentOut; // USDC, cumulative
    uint256 public receivedBack; // USDC, cumulative
    mapping(uint256 => uint256) public sentOnDay; // UTC day → USDC sent

    // risk rules on opens (step 5)
    mapping(bytes32 => uint256) public notionalCap; // USDC; 0 = no opens
    mapping(bytes32 => uint256) public directionalCap; // USDC; 0 = no opens
    mapping(bytes32 => uint256) public openNotional; // USDC, entry notional per market
    mapping(uint256 => uint256) public seriesNotional; // USDC, entry notional per series
    mapping(bytes32 => bool) public marketPaused;
    bool public opensPaused; // drawdown
    bool public depositsPaused; // the guardian (M7)
    uint256[30] internal _dayHigh; // NAV per share, daily highs
    /// @notice The hedger's delta cap per market (USD of delta, USDC units). Rule: directionalCap ≤ hedgerDeltaCap ×
    ///         2 × shock, so the directional book the pool accepts is one the hedger can carry (owner rule, M3).
    mapping(bytes32 => uint256) public hedgerDeltaCap;
    uint256[30] internal _dayOf; // the UTC day (plus one) each slot holds

    event EngineSet(address engine);
    event WriterBookSet(address writerBook);
    event WhypeSet(address whype, bytes32 market);
    event MatchBookSet(address matchBook);
    event AuctionSet(address auction);
    event OpenBookCapSet(bytes32 indexed market, uint256 cap);
    event MatchedOpened(
        bytes32 indexed market,
        uint256 indexed id,
        uint256 raw,
        uint256 premium,
        uint256 credit,
        uint256 fee,
        uint256 cut
    );
    event BuybackSettled(uint256 indexed id, uint256 paidUsdc, uint256 paidWhype, uint256 shortfall);
    event BuybackFailed(uint256 indexed id, uint256 rawSold);
    event Carried(uint256 indexed id, uint256 raw);
    event AuctionFilled(uint256 indexed id, uint256 raw, uint256 price, address winner);
    event EarlyCloseTaken(
        bytes32 indexed market, uint256 indexed id, uint256 raw, int256 cost, uint256 fee, uint256 cut
    );
    event TradeWritten(
        bytes32 indexed market, uint256 indexed seriesId, uint256 writeId, int256 credit, uint256 fee, uint256 cut
    );
    event TradeUnwritten(
        bytes32 indexed market,
        uint256 indexed seriesId,
        uint256 writeId,
        int256 cost,
        uint256 fee,
        uint256 cut,
        uint256 whypeIn
    );
    event ProtocolFeeSet(uint256 bps, address recipient);
    event DepositQueued(uint256 indexed round, address indexed lp, uint256 assets);
    event DepositCancelled(uint256 indexed round, address indexed lp, uint256 assets);
    event WithdrawQueued(uint256 indexed round, address indexed lp, uint256 shares);
    event WithdrawCancelled(uint256 indexed round, address indexed lp, uint256 shares);
    event Settled(
        uint256 indexed round,
        uint256 epoch,
        uint256 nav,
        uint256 navPerShare,
        uint256 sharesMinted,
        uint256 sharesFilled,
        uint256 assetsPaid,
        bool refunded
    );
    event SharesClaimed(uint256 indexed round, address indexed lp, uint256 shares, uint256 refund);
    event Withdrawn(uint256 indexed round, address indexed lp, uint256 assets, uint256 sharesReturned);
    event TradeBought(bytes32 indexed market, uint256 indexed id, uint256 premium, uint256 fee, uint256 protocolCut);
    event TradeSold(bytes32 indexed market, uint256 indexed id, uint256 gross, uint256 net, uint256 protocolCut);
    event TreasurySet(address indexed treasury);
    event TreasuryCapSet(uint256 bps);
    event TreasurySent(address indexed treasury, uint256 amount, uint256 sentOut, uint256 sentToday, uint256 navBefore);
    event TreasuryReturned(address indexed treasury, uint256 amount, uint256 receivedBack);
    event CapsSet(bytes32 indexed market, uint256 notionalCap, uint256 directionalCap);
    event HedgerDeltaCapSet(bytes32 indexed market, uint256 deltaCap);
    event MarketPaused(bytes32 indexed market, address by);
    event MarketUnpaused(bytes32 indexed market, address by);
    event DepositsPaused(address by);
    event DepositsUnpaused(address by);
    event DrawdownPause(uint256 navPerShare, uint256 high30);
    event OpensResumed(address by, uint256 navPerShare);

    error ZeroAddress();
    error NotSixDecimals(uint8 decimals);
    error NotEngine();
    error EngineAlreadySet();
    error NotWriterBook();
    error WriterBookAlreadySet();
    error WhypeAlreadySet();
    error NotMatchBook();
    error NotAuction();
    error MatchBookAlreadySet();
    error OpenBookCapExceeded(bytes32 market, uint256 wouldBe, uint256 cap);
    error ZeroAmount();
    error NothingQueued();
    error RoundNotSettled(uint256 round);
    error NothingToSettle();
    error Insolvent(uint256 needed, uint256 available);
    error FeeTooHigh(uint256 bps);
    error NoTreasury();
    error EquityNotReady();
    error NotTreasury();
    error AboveFree(uint256 amount, uint256 free);
    error AboveDailyCap(uint256 amount, uint256 room);
    error CapTooHigh(uint256 bps);
    error CoverageBreached(uint256 available, uint256 stressedLiability);
    error NotionalCapExceeded(bytes32 market, uint256 wouldBe, uint256 cap);
    error DirectionalCapExceeded(bytes32 market, uint256 wouldBe, uint256 cap);
    error DirectionalAboveHedge(bytes32 market, uint256 directionalCap, uint256 maxByHedge);
    error OpensArePaused();
    error MarketIsPaused(bytes32 market);
    error DepositsArePaused();

    constructor(
        address admin,
        IERC20 usdc_,
        PathFundingBook book,
        IMarkRouter marks,
        IVolSource vols,
        IEquityFeed equityFeed_,
        address protocolRecipient_
    ) ERC20("Mainspring Share", "MSPR") {
        if (
            admin == address(0) || address(usdc_) == address(0) || protocolRecipient_ == address(0)
                || address(equityFeed_) == address(0)
        ) {
            revert ZeroAddress();
        }
        equityFeed = equityFeed_;
        uint8 d = IERC20Metadata(address(usdc_)).decimals();
        if (d != 6) revert NotSixDecimals(d);
        _usdc = usdc_;
        protocolRecipient = protocolRecipient_;
        liab.init(book, marks, vols, 15_000);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin); // until the M7 handover moves it to the guardian
        _grantRole(UNPAUSER_ROLE, admin); // … and this one to the Safe
        _grantRole(TREASURER_ROLE, admin); // … and this one too
    }

    modifier onlyWriterBook() {
        if (msg.sender != writerBook || writerBook == address(0)) revert NotWriterBook();
        _;
    }

    modifier onlyEngine() {
        if (msg.sender != engine || engine == address(0)) revert NotEngine();
        _;
    }

    // ---------------------------------------------------------------- LPs

    /// @notice Queues `assets` USDC for the open round; shares are minted at that round's NAV.
    function deposit(uint256 assets) external nonReentrant {
        if (depositsPaused) revert DepositsArePaused();
        if (assets == 0) revert ZeroAmount();
        _usdc.safeTransferFrom(msg.sender, address(this), assets);
        rounds[round].deposits += assets;
        depositOf[round][msg.sender] += assets;
        queuedDeposits += assets;
        emit DepositQueued(round, msg.sender, assets);
    }

    function cancelDeposit() external nonReentrant {
        uint256 a = depositOf[round][msg.sender];
        if (a == 0) revert NothingQueued();
        depositOf[round][msg.sender] = 0;
        rounds[round].deposits -= a;
        queuedDeposits -= a;
        emit DepositCancelled(round, msg.sender, a);
        _usdc.safeTransfer(msg.sender, a);
    }

    /// @notice Queues `shares` for withdrawal in the open round; they are held by the pool until settlement.
    function requestWithdraw(uint256 shares) external nonReentrant {
        if (shares == 0) revert ZeroAmount();
        _transfer(msg.sender, address(this), shares);
        rounds[round].withdrawShares += shares;
        withdrawOf[round][msg.sender] += shares;
        emit WithdrawQueued(round, msg.sender, shares);
    }

    function cancelWithdraw() external nonReentrant {
        uint256 sh = withdrawOf[round][msg.sender];
        if (sh == 0) revert NothingQueued();
        withdrawOf[round][msg.sender] = 0;
        rounds[round].withdrawShares -= sh;
        emit WithdrawCancelled(round, msg.sender, sh);
        _transfer(address(this), msg.sender, sh);
    }

    /// @notice Permissionless: settles the open round once per finalized liability epoch.
    function settle() external nonReentrant {
        if (liab.marking || liab.epoch <= lastSettledEpoch) revert NothingToSettle();
        uint256 r = round;
        Round storage rd = rounds[r];
        uint256 nav = navNow();
        uint256 supply = totalSupply();

        // NAV not positive because liability has reached the assets (an empty pool with no liability is at par)
        if (nav == 0 && (liab.totalNavBase() > 0 || liab.totalWrittenNavBase() < 0)) {
            // NAV not positive: deposits refunded, withdrawals unfilled
            rd.refunded = true;
            queuedDeposits -= rd.deposits;
            owed += rd.deposits;
        } else {
            // withdrawals first, at NAV, from free USDC above the stressed liability only (sells first)
            if (rd.withdrawShares > 0) {
                uint256 value = _toAssets(rd.withdrawShares, nav, supply);
                uint256 free = freeForWithdrawals();
                uint256 filled = rd.withdrawShares;
                if (value > free) filled = Math.mulDiv(rd.withdrawShares, free, value);
                uint256 paid = _toAssets(filled, nav, supply);
                rd.sharesFilled = filled;
                rd.assetsPaid = paid;
                _burn(address(this), filled);
                owed += paid;
                nav -= paid;
                supply -= filled;
            }
            // then deposits, at the same price
            if (rd.deposits > 0) {
                uint256 minted = _toShares(rd.deposits, nav, supply);
                rd.sharesMinted = minted;
                _mint(address(this), minted);
                queuedDeposits -= rd.deposits;
            }
        }
        rd.settled = true;
        rd.nav = navNow(); // after the round (withdrawals paid, deposits in), for the record
        rd.navPerShare = _toAssets(1e18, nav, supply);
        _checkDrawdown(rd.navPerShare);
        rd.at = uint64(block.timestamp);
        lastSettledEpoch = liab.epoch;
        round = r + 1;
        emit Settled(
            r, liab.epoch, rd.nav, rd.navPerShare, rd.sharesMinted, rd.sharesFilled, rd.assetsPaid, rd.refunded
        );
    }

    /// @notice A depositor's shares from a settled round (or the USDC back if that round was refunded).
    function claimShares(uint256 r) external nonReentrant {
        Round storage rd = rounds[r];
        if (!rd.settled) revert RoundNotSettled(r);
        uint256 a = depositOf[r][msg.sender];
        if (a == 0) revert NothingQueued();
        depositOf[r][msg.sender] = 0;
        if (rd.refunded) {
            owed -= a;
            emit SharesClaimed(r, msg.sender, 0, a);
            _usdc.safeTransfer(msg.sender, a);
            return;
        }
        uint256 sh = Math.mulDiv(a, rd.sharesMinted, rd.deposits);
        emit SharesClaimed(r, msg.sender, sh, 0);
        _transfer(address(this), msg.sender, sh);
    }

    /// @notice A withdrawer's USDC from a settled round, and any shares that were not filled.
    function withdraw(uint256 r) external nonReentrant {
        Round storage rd = rounds[r];
        if (!rd.settled) revert RoundNotSettled(r);
        uint256 sh = withdrawOf[r][msg.sender];
        if (sh == 0) revert NothingQueued();
        withdrawOf[r][msg.sender] = 0;
        // USDC rounded down and filled shares rounded up, so the sums over all withdrawers never exceed what the
        // round set aside (the USDC owed and the unfilled shares held in escrow)
        uint256 assets = Math.mulDiv(sh, rd.assetsPaid, rd.withdrawShares);
        uint256 filled = Math.mulDiv(sh, rd.sharesFilled, rd.withdrawShares, Math.Rounding.Ceil);
        uint256 back = sh - filled;
        owed -= assets;
        emit Withdrawn(r, msg.sender, assets, back);
        if (back > 0) _transfer(address(this), msg.sender, back);
        if (assets > 0) _usdc.safeTransfer(msg.sender, assets);
    }

    // ---------------------------------------------------------------- counterparty

    function asset() external view returns (IERC20) {
        return _usdc;
    }

    /// @inheritdoc ICounterparty
    function onBuy(
        bytes32 market,
        uint256 id,
        uint256 units,
        uint256 raw,
        uint256 sWad,
        uint256 sigmaBps,
        uint256 premium,
        uint256 fee
    ) external onlyEngine {
        if (opensPaused) revert OpensArePaused();
        if (marketPaused[market]) revert MarketIsPaused(market);

        // notional cap (entry notional, released pro rata on sells); a shape counts max(long, short) units of
        // underlying per unit (M4 step 6)
        uint256 underlying = Math.mulDiv(units, liab.notionalPerUnit(id), 1e18, Math.Rounding.Ceil);
        uint256 notional = Math.ceilDiv(Math.mulDiv(underlying, sWad, 1e18, Math.Rounding.Ceil), WAD_PER_USDC_UNIT);
        uint256 nWould = openNotional[market] + notional;
        if (nWould > notionalCap[market]) revert NotionalCapExceeded(market, nWould, notionalCap[market]);
        openNotional[market] = nWould;
        seriesNotional[id] += notional;

        // directional cap: refused only if the buy raises exposure above the cap
        uint256 dirBefore = liab.liveDirectional(market);
        liab.onBuy(market, id, units, raw, sWad, sigmaBps);
        uint256 dirAfter = Math.ceilDiv(liab.liveDirectional(market), WAD_PER_USDC_UNIT);
        if (dirAfter > directionalCap[market] && dirAfter > Math.ceilDiv(dirBefore, WAD_PER_USDC_UNIT)) {
            revert DirectionalCapExceeded(market, dirAfter, directionalCap[market]);
        }

        uint256 cut = fee * protocolFeeBps / BPS;
        emit TradeBought(market, id, premium, fee, cut);
        if (cut > 0) _usdc.safeTransfer(protocolRecipient, cut);

        // coverage: Elysium USDC must still cover the stressed liability (sells first, law 3)
        uint256 avail = available();
        uint256 stressed = stressedLiability();
        if (avail < stressed) revert CoverageBreached(avail, stressed);
    }

    /// @inheritdoc ICounterparty
    function onSell(
        bytes32 market,
        uint256 id,
        uint256 raw,
        uint256 units,
        uint256 sWad,
        uint256 sigmaBps,
        uint256 gross,
        uint256 net,
        uint256 fee,
        address to
    ) external onlyEngine {
        uint256 held = liab.raw[id];
        uint256 mBefore = liab.mraw[id];
        uint256 mNew = _buyback(id, raw, gross, sWad, mBefore);
        uint256 rawSold = raw > held ? held : raw;
        uint256 rawAfter = held - rawSold;
        if (mNew > rawAfter) mNew = rawAfter; // matched raw never above the buyer raw it mirrors
        uint256 ownBefore = held - mBefore;
        uint256 ownAfter = rawAfter - mNew;
        _releaseNotional(market, id, ownBefore, ownAfter, mBefore, mNew);
        liab.setMatched(id, mNew);
        // the NAV base drops only for the raw the pool carried and no longer does
        uint256 dropped = ownAfter < ownBefore ? ownBefore - ownAfter : 0;
        liab.onSell(id, rawSold, rawSold == 0 ? 0 : Math.mulDiv(gross * WAD_PER_USDC_UNIT, dropped, rawSold));
        if (ownAfter > ownBefore && rawSold > 0) {
            // a buyback left raw uncovered: the pool carries it, in stress and coverage, from now on (D1 backstop)
            liab.addCarried(id, Math.mulDiv(units, ownAfter - ownBefore, rawSold), sWad, sigmaBps);
            emit Carried(id, ownAfter - ownBefore);
        }
        uint256 cut = fee * protocolFeeBps / BPS;
        uint256 avail = available();
        if (avail < net + cut) revert Insolvent(net + cut, avail);
        emit TradeSold(market, id, gross, net, cut);
        if (net > 0) _usdc.safeTransfer(to, net);
        if (cut > 0) _usdc.safeTransfer(protocolRecipient, cut);
    }

    /// @dev The sources' buyback for a sell (M6 D1). Never blocks the sell (law 3): on a revert the pool pays alone and
    ///      the matched raw is clamped to the buyer raw left. Returns the matched raw the MatchBook still covers.
    function _buyback(uint256 id, uint256 raw, uint256 gross, uint256 sWad, uint256 mBefore)
        internal
        returns (uint256)
    {
        if (mBefore == 0 || matchBook == address(0)) return mBefore;
        try IMatchBookForPool(matchBook).buyback(id, raw, gross, sWad) returns (uint256 pu, uint256 ph, uint256 sf) {
            emit BuybackSettled(id, pu, ph, sf);
            return IMatchBookForPool(matchBook).matchedRaw(id);
        } catch {
            emit BuybackFailed(id, raw);
            return mBefore;
        }
    }

    function _releaseNotional(
        bytes32 market,
        uint256 id,
        uint256 ownBefore,
        uint256 ownAfter,
        uint256 mBefore,
        uint256 mNew
    ) internal {
        if (ownBefore > 0 && ownAfter < ownBefore) {
            uint256 sold = ownBefore - ownAfter;
            uint256 rel = sold >= ownBefore ? seriesNotional[id] : Math.mulDiv(seriesNotional[id], sold, ownBefore);
            seriesNotional[id] -= rel;
            openNotional[market] -= rel;
        }
        if (mBefore > 0 && mNew < mBefore) {
            uint256 closed = mBefore - mNew;
            uint256 rel = closed >= mBefore
                ? openBookSeriesNotional[id]
                : Math.mulDiv(openBookSeriesNotional[id], closed, mBefore);
            openBookSeriesNotional[id] -= rel;
            openBookNotional[market] -= rel;
        }
    }

    /// @notice A matched open (M6 D1, the Engine's router path): the buyer's raw against the pool, mirrored by the same
    ///         matched raw the MatchBook has just locked. The pool pays the source `credit` (its value at its σ, D6) and
    ///         keeps the fee (10% to the protocol). Opens: refused while paused; the open-book notional cap applies; the
    ///         pool's own caps and coverage do not (it is flat, D2).
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
    ) external onlyEngine {
        if (opensPaused) revert OpensArePaused();
        if (marketPaused[market]) revert MarketIsPaused(market);
        uint256 n = _notional(id, units, sWad);
        uint256 ob = openBookNotional[market] + n;
        if (ob > openBookCap[market]) revert OpenBookCapExceeded(market, ob, openBookCap[market]);
        openBookNotional[market] = ob;
        openBookSeriesNotional[id] += n;
        liab.onMatchedBuy(market, id, raw);
        uint256 cut = fee * protocolFeeBps / BPS;
        emit MatchedOpened(market, id, raw, premium, credit, fee, cut);
        if (credit > 0) _usdc.safeTransfer(payee, credit);
        if (cut > 0) _usdc.safeTransfer(protocolRecipient, cut);
    }

    /// @inheritdoc IMatchPool
    /// @dev The pool takes the buyer's side back (D3): an open, so its checks apply (pauses, caps, coverage); the cost
    ///      has been paid in; a negative cost is paid out to the source.
    function onEarlyClose(
        bytes32 market,
        uint256 id,
        uint256 raw,
        uint256 units,
        uint256 sWad,
        uint256 sigmaBps,
        int256 cost,
        uint256 fee,
        address payee
    ) external {
        if (msg.sender != matchBook || matchBook == address(0)) revert NotMatchBook();
        if (opensPaused) revert OpensArePaused();
        if (marketPaused[market]) revert MarketIsPaused(market);
        uint256 m = liab.mraw[id];
        uint256 mNew = m > raw ? m - raw : 0;
        _releaseNotional(market, id, 0, 0, m, mNew);
        uint256 n = _notional(id, units, sWad);
        uint256 nWould = openNotional[market] + n;
        if (nWould > notionalCap[market]) revert NotionalCapExceeded(market, nWould, notionalCap[market]);
        openNotional[market] = nWould;
        seriesNotional[id] += n;
        uint256 dirBefore = liab.liveDirectional(market);
        liab.setMatched(id, mNew);
        liab.addCarried(id, units, sWad, sigmaBps);
        uint256 dirAfter = Math.ceilDiv(liab.liveDirectional(market), WAD_PER_USDC_UNIT);
        if (dirAfter > directionalCap[market] && dirAfter > Math.ceilDiv(dirBefore, WAD_PER_USDC_UNIT)) {
            revert DirectionalCapExceeded(market, dirAfter, directionalCap[market]);
        }
        uint256 cut = fee * protocolFeeBps / BPS;
        uint256 payout = cost < 0 ? uint256(-cost) : 0;
        emit EarlyCloseTaken(market, id, raw, cost, fee, cut);
        if (payout > 0) _usdc.safeTransfer(payee, payout);
        if (cut > 0) _usdc.safeTransfer(protocolRecipient, cut);
        uint256 avail = available();
        uint256 stressed = stressedLiability();
        if (avail < stressed) revert CoverageBreached(avail, stressed);
    }

    function _notional(uint256 id, uint256 units, uint256 sWad) internal view returns (uint256) {
        uint256 underlying = Math.mulDiv(units, liab.notionalPerUnit(id), 1e18, Math.Rounding.Ceil);
        return Math.ceilDiv(Math.mulDiv(underlying, sWad, 1e18, Math.Rounding.Ceil), WAD_PER_USDC_UNIT);
    }

    function matchedRawOf(uint256 id) external view returns (uint256) {
        return liab.mraw[id];
    }

    /// @inheritdoc IWriteCounterparty
    /// @dev A write is an open: refused while opens or the market are paused, if it raises directional exposure above
    ///      the cap, and if paying the credit would leave the stressed liability uncovered. The written shape adds to
    ///      NAV at its value; the stressed liability and coverage count it 0 (D9).
    function onWrite(
        bytes32 market,
        uint256 seriesId,
        uint256 writeId,
        uint256 units,
        uint256 raw,
        uint256 sWad,
        uint256 sigmaBps,
        int256 credit,
        uint256 fee,
        address writer
    ) external onlyWriterBook {
        if (opensPaused) revert OpensArePaused();
        if (marketPaused[market]) revert MarketIsPaused(market);
        // the pool holds the written shape: it adds to NAV and counts in the directional cap (D9)
        uint256 dirBefore = liab.liveDirectional(market);
        liab.onWrite(market, seriesId, units, raw, sWad, sigmaBps);
        uint256 dirAfter = Math.ceilDiv(liab.liveDirectional(market), WAD_PER_USDC_UNIT);
        if (dirAfter > directionalCap[market] && dirAfter > Math.ceilDiv(dirBefore, WAD_PER_USDC_UNIT)) {
            revert DirectionalCapExceeded(market, dirAfter, directionalCap[market]);
        }
        uint256 cut = fee * protocolFeeBps / BPS;
        emit TradeWritten(market, seriesId, writeId, credit, fee, cut);
        if (credit > 0) _usdc.safeTransfer(writer, uint256(credit));
        if (cut > 0) _usdc.safeTransfer(protocolRecipient, cut);
        uint256 avail = available();
        uint256 stressed = stressedLiability();
        if (avail < stressed) revert CoverageBreached(avail, stressed);
    }

    /// @inheritdoc IWriteCounterparty
    /// @dev Never paused. WHYPE received in a buyback is held by the pool and counted in NAV at the HYPE mark × 95%,
    ///      never in coverage or withdrawals (USDC only); it is converted through the treasury procedure.
    function onUnwrite(
        bytes32 market,
        uint256 seriesId,
        uint256 writeId,
        uint256 raw,
        uint256 units,
        uint256 sWad,
        uint256 sigmaBps,
        int256 cost,
        uint256 fee,
        uint256,
        uint256 whypeIn,
        address writer
    ) external onlyWriterBook {
        liab.onUnwrite(seriesId, raw, units, sWad, sigmaBps);
        uint256 cut = fee * protocolFeeBps / BPS;
        uint256 payout = cost < 0 ? uint256(-cost) : 0;
        uint256 avail = available();
        if (avail < payout + cut) revert Insolvent(payout + cut, avail);
        emit TradeUnwritten(market, seriesId, writeId, cost, fee, cut, whypeIn);
        if (payout > 0) _usdc.safeTransfer(writer, payout);
        if (cut > 0) _usdc.safeTransfer(protocolRecipient, cut);
    }

    // ---------------------------------------------------------------- epochs (permissionless)

    function startEpoch() external {
        liab.startEpoch();
    }

    function markChunk(uint256 maxSeries) external returns (bool done) {
        return liab.markChunk(maxSeries);
    }

    // ---------------------------------------------------------------- reads

    /// @notice USDC that belongs to the pool's LPs and pays sells: balance − queued deposits − owed.
    function available() public view returns (uint256) {
        uint256 bal = _usdc.balanceOf(address(this));
        uint256 reserved = queuedDeposits + owed;
        return bal > reserved ? bal - reserved : 0;
    }

    /// @notice The EQUITY board key of this pool: keccak256(abi.encode("EQUITY", pool)).
    function equityKey() public view returns (bytes32) {
        return keccak256(abi.encode("EQUITY", address(this)));
    }

    /// @notice True when two EQUITY finals exist and the latest is less than 2 h old. Treasury sends require it, so
    ///         a send never happens while the capital in transit would go uncounted.
    function equityReady() public view returns (bool ok) {
        (ok,) = _equityPnl();
    }

    /// @notice Capital outside Elysium counted in NAV (USDC): max(0, (sentOut − receivedBack) + P'), where P is the
    ///         lower of the latest and previous EQUITY finals minus the offset (Hyperliquid P&L), counted at 95% when
    ///         positive and at 100% when negative. Capital in transit or on HyperCore counts at par. 0 unless
    ///         equityReady().
    function equityTerm() public view returns (uint256) {
        (bool ok, int256 pnl) = _equityPnl();
        if (!ok) return 0;
        if (pnl > 0) pnl = pnl * int256(EQUITY_HAIRCUT_BPS) / int256(BPS); // a gain at 95%, rounded down
        int256 total = int256(sentOut * WAD_PER_USDC_UNIT) - int256(receivedBack * WAD_PER_USDC_UNIT) + pnl;
        return total > 0 ? uint256(total) / WAD_PER_USDC_UNIT : 0;
    }

    /// @dev (ready, P): P = lower(latest, previous EQUITY) − EQUITY_OFFSET, WAD, signed.
    function _equityPnl() internal view returns (bool, int256) {
        bytes32 key = equityKey();
        uint256 latest;
        uint256 latestAt;
        uint256 previous;
        try equityFeed.latestValue(key) returns (uint256 v, uint256 at) {
            (latest, latestAt) = (v, at);
        } catch {
            return (false, 0);
        }
        try equityFeed.previousValue(key) returns (uint256 v, uint256) {
            previous = v;
        } catch {
            return (false, 0);
        }
        if (block.timestamp >= latestAt + EQUITY_MAX_AGE) return (false, 0);
        uint256 lower = latest < previous ? latest : previous;
        return (true, int256(lower) - int256(EQUITY_OFFSET));
    }

    /// @notice NAV in USDC (0 if not positive): available + equity term + WHYPE term + written shapes the pool holds
    ///         − NAV base liability.
    function navNow() public view returns (uint256) {
        uint256 assets = available() + equityTerm() + whypeTerm();
        uint256 liability = Math.ceilDiv(liab.totalNavBase(), WAD_PER_USDC_UNIT);
        // written shapes the pool holds: an asset, or a liability when worth less than 0 (rounded against the pool)
        int256 wWad = liab.totalWrittenNavBase();
        int256 written =
            wWad >= 0 ? wWad / int256(WAD_PER_USDC_UNIT) : -int256(Math.ceilDiv(uint256(-wWad), WAD_PER_USDC_UNIT));
        int256 nav = int256(assets) + written - int256(liability);
        return nav > 0 ? uint256(nav) : 0;
    }

    /// @notice Stressed liability in USDC (the conservative bound used for withdrawals and the coverage rule).
    function stressedLiability() public view returns (uint256) {
        return Math.ceilDiv(liab.totalLiveStressed(), WAD_PER_USDC_UNIT);
    }

    /// @notice Available USDC above the stressed liability: all that withdrawals may take.
    function freeForWithdrawals() public view returns (uint256) {
        uint256 a = available();
        uint256 s = stressedLiability();
        return a > s ? a - s : 0;
    }

    function epoch() external view returns (uint256) {
        return liab.epoch;
    }

    /// @notice Start of the epoch being marked (or of the last final one) and when the last one became final. For the
    ///         keeper (the poker) that starts an epoch once an hour has passed.
    function epochTimes() external view returns (uint64 epochStart, uint64 lastFinal) {
        return (liab.epochStart, liab.lastFinal);
    }

    function marking() external view returns (bool) {
        return liab.marking;
    }

    function openSeries(bytes32 market) external view returns (uint256[] memory) {
        return liab.m[market].series;
    }

    function seriesRaw(uint256 id) external view returns (uint256) {
        return liab.raw[id];
    }

    /// @notice The pool's WHYPE at the WHYPE market's mark × 95%, in USDC (rounded down); 0 while the mark is stale.
    function whypeTerm() public view returns (uint256) {
        if (address(whype) == address(0)) return 0;
        uint256 bal = whype.balanceOf(address(this));
        if (bal == 0) return 0;
        try liab.marks.markWad(whypeMarket) returns (uint256 px) {
            return Math.mulDiv(bal, px * WHYPE_HAIRCUT_BPS, 1e18 * BPS) / WAD_PER_USDC_UNIT;
        } catch {
            return 0;
        }
    }

    function writtenNavBase(bytes32 market) external view returns (int256) {
        return liab.writtenNavBase(market);
    }

    function writtenRaw(uint256 id) external view returns (uint256) {
        return liab.writtenRaw(id);
    }

    function navBase(bytes32 market) external view returns (uint256) {
        return liab.navBase(market);
    }

    function liveStressed(bytes32 market) external view returns (uint256) {
        return liab.liveStressed(market);
    }

    // ---------------------------------------------------------------- drawdown

    /// @dev Records NAV per share in today's slot of the 30-day ring, then pauses opens if it is more than 15% below
    ///      the highest daily high of the last 30 days.
    function _checkDrawdown(uint256 nps) internal {
        uint256 day = block.timestamp / 1 days;
        uint256 slot = day % DRAWDOWN_DAYS;
        if (_dayOf[slot] != day + 1) {
            _dayOf[slot] = day + 1;
            _dayHigh[slot] = nps;
        } else if (nps > _dayHigh[slot]) {
            _dayHigh[slot] = nps;
        }
        uint256 high = high30();
        if (!opensPaused && nps * BPS < high * (BPS - DRAWDOWN_BPS)) {
            opensPaused = true;
            emit DrawdownPause(nps, high);
        }
    }

    /// @notice The highest NAV per share recorded at a settlement in the last 30 days.
    function high30() public view returns (uint256 high) {
        uint256 day = block.timestamp / 1 days;
        for (uint256 i; i < DRAWDOWN_DAYS; ++i) {
            uint256 d = _dayOf[i];
            if (d != 0 && day + 1 - d < DRAWDOWN_DAYS && _dayHigh[i] > high) high = _dayHigh[i];
        }
    }

    /// @notice The unpauser only (M7 G4): lifts the drawdown pause. The 30-day window restarts from the last settled NAV per share,
    ///         otherwise the next settlement would pause again at once.
    function resumeOpens() external onlyRole(UNPAUSER_ROLE) {
        opensPaused = false;
        uint256 nps = round == 0 ? 0 : rounds[round - 1].navPerShare;
        uint256 day = block.timestamp / 1 days;
        for (uint256 i; i < DRAWDOWN_DAYS; ++i) {
            _dayOf[i] = 0;
            _dayHigh[i] = 0;
        }
        _dayOf[day % DRAWDOWN_DAYS] = day + 1;
        _dayHigh[day % DRAWDOWN_DAYS] = nps;
        emit OpensResumed(msg.sender, nps);
    }

    // ---------------------------------------------------------------- market pauses

    /// @notice Risk-pauser key: stops opens on one market. It can never unpause.
    function pauseMarket(bytes32 market) external onlyRole(RISK_PAUSER_ROLE) {
        marketPaused[market] = true;
        emit MarketPaused(market, msg.sender);
    }

    function unpauseMarket(bytes32 market) external onlyRole(UNPAUSER_ROLE) {
        marketPaused[market] = false;
        emit MarketUnpaused(market, msg.sender);
    }

    /// @notice The pauser (the guardian): stops new deposits (M7 G18). Queued deposits still settle; withdrawals,
    ///         claims and sells are never paused.
    function pauseDeposits() external onlyRole(PAUSER_ROLE) {
        depositsPaused = true;
        emit DepositsPaused(msg.sender);
    }

    function unpauseDeposits() external onlyRole(UNPAUSER_ROLE) {
        depositsPaused = false;
        emit DepositsUnpaused(msg.sender);
    }

    function setCaps(bytes32 market, uint256 notionalCap_, uint256 directionalCap_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        notionalCap[market] = notionalCap_;
        directionalCap[market] = directionalCap_;
        _checkHedgeRule(market);
        emit CapsSet(market, notionalCap_, directionalCap_);
    }

    /// @notice Sets the hedger's delta cap for a market; refused if the market's directional cap would then break the
    ///         rule directionalCap ≤ hedgerDeltaCap × 2 × shock.
    function setHedgerDeltaCap(bytes32 market, uint256 deltaCap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        hedgerDeltaCap[market] = deltaCap;
        _checkHedgeRule(market);
        emit HedgerDeltaCapSet(market, deltaCap);
    }

    /// @notice The largest directional cap the hedger capacity allows: hedgerDeltaCap × 2 × shock (USDC, rounded
    ///         down). 0 for a market not listed.
    function maxDirectionalCap(bytes32 market) public view returns (uint256) {
        return Math.mulDiv(hedgerDeltaCap[market], 2 * uint256(liab.m[market].shockBps), BPS);
    }

    function _checkHedgeRule(bytes32 market) internal view {
        uint256 maxCap = maxDirectionalCap(market);
        if (directionalCap[market] > maxCap) revert DirectionalAboveHedge(market, directionalCap[market], maxCap);
    }

    function directional(bytes32 market) external view returns (uint256) {
        return Math.ceilDiv(liab.liveDirectional(market), WAD_PER_USDC_UNIT);
    }

    // ---------------------------------------------------------------- treasury

    /// @notice Sends USDC to the treasury address (bound for the pool's Hyperliquid account). Only from available
    ///         USDC above the stressed liability (sells first), and at most treasuryDailyCapBps of NAV per UTC day.
    function sendToTreasury(uint256 amount) external nonReentrant onlyRole(TREASURER_ROLE) {
        address t = treasury;
        if (t == address(0)) revert NoTreasury();
        if (amount == 0) revert ZeroAmount();
        if (!equityReady()) revert EquityNotReady();
        uint256 free = freeForWithdrawals();
        if (amount > free) revert AboveFree(amount, free);
        uint256 nav = navNow();
        uint256 day = block.timestamp / 1 days;
        uint256 cap = nav * treasuryDailyCapBps / BPS;
        uint256 today = sentOnDay[day];
        if (today + amount > cap) revert AboveDailyCap(amount, cap > today ? cap - today : 0);
        sentOnDay[day] = today + amount;
        sentOut += amount;
        emit TreasurySent(t, amount, sentOut, today + amount, nav);
        _usdc.safeTransfer(t, amount);
    }

    /// @notice Pulls USDC back from the treasury address (it must have approved the pool). Treasurer or treasury only.
    function receiveFromTreasury(uint256 amount) external nonReentrant {
        address t = treasury;
        if (t == address(0)) revert NoTreasury();
        if (msg.sender != t && !hasRole(TREASURER_ROLE, msg.sender)) revert NotTreasury();
        if (amount == 0) revert ZeroAmount();
        receivedBack += amount;
        emit TreasuryReturned(t, amount, receivedBack);
        _usdc.safeTransferFrom(t, address(this), amount);
    }

    // ---------------------------------------------------------------- admin

    function setTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function setTreasuryDailyCap(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > BPS) revert CapTooHigh(bps);
        treasuryDailyCapBps = bps;
        emit TreasuryCapSet(bps);
    }

    function setWriterBook(address writerBook_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (writerBook != address(0)) revert WriterBookAlreadySet();
        if (writerBook_ == address(0)) revert ZeroAddress();
        writerBook = writerBook_;
        emit WriterBookSet(writerBook_);
    }

    /// @notice Sets the WHYPE token and the market whose mark values it (once).
    function setMatchBook(address matchBook_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (matchBook != address(0)) revert MatchBookAlreadySet();
        if (matchBook_ == address(0)) revert ZeroAddress();
        matchBook = matchBook_;
        emit MatchBookSet(matchBook_);
    }

    function setAuction(address auction_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (auction != address(0)) revert MatchBookAlreadySet();
        if (auction_ == address(0)) revert ZeroAddress();
        auction = auction_;
        emit AuctionSet(auction_);
    }

    /// @notice The risk auction hands `raw` the pool carries on series `id` to `winner` as a matched write (the auction
    ///         has just locked the winner's exact collateral in the MatchBook). The pool pays `price` (at most its own
    ///         value × 1.10, checked by the auction); the raw stops counting as the pool's own (NAV at once, stress at the
    ///         next epoch).
    function onAuctionFill(
        uint256 id,
        uint256 raw,
        uint256 units,
        uint256 sWad,
        uint256 sigmaBps,
        uint256 price,
        address winner
    ) external {
        if (msg.sender != auction || auction == address(0)) revert NotAuction();
        uint256 own = liab.raw[id] - liab.mraw[id];
        if (own > 0) {
            uint256 rel = raw >= own ? seriesNotional[id] : Math.mulDiv(seriesNotional[id], raw, own);
            seriesNotional[id] -= rel;
            openNotional[liab.marketOf[id]] -= rel;
        }
        liab.stopCarrying(id, raw, units, sWad, sigmaBps);
        emit AuctionFilled(id, raw, price, winner);
        if (price > 0) _usdc.safeTransfer(winner, price);
    }

    function setOpenBookCap(bytes32 market, uint256 cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        openBookCap[market] = cap;
        emit OpenBookCapSet(market, cap);
    }

    function setWhype(IERC20 whype_, bytes32 market) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(whype) != address(0)) revert WhypeAlreadySet();
        if (address(whype_) == address(0)) revert ZeroAddress();
        whype = whype_;
        whypeMarket = market;
        emit WhypeSet(address(whype_), market);
    }

    function setEngine(address engine_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (engine != address(0)) revert EngineAlreadySet();
        if (engine_ == address(0)) revert ZeroAddress();
        engine = engine_;
        emit EngineSet(engine_);
    }

    function setProtocolFee(uint16 bps, address recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_PROTOCOL_FEE_BPS) revert FeeTooHigh(bps);
        if (recipient == address(0)) revert ZeroAddress();
        protocolFeeBps = bps;
        protocolRecipient = recipient;
        emit ProtocolFeeSet(bps, recipient);
    }

    function listMarket(bytes32 market, uint16 shockBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        liab.listMarket(market, shockBps);
    }

    function setShock(bytes32 market, uint16 shockBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        liab.setShock(market, shockBps);
        _checkHedgeRule(market); // a smaller shock cannot leave the directional cap above what the hedger carries
    }

    function setVolMult(uint16 volMultBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        liab.setVolMult(volMultBps);
    }

    // ---------------------------------------------------------------- share maths

    function _toShares(uint256 assets, uint256 nav, uint256 supply) internal pure returns (uint256) {
        return Math.mulDiv(assets, supply + VIRTUAL_SHARES, nav + VIRTUAL_ASSETS);
    }

    function _toAssets(uint256 shares, uint256 nav, uint256 supply) internal pure returns (uint256) {
        return Math.mulDiv(shares, nav + VIRTUAL_ASSETS, supply + VIRTUAL_SHARES);
    }
}
