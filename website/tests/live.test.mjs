import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeErrorResult } from 'viem';
import { CodecError, WAD, checkCanonical, displayUnits, formatUnits, maxCostFor, minOutFor, movementParts, parseDecimal, shapeLegs, singleTempo, snapStrike, strikeProblem, tempoSeconds, toWad, writerCollateral } from '../src/live/codec.mjs';
import { ENDINGS, STATES, runTrade, tracker } from '../src/live/tx.mjs';
import { ConfigError, checkManifest, walletChain } from '../src/live/manifest.mjs';
import { explain } from '../src/live/errors.mjs';
import { ERRORS } from '../src/live/abi.generated.mjs';
import { ApiError, apiClient } from '../src/live/api.mjs';

const W = (n) => BigInt(n) * WAD;

test('decimals: exact both ways, nothing rounded away, odd input refused', () => {
  assert.equal(parseDecimal('12.5', 6), 12_500_000n);
  assert.equal(parseDecimal('.5', 6), 500_000n);
  assert.equal(parseDecimal('0.000001', 6), 1n);
  assert.equal(parseDecimal('74000', 18), 74000n * WAD);
  assert.equal(formatUnits(12_500_000n, 6), '12.5');
  assert.equal(formatUnits(-1n, 6), '-0.000001');
  assert.equal(formatUnits(parseDecimal('123456789.123456', 6), 6), '123456789.123456');
  for (const bad of ['', '-1', '1e6', '1.', '1,5', 'abc', ' . ']) assert.throws(() => parseDecimal(bad, 6), CodecError, bad);
  assert.throws(() => parseDecimal('0.0000001', 6), /at most 6 decimal places/);
  assert.equal(displayUnits(12_345_678n, 6, 2), '12.35');
  assert.equal(displayUnits(1_000_000_000_000n, 6, 2), '1,000,000.00');
});

test('tempos and Movements: whole seconds in range; weights exactly one; repeats and bad weights refused', () => {
  assert.equal(tempoSeconds(1 / 24), 3600);
  assert.equal(tempoSeconds(30), 2_592_000);
  assert.throws(() => tempoSeconds(0.5 / 24), /from 1 hour to 30 days/);
  assert.throws(() => tempoSeconds(31), /from 1 hour to 30 days/);
  assert.deepEqual(singleTempo(7), [{ tempo: 604800n, weight: WAD }]);
  const p = movementParts([{ days: 1, percent: 33 }, { days: 7, percent: 33 }, { days: 30, percent: 34 }]);
  assert.equal(p.reduce((s, x) => s + x.weight, 0n), WAD);
  assert.throws(() => movementParts([{ days: 1, percent: 50 }, { days: 1, percent: 50 }]), /each tempo once/);
  assert.throws(() => movementParts([{ days: 1, percent: 50 }, { days: 7, percent: 49 }]), /add up to 100%/);
  assert.throws(() => movementParts([{ days: 1, percent: 50.5 }, { days: 7, percent: 49.5 }]), /whole percent/);
  assert.throws(() => movementParts([1, 2, 3, 4, 5].map((d) => ({ days: d, percent: 20 }))), /one to four/);
});

test('shapes: the book’s one spelling, buyer and writer sides', () => {
  assert.deepEqual(shapeLegs('Rise', '100', ''), [{ isCall: true, kWad: W(100), qty: WAD }]);
  assert.deepEqual(shapeLegs('Swing', '100', '').map((l) => l.isCall), [false, true]); // put before call
  assert.deepEqual(shapeLegs('Spread', '100', '10').map((l) => [l.kWad, l.qty]), [[W(100), WAD], [W(110), -WAD]]);
  assert.deepEqual(shapeLegs('Spread', '100', '10', 'write').map((l) => l.qty), [-WAD, WAD]);
  assert.deepEqual(shapeLegs('Band', '100', '10').map((l) => l.kWad), [W(80), W(90), W(110), W(120)]);
  assert.throws(() => shapeLegs('Band', '100', '50'), /lowest wing/);
  assert.throws(() => shapeLegs('Guard', '100', ''), /not open/);
  assert.throws(() => checkCanonical([{ isCall: true, kWad: W(1), qty: WAD }, { isCall: false, kWad: W(1), qty: WAD }]), /puts before calls/);
  assert.throws(() => checkCanonical([{ isCall: true, kWad: W(1), qty: 2n * WAD }]), /first amount/);
});

