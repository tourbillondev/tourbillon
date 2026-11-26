// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface ICoverMarks {
    function markWad(bytes32 market) external view returns (uint256);
}

/// @notice The checks some restricted tokens expose (ERC-1404 "simple restricted token"). 0 means allowed.
interface IRestrictedToken {
    function detectTransferRestriction(address from, address to, uint256 value) external view returns (uint8);
}

interface IPausableToken {
    function paused() external view returns (bool);
}

/// @notice What the books, the vault and the pool ask about covering assets.
interface ICoveringAssets {
    function coverOf(bytes32 market) external view returns (IERC20 token, uint256 scale);
    function isCover(IERC20 token) external view returns (bool);
    function checkCover(bytes32 market, address from, address to, uint256 amount) external view;
    function valueOf(address holder) external view returns (uint256);
}

/// @title CoveringAssets
/// @notice The covering-asset table (Backend §1, §2 F, §5): which token, if any, may cover Rises on each market. A
///         tokenized stock covers Rises on its own market only (tokenized AAPL covers AAPL Rises, not NVDA); crypto
///         markets have none. Governance (the timelock) lists each market's token once; a listing is never changed or
///         removed, so a token locked as cover can never be pointed elsewhere.
/// @dev    The adapter role of the spec, for any ERC-20 that behaves:
///         - decimals at most 18; `scale` = 10^(18 − decimals) turns token amounts into WAD units of the stock;
///         - at listing and on every lock, the token must not be paused, and where the token exposes the ERC-1404
///           check, every transfer between the holders given at listing (the books, the vault, the pool) must be
///           allowed (G8: the issuer whitelists them at onboarding);
///         - rebasing and fee-on-transfer tokens are refused where they show: every pull must deliver exactly the
///           amount asked (CoverLedger), and a listing is preceded by the per-token fuzz on a fork (spec §9).
///         `valueOf` counts a holder's covering tokens at each market's router mark (Backend §5: the pool's on-chain
///         hedge inventory "marked at router price"; owner G6), rounded down, and 0 for a market whose mark is stale.
contract CoveringAssets is ICoveringAssets, AccessControl {
    uint256 internal constant WAD_PER_SETTLEMENT_UNIT = 1e12;

    struct Asset {
        IERC20 token;
        uint64 scale;
    }

    ICoverMarks public immutable marks;
    mapping(bytes32 => Asset) internal _assets;
    mapping(IERC20 => bytes32) public marketOfToken;
    bytes32[] public listedMarkets;

    event Listed(bytes32 indexed market, address indexed token, uint8 decimals, address[] holders);

    error ZeroAddress();
    error AlreadyListed(bytes32 market);
    error TokenTaken(address token);
    error BadDecimals(uint8 decimals);
    error NoCover(bytes32 market);
    error CoverPaused(bytes32 market);
    error CoverRestricted(bytes32 market, address from, address to, uint8 code);

    constructor(address admin, ICoverMarks marks_) {
        if (admin == address(0) || address(marks_) == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        marks = marks_;
    }

    // ---------------------------------------------------------------- reads

    /// @notice The market's covering token and its scale to WAD; (0, 0) when the market has none.
    function coverOf(bytes32 market) external view returns (IERC20 token, uint256 scale) {
        Asset memory a = _assets[market];
        return (a.token, a.scale);
    }

    function isCover(IERC20 token) external view returns (bool) {
        return marketOfToken[token] != bytes32(0);
    }

    function listedCount() external view returns (uint256) {
        return listedMarkets.length;
    }

    /// @notice Reverts unless `amount` of the market's covering token may move from `from` to `to` now: listed, not
    ///         paused, and allowed by the token's own restriction check where it has one.
    function checkCover(bytes32 market, address from, address to, uint256 amount) public view {
        IERC20 t = _assets[market].token;
        if (address(t) == address(0)) revert NoCover(market);
        try IPausableToken(address(t)).paused() returns (bool p) {
            if (p) revert CoverPaused(market);
        } catch {}
        try IRestrictedToken(address(t)).detectTransferRestriction(from, to, amount) returns (uint8 code) {
            if (code != 0) revert CoverRestricted(market, from, to, code);
        } catch {}
    }

    /// @notice `holder`'s covering tokens, each at its market's mark × 95%, in settlement token (6 decimals, rounded down).
    function valueOf(address holder) external view returns (uint256 v) {
        for (uint256 i; i < listedMarkets.length; ++i) {
            bytes32 m = listedMarkets[i];
            Asset memory a = _assets[m];
            uint256 bal = a.token.balanceOf(holder);
            if (bal == 0) continue;
            try marks.markWad(m) returns (uint256 px) {
                v += Math.mulDiv(bal * a.scale, px, 1e18) / WAD_PER_SETTLEMENT_UNIT;
            } catch {}
        }
    }

    // ---------------------------------------------------------------- governance

    /// @notice Lists `token` as the covering asset of `market`, once. `holders` are every contract that will hold or
    ///         move it (the books, the vault, the pool): each transfer between them must be allowed today.
    function list(bytes32 market, IERC20 token, address[] calldata holders) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (market == bytes32(0) || address(token) == address(0)) revert ZeroAddress();
        if (address(_assets[market].token) != address(0)) revert AlreadyListed(market);
        if (marketOfToken[token] != bytes32(0)) revert TokenTaken(address(token));
        uint8 d = IERC20Metadata(address(token)).decimals();
        if (d > 18) revert BadDecimals(d);
        _assets[market] = Asset(token, uint64(10 ** (18 - d)));
        marketOfToken[token] = market;
        listedMarkets.push(market);
        for (uint256 i; i < holders.length; ++i) {
            for (uint256 j; j < holders.length; ++j) {
                if (i != j) checkCover(market, holders[i], holders[j], 1);
            }
        }
        emit Listed(market, address(token), d, holders);
    }
}
