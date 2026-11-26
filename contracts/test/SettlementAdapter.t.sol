// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SettlementAdapter} from "../src/SettlementAdapter.sol";
import {MockSettlementToken} from "./mocks/MockSettlementToken.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// A 6-decimal token without permit (a plain bridged form).
contract PlainSettlement is ERC20 {
    constructor() ERC20("Plain USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

/// RH5, RH7b (owner D1: USDG by default, USDC possible): the settlement token's form, behind one adapter.
contract SettlementAdapterTest is Test {
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function test_aPermitTokenIsDetectedAndItsPermitRelayed() public {
        MockUSDC settlement = new MockUSDC();
        SettlementAdapter a = new SettlementAdapter(IERC20(address(settlement)));
        assertEq(address(a.token()), address(settlement));
        assertTrue(a.supportsPermit());
        (address owner, uint256 key) = makeAddrAndKey("holder");
        address spender = makeAddr("pool");
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                settlement.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, 1_000e6, settlement.nonces(owner), deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        vm.prank(makeAddr("relayer")); // anyone may relay a holder's signed permit
        a.permit(owner, spender, 1_000e6, deadline, v, r, s);
        assertEq(settlement.allowance(owner, spender), 1_000e6, "an allowance the holder signed; nothing moved");
        assertEq(settlement.balanceOf(address(a)), 0, "the adapter holds nothing");
    }

    function test_aTokenWithoutPermitWorksWithApproveOnly() public {
        PlainSettlement settlement = new PlainSettlement();
        SettlementAdapter a = new SettlementAdapter(IERC20(address(settlement)));
        assertFalse(a.supportsPermit());
        vm.expectRevert(SettlementAdapter.NoPermit.selector);
        a.permit(address(1), address(2), 1, block.timestamp, 0, bytes32(0), bytes32(0));
    }

    /// Decimals are read from the token, never assumed: USDG and USDC (6) are accepted with their own symbol; any
    /// other decimals are refused.
    function test_decimalsAndSymbolReadFromTheToken() public {
        SettlementAdapter g = new SettlementAdapter(IERC20(address(new MockSettlementToken("Global Dollar", "USDG", 6))));
        assertEq(g.symbol(), "USDG");
        assertEq(g.decimals(), 6);
        assertTrue(g.supportsPermit());
        SettlementAdapter c = new SettlementAdapter(IERC20(address(new MockUSDC())));
        assertEq(c.symbol(), "USDC");
        for (uint8 d = 0; d <= 24; d += 6) {
            if (d == 6) continue;
            MockSettlementToken t = new MockSettlementToken("X", "X", d);
            vm.expectRevert(abi.encodeWithSelector(SettlementAdapter.WrongDecimals.selector, d));
            new SettlementAdapter(IERC20(address(t)));
        }
    }

    function test_onlySixDecimalsAndNoZeroToken() public {
        MockSettlement18 wrong = new MockSettlement18();
        vm.expectRevert(abi.encodeWithSelector(SettlementAdapter.WrongDecimals.selector, uint8(18)));
        new SettlementAdapter(IERC20(address(wrong)));
        vm.expectRevert(SettlementAdapter.ZeroAddress.selector);
        new SettlementAdapter(IERC20(address(0)));
    }

    /// Never transfer authorizations (EIP-3009): the adapter has no such entry point.
    function test_noTransferAuthorizations() public {
        SettlementAdapter a = new SettlementAdapter(IERC20(address(new MockUSDC())));
        (bool ok,) = address(a).call(
            abi.encodeWithSignature(
                "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
                address(1), address(2), 1, 0, type(uint256).max, bytes32(0), uint8(27), bytes32(0), bytes32(0)
            )
        );
        assertFalse(ok);
    }
}

contract MockSettlement18 is ERC20 {
    constructor() ERC20("Eighteen", "E18") {}
}
