// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeployM4} from "./DeployM4.s.sol";
import {IEngineConfig} from "../src/WriterBook.sol";
import {MakerVault} from "../src/MakerVault.sol";
import {MatchBook} from "../src/MatchBook.sol";
import {VolQuoteBook} from "../src/VolQuote.sol";
import {OpenBook, IEngineOpenFor} from "../src/OpenBook.sol";
import {VolFeed} from "../src/VolFeed.sol";
import {RiskAuction, IAuctionPool, IAuctionRouter} from "../src/RiskAuction.sol";

/// @title DeployM6
/// @notice M6 deployment (the open book) on top of an M1 deployment: everything DeployM4 deploys and configures, plus
///         the MakerVault, MatchBook, VolQuoteBook, OpenBook (router), VolFeed and RiskAuction, wired before the roles
///         are handed over:
///         - the Engine routes `openFor` only from the OpenBook (`setOpenBook`, once);
///         - the MatchBook takes matches from the OpenBook and buybacks from the pool (`setRouter`, `setPool`, once);
///         - the vault's operators are the MatchBook and the auction (`setMatchBook`, `setAuction`, once);
///         - the pool accepts the MatchBook's hooks and the auction's fills (`setMatchBook`, `setAuction`, once) and
///           allows matched notional up to the open-book cap per market (D2, testnet cap);
///         - the OpenBook records into the VolFeed and takes the auction's matches (`setVolFeed`, `setAuction`, once);
///           the VolFeed's recorder is the OpenBook (once).
///         Then every role goes to its owner, as in DeployM3. The deployer is the admin of the vault, the MatchBook and
///         the VolFeed (immutable), whose only admin powers are those one-time setters, all spent here.
/// @dev    LOCAL ONLY (anvil, chain 31337). Same settings (environment) as DeployM3, plus:
///           OPEN_BOOK_CAP_BTC / _ETH / _HYPE  matched notional allowed per market, USDC (6 decimals); local defaults
///                                             are the pool's notional caps ($5M / $3M / $1M). Not a spec value: the
///                                             testnet figure is the owner's.
///         Writes deployments/<chainId>-m6.json: every key of the M4 file plus the six M6 contracts.
contract DeployM6 is DeployM4 {
    struct Deployed6 {
        Deployed4 m4;
        MakerVault vault;
        MatchBook matchBook;
        VolQuoteBook quoteBook;
        OpenBook openBook;
        VolFeed volFeed;
        RiskAuction auction;
    }

    struct Caps6 {
        uint256 btc;
        uint256 eth;
        uint256 hype;
    }

    function run() external virtual override returns (Deployed memory d) {
        if (block.chainid != 31337) revert WrongChain(block.chainid);
        Config memory c = configFromEnv();
        Caps6 memory caps = capsFromEnv();
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        Deployed6 memory d6 = deploy6(c, caps, deployer);
        vm.stopBroadcast();
        d = d6.m4.m3;
        _write6(c, d6, deployer);
        console.log("MockUSDC        ", address(d.usdc));
        console.log("MainspringPool  ", address(d.pool));
        console.log("Engine          ", address(d.engine));
        console.log("MakerVault      ", address(d6.vault));
        console.log("MatchBook       ", address(d6.matchBook));
        console.log("VolQuoteBook    ", address(d6.quoteBook));
        console.log("OpenBook        ", address(d6.openBook));
        console.log("VolFeed         ", address(d6.volFeed));
        console.log("RiskAuction     ", address(d6.auction));
    }

    function capsFromEnv() public view returns (Caps6 memory caps) {
        caps.btc = vm.envOr("OPEN_BOOK_CAP_BTC", uint256(5_000_000e6));
        caps.eth = vm.envOr("OPEN_BOOK_CAP_ETH", uint256(3_000_000e6));
        caps.hype = vm.envOr("OPEN_BOOK_CAP_HYPE", uint256(1_000_000e6));
    }

    /// @notice Deploys M4, then the six M6 contracts, wires them, then hands every role over.
    function deploy6(Config memory c, Caps6 memory caps, address deployer) public returns (Deployed6 memory d6) {
        d6 = deployCore6(c, caps, deployer);
        handOver(c, d6.m4.m3, deployer);
    }

    /// @notice As deploy6, keeping the admin roles (DeployM7 hands them to the Safe, guardian and timelock).
    function deployCore6(Config memory c, Caps6 memory caps, address deployer) public returns (Deployed6 memory d6) {
        Deployed4 memory d4 = deployCore4(c, deployer);
        d6.m4 = d4;
        Deployed memory d = d4.m3;
        IEngineConfig cfg = IEngineConfig(address(d.engine));

        d6.vault = new MakerVault(deployer, IERC20(address(d.usdc)), IERC20(address(d4.whype)));
        d6.matchBook = new MatchBook(deployer, d.book, cfg, d6.vault, c.router, c.board);
        // the quote book's filler is the OpenBook, deployed next
        address openBookAt = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        d6.quoteBook = new VolQuoteBook(openBookAt);
        d6.openBook =
            new OpenBook(IEngineOpenFor(address(d.engine)), cfg, c.router, c.board, d6.quoteBook, d6.matchBook);
        if (address(d6.openBook) != openBookAt) revert PredictionFailed(openBookAt, address(d6.openBook));
        d6.volFeed = new VolFeed(deployer);
        d6.auction = new RiskAuction(
            d.book, IAuctionPool(address(d.pool)), IAuctionRouter(address(d6.openBook)), d6.vault, c.router, c.board
        );

        d.engine.setOpenBook(address(d6.openBook));
        d6.matchBook.setRouter(address(d6.openBook));
        d6.matchBook.setPool(address(d.pool));
        d6.vault.setMatchBook(address(d6.matchBook));
        d6.vault.setAuction(address(d6.auction));
        d.pool.setMatchBook(address(d6.matchBook));
        d.pool.setAuction(address(d6.auction));
        d.pool.setOpenBookCap("BTC", caps.btc);
        d.pool.setOpenBookCap("ETH", caps.eth);
        d.pool.setOpenBookCap("HYPE", caps.hype);
        d6.volFeed.setRecorder(address(d6.openBook));
        d6.openBook.setVolFeed(d6.volFeed);
        d6.openBook.setAuction(address(d6.auction));
    }

    function _write6(Config memory c, Deployed6 memory d6, address deployer) internal {
        Deployed memory d = d6.m4.m3;
        string memory k = "m6";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "deployer", deployer);
        vm.serializeAddress(k, "admin", c.admin);
        vm.serializeAddress(k, "riskPauser", c.riskPauser);
        vm.serializeAddress(k, "protocolRecipient", c.protocolRecipient);
        vm.serializeAddress(k, "MarkRouter", address(c.router));
        vm.serializeAddress(k, "QuorumBoard", address(c.board));
        vm.serializeAddress(k, "MockUSDC", address(d.usdc));
        vm.serializeAddress(k, "MockWHYPE", address(d6.m4.whype));
        vm.serializeAddress(k, "MainspringPool", address(d.pool));
        vm.serializeAddress(k, "PathFundingBook", address(d.book));
        vm.serializeAddress(k, "WriterBook", address(d6.m4.writerBook));
        vm.serializeAddress(k, "MakerVault", address(d6.vault));
        vm.serializeAddress(k, "MatchBook", address(d6.matchBook));
        vm.serializeAddress(k, "VolQuoteBook", address(d6.quoteBook));
        vm.serializeAddress(k, "OpenBook", address(d6.openBook));
        vm.serializeAddress(k, "VolFeed", address(d6.volFeed));
        vm.serializeAddress(k, "RiskAuction", address(d6.auction));
        vm.serializeBytes32(k, "equityKey", d.pool.equityKey());
        string[] memory markets = new string[](3);
        (markets[0], markets[1], markets[2]) = ("BTC", "ETH", "HYPE");
        vm.serializeString(k, "markets", markets);
        vm.serializeUint(k, "deployBlock", block.number);
        string memory json = vm.serializeAddress(k, "Engine", address(d.engine));
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), "-m6.json"));
    }
}
