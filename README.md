# Tourbillon

[![ci](https://github.com/tourbillondev/tourbillon/actions/workflows/ci.yml/badge.svg)](https://github.com/tourbillondev/tourbillon/actions/workflows/ci.yml)
[![analysis](https://github.com/tourbillondev/tourbillon/actions/workflows/analysis.yml/badge.svg)](https://github.com/tourbillondev/tourbillon/actions/workflows/analysis.yml)
[![invariants-deep](https://github.com/tourbillondev/tourbillon/actions/workflows/invariants-deep.yml/badge.svg)](https://github.com/tourbillondev/tourbillon/actions/workflows/invariants-deep.yml)

Options that never expire, on tokenized stocks and crypto, on Robinhood Chain. Settled in USDG.

A buyer holds a call (Rise), a put (Fall) or a shape of up to four legs for as long as they like. Instead of an expiry,
they pick a tempo from 1 hour to 30 days (or a Movement mixing up to four tempos): the position's units shrink a
little each day along the recorded price path. Writers lock the exact worst case of what they sell; a pool (the
Mainspring) backstops every trade and hedges its stock delta on Robinhood Chain and its crypto delta at an exchange.

**Status:** local chains and the Robinhood Chain testnet only. Nothing is deployed on any mainnet; mainnet waits for
an external review, a compliance review and the owners' approval.

This repository is the project's public code for anyone who wants to check it: the contracts, the services, the
website, their tests, and the documents below.

## The six laws

1. A buyer never loses more than they paid. No margin, no liquidation.
2. No price without a fresh, cross-checked mark. If none, opens on that market close.
3. Sells always work. Pauses stop new opens only.
4. Every writer's collateral covers the exact worst case of what they sold.
5. Funding follows the recorded price path. No caller supplies a price.
6. No single key can set a price, a vol or an admin action.

Each law is checked by stateful invariants and fuzz tests, linked one by one in [docs/invariants.md](docs/invariants.md).

## Documents

| Document | What it covers |
|---|---|
| [Architecture](docs/architecture.md) | The contracts and services, how a trade flows, and the roles matrix (who can do what, through which key) |
| [Invariants](docs/invariants.md) | Each law and the tests that check it |
| [Threat model](docs/threat-model.md) | What can go wrong, and what stops it |
| [Runbook](docs/runbook.md) | Operating the system: alarms, pauses, recovery |
| [API v1](docs/backend/api-v1.md) | The public read API |
| [Honest limits](docs/backend/honest-limits.md) | What the system does not do, and what is not verified yet |
| [Running a signer](docs/backend/signer-operator.md) | For signer operators |
| [SECURITY.md](SECURITY.md) | Reporting a problem privately |
| [CHANGELOG.md](CHANGELOG.md) | Every notable change |
| [LICENSE](LICENSE) | MIT |

## Check it yourself

You need [Foundry](https://getfoundry.sh) (forge and anvil; solc 0.8.28 is fetched by forge), [Bun](https://bun.sh)
1.4.4, Node.js 20 or later, and optionally PostgreSQL 17 (the indexer and API end-to-end tests run only when `initdb`
and `pg_ctl` are installed).

```sh
git clone --recurse-submodules https://github.com/tourbillondev/tourbillon.git
cd tourbillon
```

**Contracts**

```sh
cd contracts
forge build
forge test                                                            # unit, fuzz and invariant tests
FOUNDRY_PROFILE=deep forge test --match-path 'test/invariant/*'       # the invariants at 100,000 calls per suite
cd ..
```

**Services** (the end-to-end tests deploy the contracts on a local anvil)

```sh
cd services
bun install --frozen-lockfile
bun run typecheck
bun test
cd ..
```

**Website**

```sh
cd website
bun install --frozen-lockfile
node --test tests/*.test.mjs       # amounts, the transaction state machine, the manifest, refusals, the API client, the wallet
bun test test-bun                  # the generated contract interface, the manifest maker, the live end-to-end test on anvil
bunx vite                          # the demo at http://127.0.0.1:5173/#/ (sample data, labelled)
bun scripts/local.ts --wallet 0xYourAddress   # the live site against a local anvil, indexer and API (this computer only)
cd ..
```

**Words check** (the wording rules every published text follows)

```sh
bun tools/banned-words.ts .
```

## Deployments

**Robinhood Chain testnet (chain 46630): coming.** The contract addresses, their source verification and the
deployment block will be listed here after the testnet deployment.

| Contract | Address |
|---|---|
| Engine, OpenBook, WriterBook, PathFundingBook, MainspringPool, MarkRouter, QuorumBoard, ReceiptRoots, VolFeed, Safe, Timelock | coming |

**Mainnet:** none. Nothing is deployed on any mainnet.

## Audit

**External review: coming.** The report and the fixes made for it will be linked here.

## What is here

| Folder | Contents |
|---|---|
| `contracts/` | The Solidity contracts (Foundry), their tests and deploy scripts |
| `services/` | The off-chain services (Bun, TypeScript): signers, poker, hedgers, risk monitor, receipts, indexer, API, MCP, maker gateway, alert bot, release system |
| `website/` | The site and dashboard (React, Vite): a labelled demo mode and a live mode on the API and contracts |
| `docs/` | The documents above |
| `tools/`, `scripts/` | The words check and the publish script |

## Limits

Read the [honest limits](docs/backend/honest-limits.md) before relying on anything here: prices come from a signer
quorum until Robinhood Chain publishes a first-party mark, buyers can lose what they paid, writers can lose their
locked collateral, and the pool's NAV can fall.

Tourbillon is an independent project. Robinhood Chain is used as a network only.

## License

[MIT](LICENSE)
