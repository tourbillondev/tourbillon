// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice The two Safe v1.4.1 calls governance needs (the Safe sources compile in their own profile; nothing here
///         imports them).
interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

interface ISafeSetup {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
}

/// @title Governance
/// @notice M7 (law 6): the 3-of-5 Safe and the 2-of-3 guardian Safe (Safe v1.4.1 proxies), and the timelock every admin
///         action goes through (M7 decisions G1, G2, G3, G19).
///         - Timelock: OpenZeppelin TimelockController. The Safe proposes and cancels; anyone executes once the delay
///           has passed; no admin (the timelock administers itself).
///         - Delay (owner, G19): 1 h on anvil (31337) and the Elysium testnet (99801); at least 48 h on any other chain.
/// @dev    Internal functions only: they run inside the deploying contract or script, so the deployer holds no role in
///         anything they create.
library Governance {
    uint256 internal constant SAFE_OWNERS = 5;
    uint256 internal constant SAFE_THRESHOLD = 3;
    uint256 internal constant GUARDIAN_OWNERS = 3;
    uint256 internal constant GUARDIAN_THRESHOLD = 2;
    uint256 internal constant MAINNET_MIN_DELAY = 48 hours;
    uint256 internal constant TESTNET_DELAY = 1 hours;
    uint256 internal constant ANVIL = 31337;
    uint256 internal constant ELYSIUM_TESTNET = 99801;

    error DelayTooShort(uint256 chainId, uint256 delay, uint256 minimum);
    error BadOwners(uint256 given, uint256 expected);

    /// @notice Reverts unless `delay` is allowed on `chainId`: at least 48 h, except on anvil and the Elysium testnet.
    function checkDelay(uint256 chainId, uint256 delay) internal pure {
        if (chainId == ANVIL || chainId == ELYSIUM_TESTNET) return;
        if (delay < MAINNET_MIN_DELAY) revert DelayTooShort(chainId, delay, MAINNET_MIN_DELAY);
    }

    /// @notice A Safe proxy with `owners` and `threshold`, no modules, no fallback handler.
    function deploySafe(
        ISafeProxyFactory factory,
        address singleton,
        address[] memory owners,
        uint256 threshold,
        uint256 saltNonce
    ) internal returns (address safe) {
        bytes memory init = abi.encodeCall(
            ISafeSetup.setup, (owners, threshold, address(0), "", address(0), address(0), 0, payable(address(0)))
        );
        safe = factory.createProxyWithNonce(singleton, init, saltNonce);
    }

    /// @notice The 3-of-5 Safe.
    function deployAdminSafe(ISafeProxyFactory factory, address singleton, address[] memory owners, uint256 saltNonce)
        internal
        returns (address)
    {
        if (owners.length != SAFE_OWNERS) revert BadOwners(owners.length, SAFE_OWNERS);
        return deploySafe(factory, singleton, owners, SAFE_THRESHOLD, saltNonce);
    }

    /// @notice The 2-of-3 guardian Safe.
    function deployGuardian(ISafeProxyFactory factory, address singleton, address[] memory owners, uint256 saltNonce)
        internal
        returns (address)
    {
        if (owners.length != GUARDIAN_OWNERS) revert BadOwners(owners.length, GUARDIAN_OWNERS);
        return deploySafe(factory, singleton, owners, GUARDIAN_THRESHOLD, saltNonce);
    }

    /// @notice The timelock: `safe` proposes and cancels, anyone executes after `delay`, no admin. Applies the delay rule
    ///         on the current chain.
    function deployTimelock(address safe, uint256 delay) internal returns (TimelockController) {
        checkDelay(block.chainid, delay);
        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        address[] memory executors = new address[](1); // address(0): anyone may execute a ready operation
        return new TimelockController(delay, proposers, executors, address(0));
    }
}