test('strikes: on the step and within half to twice the mark; snapping', () => {
  assert.equal(strikeProblem(W(100), W(100), W(5)), null);
  assert.match(strikeProblem(W(102), W(100), W(5)), /multiple of 5/);
  assert.match(strikeProblem(W(45), W(100), W(5)), /between 50 and 200/);
  assert.match(strikeProblem(W(205), W(100), W(5)), /between 50 and 200/);
  assert.equal(snapStrike('102.4', W(5)), '100');
  assert.equal(snapStrike('102.5', W(5)), '105');
});

test('bounds the wallet signs are never looser than asked', () => {
  assert.equal(maxCostFor(10_000_000n, 50), 10_050_000n);
  assert.equal(maxCostFor(1n, 50), 2n); // rounded up
  assert.equal(minOutFor(10_000_000n, 50), 9_950_000n);
  assert.equal(minOutFor(1n, 50), 0n); // rounded against the seller
});

test('writer collateral: exact worst case as the contract computes it; unbounded shapes refused', () => {
  const units = toWad('10');
  assert.equal(writerCollateral(shapeLegs('Spread', '100', '10'), units, 6).locked, 100_000_000n); // 10 × 10 USDG-units
  assert.equal(writerCollateral(shapeLegs('Fall', '100', ''), units, 6).locked, 1_000_000_000n); // 10 × 100
  assert.equal(writerCollateral(shapeLegs('Band', '100', '10'), toWad('1'), 6).locked, 10_000_000n);
  assert.equal(writerCollateral(shapeLegs('Rise', '100', ''), units, 6), null);
  assert.equal(writerCollateral(shapeLegs('Swing', '100', ''), units, 6), null);
  // rounding is up, to the token's smallest unit
  assert.equal(writerCollateral(shapeLegs('Spread', '100', '0.0000001'), 1n, 6).locked, 1n);
});

test('the machine: every move listed; a move it does not list is refused', () => {
  const t = tracker();
  assert.throws(() => t.go('confirmed'), /idle cannot move to confirmed/);
  t.go('preparing');
  t.go('ready-for-review');
  assert.throws(() => t.go('submitted'), /cannot move/);
  for (const s of ENDINGS) assert.ok(STATES.includes(s));
});

const fakeIo = (over = {}) => ({
  account: async () => '0xA',
  chainId: async () => 31337,
  switchNetwork: async () => {},
  allowance: async () => 0n,
  approve: async () => ({ status: 'success' }),
  simulate: async () => ({ ok: true, review: { cost: 5n } }),
  confirm: async () => true,
  send: async () => '0xhash',
  wait: async () => ({ status: 'success' }),
  reconcile: async () => ({ id: 1n }),
  ...over,
});
const plan = (over = {}) => ({ chainId: 31337, networkName: 'Local', approval: { spender: '0xE', amount: 10n }, ...over });
const run = async (p, io) => {
  const seen = [];
  const r = await runTrade(p, io, (s) => seen.push(s));
  return { r, seen };
};

test('a trade: approval, review, wallet, confirmations, then reconciled; success only after reconcile', async () => {
  const { r, seen } = await run(plan(), fakeIo());
  assert.equal(r.state, 'reconciled');
  assert.deepEqual(seen, ['preparing', 'needs-approval', 'approving', 'preparing', 'ready-for-review', 'awaiting-wallet', 'submitted', 'confirming', 'confirmed', 'reconciled']);
  const enough = await run(plan(), fakeIo({ allowance: async () => 10n }));
  assert.ok(!enough.seen.includes('needs-approval'));
  const notSeen = await run(plan(), fakeIo({ reconcile: async () => false }));
  assert.equal(notSeen.r.state, 'unknown'); // mined but not visible: never announced as done
});

