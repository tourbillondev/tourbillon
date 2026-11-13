// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {QuorumBoard} from "../src/QuorumBoard.sol";
import {QuorumMarkSource} from "../src/QuorumMarkSource.sol";
import {MarkRouter} from "../src/MarkRouter.sol";
import {IMarkSource} from "../src/IMarkSource.sol";

/// @title M1Core
/// @notice The M1 contracts and their settings, deployed by the calling script with the deployer as admin: QuorumBoard
///         (MARK and VOL feeds per market), QuorumMarkSource and MarkRouter with a quorum-only route queued for every
///         market. DeployM1 hands the admin roles to `ADMIN`; DeployM7 lists more first and hands them to the timelock.
abstract contract M1Core {
    uint256 public constant QUORUM = 2; // m of n = 3
    uint256 public constant WINDOW = 30 seconds;
    uint16 public constant MARK_STEP_BPS = 200; // 2% per round
    uint32 public constant MARK_HEARTBEAT = 60 seconds;
    uint16 public constant VOL_STEP_BPS = 1000; // 10% per round (sanity cap; vol moves slowly)
    uint32 public constant VOL_HEARTBEAT = 15 minutes;
    uint32 public constant MARK_MAX_AGE = 120 seconds;
    uint256 public constant ROUTER_DELAY = 1 hours; // the router's own delay (testnet; M7 G8 keeps it behind the timelock)
    uint256 public constant MIN_SIGNERS = 3;

    struct M1Deployed {
        QuorumBoard board;
        QuorumMarkSource quorumSource;
        MarkRouter router;
        uint64 routeEta;
    }

    /// @notice Deploys and configures the M1 contracts; `deployer` keeps every admin role.
    function m1Core(address deployer, address[] memory signers, bytes32[] memory markets)
        public
        returns (M1Deployed memory d)
    {
        d.board = new QuorumBoard(deployer, signers, QUORUM, WINDOW);
        for (uint256 i; i < markets.length; ++i) {
            d.board.setFeed(d.board.markKey(markets[i]), MARK_STEP_BPS, MARK_HEARTBEAT);
            d.board.setFeed(d.board.volKey(markets[i]), VOL_STEP_BPS, VOL_HEARTBEAT);
        }
        d.quorumSource = new QuorumMarkSource(d.board);
        d.router = new MarkRouter(deployer, ROUTER_DELAY);
        MarkRouter.Route memory r = MarkRouter.Route({
            primary: IMarkSource(address(d.quorumSource)),
            secondary: IMarkSource(address(0)),
            maxAge: MARK_MAX_AGE,
            maxDevBps: 0
        });
        for (uint256 i; i < markets.length; ++i) {
            d.router.queueRoute(markets[i], r);
        }
        (, d.routeEta) = d.router.pending(markets[0]);
    }
}
