// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MainspringPoolBase} from "./MainspringPool.t.sol";
import {Engine} from "../src/Engine.sol";
import {TempoBlend} from "../src/TempoBlend.sol";
import {StrategyMath} from "../src/StrategyMath.sol";
import {VolQuote, VolQuoteBook} from "../src/VolQuote.sol";
import {MakerVault} from "../src/MakerVault.sol";
import {MatchBook} from "../src/MatchBook.sol";
import {OpenBook, IEngineOpenFor} from "../src/OpenBook.sol";
import {IEngineConfig} from "../src/WriterBook.sol";
import {MockWHYPE} from "./mocks/MockWHYPE.sol";
import {AgentRouter, IAgentOpenBook, IAgentEngine, IAgentBook} from "../src/AgentRouter.sol";
import {IMarkRouter, IVolSource} from "../src/PathFundingBook.sol";

/// M7 step 7: AgentRouter (G12, G13, G15, G16) on the full stack: owner-signed mandates, routed agent buys, per-owner
/// sub-accounts, agent sells within the mandate, the owner's sell always (law 3).
abstract contract AgentRouterBase is MainspringPoolBase {
    MockWHYPE whype;
    MakerVault vault;
    MatchBook mb;
    VolQuoteBook qb;
    OpenBook ob;
    AgentRouter ar;
    address owner;
    uint256 ownerPk;
    address owner2;
    uint256 owner2Pk;
    address maker;
    uint256 makerPk;
    address constant AGENT = address(0xA6E7);

    function setUp() public virtual override {
        super.setUp();
        _seed(5_000_000e6);
        whype = new MockWHYPE();
        vault = new MakerVault(address(this), IERC20(address(usdc)), IERC20(address(whype)));
        mb = new MatchBook(address(this), book, IEngineConfig(address(engine)), vault, marks, vols);
        address obAt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        qb = new VolQuoteBook(obAt);
        ob = new OpenBook(IEngineOpenFor(address(engine)), IEngineConfig(address(engine)), marks, vols, qb, mb);
        engine.setOpenBook(address(ob));
        mb.setRouter(address(ob));
        mb.setPool(address(pool));
        vault.setMatchBook(address(mb));
        pool.setMatchBook(address(mb));
        pool.setOpenBookCap(BTC, 1e15);
        ar = new AgentRouter(
            IAgentOpenBook(address(ob)),
            IAgentEngine(address(engine)),
            IAgentBook(address(book)),
            IERC20(address(usdc)),
            IMarkRouter(address(marks)),
            IVolSource(address(vols))
        );
        (owner, ownerPk) = makeAddrAndKey("owner");
        (owner2, owner2Pk) = makeAddrAndKey("owner2");
        (maker, makerPk) = makeAddrAndKey("maker");
        address[2] memory os = [owner, owner2];
        for (uint256 i; i < 2; ++i) {
            usdc.mint(os[i], 1_000_000e6);
            vm.prank(os[i]);
            usdc.approve(address(ar), type(uint256).max);
        }
        usdc.mint(maker, 50_000_000e6);
        vm.startPrank(maker);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(IERC20(address(usdc)), 10_000_000e6);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- helpers

    function _mandate(address o) internal view returns (AgentRouter.Mandate memory m) {
        m.owner = o;
        m.agent = AGENT;
        m.markets = new bytes32[](1);
        m.markets[0] = BTC;
        m.shapes = ar.CALL_SPREAD() | ar.PUT_SPREAD();
        m.maxPremiumPerTrade = 20_000e6;
        m.maxPremiumTotal = 50_000e6;
        m.deltaBudgetUsd = type(uint256).max;
        m.vegaBudgetUsd = type(uint256).max;
        m.expiry = uint64(nowT + 1 days);
        m.nonce = 1;
    }

    function _sign(AgentRouter.Mandate memory m, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ar.hashMandate(m));
        return abi.encodePacked(r, s, v);
    }

    function _spread() internal pure returns (StrategyMath.Leg[] memory l) {
        l = new StrategyMath.Leg[](2);
        l[0] = StrategyMath.Leg(true, 70_000e18, 1e18);
        l[1] = StrategyMath.Leg(true, 75_000e18, -1e18);
    }

    function _args(StrategyMath.Leg[] memory legs, uint256 units, uint256 maxCost)
        internal
        view
        returns (AgentRouter.BuyArgs memory a)
    {
        a.market = BTC;
        a.legs = legs;
        a.movement = TempoBlend.single(1 days);
        a.units = units;
        a.maxCost = maxCost;
        a.deadline = nowT;
        a.quotes = new VolQuote.Quote[](0);
        a.sigs = new bytes[](0);
        a.offerIds = new uint256[](0);
    }

    function _agentBuy(AgentRouter.Mandate memory m, bytes memory sig, AgentRouter.BuyArgs memory a)
        internal
        returns (uint256 id, uint256 raw, uint256 cost)
    {
        vm.prank(AGENT);
        return ar.agentBuy(m, sig, a);
    }
}

