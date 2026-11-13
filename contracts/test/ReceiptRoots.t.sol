// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";
import {ReceiptRoots} from "../src/ReceiptRoots.sol";

/// M7 step 5: ReceiptRoots (G10, G11).
contract ReceiptRootsTest is Test {
    address constant ADMIN = address(0x71); // stands in for the timelock
    address constant POSTER = address(0x9057);
    address constant ANYONE = address(0xA11);
    ReceiptRoots rr;
    uint256 nowT;

    function _set(uint256 t) internal {
        nowT = t;
        vm.warp(t);
    }

    function setUp() public {
        _set(1_794_182_400 + 30 minutes); // inside hour E0
        rr = new ReceiptRoots(ADMIN, POSTER);
    }

    function _e0() internal view returns (uint256) {
        return nowT / 1 hours;
    }

    // ---------------------------------------------------------------- a small sorted-pair tree (OZ layout)

    function _leaf(uint256 i) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(uint8(1), uint256(31337), address(0xE), bytes32(i), i))));
    }

    /// Root and the proof of leaf `k` for `n` leaves (odd levels carry the last node up unchanged).
    function _tree(uint256 n, uint256 k) internal pure returns (bytes32 root, bytes32[] memory proof) {
        bytes32[] memory level = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            level[i] = _leaf(i);
        }
        bytes32[] memory p = new bytes32[](8);
        uint256 depth;
        uint256 idx = k;
        while (level.length > 1) {
            uint256 m = (level.length + 1) / 2;
            bytes32[] memory up = new bytes32[](m);
            for (uint256 i; i < m; ++i) {
                uint256 a = 2 * i;
                up[i] = a + 1 < level.length ? Hashes.commutativeKeccak256(level[a], level[a + 1]) : level[a];
            }
            uint256 sib = idx ^ 1;
            if (sib < level.length) p[depth++] = level[sib];
            idx /= 2;
            level = up;
        }
        root = level[0];
        proof = new bytes32[](depth);
        for (uint256 i; i < depth; ++i) {
            proof[i] = p[i];
        }
    }

    // ---------------------------------------------------------------- tests

    function test_postsAFinishedHourAndProofsVerify() public {
        (bytes32 root,) = _tree(5, 0);
        uint256 e = _e0();
        vm.prank(POSTER);
        vm.expectRevert(abi.encodeWithSelector(ReceiptRoots.EpochNotOver.selector, e, (e + 1) * 1 hours));
        rr.post(e, root, 5);
        _set((e + 1) * 1 hours);
        vm.expectEmit(address(rr));
        emit ReceiptRoots.Posted(e, root, 5, POSTER);
        vm.prank(POSTER);
        rr.post(e, root, 5);
        (bytes32 r, uint256 count, uint256 at) = rr.rootOf(e);
        assertEq(r, root);
        assertEq(count, 5);
        assertEq(at, nowT);
        for (uint256 k; k < 5; ++k) {
            (, bytes32[] memory proof) = _tree(5, k);
            assertTrue(rr.verify(e, _leaf(k), proof), "every leaf proves");
            assertFalse(rr.verify(e, _leaf(k + 7), proof), "a leaf that is not in the tree fails");
            assertFalse(rr.verify(e + 1, _leaf(k), proof), "no root for another hour");
        }
        bytes memory enc = abi.encode(uint8(1), uint256(31337), address(0xE), bytes32(uint256(2)), uint256(2));
        assertEq(rr.leafOf(enc), _leaf(2), "leafOf matches the off-chain double hash");
    }

    function test_epochsStrictlyIncreaseGapsAllowedNeverReplaced() public {
        uint256 e = _e0();
        (bytes32 a,) = _tree(3, 0);
        (bytes32 b,) = _tree(4, 0);
        _set((e + 5) * 1 hours);
        vm.startPrank(POSTER);
        rr.post(e, a, 3);
        vm.expectRevert(abi.encodeWithSelector(ReceiptRoots.EpochNotAfterLast.selector, e, e));
        rr.post(e, b, 4); // never replaced
        rr.post(e + 3, b, 4); // a gap of two hours, posted late
        vm.expectRevert(abi.encodeWithSelector(ReceiptRoots.EpochNotAfterLast.selector, e + 1, e + 3));
        rr.post(e + 1, b, 4); // no going back
        vm.expectRevert(ReceiptRoots.EmptyRoot.selector);
        rr.post(e + 4, bytes32(0), 1);
        vm.expectRevert(ReceiptRoots.EmptyRoot.selector);
        rr.post(e + 4, b, 0);
        vm.stopPrank();
        (bytes32 r0,,) = rr.rootOf(e);
        assertEq(r0, a);
        assertEq(rr.lastEpoch(), e + 3);
        (bytes32 r1,,) = rr.rootOf(e + 1);
        assertEq(r1, bytes32(0), "the gap stays empty");
    }

    function test_onlyThePosterPostsAndTheAdminRotatesIt() public {
        uint256 e = _e0();
        (bytes32 root,) = _tree(2, 0);
        _set((e + 1) * 1 hours);
        bytes32 role = rr.POSTER_ROLE();
        address[2] memory no = [ANYONE, ADMIN];
        for (uint256 i; i < 2; ++i) {
            vm.prank(no[i]);
            vm.expectRevert(
                abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, no[i], role)
            );
            rr.post(e, root, 2);
        }
        address next = address(0x9058);
        vm.startPrank(ADMIN);
        rr.grantRole(role, next);
        rr.revokeRole(role, POSTER);
        vm.stopPrank();
        vm.prank(POSTER);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, POSTER, role));
        rr.post(e, root, 2);
        vm.prank(next);
        rr.post(e, root, 2);
        assertEq(rr.epochOf(nowT), e + 1);
    }

    function test_constructorRefusesZero() public {
        vm.expectRevert(ReceiptRoots.ZeroAddress.selector);
        new ReceiptRoots(address(0), POSTER);
        vm.expectRevert(ReceiptRoots.ZeroAddress.selector);
        new ReceiptRoots(ADMIN, address(0));
    }

    function test_postGas() public {
        uint256 e = _e0();
        (bytes32 root,) = _tree(8, 0);
        _set((e + 1) * 1 hours);
        vm.prank(POSTER);
        uint256 g = gasleft();
        rr.post(e, root, 8);
        emit log_named_uint("post gas", g - gasleft());
    }
}
