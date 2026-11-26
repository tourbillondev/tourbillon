// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HedgeKeeperGate, IPoolHedgeSwap} from "../src/HedgeKeeperGate.sol";
import {UniswapV4HedgeRouter, IPoolManagerV4} from "../src/UniswapV4HedgeRouter.sol";
import {console} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {DeployM6} from "./DeployM6.s.sol";
import {M1Core} from "./M1Core.sol";
import {IMarkRouter, IVolSource} from "../src/PathFundingBook.sol";
import {Governance, ISafeProxyFactory} from "../src/governance/Governance.sol";
import {ReceiptRoots} from "../src/ReceiptRoots.sol";
import {AgentRouter, IAgentOpenBook, IAgentEngine, IAgentBook} from "../src/AgentRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title DeployM7
/// @notice M7 deployment (law 6): everything in one run, then every role handed to the Safe, the guardian and the
///         timelock (docs: the M7 role map), so no externally owned account keeps an admin role anywhere.
///         1. Governance: the Safe v1.4.1 build and factory (deployed here unless SAFE_SINGLETON / SAFE_FACTORY are
///            given), the 3-of-5 Safe, the 2-of-3 guardian Safe, the timelock (the Safe proposes and cancels, anyone
///            executes after the delay, no admin; delay rule G19).
///         2. The M1 contracts (board, quorum source, router with routes queued), the M6 system and its wiring
///            (DeployM6), the pool's EQUITY feed listed on the board, ReceiptRoots (admin: the timelock; poster: the
///            receipts service key, G10), AgentRouter (no admin; owners sign mandates).
///         3. The handover:
///            - board, router, Engine and pool admin → the timelock (listings, caps, fees, the signer set, routes);
///            - Engine and pool pausers → the guardian; the pool's market pause also → the automated risk key (E1);
///            - Engine and pool unpausers and the pool's treasurer → the Safe (G4, G6);
///            - the deployer renounces every role it held. The immutable admins of the MakerVault, MatchBook and
///              VolFeed are the deployer with every setter already spent (G9).
/// @dev    Settings (environment):
///           SAFE_OWNERS        5 comma-separated addresses (the 3-of-5 Safe)
///           GUARDIAN_OWNERS    3 comma-separated addresses (the 2-of-3 guardian)
///           RISK_PAUSER        the risk-monitor's pause-only key (E1)
///           RECEIPTS_POSTER    the receipts service key (posts hourly roots only)
///           PROTOCOL_RECIPIENT receives the protocol's 10% of fees
///           SIGNERS            comma-separated quorum signers (at least 3)
///           TIMELOCK_DELAY     seconds; default 1 h (anvil and the Robinhood Chain testnet only; elsewhere ≥ 48 h)
///           SAFE_SINGLETON, SAFE_FACTORY   existing Safe v1.4.1 contracts (optional)
///           OPEN_BOOK_CAP_BTC / _ETH / _STK1  as DeployM6
///         Writes deployments/<chainId>-m7.json: every key of the M6 file plus Safe, Guardian, Timelock and the Safe
///         build and factory. Mainnet is refused by the chain check until the owner says otherwise.
contract DeployM7 is DeployM6, M1Core {
    struct Gov {
        address singleton;
        address factory;
        address safe;
        address guardian;
        TimelockController timelock;
    }

    struct Config7 {
        address[] safeOwners;
        address[] guardianOwners;
        address riskPauser;
        address receiptsPoster;
        address protocolRecipient;
        address[] signers;
        uint256 delay;
        address singleton;
        address factory;
        IERC20 settlement; // RH7b (D1): SETTLEMENT_TOKEN, the settlement token (USDG on Robinhood Chain)
        address poolManager; // RH7b (Q4): UNISWAP_V4_POOL_MANAGER; the v4 hedge router is deployed when set
        Caps6 caps;
        bytes32[] stockMarkets; // listed on the SessionCalendar, MARK keys bound to the session rule
    }

    struct Deployed7 {
        Gov gov;
        M1Deployed m1;
        Deployed6 m6;
        ReceiptRoots receipts;
        AgentRouter agents;
        UniswapV4HedgeRouter hedgeRouter; // RH7b (Q4): set when a v4 PoolManager is given; zero otherwise
        HedgeKeeperGate hedgeGate; // RH8b (C63): holds the pool's HEDGER_ROLE; the guardian can freeze it
    }

    function run() external override(DeployM6) returns (Deployed memory d) {
        if (block.chainid != ANVIL_ID && block.chainid != ROBINHOOD_TESTNET_ID) revert WrongChain(block.chainid);
        Config7 memory c = config7FromEnv();
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        Deployed7 memory d7 = deploy7(c, deployer);
        vm.stopBroadcast();
        d = d7.m6.m4.m3;
        _write7(c, d7, deployer);
        console.log("Safe (3-of-5)   ", d7.gov.safe);
        console.log("Guardian (2-of-3)", d7.gov.guardian);
        console.log("Timelock        ", address(d7.gov.timelock));
        console.log("MainspringPool  ", address(d.pool));
        console.log("OpenBook        ", address(d7.m6.openBook));
    }

    uint256 internal constant ANVIL_ID = 31337;
    uint256 internal constant ROBINHOOD_TESTNET_ID = 46630; // (U) until probed

    function config7FromEnv() public view returns (Config7 memory c) {
        c.safeOwners = vm.envAddress("SAFE_OWNERS", ",");
        c.guardianOwners = vm.envAddress("GUARDIAN_OWNERS", ",");
        c.riskPauser = vm.envAddress("RISK_PAUSER");
        c.receiptsPoster = vm.envAddress("RECEIPTS_POSTER");
        c.protocolRecipient = vm.envAddress("PROTOCOL_RECIPIENT");
        c.signers = vm.envAddress("SIGNERS", ",");
        c.delay = vm.envOr("TIMELOCK_DELAY", Governance.TESTNET_DELAY);
        c.singleton = vm.envOr("SAFE_SINGLETON", address(0));
        c.factory = vm.envOr("SAFE_FACTORY", address(0));
        c.caps = capsFromEnv();
        // the settlement token: required on a real chain (a mock only on anvil, or when MOCK_SETTLEMENT=1 is set for a
        // testnet rehearsal without the token); its decimals are checked by the adapter, the Engine and the pool
        c.settlement = IERC20(vm.envOr("SETTLEMENT_TOKEN", address(0)));
        c.poolManager = vm.envOr("UNISWAP_V4_POOL_MANAGER", address(0));
        if (address(c.settlement) == address(0) && block.chainid != 31337 && !vm.envOr("MOCK_SETTLEMENT", false)) {
            revert BadConfig("SETTLEMENT_TOKEN");
        }
        // STOCK_MARKETS: comma-separated, default STK1 (the production shape); "none" binds none (local test harnesses,
        // so a service test does not depend on the time of day; the session rule has its own tests)
        string memory sm = vm.envOr("STOCK_MARKETS", string("STK1"));
        if (keccak256(bytes(sm)) == keccak256("none") || bytes(sm).length == 0) {
            c.stockMarkets = new bytes32[](0);
        } else {
            string[] memory names = vm.split(sm, ",");
            c.stockMarkets = new bytes32[](names.length);
            for (uint256 i; i < names.length; ++i) {
                c.stockMarkets[i] = bytes32(bytes(names[i]));
            }
        }
    }

    function markets7() public pure returns (bytes32[] memory m) {
        m = new bytes32[](3);
        (m[0], m[1], m[2]) = (bytes32("BTC"), bytes32("ETH"), bytes32("STK1"));
    }

    /// @notice The tokenized-stock markets among markets7: STK1, the placeholder for the launch stocks (owner queue Q2).
    function stockMarkets7() public pure returns (bytes32[] memory m) {
        m = new bytes32[](1);
        m[0] = "STK1";
    }

    /// @notice Deploys everything as `deployer`, then hands every role over (see the contract notice).
    function deploy7(Config7 memory c, address deployer) public returns (Deployed7 memory d7) {
        if (c.riskPauser == address(0) || c.riskPauser == deployer) revert BadConfig("risk pauser");
        if (c.protocolRecipient == address(0)) revert BadConfig("protocol recipient");
        if (c.receiptsPoster == address(0) || c.receiptsPoster == deployer) revert BadConfig("receipts poster");
        if (c.signers.length < MIN_SIGNERS) revert BadConfig("signers");
        for (uint256 i; i < c.safeOwners.length; ++i) {
            if (c.safeOwners[i] == deployer) revert BadConfig("deployer owns the Safe");
        }
        // 1. governance (the delay rule applies here)
        d7.gov.singleton = c.singleton == address(0) ? deployCode("Safe.sol:Safe") : c.singleton;
        d7.gov.factory = c.factory == address(0) ? deployCode("SafeProxyFactory.sol:SafeProxyFactory") : c.factory;
        ISafeProxyFactory f = ISafeProxyFactory(d7.gov.factory);
        d7.gov.safe = Governance.deployAdminSafe(f, d7.gov.singleton, c.safeOwners, uint256(keccak256("TRB-SAFE")));
        d7.gov.guardian =
            Governance.deployGuardian(f, d7.gov.singleton, c.guardianOwners, uint256(keccak256("TRB-GUARDIAN")));
        d7.gov.timelock = Governance.deployTimelock(d7.gov.safe, c.delay);

        // 2. M1, then M6 on top of it; the EQUITY feed listed while the deployer still administers the board
        d7.m1 = m1Core(deployer, c.signers, markets7(), c.stockMarkets, loadCalendar(CALENDAR_FILE));
        Config memory c6;
        c6.admin = address(d7.gov.timelock);
        c6.riskPauser = c.riskPauser;
        c6.protocolRecipient = c.protocolRecipient;
        c6.router = IMarkRouter(address(d7.m1.router));
        c6.board = IVolSource(address(d7.m1.board));
        c6.calendar = d7.m1.calendar;
        c6.settlement = c.settlement;
        d7.m6 = deployCore6(c6, c.caps, deployer);
        d7.m1.board.setFeed(d7.m6.m4.m3.pool.equityKey(), 5000, 2 hours);
        // receipts: the timelock administers, the receipts service posts (G10)
        d7.receipts = new ReceiptRoots(address(d7.gov.timelock), c.receiptsPoster);
        // agents: no admin at all; owners sign mandates (G12, G13)
        d7.agents = new AgentRouter(
            IAgentOpenBook(address(d7.m6.openBook)),
            IAgentEngine(address(d7.m6.m4.m3.engine)),
            IAgentBook(address(d7.m6.m4.m3.book)),
            IERC20(address(d7.m6.m4.m3.settlement)),
            IMarkRouter(address(d7.m1.router)),
            IVolSource(address(d7.m1.board))
        );

        // the hedge keeper gate (C63): the only holder of the pool's HEDGER_ROLE, never a key; its hedger key is set
        // through the timelock later
        d7.hedgeGate = new HedgeKeeperGate(deployer, IPoolHedgeSwap(address(d7.m6.m4.m3.pool)));
        d7.m6.m4.m3.pool.grantRole(d7.m6.m4.m3.pool.HEDGER_ROLE(), address(d7.hedgeGate));

        // the stock hedge's swap path (Q4): administered by the timelock from the start; listing its pools, setting it on
        // the pool and granting the keeper are timelocked steps (RH12, with the real pool addresses)
        if (c.poolManager != address(0)) {
            d7.hedgeRouter = new UniswapV4HedgeRouter(address(d7.gov.timelock), IPoolManagerV4(c.poolManager));
        }

        // 3. the handover
        handOver7(d7, c.riskPauser, deployer);
    }

    /// @notice The M7 role map. The deployer renounces each role last, after granting it.
    function handOver7(Deployed7 memory d7, address riskPauser, address deployer) public {
        address tl = address(d7.gov.timelock);
        address safe = d7.gov.safe;
        address guardian = d7.gov.guardian;
        Deployed memory d = d7.m6.m4.m3;
        bytes32 adminRole = d.pool.DEFAULT_ADMIN_ROLE();

        d7.m1.board.grantRole(adminRole, tl);
        d7.m1.board.renounceRole(adminRole, deployer);
        d7.m1.router.grantRole(adminRole, tl);
        d7.m1.router.renounceRole(adminRole, deployer);
        d7.m1.calendar.grantRole(adminRole, tl);
        d7.m1.calendar.renounceRole(adminRole, deployer);
        handOverCovers(d7.m6.m4.covers, tl, deployer); // covering-asset listings go through the timelock (Backend §5)

        d.engine.grantRole(d.engine.PAUSER_ROLE(), guardian);
        d.engine.grantRole(d.engine.UNPAUSER_ROLE(), safe);
        d.engine.renounceRole(d.engine.UNPAUSER_ROLE(), deployer);
        d.engine.grantRole(adminRole, tl);
        d.engine.renounceRole(adminRole, deployer);

        d.pool.grantRole(d.pool.PAUSER_ROLE(), guardian);
        d.pool.grantRole(d.pool.RISK_PAUSER_ROLE(), guardian);
        d.pool.grantRole(d.pool.RISK_PAUSER_ROLE(), riskPauser);
        d.pool.grantRole(d.pool.UNPAUSER_ROLE(), safe);
        d.pool.grantRole(d.pool.TREASURER_ROLE(), safe);
        d.pool.renounceRole(d.pool.PAUSER_ROLE(), deployer);
        d.pool.renounceRole(d.pool.UNPAUSER_ROLE(), deployer);
        d.pool.renounceRole(d.pool.TREASURER_ROLE(), deployer);
        d.pool.grantRole(adminRole, tl);
        d.pool.renounceRole(adminRole, deployer);

        // the hedge keeper gate: the guardian freezes, the Safe unfreezes, the timelock sets the hedger key
        d7.hedgeGate.grantRole(d7.hedgeGate.FREEZER_ROLE(), guardian);
        d7.hedgeGate.grantRole(d7.hedgeGate.UNFREEZER_ROLE(), safe);
        d7.hedgeGate.grantRole(adminRole, tl);
        d7.hedgeGate.renounceRole(adminRole, deployer);
    }

    function _write7(Config7 memory c, Deployed7 memory d7, address deployer) internal {
        Deployed memory d = d7.m6.m4.m3;
        string memory k = "m7";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "deployer", deployer);
        vm.serializeAddress(k, "Safe", d7.gov.safe);
        vm.serializeAddress(k, "Guardian", d7.gov.guardian);
        vm.serializeAddress(k, "Timelock", address(d7.gov.timelock));
        vm.serializeUint(k, "timelockDelay", c.delay);
        vm.serializeAddress(k, "SafeSingleton", d7.gov.singleton);
        vm.serializeAddress(k, "SafeProxyFactory", d7.gov.factory);
        vm.serializeAddress(k, "admin", address(d7.gov.timelock));
        vm.serializeAddress(k, "riskPauser", c.riskPauser);
        vm.serializeAddress(k, "receiptsPoster", c.receiptsPoster);
        vm.serializeAddress(k, "ReceiptRoots", address(d7.receipts));
        vm.serializeAddress(k, "HedgeRouterV4", address(d7.hedgeRouter));
        vm.serializeAddress(k, "HedgeKeeperGate", address(d7.hedgeGate));
        vm.serializeAddress(k, "AgentRouter", address(d7.agents));
        vm.serializeAddress(k, "protocolRecipient", c.protocolRecipient);
        vm.serializeAddress(k, "MarkRouter", address(d7.m1.router));
        vm.serializeAddress(k, "QuorumBoard", address(d7.m1.board));
        vm.serializeAddress(k, "QuorumMarkSource", address(d7.m1.quorumSource));
        vm.serializeUint(k, "routeEta", d7.m1.routeEta);
        writeSettlement(k, d);
        vm.serializeAddress(k, "MockStockToken", address(d7.m6.m4.stock));
        vm.serializeAddress(k, "CoveringAssets", address(d7.m6.m4.covers));
        vm.serializeAddress(k, "SessionCalendar", address(d7.m1.calendar));
        vm.serializeAddress(k, "MainspringPool", address(d.pool));
        vm.serializeAddress(k, "PathFundingBook", address(d.book));
        vm.serializeAddress(k, "WriterBook", address(d7.m6.m4.writerBook));
        vm.serializeAddress(k, "MakerVault", address(d7.m6.vault));
        vm.serializeAddress(k, "MatchBook", address(d7.m6.matchBook));
        vm.serializeAddress(k, "VolQuoteBook", address(d7.m6.quoteBook));
        vm.serializeAddress(k, "OpenBook", address(d7.m6.openBook));
        vm.serializeAddress(k, "VolFeed", address(d7.m6.volFeed));
        vm.serializeAddress(k, "RiskAuction", address(d7.m6.auction));
        vm.serializeBytes32(k, "equityKey", d.pool.equityKey());
        string[] memory markets = new string[](3);
        (markets[0], markets[1], markets[2]) = ("BTC", "ETH", "STK1");
        vm.serializeString(k, "markets", markets);
        vm.serializeAddress(k, "signers", c.signers);
        vm.serializeUint(k, "deployBlock", block.number);
        string memory json = vm.serializeAddress(k, "Engine", address(d.engine));
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), "-m7.json"));
    }
}
