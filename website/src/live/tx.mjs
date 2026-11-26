// The transaction lifecycle of docs 03 (website integration contract), as a checked state machine: every step the
// user sees is a named state, every move between states is listed, and success is announced only after the chain
// shows the intended events and the read models agree (reconciled), never on submission alone.

export const STATES = [
  'idle', 'preparing', 'needs-network', 'needs-approval', 'approving', 'ready-for-review', 'awaiting-wallet',
  'submitted', 'confirming', 'confirmed', 'reconciled',
  // endings other than success
  'rejected', 'expired', 'reverted', 'replaced', 'dropped', 'unknown', 'failed',
];
export const ENDINGS = new Set(['reconciled', 'rejected', 'expired', 'reverted', 'replaced', 'dropped', 'unknown', 'failed']);

const MOVES = {
  idle: ['preparing'],
  preparing: ['needs-network', 'needs-approval', 'ready-for-review', 'failed'],
  'needs-network': ['preparing', 'rejected', 'failed'],
  'needs-approval': ['approving', 'rejected', 'failed'],
  approving: ['preparing', 'rejected', 'reverted', 'unknown', 'failed'],
  'ready-for-review': ['awaiting-wallet', 'rejected', 'expired', 'preparing', 'failed'],
  'awaiting-wallet': ['submitted', 'rejected', 'failed'],
  submitted: ['confirming', 'replaced', 'dropped', 'unknown', 'reverted'],
  confirming: ['confirmed', 'reverted', 'replaced', 'dropped', 'unknown'],
  confirmed: ['reconciled', 'unknown'],
};

export class TxError extends Error {
  constructor(state, message, detail) {
    super(message);
    this.name = 'TxError';
    this.state = state;
    this.detail = detail;
  }
}

/// A tracker: `go(state, info)` refuses a move the machine does not list; `history` keeps every step.
export function tracker(onChange = () => {}) {
  let state = 'idle';
  const history = [{ state, at: Date.now() }];
  return {
    get state() { return state; },
    history,
    go(next, info = {}) {
      if (!(MOVES[state] ?? []).includes(next)) throw new Error(`transaction: ${state} cannot move to ${next}`);
      state = next;
      history.push({ state, at: Date.now(), ...info });
      onChange(state, info);
      return state;
    },
  };
}

/// Wallet error codes (EIP-1193): the user declined.
export const isRejection = (e) => [4001, 'ACTION_REJECTED'].includes(e?.code ?? e?.cause?.code) || /user (rejected|denied)/i.test(String(e?.message ?? ''));

/// Runs one trade through the machine. `plan` holds what is fixed before the wallet is asked; `io` does the I/O:
///   io.chainId()                       the wallet's chain now
///   io.account()                       the wallet's account now
///   io.switchNetwork()                 asks the wallet to switch (resolves when switched)
///   io.allowance()                     the settlement allowance for the spender
///   io.approve(amount)                 sends the approval, resolves with its receipt
///   io.simulate()                      the exact call at the current block: { ok, result, review } or { ok: false, error }
///   io.confirm(review)                 shows the review; resolves true (confirmed) or false (cancelled)
///   io.send()                          asks the wallet to send the exact call; resolves with the hash
///   io.wait(hash)                      the receipt: { status, replacedBy? } (throws when the outcome is unknown)
///   io.reconcile(receipt)              true once the events and read models show the result
/// The returned promise settles in an ending state; `lock` prevents a second submission while one runs.
export async function runTrade(plan, io, onChange) {
  if (plan.lock?.busy) throw new Error('a transaction is already in progress');
  if (plan.lock) plan.lock.busy = true;
  const t = tracker(onChange);
  const end = (state, info) => { t.go(state, info); return { state, history: t.history, ...info }; };
  try {
    t.go('preparing');
    const account = await io.account();
    if (!account) return end('failed', { reason: 'Connect a wallet first.' });
    if ((await io.chainId()) !== plan.chainId) {
      t.go('needs-network');
      try {
        await io.switchNetwork();
      } catch (e) {
        return end(isRejection(e) ? 'rejected' : 'failed', { reason: isRejection(e) ? 'The network switch was declined.' : `Switch to ${plan.networkName} in your wallet.` });
      }
      t.go('preparing');
      if ((await io.chainId()) !== plan.chainId) return end('failed', { reason: `Your wallet is not on ${plan.networkName}.` });
    }
    if (plan.approval && plan.approval.amount > 0n) {
      const have = await io.allowance();
      if (have < plan.approval.amount) {
        t.go('needs-approval', { spender: plan.approval.spender, amount: plan.approval.amount });
        t.go('approving');
        try {
          const rc = await io.approve(plan.approval.amount);
          if (rc.status !== 'success') return end('reverted', { reason: 'The approval reverted.' });
        } catch (e) {
          if (isRejection(e)) return end('rejected', { reason: 'The approval was declined.' });
          return end('unknown', { reason: 'The approval outcome is unknown: check your wallet before trying again.' });
        }
        t.go('preparing');
      }
    }
    const sim = await io.simulate();
    if (!sim.ok) return end('failed', { reason: sim.error });
    t.go('ready-for-review', { review: sim.review });
    const ok = await io.confirm(sim.review);
    if (!ok) return end('rejected', { reason: 'Cancelled before sending.' });
    if ((await io.account()) !== account) return end('failed', { reason: 'The wallet account changed: review again.' });
    if ((await io.chainId()) !== plan.chainId) return end('failed', { reason: 'The wallet network changed: review again.' });
    if (plan.deadline && BigInt(Math.floor(Date.now() / 1000)) > plan.deadline) return end('expired', { reason: 'The review expired: review again.' });
    t.go('awaiting-wallet');
    let hash;
    try {
      hash = await io.send();
    } catch (e) {
      if (isRejection(e)) return end('rejected', { reason: 'Declined in your wallet.' });
      return end('failed', { reason: io.explain?.(e) ?? 'The wallet could not send the transaction.' });
    }
    t.go('submitted', { hash });
    t.go('confirming', { hash });
    let rc;
    try {
      rc = await io.wait(hash);
    } catch {
      return end('unknown', { hash, reason: 'The outcome is unknown: check the transaction before trying again.' });
    }
    if (rc.replacedBy) return end('replaced', { hash, replacedBy: rc.replacedBy, reason: 'The transaction was replaced in your wallet.' });
    if (rc.status === 'dropped') return end('dropped', { hash, reason: 'The transaction was dropped and not mined.' });
    if (rc.status !== 'success') return end('reverted', { hash, reason: io.explain?.(rc) ?? 'The transaction reverted.' });
    t.go('confirmed', { hash, receipt: rc });
    const done = await io.reconcile(rc).catch(() => false);
    if (!done) return end('unknown', { hash, reason: 'Mined, but the result is not visible yet: refresh before trying again.' });
    return end('reconciled', { hash, receipt: rc, result: done });
  } finally {
    if (plan.lock) plan.lock.busy = false;
  }
}