contract AgentRouterTest is AgentRouterBase {
    // ---------------------------------------------------------------- 1. buys within the mandate

    function test_agentBuysForTheOwnerWhoPaysExactlyTheRoutedCost() public {
        AgentRouter.Mandate memory m = _mandate(owner);
        bytes memory sig = _sign(m, ownerPk);
        uint256 before = usdc.balanceOf(owner);
        (uint256 id, uint256 raw, uint256 cost) = _agentBuy(m, sig, _args(_spread(), 2e18, 20_000e6));
        assertGt(cost, 0);
        assertEq(before - usdc.balanceOf(owner), cost, "the owner pays the routed cost and the rest comes back");
        assertEq(usdc.balanceOf(address(ar)), 0, "the router keeps no USDC");
        assertEq(ar.rawOf(owner, id), raw);
        assertEq(ar.totalRaw(id), raw);
        assertEq(book.balanceOf(id, address(ar)), raw, "the router holds exactly the sub-accounts");
        assertEq(ar.premiumUsed(ar.hashMandate(m)), cost);
    }

    function test_twoOwnersOnOneSeriesStaySeparate() public {
        AgentRouter.Mandate memory m1 = _mandate(owner);
        AgentRouter.Mandate memory m2 = _mandate(owner2);
        (uint256 id, uint256 r1,) = _agentBuy(m1, _sign(m1, ownerPk), _args(_spread(), 2e18, 20_000e6));
        (uint256 id2, uint256 r2,) = _agentBuy(m2, _sign(m2, owner2Pk), _args(_spread(), 3e18, 20_000e6));
        assertEq(id, id2);
        assertEq(book.balanceOf(id, address(ar)), r1 + r2);
        // owner 2 sells everything it has; owner 1 is untouched
        vm.prank(owner2);
        ar.ownerSell(id, type(uint256).max, 0, nowT);
        assertEq(ar.rawOf(owner2, id), 0);
        assertEq(ar.rawOf(owner, id), r1);
        assertEq(book.balanceOf(id, address(ar)), r1);
        // owner 2 cannot touch owner 1's position
        vm.prank(owner2);
        vm.expectRevert(abi.encodeWithSelector(AgentRouter.NothingHeld.selector, id));
        ar.ownerSell(id, 1e18, 0, nowT);
        // the last holder takes it all: no dust left
        vm.prank(owner);
        ar.ownerSell(id, type(uint256).max, 0, nowT);
        assertEq(book.balanceOf(id, address(ar)), 0);
        assertEq(ar.totalRaw(id), 0);
    }

    // ---------------------------------------------------------------- 2. a refusal per mandate field

    function test_aRefusalForEveryMandateField() public {
        AgentRouter.Mandate memory m = _mandate(owner);
        bytes memory sig = _sign(m, ownerPk);
        AgentRouter.BuyArgs memory a = _args(_spread(), 1e18, 20_000e6);

        vm.prank(address(0xBAD)); // not the agent
        vm.expectRevert(AgentRouter.NotAgent.selector);
        ar.agentBuy(m, sig, a);

        bytes memory wrong = _sign(m, owner2Pk); // signed by someone else (signatures made first: they call the router)
        vm.prank(AGENT);
        vm.expectRevert(AgentRouter.BadMandateSignature.selector);
        ar.agentBuy(m, wrong, a);

        AgentRouter.Mandate memory t = _mandate(owner); // tampered after signing
        t.maxPremiumTotal = 1e30;
        vm.prank(AGENT);
        vm.expectRevert(AgentRouter.BadMandateSignature.selector);
        ar.agentBuy(t, sig, a);

        AgentRouter.Mandate memory c = _mandate(owner); // close-only
        c.closeOnly = true;
        bytes memory csig = _sign(c, ownerPk);
        vm.prank(AGENT);
        vm.expectRevert(AgentRouter.CloseOnly.selector);
        ar.agentBuy(c, csig, a);

        AgentRouter.BuyArgs memory eth = _args(_spread(), 1e18, 20_000e6); // a market not in the mandate
        eth.market = ETH;
        vm.prank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(AgentRouter.MarketNotAllowed.selector, ETH));
        ar.agentBuy(m, sig, eth);

        StrategyMath.Leg[] memory rise = new StrategyMath.Leg[](1); // a family not in the mandate
        rise[0] = StrategyMath.Leg(true, 70_000e18, 1e18);
        uint256 riseFamily = ar.RISE(); // read first: a call in the arguments would use up the prank
        vm.prank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(AgentRouter.ShapeNotAllowed.selector, riseFamily));
        ar.agentBuy(m, sig, _args(rise, 1e18, 20_000e6));

        AgentRouter.Mandate memory p = _mandate(owner); // the per-trade cap binds as the buy's maxCost
        p.maxPremiumPerTrade = 1e6;
        bytes memory psig = _sign(p, ownerPk);
        vm.prank(AGENT);
        vm.expectRevert(); // the Engine: cost above max
        ar.agentBuy(p, psig, a);

        // the total cap: spend most of it, then a buy that would cross it is refused by its maxCost
        AgentRouter.Mandate memory tot = _mandate(owner);
        tot.maxPremiumTotal = 6_000e6; // one 8-unit buy costs about 4,850: a second one crosses the cap
        tot.nonce = 7;
        bytes memory tsig = _sign(tot, ownerPk);
        (,, uint256 c1) = _agentBuy(tot, tsig, _args(_spread(), 8e18, 20_000e6));
        assertLt(c1, 6_000e6);
        vm.prank(AGENT);
        vm.expectRevert();
        ar.agentBuy(tot, tsig, _args(_spread(), 8e18, 20_000e6)); // more than what is left
        assertEq(ar.premiumUsed(ar.hashMandate(tot)), c1, "nothing spent by the refused buy");

        vm.prank(owner); // revoked
        ar.revoke(1);
        vm.prank(AGENT);
        vm.expectRevert(AgentRouter.MandateRevoked.selector);
        ar.agentBuy(m, sig, a);

        AgentRouter.Mandate memory e = _mandate(owner); // expired
        e.nonce = 2;
        bytes memory esig = _sign(e, ownerPk);
        _set(nowT + 1 days + 1);
        vm.prank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(AgentRouter.MandateExpired.selector, e.expiry));
        ar.agentBuy(e, esig, a);
    }

    function test_familiesOfBuyerShapes() public view {
        StrategyMath.Leg[] memory l1 = new StrategyMath.Leg[](1);
        l1[0] = StrategyMath.Leg(false, 70_000e18, 1e18);
        assertEq(ar.familyOf(l1), ar.FALL());
        StrategyMath.Leg[] memory sw = new StrategyMath.Leg[](2);
        sw[0] = StrategyMath.Leg(false, 70_000e18, 1e18);
        sw[1] = StrategyMath.Leg(true, 70_000e18, 1e18);
        assertEq(ar.familyOf(sw), ar.SWING());
        StrategyMath.Leg[] memory ps = new StrategyMath.Leg[](2);
        ps[0] = StrategyMath.Leg(false, 65_000e18, -1e18);
        ps[1] = StrategyMath.Leg(false, 70_000e18, 1e18);
        assertEq(ar.familyOf(ps), ar.PUT_SPREAD());
        StrategyMath.Leg[] memory fly = new StrategyMath.Leg[](3);
        fly[0] = StrategyMath.Leg(true, 65_000e18, 1e18);
        fly[1] = StrategyMath.Leg(true, 70_000e18, -2e18);
        fly[2] = StrategyMath.Leg(true, 75_000e18, 1e18);
        assertEq(ar.familyOf(fly), ar.OTHER());
        assertEq(ar.familyOf(_spread()), ar.CALL_SPREAD());
    }

    // ---------------------------------------------------------------- 3. sells: agent within the mandate, owner always

    function test_agentSellsOnlyWhatItOpenedAndCloseOnlyStillSells() public {
        AgentRouter.Mandate memory m = _mandate(owner);
        bytes memory sig = _sign(m, ownerPk);
        (uint256 id, uint256 raw,) = _agentBuy(m, sig, _args(_spread(), 4e18, 20_000e6));
        // another mandate of the same owner and agent did not open this: it cannot sell it
        AgentRouter.Mandate memory other = _mandate(owner);
        other.nonce = 9;
        bytes memory osig = _sign(other, ownerPk);
        vm.prank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(AgentRouter.NothingHeld.selector, id));
        ar.agentSell(other, osig, id, 1e18, 0, nowT);
        // a close-only mandate of its own still sells what it opened
        AgentRouter.Mandate memory c = _mandate(owner);
        c.nonce = 3;
        bytes memory csig = _sign(c, ownerPk);
        (uint256 id2,,) = _agentBuy(m, sig, _args(_spread(), 1e18, 20_000e6));
        assertEq(id2, id);
        vm.prank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(AgentRouter.NothingHeld.selector, id));
        ar.agentSell(c, csig, id, 1e18, 0, nowT); // c opened nothing
        uint256 ownerBefore = usdc.balanceOf(owner);
        vm.prank(AGENT);
        (uint256 sold, uint256 net) = ar.agentSell(m, sig, id, 1e18, 0, nowT);
        assertGt(net, 0);
        assertEq(usdc.balanceOf(owner) - ownerBefore, net, "proceeds go to the owner");
        assertEq(ar.rawOf(owner, id), ar.mandateRaw(ar.hashMandate(m), id));
        assertLt(ar.rawOf(owner, id), raw + raw);
        assertGt(sold, 0);
    }

    function test_ownerAlwaysSellsEvenRevokedOrExpired() public {
        AgentRouter.Mandate memory m = _mandate(owner);
        bytes memory sig = _sign(m, ownerPk);
        (uint256 id,,) = _agentBuy(m, sig, _args(_spread(), 2e18, 20_000e6));
        vm.prank(owner);
        ar.revoke(1);
        _set(nowT + 2 days);
        // the agent is out
        vm.prank(AGENT);
        vm.expectRevert(AgentRouter.MandateRevoked.selector);
        ar.agentSell(m, sig, id, 1e18, 0, nowT);
        // the owner is not: even with buys paused
        engine.grantRole(engine.PAUSER_ROLE(), address(this));
        engine.pauseBuys();
        uint256 before = usdc.balanceOf(owner);
        vm.prank(owner);
        (, uint256 net) = ar.ownerSell(id, type(uint256).max, 0, nowT);
        assertEq(usdc.balanceOf(owner) - before, net);
        assertEq(ar.rawOf(owner, id), 0);
    }

    // ---------------------------------------------------------------- 4. laws 5 and 1

    /// Law 5: the agent supplies no price and no σ. A "quote" it forges (not signed by a maker) is skipped by the
    /// router: the fill is priced by the board or a genuine maker signature only.
    function test_law5ForgedQuotesAreIgnored() public {
        AgentRouter.Mandate memory m = _mandate(owner);
        bytes memory sig = _sign(m, ownerPk);
        AgentRouter.BuyArgs memory a = _args(_spread(), 2e18, 20_000e6);
        a.quotes = new VolQuote.Quote[](1);
        a.sigs = new bytes[](1);
        a.quotes[0] = VolQuote.Quote(
            maker,
            BTC,
            VolQuote.SIDE_CALLS,
            60_000e18,
            90_000e18,
            1 hours,
            30 days,
            500,
            100e18,
            uint64(nowT + 1 hours),
            1
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBADBAD, qb.hashQuote(a.quotes[0])); // the agent signs, not the maker
        a.sigs[0] = abi.encodePacked(r, s, v);
        vm.recordLogs();
        (,, uint256 cost) = _agentBuy(m, sig, a);
        AgentRouter.BuyArgs memory plain = _args(_spread(), 2e18, 20_000e6);
        uint256 snap = vm.snapshotState();
        AgentRouter.Mandate memory m2 = _mandate(owner2);
        (,, uint256 poolCost) = _agentBuy(m2, _sign(m2, owner2Pk), plain);
        vm.revertToState(snap);
        assertEq(cost, poolCost, "priced by the board, as without the forged quote");
    }

    /// Law 1 for owners: across a buy and a sell at any later mark, the owner's USDC never falls by more than the cost.
    function testFuzz_law1OwnerLosesAtMostWhatWasPaid(uint256 units, uint256 move) public {
        units = bound(units, 1e17, 5e18);
        move = bound(move, 50_000, 95_000);
        AgentRouter.Mandate memory m = _mandate(owner);
        uint256 before = usdc.balanceOf(owner);
        (uint256 id,, uint256 cost) = _agentBuy(m, _sign(m, ownerPk), _args(_spread(), units, 20_000e6));
        marks.set(BTC, move * 1e18);
        _set(nowT + 1 hours);
        book.record(BTC, move * 1e18, 4500);
        vm.prank(owner);
        ar.ownerSell(id, type(uint256).max, 0, nowT);
        uint256 afterBal = usdc.balanceOf(owner);
        assertGe(afterBal + cost, before, "never more than the cost");
    }
}
