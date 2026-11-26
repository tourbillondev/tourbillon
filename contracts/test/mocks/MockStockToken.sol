// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice LOCAL AND TESTS ONLY. A tokenized stock with the behaviours the spec says to probe before listing (§9):
///         any decimals, an issuer pause, an allow list read through the ERC-1404 check, a freeze (transfers revert
///         without warning, as an issuer action might), and a fee on transfer (standing in for rebasing). Open minting.
contract MockStockToken is ERC20 {
    uint8 internal immutable _dec;
    bool public paused;
    bool public frozen; // every transfer reverts, and the restriction check does not say so
    bool public restricted; // only allowed accounts may send and receive
    uint256 public feeBps; // taken from every transfer
    mapping(address => bool) public allowed;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _dec = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function setFrozen(bool f) external {
        frozen = f;
    }

    function setRestricted(bool r) external {
        restricted = r;
    }

    function setAllowed(address who, bool ok) external {
        allowed[who] = ok;
    }

    function setFeeBps(uint256 bps) external {
        feeBps = bps;
    }

    /// @notice ERC-1404: 0 = allowed, 1 = paused, 2 = sender not allowed, 3 = receiver not allowed.
    function detectTransferRestriction(address from, address to, uint256) public view returns (uint8) {
        if (paused) return 1;
        if (restricted && !allowed[from]) return 2;
        if (restricted && !allowed[to]) return 3;
        return 0;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            require(!frozen, "frozen");
            require(detectTransferRestriction(from, to, value) == 0, "restricted");
            uint256 fee = value * feeBps / 10_000;
            if (fee > 0) {
                super._update(from, address(0), fee);
                value -= fee;
            }
        }
        super._update(from, to, value);
    }
}
