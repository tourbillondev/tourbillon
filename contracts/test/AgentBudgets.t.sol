// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgentRouterBase} from "./AgentRouter.t.sol";
import {AgentRouter} from "../src/AgentRouter.sol";
import {ShapeGreeks} from "../src/ShapeGreeks.sol";
import {StrategyMath} from "../src/StrategyMath.sol";
import {TempoBlend} from "../src/TempoBlend.sol";

/// M7 step 8: delta and vega budgets (G14): charged at open at the fresh mark and the board's σ, released pro rata on
/// every close, never exceeded; refused when the board is stale and a budget is finite.
contract AgentBudgetsTest is AgentRouterBase {
    function _budgeted(address o, uint256 dBudget, uint256 vBudget)
        internal
        view
        returns (AgentRouter.Mandate memory m)
    {
        m = _mandate(o);
        m.deltaBudgetUsd = dBudget;
        m.vegaBudgetUsd = vBudget;
        m.maxPremiumTotal = 1_000_000e6;
    }

    function _expected(uint256 units) internal view returns (uint256 d, uint256 v) {
        StrategyMath.Leg[] memory legs = _spread();
        TempoBlend.Part[] memory mv = TempoBlend.single(1 days);
        uint256 s = marks.markWad(BTC);
        uint256 sigma = vols.volBps(BTC);
        d = ShapeGreeks.deltaUsd(ShapeGreeks.delta(legs, s, sigma, mv), s, units);
        v = ShapeGreeks.vegaUsd(ShapeGreeks.vega(legs, s, sigma, mv), units);
    }

    function test_chargedAtOpenAndRefusedOverEitherBudget() public {
        (uint256 d1, uint256 v1) = _expected(1e18);
        assertGt(d1, 0);
        assertGt(v1, 0);
        // budgets for 2.5 units of delta, plenty of vega
        AgentRouter.Mandate memory m = _budgeted(owner, d1 * 5 / 2, type(uint256).max - 1);
        bytes memory sig = _sign(m, ownerPk);
        bytes32 h = ar.hashMandate(m);
        _agentBuy(m, sig, _args(_spread(), 1e18, 20_000e6));
        assertApproxEqAbs(ar.deltaUsed(h), d1, 2);
        assertApproxEqAbs(ar.vegaUsed(h), v1, 2);
        _agentBuy(m, sig, _args(_spread(), 1e18, 20_000e6));
        AgentRouter.BuyArgs memory a = _args(_spread(), 1e18, 20_000e6);
        vm.prank(AGENT);
        vm.expectRevert(); // OverDeltaBudget: a third unit would take it to 3 × d1
        ar.agentBuy(m, sig, a);
        // a vega budget binds the same way
        AgentRouter.Mandate memory mv = _budgeted(owner2, type(uint256).max - 1, v1 / 2);
        bytes memory vsig = _sign(mv, owner2Pk);
        vm.prank(AGENT);
        vm.expectRevert();
        ar.agentBuy(mv, vsig, a);
        assertEq(ar.vegaUsed(ar.hashMandate(mv)), 0, "nothing charged by a refused buy");
    }

    function test_releasedProRataOnAgentAndOwnerSells() public {
        AgentRouter.Mandate memory m = _budgeted(owner, 1e18, 1e18);
        bytes memory sig = _sign(m, ownerPk);
        bytes32 h = ar.hashMandate(m);
        (uint256 id, uint256 raw,) = _agentBuy(m, sig, _args(_spread(), 4e18, 20_000e6));
        uint256 d0 = ar.deltaUsed(h);
        // the agent sells about a quarter: about a quarter is released
        vm.prank(AGENT);
        (uint256 sold,) = ar.agentSell(m, sig, id, 1e18, 0, nowT);
        assertApproxEqAbs(ar.deltaUsed(h), d0 - d0 * sold / raw, 2);
        assertEq(ar.mandateRaw(h, id), raw - sold);
        // a second mandate opens the same series; the owner sells half of everything: both give up half
        AgentRouter.Mandate memory m2 = _budgeted(owner, 1e18, 1e18);
        m2.nonce = 5;
        bytes32 h2 = ar.hashMandate(m2);
        _agentBuy(m2, _sign(m2, ownerPk), _args(_spread(), 2e18, 20_000e6));
        uint256 r1 = ar.mandateRaw(h, id);
        uint256 r2 = ar.mandateRaw(h2, id);
        assertEq(r1 + r2, ar.rawOf(owner, id), "the mandates' raw adds up to the owner's");
        uint256 dA = ar.deltaUsed(h);
        uint256 dB = ar.deltaUsed(h2);
        uint256 held = ar.rawOf(owner, id);
        uint256 norm = book.normNow(id);
        vm.prank(owner);
        (uint256 ownerSold,) = ar.ownerSell(id, held * norm / 1e18 / 2, 0, nowT);
        assertEq(ar.mandateRaw(h, id) + ar.mandateRaw(h2, id), ar.rawOf(owner, id), "still adds up");
        assertApproxEqRel(ar.deltaUsed(h), dA - dA * ownerSold / held, 1e15);
        assertApproxEqRel(ar.deltaUsed(h2), dB - dB * ownerSold / held, 1e15);
        // everything sold: every budget fully released
        vm.prank(owner);
        ar.ownerSell(id, type(uint256).max, 0, nowT);
        assertEq(ar.deltaUsed(h), 0);
        assertEq(ar.vegaUsed(h), 0);
        assertEq(ar.deltaUsed(h2), 0);
        assertEq(ar.mandateRaw(h, id) + ar.mandateRaw(h2, id), 0);
    }

    function test_staleBoardRefusesFiniteBudgetsButNotUnlimitedOnes() public {
        AgentRouter.Mandate memory m = _budgeted(owner, 1e18, 1e18);
        bytes memory sig = _sign(m, ownerPk);
        // a maker quote can still fill with a stale board (D8), but the Greeks need the board's σ
        vols.setStale(true);
        AgentRouter.BuyArgs memory a = _args(_spread(), 1e18, 20_000e6);
        a.quotes = new VolQuoteArray().one(maker, BTC, uint64(nowT + 1 hours));
        a.sigs = new bytes[](1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerPk, qb.hashQuote(a.quotes[0]));
        a.sigs[0] = abi.encodePacked(r, s, v);
        vm.prank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(AgentRouter.GreeksUnavailable.selector, BTC));
        ar.agentBuy(m, sig, a);
        AgentRouter.Mandate memory u = _mandate(owner); // unlimited budgets: no Greeks needed
        u.nonce = 4;
        bytes memory usig = _sign(u, ownerPk);
        vm.prank(AGENT);
        (,, uint256 cost) = ar.agentBuy(u, usig, a);
        assertGt(cost, 0);
    }
}

import {VolQuote} from "../src/VolQuote.sol";

contract VolQuoteArray {
    function one(address maker, bytes32 market, uint64 validUntil) external pure returns (VolQuote.Quote[] memory q) {
        q = new VolQuote.Quote[](1);
        q[0] = VolQuote.Quote(
            maker, market, VolQuote.SIDE_CALLS, 60_000e18, 90_000e18, 1 hours, 30 days, 4000, 100e18, validUntil, 1
        );
    }
}
