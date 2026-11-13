# mcp

The spec's `api / mcp` tools (section 7: "Chains by tempo, vol feed, shapes, quotes, positions, mandates"), served over
MCP, a JSON-RPC tool protocol for automated clients, on standard input and output (one message per line). It never
holds a key: read tools answer from the chain (and the maker-gateway for quotes); builder tools return unsigned
transactions and EIP-712 mandates for the owner or agent to sign with their own wallet.

Tools: `chains_by_tempo` (indicative values at the board's vol; the router prices every fill), `vol_feed`, `shapes`
(families, buyer-safety of legs), `quotes`, `positions` (direct and AgentRouter sub-account), `mandates` (hash and
usage), `build_mandate`, `build_buy` (OpenBook, or AgentRouter under a mandate), `build_sell` (direct, owner, agent).

    bun src/main.ts --deployment ../../contracts/deployments/31337-m7.json [--rpc URL] [--gateway http://127.0.0.1:8547]
