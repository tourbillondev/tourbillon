// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PathFundingBook, IMarkRouter, IVolSource} from "../src/PathFundingBook.sol";
import {MainspringPool, IEquityFeed} from "../src/MainspringPool.sol";
import {Engine} from "../src/Engine.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";

/// @title DeployM3
/// @notice M3 deployment on top of an M1 deployment: mock USDC, MainspringPool, PathFundingBook and Engine, wired to
///         the M1 MarkRouter (marks) and QuorumBoard (vols and the EQUITY key). The deployer configures everything,
///         hands every role to its owner and keeps none.
/// @dev    LOCAL ONLY (anvil, chain 31337): it deploys a mock USDC with open minting. A testnet deployment needs the
///         real USDC address and the owner's yes.
///
///         - The book has no bootstrap recorder: samples come only through the permissionless `poke`.
///         - Markets BTC / ETH / HYPE: stress shocks 2000 / 2500 / 3500 bps (vol × 1.5); strike steps $100 / $5 /
///           $0.10; spread 2%. Caps (owner's starting values): notional $5M / $3M / $1M, directional $1M / $600k /
///           $250k. Hedger delta caps $2.5M / $1.2M / $357,143, set first: the pool refuses a directional cap above
///           hedgerDeltaCap × 2 × shock, so a cap the hedger cannot carry stops the deploy.
///         - No pool funding: LPs fund the pool through the deposit round.
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
    }

    struct Deployed {
        MockUSDC usdc;
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
        console.log("MockUSDC        ", address(d.usdc));
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

        d.usdc = new MockUSDC();
        // pool → book → engine: each needs the next one's address, so predict them
        uint256 n = vm.getNonce(deployer);
        address bookAt = vm.computeCreateAddress(deployer, n + 1);
        address engineAt = vm.computeCreateAddress(deployer, n + 2);
        d.pool = new MainspringPool(
            deployer,
            d.usdc,
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
        d.pool.listMarket("BTC", 2000);
        d.pool.listMarket("ETH", 2500);
        d.pool.listMarket("HYPE", 3500);
        d.pool.setHedgerDeltaCap("BTC", 2_500_000e6); // × 2 × 20% = $1,000,000
        d.pool.setHedgerDeltaCap("ETH", 1_200_000e6); // × 2 × 25% = $600,000
        d.pool.setHedgerDeltaCap("HYPE", 357_143e6); // × 2 × 35% = $250,000.10
        d.pool.setCaps("BTC", 5_000_000e6, 1_000_000e6);
        d.pool.setCaps("ETH", 3_000_000e6, 600_000e6);
        d.pool.setCaps("HYPE", 1_000_000e6, 250_000e6);
        d.engine.setMarket("BTC", 100e18, SPREAD_BPS);
        d.engine.setMarket("ETH", 5e18, SPREAD_BPS);
        d.engine.setMarket("HYPE", 0.1e18, SPREAD_BPS);
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

    function _write(Config memory c, Deployed memory d, address deployer) internal {
        string memory k = "m3";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "deployer", deployer);
        vm.serializeAddress(k, "admin", c.admin);
        vm.serializeAddress(k, "riskPauser", c.riskPauser);
        vm.serializeAddress(k, "protocolRecipient", c.protocolRecipient);
        vm.serializeAddress(k, "MarkRouter", address(c.router));
        vm.serializeAddress(k, "QuorumBoard", address(c.board));
        vm.serializeAddress(k, "MockUSDC", address(d.usdc));
        vm.serializeAddress(k, "MainspringPool", address(d.pool));
        vm.serializeAddress(k, "PathFundingBook", address(d.book));
        vm.serializeBytes32(k, "equityKey", d.pool.equityKey());
        string[] memory markets = new string[](3);
        (markets[0], markets[1], markets[2]) = ("BTC", "ETH", "HYPE");
        vm.serializeString(k, "markets", markets);
        vm.serializeUint(k, "deployBlock", block.number); // where event scanning starts
        string memory json = vm.serializeAddress(k, "Engine", address(d.engine));
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), "-m3.json"));
    }
}
