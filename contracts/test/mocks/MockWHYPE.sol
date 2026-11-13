// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Local stand-in for wrapped HYPE (18 decimals, open minting). Tests only.
contract MockWHYPE is ERC20 {
    constructor() ERC20("Mock Wrapped HYPE", "mWHYPE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
