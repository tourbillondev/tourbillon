// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PathFundingBook, IMarkRouter, IVolSource} from "../src/PathFundingBook.sol";
import {ISessionCalendar} from "../src/SessionCalendar.sol";
import {MainspringPool, IEquityFeed} from "../src/MainspringPool.sol";
import {Engine} from "../src/Engine.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SettlementAdapter} from "../src/SettlementAdapter.sol";
import {MockSettlementToken} from "../test/mocks/MockSettlementToken.sol";

/// @title DeployM3
/// @notice M3 deployment on top of an M1 deployment: mock USDC, MainspringPool, PathFundingBook and Engine, wired to
///         the M1 MarkRouter (marks) and QuorumBoard (vols and the EQUITY key). The deployer configures everything,
///         hands every role to its owner and keeps none.
/// @dev    LOCAL ONLY (anvil, chain 31337): it deploys a mock USDC with open minting. A testnet deployment needs the
///         real USDC address and the owner's yes.
///
///         - The book has no bootstrap recorder: samples come only through the permissionless `poke`.
///         - Markets BTC / ETH / STK1 (STK1: the placeholder tokenized stock, owner queue Q2 and Q13): stress shocks
///           2000 / 2500 / 2000 bps (vol × 1.5); strike steps $100 / $5 / $1; spread 2%. Caps: notional $5M / $3M /
///           $1M, directional $1M / $600k / $250k. Hedger delta caps $2.5M / $1.2M / $625,000, set first: the pool
///           refuses a directional cap above
///           hedgerDeltaCap × 2 × shock, so a cap the hedger cannot carry stops the deploy.
///         - No pool seed: LPs deposit into the pool through the deposit round.
///         - The EQUITY feed is listed on the QuorumBoard by its admin with ListEquityFeed.s.sol (the deployer is not
///           the board's admin).
///
///         Settings (environment):
///           ADMIN               pool and Engine admin, Engine pauser
///           RISK_PAUSER         the risk-monitor's pause-only key (default: ADMIN)
///           PROTOCOL_RECIPIENT  receives the protocol's 10% of trade fees (default: ADMIN)
///           M1_DEPLOYMENT       default: deployments/<chainId>.json (written by DeployM1)
///         Writes deployments/<chainId>-m3.json; the M1 file is never overwritten.
contract DeployM3 is Script {
    uint16 public constant SPREAD_BPS = 200;

    struct Config {
        address admin;
        address riskPauser;
        address protocolRecipient;
        IMarkRouter router;
        IVolSource board;
        ISessionCalendar calendar; // RH4: scales stock markets' open caps on weekends and holidays (unset: none)
        IERC20 settlement; // RH7b (D1): the settlement token (USDG on Robinhood Chain); unset: a mock USDG (anvil)
    }

    struct Deployed {
        MockSettlementToken settlement; // the settlement token: the mock on anvil, else the configured token (used as an ERC-20 only)
        SettlementAdapter settlementAdapter; // its form (D1): symbol and decimals read from it; approve or permit
        MainspringPool pool;
        PathFundingBook book;
        Engine engine;
    }

    error WrongChain(uint256 chainId);
    error BadConfig(string why);
    error PredictionFailed(address predicted, address actual);

    function run() external virtual returns (Deployed memory d) {
        if (block.chainid != 31337) revert WrongChain(block.chainid);
        Config memory c = configFromEnv();

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        d = deploy(c, deployer);
        vm.stopBroadcast();

        _write(c, d, deployer);
        console.log("SettlementToken ", address(d.settlement));
        console.log("MainspringPool  ", address(d.pool));
        console.log("PathFundingBook ", address(d.book));
        console.log("Engine          ", address(d.engine));
    }

    function configFromEnv() public view returns (Config memory c) {
        c.admin = vm.envAddress("ADMIN");
        c.riskPauser = vm.envOr("RISK_PAUSER", c.admin);
        c.protocolRecipient = vm.envOr("PROTOCOL_RECIPIENT", c.admin);
        string memory m1 = vm.envOr("M1_DEPLOYMENT", string.concat("deployments/", vm.toString(block.chainid), ".json"));
        string memory json = vm.readFile(m1);
        if (vm.parseJsonUint(json, ".chainId") != block.chainid) revert BadConfig("M1 deployment is another chain");
        c.router = IMarkRouter(vm.parseJsonAddress(json, ".MarkRouter"));
        c.board = IVolSource(vm.parseJsonAddress(json, ".QuorumBoard"));
        if (vm.keyExistsJson(json, ".SessionCalendar")) c.calendar = ISessionCalendar(vm.parseJsonAddress(json, ".SessionCalendar"));
        c.settlement = IERC20(vm.envOr("SETTLEMENT_TOKEN", address(0)));
    }

    /// @notice Deploys and configures everything as `deployer`, then hands every role to its owner.
    function deploy(Config memory c, address deployer) public returns (Deployed memory d) {
        d = deployCore(c, deployer);
        handOver(c, d, deployer);
    }

    /// @notice Deploys and configures everything as `deployer`, keeping the admin roles (DeployM4 wires more first).
    function deployCore(Config memory c, address deployer) public returns (Deployed memory d) {
        if (c.admin == address(0) || c.admin == deployer) revert BadConfig("admin");
        if (c.riskPauser == address(0) || c.riskPauser == deployer) revert BadConfig("risk pauser");
        if (c.protocolRecipient == address(0)) revert BadConfig("protocol recipient");
        if (address(c.router).code.length == 0 || address(c.board).code.length == 0) revert BadConfig("M1 contracts");

        d.settlement = address(c.settlement) == address(0)
            ? new MockSettlementToken("Mock Global Dollar", "USDG", 6)
            : MockSettlementToken(address(c.settlement));
        d.settlementAdapter = new SettlementAdapter(IERC20(address(d.settlement))); // refuses a token without 6 decimals
        // pool → book → engine: each needs the next one's address, so predict them
        uint256 n = vm.getNonce(deployer);
        address bookAt = vm.computeCreateAddress(deployer, n + 1);
        address engineAt = vm.computeCreateAddress(deployer, n + 2);
        d.pool = new MainspringPool(
            deployer,
            d.settlement,
            PathFundingBook(bookAt),
            c.router,
            c.board,
            IEquityFeed(address(c.board)),
            c.protocolRecipient
        );
        d.book = new PathFundingBook(engineAt, address(0), c.router, c.board);
        d.engine = new Engine(deployer, d.book, d.pool, c.router, c.board);
        if (address(d.book) != bookAt) revert PredictionFailed(bookAt, address(d.book));
        if (address(d.engine) != engineAt) revert PredictionFailed(engineAt, address(d.engine));

        d.pool.setEngine(address(d.engine));
        if (address(c.calendar) != address(0)) d.pool.setSessionCalendar(c.calendar);
        d.pool.listMarket("BTC", 2000);
        d.pool.listMarket("ETH", 2500);
        d.pool.listMarket("STK1", 2000);
        d.pool.setHedgerDeltaCap("BTC", 2_500_000e6); // × 2 × 20% = $1,000,000
        d.pool.setHedgerDeltaCap("ETH", 1_200_000e6); // × 2 × 25% = $600,000
        d.pool.setHedgerDeltaCap("STK1", 625_000e6); // × 2 × 20% = $250,000
        d.pool.setCaps("BTC", 5_000_000e6, 1_000_000e6);
        d.pool.setCaps("ETH", 3_000_000e6, 600_000e6);
        d.pool.setCaps("STK1", 1_000_000e6, 250_000e6);
        d.engine.setMarket("BTC", 100e18, SPREAD_BPS);
        d.engine.setMarket("ETH", 5e18, SPREAD_BPS);
        d.engine.setMarket("STK1", 1e18, SPREAD_BPS);
    }

    /// @notice Hands every role to its owner; the deployer keeps none.
    function handOver(Config memory c, Deployed memory d, address deployer) public {
        bytes32 adminRole = d.engine.DEFAULT_ADMIN_ROLE();
        d.engine.grantRole(d.engine.PAUSER_ROLE(), c.admin);
        d.engine.grantRole(d.engine.UNPAUSER_ROLE(), c.admin);
        d.engine.renounceRole(d.engine.UNPAUSER_ROLE(), deployer);
        d.engine.grantRole(adminRole, c.admin);
        d.engine.renounceRole(adminRole, deployer);
        d.pool.grantRole(d.pool.RISK_PAUSER_ROLE(), c.riskPauser);
        // interim holders until the M7 handover (deposit pauser → guardian, unpauser → Safe)
        d.pool.grantRole(d.pool.PAUSER_ROLE(), c.admin);
        d.pool.renounceRole(d.pool.PAUSER_ROLE(), deployer);
        d.pool.grantRole(d.pool.UNPAUSER_ROLE(), c.admin);
        d.pool.renounceRole(d.pool.UNPAUSER_ROLE(), deployer);
        d.pool.grantRole(d.pool.TREASURER_ROLE(), c.admin);
        d.pool.renounceRole(d.pool.TREASURER_ROLE(), deployer);
        d.pool.grantRole(adminRole, c.admin);
        d.pool.renounceRole(adminRole, deployer);
    }

    /// @notice The settlement token in a deployment file: its address, adapter, symbol and decimals as the token gives
    ///         them (RH7b, D1). Every service reads its symbol and decimals from here.
    function writeSettlement(string memory k, Deployed memory d) public {
        vm.serializeAddress(k, "SettlementToken", address(d.settlement));
        vm.serializeAddress(k, "SettlementAdapter", address(d.settlementAdapter));
        vm.serializeString(k, "settlementSymbol", d.settlementAdapter.symbol());
        vm.serializeUint(k, "settlementDecimals", d.settlementAdapter.decimals());
    }

    function _write(Config memory c, Deployed memory d, address deployer) internal {
        string memory k = "m3";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "deployer", deployer);
        vm.serializeAddress(k, "admin", c.admin);
        vm.serializeAddress(k, "riskPauser", c.riskPauser);
        vm.serializeAddress(k, "protocolRecipient", c.protocolRecipient);
        vm.serializeAddress(k, "MarkRouter", address(c.router));
        vm.serializeAddress(k, "QuorumBoard", address(c.board));
        writeSettlement(k, d);
        vm.serializeAddress(k, "MainspringPool", address(d.pool));
        vm.serializeAddress(k, "PathFundingBook", address(d.book));
        vm.serializeBytes32(k, "equityKey", d.pool.equityKey());
        string[] memory markets = new string[](3);
        (markets[0], markets[1], markets[2]) = ("BTC", "ETH", "STK1");
        vm.serializeString(k, "markets", markets);
        vm.serializeUint(k, "deployBlock", block.number); // where event scanning starts
        string memory json = vm.serializeAddress(k, "Engine", address(d.engine));
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), "-m3.json"));
    }
}
