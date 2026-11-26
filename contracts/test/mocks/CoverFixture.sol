// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CoveringAssets, ICoverMarks} from "../../src/CoveringAssets.sol";

/// Tests only: a covering-asset table with `token` listed as STK1's cover, administered by the calling test.
/// The test token has no restrictions, so no holder pair needs checking at listing.
library CoverFixture {
    function listed(address admin, address marks, IERC20 token) internal returns (CoveringAssets c) {
        c = new CoveringAssets(admin, ICoverMarks(marks));
        c.list("STK1", token, new address[](0));
    }
}
