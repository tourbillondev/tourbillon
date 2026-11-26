// The live chain side of the dashboard: checks that the manifest, the RPC, the contracts and the API all describe the
// same deployment, then builds each trade (buy, sell, write) as an exact contract call that is simulated from the
// user's own account before the wallet is asked, and reconciled from its events afterwards.
import { createPublicClient, createWalletClient, custom, decodeEventLog, defineChain, getAddress, http, maxUint256, parseAbi, stringToHex } from 'viem';
import { ERC20, Engine, MainspringPool, OpenBook, PathFundingBook, WriterBook } from './abi.generated.mjs';
import { explain } from './errors.mjs';
import { maxCostFor, minOutFor, writerCollateral } from './codec.mjs';
import { walletChain } from './manifest.mjs';

const erc20 = parseAbi(ERC20);
export const b32 = (m) => stringToHex(m, { size: 32 });
export const DEADLINE_SECONDS = 600n;
export const SLIPPAGE_BPS = 50; // 0.5%: the most a buy may cost above, or a sale pay below, the reviewed amount

export function chainOf(m) {
  return defineChain({ id: m.chainId, name: m.networkName, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [m.rpcUrl] } } });
}

export function liveChain(m, { transport } = {}) {
  const chain = chainOf(m);
  const client = createPublicClient({ chain, transport: transport ?? http(m.rpcUrl) });
  const C = m.contracts;

  /// Every way the site could be pointed at the wrong thing, checked before anything is shown as live.
  async function verify(status) {
    const problems = [];
    const id = await client.getChainId().catch(() => null);
    if (id === null) return ['The RPC in the deployment manifest could not be reached.'];
    if (id !== m.chainId) problems.push(`The RPC is chain ${id}, the manifest says ${m.chainId}.`);
    for (const [name, address] of Object.entries(C)) {
      const code = await client.getCode({ address }).catch(() => null);
      if (!code || code === '0x') problems.push(`No contract code at ${name} (${address}).`);
    }
    if (!problems.length) {
      const [symbol, decimals] = await Promise.all([
        client.readContract({ address: C.SettlementToken, abi: erc20, functionName: 'symbol' }),
        client.readContract({ address: C.SettlementToken, abi: erc20, functionName: 'decimals' }),
      ]).catch(() => [null, null]);
      if (symbol !== m.settlement.symbol || Number(decimals) !== m.settlement.decimals) problems.push(`The settlement token says ${symbol} with ${decimals} decimals; the manifest says ${m.settlement.symbol} with ${m.settlement.decimals}.`);
    }
    if (status) {
      if (status.chainId !== m.chainId) problems.push(`The API serves chain ${status.chainId}, the manifest says ${m.chainId}.`);
      if (status.settlement?.symbol !== m.settlement.symbol || getAddress(status.settlement?.token ?? '0x0000000000000000000000000000000000000000') !== getAddress(C.SettlementToken)) problems.push('The API names a different settlement token.');
    }
    return problems;
  }

  const now = async () => (await client.getBlock()).timestamp;
  const balance = (owner) => client.readContract({ address: C.SettlementToken, abi: erc20, functionName: 'balanceOf', args: [owner] });
  const allowance = (owner, spender) => client.readContract({ address: C.SettlementToken, abi: erc20, functionName: 'allowance', args: [owner, spender] });

  /// The I/O the transaction machine needs, around one exact call. `call` is { address, abi, functionName, args };
  /// `build(account)` gives it (with the bounds and deadline) after the simulation fixed the amounts.
  function io({ provider, account, approval, simulate, build, confirm, reconcile }) {
    const wallet = createWalletClient({ account, chain, transport: custom(provider) });
    const toChain = (x) => Number(BigInt(x));
    let call = null;
    return {
      account: async () => {
        const a = await provider.request({ method: 'eth_accounts' });
        return a?.[0] ? getAddress(a[0]) : null;
      },
      chainId: async () => toChain(await provider.request({ method: 'eth_chainId' })),
      switchNetwork: async () => {
        const target = walletChain(m);
        try {
          await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: target.chainId }] });
        } catch (e) {
          if (Number(e?.code) !== 4902) throw e;
          await provider.request({ method: 'wallet_addEthereumChain', params: [target] });
        }
      },
      allowance: () => allowance(account, approval.spender),
      approve: async (amount) => {
        const hash = await wallet.writeContract({ address: C.SettlementToken, abi: erc20, functionName: 'approve', args: [approval.spender, amount] });
        return client.waitForTransactionReceipt({ hash });
      },
      simulate: async () => {
        try {
          const r = await simulate();
          call = build(r);
          return { ok: true, result: r, review: r.review };
        } catch (e) {
          return { ok: false, error: explain(e).message };
        }
      },
      confirm,
      send: () => wallet.writeContract(call),
      wait: async (hash) => {
        let replaced = null;
        const rc = await client.waitForTransactionReceipt({ hash, onReplaced: (r) => { if (r.reason !== 'repriced') replaced = r.transaction.hash; } });
        return replaced ? { status: 'replaced', replacedBy: replaced } : rc;
      },
      reconcile,
      explain: (e) => explain(e).message,
    };
  }

  /// Logs of `abi` emitted by `address` in a receipt, decoded.
  const eventsIn = (rc, address, abi) => rc.logs.filter((l) => getAddress(l.address) === getAddress(address)).flatMap((l) => {
    try {
      return [decodeEventLog({ abi, data: l.data, topics: l.topics })];
    } catch {
      return [];
    }
  });

  /// A buy: the cheapest of the pool, maker quotes and offers through OpenBook. `limit` is the most the user agrees to
  /// pay (the API's exact quote, or the model estimate for a Movement, plus the slippage bound); the approval is that
  /// limit, and the review shows the exact cost simulated from the user's account at the current block.
  function buy({ provider, account, market, legs, movement, units, limit, confirm, positionsAgree }) {
    const maxCost = maxCostFor(limit, SLIPPAGE_BPS);
    let deadline;
    const args = () => [b32(market), legs, movement, units, maxCost, deadline, [], [], []];
    return {
      plan: { chainId: m.chainId, networkName: m.networkName, approval: { spender: C.Engine, amount: maxCost } },
      io: io({
        provider,
        account,
        approval: { spender: C.Engine },
        simulate: async () => {
          deadline = (await now()) + DEADLINE_SECONDS;
          const { result } = await client.simulateContract({ account, address: C.OpenBook, abi: OpenBook, functionName: 'buy', args: args() });
          const [, cost, kind] = result;
          return { cost, kind, review: { action: 'buy', cost, maxCost, deadline, source: ['pool', 'maker quote', 'written offer'][kind] ?? 'unknown' } };
        },
        build: () => ({ address: C.OpenBook, abi: OpenBook, functionName: 'buy', args: args() }),
        confirm,
        reconcile: async (rc) => {
          const routed = eventsIn(rc, C.OpenBook, OpenBook).find((e) => e.eventName === 'Routed');
          if (!routed) return false;
          const id = routed.args.id;
          const held = await client.readContract({ address: C.PathFundingBook, abi: PathFundingBook, functionName: 'balanceOf', args: [id, account] });
          if (held <= 0n) return false;
          // reconciled means the read models agree too: until the API shows the position, the outcome stays unknown
          if (positionsAgree && !(await positionsAgree(id))) return false;
          return { id, cost: routed.args.cost };
        },
      }),
    };
  }

  /// A sale of a whole position through the Engine: the review shows the exact net simulated now; the user signs a
  /// minimum of that net less the slippage bound. No approval: the Engine burns the user's own units.
  function sell({ provider, account, id, confirm, positionsAgree }) {
    let deadline;
    let minOut = 0n;
    return {
      plan: { chainId: m.chainId, networkName: m.networkName },
      io: io({
        provider,
        account,
        approval: null,
        simulate: async () => {
          deadline = (await now()) + DEADLINE_SECONDS;
          const { result } = await client.simulateContract({ account, address: C.Engine, abi: Engine, functionName: 'sell', args: [id, maxUint256, 0n, deadline] });
          const [, net] = result;
          minOut = minOutFor(net, SLIPPAGE_BPS);
          return { net, review: { action: 'sell', net, minOut, deadline } };
        },
        build: () => ({ address: C.Engine, abi: Engine, functionName: 'sell', args: [id, maxUint256, minOut, deadline] }),
        confirm,
        reconcile: async (rc) => {
          const sold = eventsIn(rc, C.Engine, Engine).find((e) => e.eventName === 'Sold' && e.args.id === id);
          if (!sold) return false;
          if (positionsAgree && !(await positionsAgree(id))) return false;
          return { id, net: sold.args.net };
        },
      }),
    };
  }

  /// A cash write through WriterBook: the collateral is the exact worst case (computed here as the contract does, and
  /// approved to the WriterBook); the review shows the credit simulated now, and the user signs a minimum credit of
  /// that less the slippage bound. A shape with no bounded worst case is refused before anything is asked.
  function write({ provider, account, market, buyerLegs, writerLegs, movement, units, confirm }) {
    const col = writerCollateral(buyerLegs, units, m.settlement.decimals);
    if (!col) throw new Error('This shape has no bounded worst case, so it cannot be written against collateral.');
    let deadline;
    let minCredit = 0n;
    const args = () => [b32(market), writerLegs, movement, units, false, minCredit, deadline];
    return {
      collateral: col.locked,
      plan: { chainId: m.chainId, networkName: m.networkName, approval: { spender: C.WriterBook, amount: col.locked } },
      io: io({
        provider,
        account,
        approval: { spender: C.WriterBook },
        simulate: async () => {
          deadline = (await now()) + DEADLINE_SECONDS;
          minCredit = -(2n ** 255n);
          const { result } = await client.simulateContract({ account, address: C.WriterBook, abi: WriterBook, functionName: 'write', args: args() });
          const [, credit] = result;
          minCredit = credit >= 0n ? minOutFor(credit, SLIPPAGE_BPS) : credit - (-credit * BigInt(SLIPPAGE_BPS) + 9999n) / 10000n;
          return { credit, review: { action: 'write', collateral: col.locked, credit, minCredit, deadline } };
        },
        build: () => ({ address: C.WriterBook, abi: WriterBook, functionName: 'write', args: args() }),
        confirm,
        reconcile: async (rc) => {
          const w = eventsIn(rc, C.WriterBook, WriterBook).find((e) => e.eventName === 'Written' && getAddress(e.args.writer) === getAddress(account));
          return w ? { writeId: w.args.writeId, locked: w.args.settlementLocked, credit: w.args.credit } : false;
        },
      }),
    };
  }

  /// The user's open writes, from the WriterBook's own events and state (no indexer needed).
  async function writesOf(owner) {
    const logs = await client.getContractEvents({ address: C.WriterBook, abi: WriterBook, eventName: 'Written', args: { writer: owner }, fromBlock: m.deployBlock, toBlock: 'latest' });
    return logs.map((l) => ({ writeId: l.args.writeId, seriesId: l.args.seriesId, market: l.args.market, units: l.args.units, locked: l.args.settlementLocked, credit: l.args.credit, block: l.blockNumber }));
  }

  /// The exact sale value of a whole position now, from the user's account (null when the Engine would refuse).
  async function saleValue(account, id) {
    try {
      const { result } = await client.simulateContract({ account, address: C.Engine, abi: Engine, functionName: 'sell', args: [id, maxUint256, 0n, (await now()) + DEADLINE_SECONDS] });
      return result[1];
    } catch {
      return null;
    }
  }

  const opensPaused = (market) => client.readContract({ address: C.MainspringPool, abi: MainspringPool, functionName: 'marketPaused', args: [b32(market)] });

  return { client, verify, balance, allowance, buy, sell, write, writesOf, saleValue, opensPaused, now };
}