test('a trade: every other ending', async () => {
  const reject = { code: 4001 };
  assert.equal((await run(plan(), fakeIo({ account: async () => null }))).r.state, 'failed');
  assert.equal((await run(plan(), fakeIo({ chainId: async () => 1, switchNetwork: async () => { throw reject; } }))).r.state, 'rejected');
  assert.equal((await run(plan(), fakeIo({ chainId: async () => 1 }))).r.state, 'failed'); // switch reported done, chain unchanged
  assert.equal((await run(plan(), fakeIo({ approve: async () => { throw reject; } }))).r.state, 'rejected');
  assert.equal((await run(plan(), fakeIo({ approve: async () => ({ status: 'reverted' }) }))).r.state, 'reverted');
  assert.equal((await run(plan(), fakeIo({ approve: async () => { throw new Error('timeout'); } }))).r.state, 'unknown');
  const sim = await run(plan(), fakeIo({ simulate: async () => ({ ok: false, error: 'Opens are paused. Selling still works.' }) }));
  assert.equal(sim.r.state, 'failed');
  assert.match(sim.r.reason, /Selling still works/);
  assert.equal((await run(plan(), fakeIo({ confirm: async () => false }))).r.state, 'rejected');
  assert.equal((await run(plan({ deadline: 1n }), fakeIo())).r.state, 'expired');
  let n = 0;
  assert.equal((await run(plan(), fakeIo({ account: async () => (n++ ? '0xB' : '0xA') }))).r.state, 'failed'); // account changed after review
  assert.equal((await run(plan(), fakeIo({ send: async () => { throw reject; } }))).r.state, 'rejected');
  assert.equal((await run(plan(), fakeIo({ wait: async () => { throw new Error('lost'); } }))).r.state, 'unknown');
  assert.equal((await run(plan(), fakeIo({ wait: async () => ({ status: 'replaced', replacedBy: '0xnew' }) }))).r.state, 'replaced');
  assert.equal((await run(plan(), fakeIo({ wait: async () => ({ status: 'dropped' }) }))).r.state, 'dropped');
  assert.equal((await run(plan(), fakeIo({ wait: async () => ({ status: 'reverted' }) }))).r.state, 'reverted');
});

test('a trade: one at a time', async () => {
  const lock = { busy: false };
  let release;
  const slow = fakeIo({ confirm: () => new Promise((r) => { release = r; }) });
  const first = runTrade(plan({ lock }), slow, () => {});
  await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(runTrade(plan({ lock }), fakeIo(), () => {}), /already in progress/);
  release(true);
  assert.equal((await first).state, 'reconciled');
  assert.equal(lock.busy, false);
});

const A = (n) => `0x${String(n).repeat(40).slice(0, 40)}`;
const good = () => ({
  version: 1, chainId: 31337, rpcUrl: 'http://127.0.0.1:8545', apiUrl: 'http://127.0.0.1:8550/', explorerUrl: '', deployBlock: '12',
  contracts: { Engine: A(1), OpenBook: A(2), WriterBook: A(3), PathFundingBook: A(4), MainspringPool: A(5), MarkRouter: A(6), SettlementToken: A(7) },
  settlement: { symbol: 'USDG', decimals: 6 }, markets: ['BTC', 'ETH'],
});

test('the manifest: checked whole; mainnet and other chains refused; http only on this computer', () => {
  const m = checkManifest(good());
  assert.equal(m.apiUrl, 'http://127.0.0.1:8550');
  assert.equal(m.deployBlock, 12n);
  assert.equal(walletChain({ ...m, chainId: 46630, networkName: 'Robinhood Chain testnet' }).chainId, '0xb626');
  const bad = (f, msg) => { const x = good(); f(x); assert.throws(() => checkManifest(x), (e) => e instanceof ConfigError && msg.test(e.message)); };
  bad((x) => { x.chainId = 4663; }, /not open for this site/);
  bad((x) => { x.chainId = 1; }, /not open for this site/);
  bad((x) => { x.version = 2; }, /version 2/);
  bad((x) => { x.rpcUrl = 'http://rpc.example.com'; }, /https RPC/);
  bad((x) => { delete x.contracts.WriterBook; }, /WriterBook/);
  bad((x) => { x.settlement.decimals = 18; }, /6 decimals/);
  bad((x) => { x.markets = []; }, /no market/);
  assert.throws(() => checkManifest(null), /missing/);
  assert.doesNotThrow(() => checkManifest({ ...good(), chainId: 46630, rpcUrl: 'https://rpc.testnet.example', apiUrl: 'https://api.example' }));
});

