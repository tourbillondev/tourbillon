// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title ReceiptRoots
/// @notice Receipts (spec: "Trades, vol finals and NAV snapshots roll into an hourly Merkle root on Elysium";
///         `post(epoch, root, count)`). Each root commits to every receipt leaf of one UTC hour, built off-chain by the
///         receipts service from the chain's own events, so anyone can rebuild it and check it.
/// @dev    M7 decisions G10 and G11:
///         - Epoch = `timestamp / 3600` (the UTC hour); a root is posted only once its hour is over.
///         - Epochs strictly increase; gaps (an hour with nothing, or posted later) are allowed; a posted root is never
///           replaced. `count` is the number of leaves (at least one; an empty hour is simply not posted).
///         - Leaves are double-hashed (`keccak256(bytes.concat(keccak256(encoded)))`) and the tree hashes sorted pairs,
///           so OpenZeppelin's `MerkleProof.verify` checks a receipt.
///         - The POSTER_ROLE (the receipts service key) can only add the next root; the admin (the timelock) grants and
///           revokes it. A poster cannot set a price, a vol or an admin action, so this is no law-6 exception.
contract ReceiptRoots is AccessControl {
    bytes32 public constant POSTER_ROLE = keccak256("POSTER_ROLE");
    uint256 public constant EPOCH = 1 hours;

    struct Root {
        bytes32 root;
        uint64 count;
        uint64 postedAt;
    }

    mapping(uint256 => Root) internal _roots;
    uint256 public lastEpoch;
    bool public anyPosted;

    event Posted(uint256 indexed epoch, bytes32 root, uint256 count, address indexed poster);

    error ZeroAddress();
    error EpochNotOver(uint256 epoch, uint256 endsAt);
    error EpochNotAfterLast(uint256 epoch, uint256 lastEpoch);
    error EmptyRoot();

    constructor(address admin, address poster) {
        if (admin == address(0) || poster == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(POSTER_ROLE, poster);
    }

    /// @notice The poster only: the root of `count` receipt leaves for `epoch` (a finished hour after the last posted).
    function post(uint256 epoch, bytes32 root, uint256 count) external onlyRole(POSTER_ROLE) {
        if (root == bytes32(0) || count == 0) revert EmptyRoot();
        uint256 endsAt = (epoch + 1) * EPOCH;
        if (block.timestamp < endsAt) revert EpochNotOver(epoch, endsAt);
        if (anyPosted && epoch <= lastEpoch) revert EpochNotAfterLast(epoch, lastEpoch);
        _roots[epoch] = Root(root, uint64(count), uint64(block.timestamp));
        lastEpoch = epoch;
        anyPosted = true;
        emit Posted(epoch, root, count, msg.sender);
    }

    function rootOf(uint256 epoch) external view returns (bytes32 root, uint256 count, uint256 postedAt) {
        Root memory r = _roots[epoch];
        return (r.root, r.count, r.postedAt);
    }

    /// @notice True when `leaf` (already double-hashed, see `leafOf`) is in the root posted for `epoch`.
    function verify(uint256 epoch, bytes32 leaf, bytes32[] calldata proof) external view returns (bool) {
        bytes32 root = _roots[epoch].root;
        return root != bytes32(0) && MerkleProof.verifyCalldata(proof, root, leaf);
    }

    /// @notice The leaf of an encoded receipt: `keccak256(bytes.concat(keccak256(encoded)))`.
    function leafOf(bytes calldata encoded) external pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(encoded)));
    }

    function epochOf(uint256 timestamp) external pure returns (uint256) {
        return timestamp / EPOCH;
    }
}
