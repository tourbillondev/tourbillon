// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PathFundingBook, IMarkRouter, IVolSource} from "../src/PathFundingBook.sol";
import {HousePool} from "../src/HousePool.sol";
import {Engine} from "../src/Engine.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";

/// @title DeployM2
/// @notice M2 deployment on top of an M1 deployment: mock USDC, HousePool, PathFundingBook and Engine, wired to the
///         M1 MarkRouter (marks) and QuorumBoard (vols). The deployer configures everything, hands every admin role
///         and the pauser role to `ADMIN`, and keeps none.
/// @dev    LOCAL ONLY (anvil, chain 31337): it deploys a mock USDC with open minting. A testnet deployment needs the
///         real USDC address and the owner's yes. HousePool is interim and must be replaced by MainspringPool (M3)
///         before any mainnet deployment (M2_NOTES, mainnet blockers).
///
///         - The book has no bootstrap recorder: samples come only through the permissionless `poke`, as in
///           production.
///         - Local defaults: markets BTC / ETH / HYPE with strike steps $100 / $5 / $0.10 at a 2% spread; pool funded
///           with 10,000,000 mock USDC; caps BTC $2,000,000, ETH $1,000,000, HYPE $500,000.
///
///         Settings (environment):
///           ADMIN          receives every admin role and the pauser role
///           FEE_RECIPIENT  default: ADMIN
///           M1_DEPLOYMENT  default: deployments/<chainId>.json (written by DeployM1)
///         Writes deployments/<chainId>-m2.json (addresses, markets, deploy block); the M1 file is never overwritten.
contract DeployM2 is Script {
    uint16 public constant SPREAD_BPS = 200;
    uint256 public constant POOL_FUNDING = 10_000_000e6;

    struct Config {
        address admin;
        address feeRecipient;
        IMarkRouter router;
        IVolSource board;
    }

    struct Deployed {
        MockUSDC usdc;
        HousePool pool;
        PathFundingBook book;
        Engine engine;
    }

    error WrongChain(uint256 chainId);
    error BadConfig(string why);
    error PredictionFailed(address predicted, address actual);

    function run() external returns (Deployed memory d) {
        if (block.chainid != 31337) revert WrongChain(block.chainid);
        Config memory c = configFromEnv();

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        d = deploy(c, deployer);
        vm.stopBroadcast();

        _write(c, d, deployer);
        console.log("MockUSDC        ", address(d.usdc));
        console.log("HousePool       ", address(d.pool));
        console.log("PathFundingBook ", address(d.book));
        console.log("Engine          ", address(d.engine));
    }

    function configFromEnv() public view returns (Config memory c) {
        c.admin = vm.envAddress("ADMIN");
        c.feeRecipient = vm.envOr("FEE_RECIPIENT", c.admin);
        string memory m1 = vm.envOr("M1_DEPLOYMENT", string.concat("deployments/", vm.toString(block.chainid), ".json"));
        string memory json = vm.readFile(m1);
        if (vm.parseJsonUint(json, ".chainId") != block.chainid) revert BadConfig("M1 deployment is another chain");
        c.router = IMarkRouter(vm.parseJsonAddress(json, ".MarkRouter"));
        c.board = IVolSource(vm.parseJsonAddress(json, ".QuorumBoard"));
    }

    /// @notice Deploys and configures everything as `deployer`, then hands every role to `c.admin`.
    function deploy(Config memory c, address deployer) public returns (Deployed memory d) {
        if (c.admin == address(0) || c.admin == deployer) revert BadConfig("admin");
        if (c.feeRecipient == address(0)) revert BadConfig("fee recipient");
        if (address(c.router).code.length == 0 || address(c.board).code.length == 0) revert BadConfig("M1 contracts");

        d.usdc = new MockUSDC();
        d.pool = new HousePool(deployer, d.usdc, c.feeRecipient);
        // The book stores its engine permanently: predict the engine's address (created right after the book).
        address predicted = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        d.book = new PathFundingBook(predicted, address(0), c.router, c.board);
        d.engine = new Engine(deployer, d.book, d.pool, c.router, c.board);
        if (address(d.engine) != predicted) revert PredictionFailed(predicted, address(d.engine));

        d.pool.setEngine(address(d.engine));
        d.engine.setMarket("BTC", 100e18, SPREAD_BPS);
        d.engine.setMarket("ETH", 5e18, SPREAD_BPS);
        d.engine.setMarket("HYPE", 0.1e18, SPREAD_BPS);
        d.pool.setCap("BTC", 2_000_000e6);
        d.pool.setCap("ETH", 1_000_000e6);
        d.pool.setCap("HYPE", 500_000e6);
        d.usdc.mint(deployer, POOL_FUNDING);
        d.usdc.approve(address(d.pool), POOL_FUNDING);
        d.pool.deposit(POOL_FUNDING);

        bytes32 adminRole = d.engine.DEFAULT_ADMIN_ROLE();
        d.engine.grantRole(d.engine.PAUSER_ROLE(), c.admin);
        d.engine.grantRole(d.engine.UNPAUSER_ROLE(), c.admin);
        d.engine.renounceRole(d.engine.UNPAUSER_ROLE(), deployer);
        d.engine.grantRole(adminRole, c.admin);
        d.engine.renounceRole(adminRole, deployer);
        d.pool.grantRole(adminRole, c.admin);
        d.pool.renounceRole(adminRole, deployer);
    }

    function _write(Config memory c, Deployed memory d, address deployer) internal {
        string memory k = "m2";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "deployer", deployer);
        vm.serializeAddress(k, "admin", c.admin);
        vm.serializeAddress(k, "feeRecipient", c.feeRecipient);
        vm.serializeAddress(k, "MarkRouter", address(c.router));
        vm.serializeAddress(k, "QuorumBoard", address(c.board));
        vm.serializeAddress(k, "MockUSDC", address(d.usdc));
        vm.serializeAddress(k, "HousePool", address(d.pool));
        vm.serializeAddress(k, "PathFundingBook", address(d.book));
        string[] memory markets = new string[](3);
        (markets[0], markets[1], markets[2]) = ("BTC", "ETH", "HYPE");
        vm.serializeString(k, "markets", markets);
        vm.serializeUint(k, "deployBlock", block.number); // where event scanning starts
        string memory json = vm.serializeAddress(k, "Engine", address(d.engine));
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), "-m2.json"));
    }
}
