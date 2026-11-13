// SPDX-License-Identifier: MIT
pragma solidity >=0.7.0 <0.9.0;

// Builds the Safe v1.4.1 artifacts (legacy pipeline, see foundry.toml) so tests and scripts deploy them with
// `deployCode`; nothing else imports the Safe sources.
import {Safe} from "@safe/Safe.sol";
import {SafeProxyFactory} from "@safe/proxies/SafeProxyFactory.sol";
