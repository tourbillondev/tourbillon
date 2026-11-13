# maker-gateway

Serves signed vol quotes (spec section 7; M6 decision D14). Makers sign Quote v2 (EIP-712, domain "Tourbillon" / "1" /
chain id / VolQuoteBook) and post them here; buyers and front ends ask for the best quotes for an order and pass them to
`OpenBook.buy`, which re-checks and prices every quote on-chain and fills at the cheapest of makers, writer offers and
the pool.

The gateway holds no keys and no funds and sends no transactions. It checks, on receipt: the quote's terms, the maker's
signature for this chain and quote book, expiry (chain time), the nonce (not cancelled, room left) and that the maker's
vault has free USDC. On a request it returns at most 4 quotes (one per maker) that fit the whole order, whose maker's
vault holds the order's exact collateral free, cheapest first at the router's mark. With no fresh mark it returns none.

    bun src/main.ts --deployment ../../contracts/deployments/31337-m6.json [--rpc URL] [--port 8547]

    POST /quotes  { quote, sig }
    POST /best    { name, legs, movement, units }     (integers as decimal strings; legs are the buyer's side)
    GET  /health

## Reference maker bot (local only)

`src/bot.ts` quotes one market around the board's vol (default 3 vol points under it) and posts to the gateway. It runs
only on a local anvil and signs through the node's unlocked account (`eth_signTypedData_v4`), so no key appears
anywhere. `--fund 100000` mints mock USDC and deposits it in the maker's vault first.

    bun src/bot.ts --deployment ../../contracts/deployments/31337-m6.json --maker 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 --market BTC --fund 100000
