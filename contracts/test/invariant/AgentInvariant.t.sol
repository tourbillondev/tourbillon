// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentRouterBase} from "../AgentRouter.t.sol";
import {AgentRouter} from "../../src/AgentRouter.sol";
import {PathFundingBook} from "../../src/PathFundingBook.sol";
import {StrategyMath} from "../../src/StrategyMath.sol";
import {TempoBlend} from "../../src/TempoBlend.sol";
import {VolQuote} from "../../src/VolQuote.sol";

/// Random agent buys (three call spreads, two mandates), agent sells and owner sells, with the clock moving.
contract AgentHandler is Test {
    AgentRouter ar;
    PathFundingBook book;
    AgentRouter.Mandate[2] ms;
    bytes[2] sigs;
    address owner;
    address agent;
    uint256 nowT;
    uint256[] public ids;
    mapping(uint256 => bool) seen;
    uint256 public calls;

    constructor(
        AgentRouter ar_,
        PathFundingBook book_,
        AgentRouter.Mandate[2] memory ms_,
        bytes[2] memory sigs_,
        uint256 t
    ) {
        ar = ar_;
        book = book_;
        for (uint256 i; i < 2; ++i) {
            ms[i] = ms_[i];
            sigs[i] = sigs_[i];
        }
        owner = ms_[0].owner;
        agent = ms_[0].agent;
        nowT = t;
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function mandate(uint256 i) external view returns (AgentRouter.Mandate memory) {
        return ms[i];
    }

    function _legs(uint256 k) internal pure returns (StrategyMath.Leg[] memory l) {
        l = new StrategyMath.Leg[](2);
        uint128 lo = uint128(68_000e18 + (k % 3) * 2_000e18);
        l[0] = StrategyMath.Leg(true, lo, 1e18);
        l[1] = StrategyMath.Leg(true, lo + 5_000e18, -1e18);
    }

    function buy(uint256 which, uint256 k, uint256 units) external {
        ++calls;
        which = which % 2;
        units = bound(units, 1e17, 3e18);
        AgentRouter.BuyArgs memory a;
        a.market = bytes32("BTC");
        a.legs = _legs(k);
        a.movement = TempoBlend.single(1 days);
        a.units = units;
        a.maxCost = 20_000e6;
        a.deadline = nowT;
        a.quotes = new VolQuote.Quote[](0);
        a.sigs = new bytes[](0);
        a.offerIds = new uint256[](0);
        vm.prank(agent);
        try ar.agentBuy(ms[which], sigs[which], a) returns (uint256 id, uint256, uint256) {
            if (!seen[id]) {
                seen[id] = true;
                ids.push(id);
            }
        } catch {} // over a budget or a cap: refused, nothing charged (checked by the invariants)
    }

    function agentSell(uint256 which, uint256 i, uint256 units) external {
        ++calls;
        if (ids.length == 0) return;
        which = which % 2;
        uint256 id = ids[i % ids.length];
        if (ar.mandateRaw(ar.hashMandate(ms[which]), id) == 0) return;
        vm.prank(agent);
        ar.agentSell(ms[which], sigs[which], id, bound(units, 1, 4e18), 0, nowT);
    }

    function ownerSell(uint256 i, uint256 units) external {
        ++calls;
        if (ids.length == 0) return;
        uint256 id = ids[i % ids.length];
        if (ar.rawOf(owner, id) == 0) return;
        vm.prank(owner);
        ar.ownerSell(id, bound(units, 1, type(uint256).max), 0, nowT);
    }
}

/// forge-config: default.invariant.runs = 32
/// forge-config: default.invariant.depth = 40
/// M7 step 8: AgentRouter invariants: no budget or cap is ever exceeded; the mandates' raw adds up to the owner's,
/// the owner's to the router's book balance; each mandate's delta and vega are exactly the sum over its series.
contract AgentInvariantTest is AgentRouterBase {
    AgentHandler handler;
    uint256 dBudget;
    uint256 vBudget;

    function setUp() public override {
        super.setUp();
        AgentRouter.Mandate[2] memory ms;
        bytes[2] memory ss;
        for (uint256 i; i < 2; ++i) {
            ms[i] = _mandate(owner);
            ms[i].nonce = uint64(10 + i);
            ms[i].deltaBudgetUsd = 120_000e6; // about 3–4 units of delta on BTC
            ms[i].vegaBudgetUsd = 60e6;
            ms[i].maxPremiumTotal = 60_000e6;
            ss[i] = _sign(ms[i], ownerPk);
        }
        dBudget = ms[0].deltaBudgetUsd;
        vBudget = ms[0].vegaBudgetUsd;
        handler = new AgentHandler(ar, book, ms, ss, nowT);
        targetContract(address(handler));
    }

    function invariant_budgetsCapsAndBooksHold() public view {
        uint256 n = handler.idCount();
        for (uint256 j; j < 2; ++j) {
            AgentRouter.Mandate memory m = handler.mandate(j);
            bytes32 h = ar.hashMandate(m);
            assertLe(ar.deltaUsed(h), m.deltaBudgetUsd, "delta budget");
            assertLe(ar.vegaUsed(h), m.vegaBudgetUsd, "vega budget");
            assertLe(ar.premiumUsed(h), m.maxPremiumTotal, "premium cap");
            uint256 sd;
            uint256 sv;
            for (uint256 i; i < n; ++i) {
                uint256 id = handler.ids(i);
                sd += ar.mandateDelta(h, id);
                sv += ar.mandateVega(h, id);
            }
            assertEq(sd, ar.deltaUsed(h), "delta = sum over series");
            assertEq(sv, ar.vegaUsed(h), "vega = sum over series");
        }
        bytes32 h0 = ar.hashMandate(handler.mandate(0));
        bytes32 h1 = ar.hashMandate(handler.mandate(1));
        for (uint256 i; i < n; ++i) {
            uint256 id = handler.ids(i);
            assertEq(ar.mandateRaw(h0, id) + ar.mandateRaw(h1, id), ar.rawOf(owner, id), "mandates = owner");
            assertEq(ar.rawOf(owner, id), ar.totalRaw(id), "one owner here: owner = total");
            assertEq(ar.totalRaw(id), book.balanceOf(id, address(ar)), "total = the router's book balance");
            if (ar.rawOf(owner, id) == 0) {
                assertEq(ar.mandateDelta(h0, id) + ar.mandateDelta(h1, id), 0, "nothing held, nothing charged");
            }
        }
        assertEq(usdc.balanceOf(address(ar)), 0, "the router keeps no USDC");
    }

    function test_handlerReachesEveryPath() public {
        for (uint256 i; i < 6; ++i) {
            handler.buy(i, i, 1e18);
        }
        handler.agentSell(0, 0, 5e17);
        handler.ownerSell(1, type(uint256).max);
        handler.buy(0, 0, 3e18);
        handler.buy(0, 0, 3e18); // past a budget: refused
        invariant_budgetsCapsAndBooksHold();
        assertGt(handler.idCount(), 1);
    }
}
