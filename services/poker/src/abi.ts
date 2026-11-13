/// The parts of PathFundingBook and Engine the poker reads and calls, plus the router and board errors a poke can
/// revert with (so they can be named in logs).
export const bookAbi = [
  { type: "function", name: "poke", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }, { type: "bool" }, { type: "bool" }] },
  {
    type: "function",
    name: "latestSample",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "uint256", name: "t" }, { type: "uint256", name: "sWad" }, { type: "uint256", name: "sigmaBps" }],
  },
  {
    type: "function",
    name: "cursor",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { type: "uint40", name: "at" },
          { type: "uint40", name: "eff" },
          { type: "uint256", name: "x" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "accrue",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint256" }, { type: "uint256" }],
    outputs: [{ type: "uint256", name: "norm" }, { type: "bool", name: "done" }],
  },
  { type: "function", name: "normNow", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  {
    type: "event",
    name: "Opened",
    inputs: [
      { type: "uint256", name: "id", indexed: true },
      { type: "bytes32", name: "name", indexed: true },
      { type: "bool", name: "isCall", indexed: false },
      { type: "uint128", name: "kWad", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ShapeOpened",
    inputs: [
      { type: "uint256", name: "id", indexed: true },
      { type: "bytes32", name: "name", indexed: true },
      { type: "uint256", name: "legs", indexed: false },
    ],
  },
  { type: "error", name: "NoHistory", inputs: [] },
  { type: "error", name: "HistoryGone", inputs: [{ type: "uint256" }] },
  { type: "error", name: "Unknown", inputs: [{ type: "uint256" }] },
  // router
  { type: "error", name: "NoRoute", inputs: [{ type: "bytes32" }] },
  { type: "error", name: "Stale", inputs: [{ type: "bytes32" }, { type: "address" }] },
  { type: "error", name: "Disagree", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }] },
  // board
  { type: "error", name: "Stale", inputs: [{ type: "bytes32" }, { type: "uint256" }] },
  { type: "error", name: "NoData", inputs: [{ type: "bytes32" }] },
] as const;

export const engineAbi = [
  {
    type: "event",
    name: "ShapeBought",
    inputs: [
      { type: "address", name: "buyer", indexed: true },
      { type: "uint256", name: "id", indexed: true },
      { type: "bytes32", name: "market", indexed: true },
      { type: "uint256", name: "units", indexed: false },
      { type: "uint256", name: "raw", indexed: false },
      { type: "uint256", name: "sWad", indexed: false },
      { type: "uint256", name: "sigmaBps", indexed: false },
      { type: "int256", name: "unitValueWad", indexed: false },
      { type: "uint256", name: "premium", indexed: false },
      { type: "uint256", name: "fee", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Bought",
    inputs: [
      { type: "address", name: "buyer", indexed: true },
      { type: "uint256", name: "id", indexed: true },
      { type: "bytes32", name: "market", indexed: true },
      { type: "uint256", name: "units", indexed: false },
      { type: "uint256", name: "raw", indexed: false },
      { type: "uint256", name: "sWad", indexed: false },
      { type: "uint256", name: "sigmaBps", indexed: false },
      { type: "uint256", name: "unitValueWad", indexed: false },
      { type: "uint256", name: "premium", indexed: false },
      { type: "uint256", name: "fee", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Sold",
    inputs: [
      { type: "address", name: "seller", indexed: true },
      { type: "uint256", name: "id", indexed: true },
      { type: "bytes32", name: "market", indexed: true },
      { type: "uint256", name: "units", indexed: false },
      { type: "uint256", name: "raw", indexed: false },
      { type: "uint256", name: "sWad", indexed: false },
      { type: "uint256", name: "sigmaBps", indexed: false },
      { type: "uint256", name: "unitValueWad", indexed: false },
      { type: "uint256", name: "gross", indexed: false },
      { type: "uint256", name: "fee", indexed: false },
      { type: "uint256", name: "net", indexed: false },
      { type: "bool", name: "markFromSample", indexed: false },
      { type: "bool", name: "volFromSample", indexed: false },
    ],
  },
] as const;

/// WriterBook events (M4): a write holds raw of its series (the pool long) until unwritten.
export const writerBookAbi = [
  {
    type: "event",
    name: "Written",
    inputs: [
      { type: "address", name: "writer", indexed: true },
      { type: "uint256", name: "writeId", indexed: true },
      { type: "uint256", name: "seriesId", indexed: true },
      { type: "bytes32", name: "market", indexed: false },
      { type: "uint256", name: "units", indexed: false },
      { type: "uint256", name: "raw", indexed: false },
      { type: "uint256", name: "sWad", indexed: false },
      { type: "uint256", name: "sigmaBps", indexed: false },
      { type: "uint256", name: "usdcLocked", indexed: false },
      { type: "uint256", name: "whypeLocked", indexed: false },
      { type: "int256", name: "credit", indexed: false },
      { type: "uint256", name: "fee", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Unwritten",
    inputs: [
      { type: "uint256", name: "writeId", indexed: true },
      { type: "uint256", name: "units", indexed: false },
      { type: "uint256", name: "raw", indexed: false },
      { type: "uint256", name: "sWad", indexed: false },
      { type: "uint256", name: "sigmaBps", indexed: false },
      { type: "int256", name: "cost", indexed: false },
      { type: "uint256", name: "fee", indexed: false },
      { type: "uint256", name: "usdcPaid", indexed: false },
      { type: "uint256", name: "whypePaid", indexed: false },
      { type: "uint256", name: "walletPaid", indexed: false },
      { type: "bool", name: "capped", indexed: false },
      { type: "bool", name: "markFromSample", indexed: false },
      { type: "bool", name: "volFromSample", indexed: false },
    ],
  },
] as const;
