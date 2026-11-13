# receipts

Posts the hourly receipt root (spec section 7; M7 decisions G10, G11). Every finished UTC hour that holds receipts gets
one root on `ReceiptRoots`, built from the chain's own events, so anyone can rebuild and check it:

- trades: Engine `Bought` / `ShapeBought` / `Sold`, OpenBook `Routed`, WriterBook `Written` / `Unwritten`, MatchBook
  `Matched` / `BoughtBack` / `EarlyClosed`, RiskAuction `Settled`;
- vol finals: QuorumBoard `Finalised` for each market's VOL key;
- NAV snapshots: MainspringPool `Settled` (each settled round).

A receipt is `abi.encode(kind, chainId, emitter, txHash, logIndex, topics, data)`; its leaf is the double hash; pairs
are hashed sorted, so `ReceiptRoots.verify` (OpenZeppelin `MerkleProof`) checks a proof. Hours with no receipts are not
posted. The poster key can only add the next root; the timelock rotates it.

    bun src/main.ts --deployment ../../contracts/deployments/31337-m7.json --local-unlocked <poster> [--rpc URL]
    GET /proof?tx=0x…&logIndex=N   GET /epoch?e=N   GET /health