test('refusals by name: decoded from the contracts’ own errors; transport kept apart', () => {
  const stale = ERRORS.find((e) => e.name === 'Stale');
  const data = encodeErrorResult({ abi: [stale], errorName: 'Stale', args: stale.inputs.map((i) => (i.type.startsWith('uint') ? 1n : i.type === 'bytes32' ? `0x${'00'.repeat(32)}` : i.type === 'address' ? A(1) : 0n)) });
  const r = explain({ message: 'execution reverted', cause: { data } });
  assert.equal(r.kind, 'refused');
  assert.equal(r.name, 'Stale');
  assert.match(r.message, /Selling still works/);
  assert.equal(explain(new TypeError('Failed to fetch')).kind, 'transport');
  assert.equal(explain(new Error('something else')).kind, 'other');
});

const fakeFetch = (routes) => async (url) => {
  const path = new URL(url).pathname + new URL(url).search;
  const hit = Object.entries(routes).find(([p]) => path.startsWith(p));
  if (!hit) return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
  const [, v] = hit;
  if (v === 'down') throw new TypeError('Failed to fetch');
  return { ok: true, status: 200, json: async () => v };
};

test('the API client: amounts become base units; a failure is an error, never sample data', async () => {
  const api = apiClient('http://api', {
    fetch: fakeFetch({
      '/v1/status': { chainId: 31337, settlement: { token: A(7), symbol: 'USDG', decimals: 6 }, block: '9', blockTime: 100, opens: { buysPaused: false, drawdownPaused: false, depositsPaused: false }, pool: { nav: '5000000', navPerShare: '1', lastSettlement: 1, available: '4999990.5', stressedLiability: '1.25', covered: true }, markets: [], receipts: null },
      '/v1/markets': { markets: [{ market: 'BTC', kind: 'crypto', listed: true, spreadBps: 200, strikeStep: '100', mark: '74000', volBps: 4500, opensPaused: false, caps: { notional: '1000000', notionalUsed: '0', directional: '500000', directionalUsed: '0' } }] },
      '/v1/quote/buy': { market: 'BTC', quoted: true, cost: '123.456789', source: 'pool', makerQuotesConsidered: 0 },
      '/v1/positions/': { owner: A(1), positions: [{ id: '7', held: 'direct', market: 'BTC', legs: [], movement: [], raw: '10', units: '9', unitsDecimal: '0' }] },
    }),
  });
  const s = await api.status();
  assert.equal(s.source, 'live');
  assert.equal(s.pool.available, 4_999_990_500_000n);
  const [btc] = await api.markets(6);
  assert.equal(btc.markWad, 74000n * WAD);
  assert.equal(btc.caps.directional, 500_000_000_000n);
  const q = await api.quoteBuy({ market: 'BTC', legs: shapeLegs('Rise', '74000', ''), tempo: 86400, units: WAD }, 6);
  assert.deepEqual(q, { quoted: true, cost: 123_456_789n, source: 'pool', makerQuotes: 0 });
  assert.equal((await api.positions(A(1)))[0].id, 7n);

  const down = apiClient('http://api', { fetch: fakeFetch({ '/v1/status': 'down' }) });
  await assert.rejects(down.status(), (e) => e instanceof ApiError && e.kind === 'transport');
  const missing = apiClient('http://api', { fetch: fakeFetch({}) });
  await assert.rejects(missing.markets(6), (e) => e instanceof ApiError && e.kind === 'domain' && /not found/.test(e.message));
});
