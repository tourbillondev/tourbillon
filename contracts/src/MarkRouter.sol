// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IMarkSource} from "./IMarkSource.sol";

/// @title MarkRouter
/// @notice One cross-checked mark per market. The primary source must be fresh; if the
///         secondary is fresh too, the two must agree within maxDevBps or the read reverts.
/// @dev Every route change, including a market's first route, waits out `delay` after it is
///      queued. Queuing and cancelling sit behind DEFAULT_ADMIN_ROLE (the timelock); once the
///      delay has passed anyone may apply the queued route.
///      T0: primary = quorum, no secondary. T2: primary = precompile, secondary = quorum (50 bps).
contract MarkRouter is AccessControl {
    uint256 internal constant BPS = 10_000;

    struct Route {
        IMarkSource primary;
        IMarkSource secondary; // optional
        uint32 maxAge; // seconds
        uint16 maxDevBps; // used only with a secondary
    }

    struct Pending {
        Route route;
        uint64 eta;
    }

    uint256 public immutable delay;
    mapping(bytes32 => Route) internal _routes;
    mapping(bytes32 => Pending) internal _pending;

    event RouteQueued(
        bytes32 indexed market, address primary, address secondary, uint32 maxAge, uint16 maxDevBps, uint64 eta
    );
    event RouteApplied(bytes32 indexed market, address primary, address secondary, uint32 maxAge, uint16 maxDevBps);
    event RouteCancelled(bytes32 indexed market);

    error NoRoute(bytes32 market);
    error Stale(bytes32 market, address source);
    error Disagree(bytes32 market, uint256 primaryPx, uint256 secondaryPx);
    error NotQueued(bytes32 market);
    error TooEarly(bytes32 market, uint64 eta);
    error BadRoute();

    constructor(address admin, uint256 delay_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        delay = delay_;
    }

    // ---------------------------------------------------------------- reads

    /// @notice Cross-checked mark of `market` in WAD. Reverts with NoRoute, Stale or Disagree.
    function markWad(bytes32 market) external view returns (uint256) {
        Route memory r = _routes[market];
        if (address(r.primary) == address(0)) revert NoRoute(market);

        (bool ok, uint256 p1) = _read(r.primary, market, r.maxAge);
        if (!ok) revert Stale(market, address(r.primary));

        if (address(r.secondary) != address(0)) {
            (bool ok2, uint256 p2) = _read(r.secondary, market, r.maxAge);
            if (ok2) {
                uint256 diff = p1 > p2 ? p1 - p2 : p2 - p1;
                if (diff * BPS > p1 * r.maxDevBps) revert Disagree(market, p1, p2);
            }
        }
        return p1;
    }

    function route(bytes32 market) external view returns (Route memory) {
        return _routes[market];
    }

    function pending(bytes32 market) external view returns (Route memory r, uint64 eta) {
        Pending memory p = _pending[market];
        return (p.route, p.eta);
    }

    /// @dev A source that reverts, returns zero, or is older than maxAge counts as unavailable.
    function _read(IMarkSource src, bytes32 market, uint256 maxAge) internal view returns (bool, uint256) {
        try src.markWad(market) returns (uint256 px, uint256 updatedAt) {
            if (px == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > maxAge) return (false, 0);
            return (true, px);
        } catch {
            return (false, 0);
        }
    }

    // ---------------------------------------------------------------- route changes

    function queueRoute(bytes32 market, Route calldata r) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(r.primary) == address(0) || address(r.primary) == address(r.secondary) || r.maxAge == 0) {
            revert BadRoute();
        }
        if (address(r.primary).code.length == 0) revert BadRoute();
        if (address(r.secondary) != address(0)) {
            if (address(r.secondary).code.length == 0 || r.maxDevBps == 0 || r.maxDevBps >= BPS) revert BadRoute();
        }
        uint64 eta = uint64(block.timestamp + delay);
        _pending[market] = Pending(r, eta);
        emit RouteQueued(market, address(r.primary), address(r.secondary), r.maxAge, r.maxDevBps, eta);
    }

    function applyRoute(bytes32 market) external {
        Pending memory p = _pending[market];
        if (p.eta == 0) revert NotQueued(market);
        if (block.timestamp < p.eta) revert TooEarly(market, p.eta);
        _routes[market] = p.route;
        delete _pending[market];
        Route memory r = p.route;
        emit RouteApplied(market, address(r.primary), address(r.secondary), r.maxAge, r.maxDevBps);
    }

    function cancelRoute(bytes32 market) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_pending[market].eta == 0) revert NotQueued(market);
        delete _pending[market];
        emit RouteCancelled(market);
    }
}
