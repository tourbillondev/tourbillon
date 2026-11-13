// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ICounterparty} from "./ICounterparty.sol";

/// @title HousePool
/// @notice INTERIM counterparty for M2, local and testnet only. It must be replaced by MainspringPool (M3) before
///         any mainnet deployment: it does not hedge, and a sell it cannot pay reverts with `Insolvent`, which
///         would break law 3.
/// @dev    - Every trade fee goes on to `feeRecipient` in full (the M2 behaviour).
///         - Admin-funded USDC. The admin may withdraw only the balance above a reserve of 2× the open entry
///           notional (a call is worth at most S per unit, a put at most K ≤ 2× the mark at buy; not a guarantee).
///         - Per-market cap on open entry notional, in USDC (6 decimals); 0 means no buys. Entry notional is
///           units × the S used for the price, rounded up, recorded on buy and released in proportion to the raw
///           sold, so a fully closed series releases exactly what it added. Units shrink with funding, so this
///           overstates live exposure (cautious).
///         - The engine is set once by the admin; only it may call onBuy and onSell. No pause applies to onSell.
contract HousePool is ICounterparty, AccessControl {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant WAD_PER_USDC_UNIT = 1e12;
    uint256 public constant RESERVE_MULTIPLE = 2;

    IERC20 internal immutable _usdc;
    address public engine;
    address public feeRecipient;

    mapping(bytes32 => uint256) public cap; // USDC
    mapping(bytes32 => uint256) public openNotional; // USDC, per market
    uint256 public totalOpenNotional; // USDC
    mapping(uint256 => uint256) public seriesNotional; // USDC, per series
    mapping(uint256 => uint256) public seriesRaw; // book raw held against this pool, per series

    event EngineSet(address engine);
    event FeeRecipientSet(address feeRecipient);
    event CapSet(bytes32 indexed market, uint256 cap);
    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event Bought(
        bytes32 indexed market, uint256 indexed id, uint256 units, uint256 raw, uint256 notional, uint256 premium
    );
    event Sold(bytes32 indexed market, uint256 indexed id, uint256 raw, uint256 released, uint256 net, uint256 fee);

    error NotEngine();
    error EngineAlreadySet();
    error ZeroAddress();
    error NotSixDecimals(uint8 decimals);
    error ZeroRaw();
    error CapExceeded(bytes32 market, uint256 wouldBe, uint256 cap);
    error Insolvent(uint256 needed, uint256 balance);
    error AboveFree(uint256 amount, uint256 free);

    constructor(address admin, IERC20 usdc_, address feeRecipient_) {
        if (admin == address(0) || address(usdc_) == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        uint8 d = IERC20Metadata(address(usdc_)).decimals();
        if (d != 6) revert NotSixDecimals(d);
        _usdc = usdc_;
        feeRecipient = feeRecipient_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    modifier onlyEngine() {
        if (msg.sender != engine || engine == address(0)) revert NotEngine();
        _;
    }

    // ---------------------------------------------------------------- engine

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
        uint256,
        uint256 premium,
        uint256 fee
    ) external onlyEngine {
        if (raw == 0) revert ZeroRaw();
        uint256 notional = Math.ceilDiv(Math.mulDiv(units, sWad, WAD, Math.Rounding.Ceil), WAD_PER_USDC_UNIT);
        uint256 wouldBe = openNotional[market] + notional;
        if (wouldBe > cap[market]) revert CapExceeded(market, wouldBe, cap[market]);
        openNotional[market] = wouldBe;
        totalOpenNotional += notional;
        seriesNotional[id] += notional;
        seriesRaw[id] += raw;
        emit Bought(market, id, units, raw, notional, premium);
        if (fee > 0) _usdc.safeTransfer(feeRecipient, fee);
    }

    /// @inheritdoc ICounterparty
    function onSell(
        bytes32 market,
        uint256 id,
        uint256 raw,
        uint256,
        uint256,
        uint256,
        uint256,
        uint256 net,
        uint256 fee,
        address to
    ) external onlyEngine {
        uint256 held = seriesRaw[id];
        if (raw > held) raw = held;
        uint256 released = raw == held ? seriesNotional[id] : Math.mulDiv(seriesNotional[id], raw, held);
        seriesRaw[id] = held - raw;
        seriesNotional[id] -= released;
        openNotional[market] -= released;
        totalOpenNotional -= released;

        uint256 bal = _usdc.balanceOf(address(this));
        if (bal < net + fee) revert Insolvent(net + fee, bal);
        emit Sold(market, id, raw, released, net, fee);
        if (net > 0) _usdc.safeTransfer(to, net);
        if (fee > 0) _usdc.safeTransfer(feeRecipient, fee);
    }

    // ---------------------------------------------------------------- admin

    function setEngine(address engine_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (engine != address(0)) revert EngineAlreadySet();
        if (engine_ == address(0)) revert ZeroAddress();
        engine = engine_;
        emit EngineSet(engine_);
    }

    function setFeeRecipient(address feeRecipient_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        feeRecipient = feeRecipient_;
        emit FeeRecipientSet(feeRecipient_);
    }

    function setCap(bytes32 market, uint256 cap_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        cap[market] = cap_;
        emit CapSet(market, cap_);
    }

    function deposit(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /// @notice Withdraws only from the balance above the reserve (2× open entry notional).
    function withdraw(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 f = free();
        if (amount > f) revert AboveFree(amount, f);
        _usdc.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    // ---------------------------------------------------------------- reads

    function reserve() public view returns (uint256) {
        return RESERVE_MULTIPLE * totalOpenNotional;
    }

    function free() public view returns (uint256) {
        uint256 bal = _usdc.balanceOf(address(this));
        uint256 r = reserve();
        return bal > r ? bal - r : 0;
    }
}
