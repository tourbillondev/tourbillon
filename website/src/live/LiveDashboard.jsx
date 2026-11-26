import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Clock3, Info, Layers3, Loader2, X } from 'lucide-react';
import { displayUnits, fromWad, shapeLegs, singleTempo, movementParts, tempoSeconds, toWad } from './codec.mjs';
import { runTrade, ENDINGS } from './tx.mjs';
import './live.css';

// The live pieces of the dashboard, drawn with the dashboard's own classes so the design stays as it is. Each one
// shows live data or says plainly that it has none; none of them falls back to the sample fixtures.

const STEP_LABEL = {
  idle: 'Ready', preparing: 'Checking your wallet, network and balance', 'needs-network': 'Switch network in your wallet',
  'needs-approval': 'Approval needed', approving: 'Approve in your wallet', 'ready-for-review': 'Review the exact amounts',
  'awaiting-wallet': 'Confirm in your wallet', submitted: 'Sent', confirming: 'Waiting for the block', confirmed: 'Confirmed on chain',
  reconciled: 'Done: the chain and the read models agree', rejected: 'Declined', expired: 'Expired', reverted: 'Reverted',
  replaced: 'Replaced in your wallet', dropped: 'Dropped', unknown: 'Outcome not known yet', failed: 'Not sent',
};

const amount = (v, s) => (v == null ? '-' : `${displayUnits(v, s.decimals, 2)} ${s.symbol}`);
const units = (v) => Number(fromWad(v)).toLocaleString('en-US', { maximumFractionDigits: 6 });
const shapeName = (legs) => {
  if (!Array.isArray(legs) || !legs.length) return 'Position';
  if (legs.length === 1) return legs[0].isCall ? 'Rise' : 'Fall';
  if (legs.length === 2 && legs[0].isCall !== legs[1].isCall) return 'Swing';
  if (legs.length === 2) return 'Spread';
  if (legs.length === 4) return 'Band';
  return `${legs.length}-leg shape`;
};
const tempoText = (mv) => {
  if (!Array.isArray(mv) || !mv.length) return '-';
  if (mv.length > 1) return `${mv.length}-tempo`;
  const s = Number(mv[0].tempo);
  return s < 86400 ? `${Math.round(s / 3600)}h` : `${Number((s / 86400).toFixed(1))}d`;
};

/// The connected wallet's positions (from the API's indexer) and writes (from the WriterBook's own events), with the
/// exact sale value of each position now.
export function useLivePositions(live, address) {
  const [state, setState] = useState({ rows: [], writes: [], loading: false, error: null });
  const reload = useCallback(async () => {
    if (live.mode !== 'live' || live.phase !== 'ready' || !address) {
      setState({ rows: [], writes: [], loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    try {
      const [rows, writes] = await Promise.all([live.api.positions(address), live.chain.writesOf(address)]);
      const valued = await Promise.all(rows.map(async (r) => ({ ...r, sale: r.held === 'direct' ? await live.chain.saleValue(address, r.id) : null })));
      setState({ rows: valued, writes, loading: false, error: null });
    } catch (e) {
      setState({ rows: [], writes: [], loading: false, error: e.message });
    }
  }, [live.mode, live.phase, live.api, live.chain, address]);
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload };
}

/// Waits until the API's positions show `test` true for the user (the indexer follows the chain a block or two later).
export async function untilPositions(live, address, test, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const rows = await live.api.positions(address).catch(() => null);
    if (rows && test(rows)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export function LivePositionTable({ live, wallet, positions, onSell, onConnect }) {
  const s = live.manifest.settlement;
  const count = positions.rows.length + positions.writes.length;
  return <div className="tb-panel tb-position-panel"><div className="tb-panel-heading"><h2>Your positions <span className="tb-count">{count}</span></h2><span className="tb-tag">Live</span></div>
    {!wallet.address ? <div className="tb-empty"><Layers3 size={28}/><h3>Connect a wallet</h3><p>Your positions on {live.manifest.networkName} appear here.</p><button className="tb-primary" onClick={onConnect}>Connect wallet <ArrowUpRight size={15}/></button></div>
    : positions.error ? <div className="tb-empty"><Info size={28}/><h3>Positions are unavailable</h3><p>{positions.error}</p><button className="tb-primary" onClick={positions.reload}>Try again</button></div>
    : count ? <div className="tb-table-wrap"><table><thead><tr><th>Position</th><th>Strikes</th><th>Tempo</th><th>Units</th><th>Sale value now</th><th></th></tr></thead><tbody>
      {positions.rows.map((p) => <tr key={`p${p.id}`}><td><div className="tb-position-name"><span>{p.market} <b>{shapeName(p.legs)}</b><small>No expiry · #{String(p.id).slice(-6)}</small></span></div></td><td>{(p.legs ?? []).map((l) => l.k).join(' / ')}</td><td><Clock3 size={12}/> {tempoText(p.movement)}</td><td>{units(p.units)}</td><td>{p.held === 'direct' ? amount(p.sale, s) : 'Agent account'}</td><td>{p.held === 'direct' && <button className="tb-mini-button" disabled={p.sale == null} onClick={() => onSell(p)}>Sell <ArrowUpRight size={12}/></button>}</td></tr>)}
      {positions.writes.map((w) => <tr key={`w${w.writeId}`}><td><div className="tb-position-name"><span>Write <b>#{String(w.writeId)}</b><small>Collateral locked</small></span></div></td><td>-</td><td>-</td><td>{units(w.units)}</td><td>{amount(w.locked, s)} locked</td><td/></tr>)}
    </tbody></table></div>
    : <div className="tb-empty"><Layers3 size={28}/><h3>No open positions</h3><p>Open a position from the order ticket.</p></div>}
    <div className="tb-table-note"><Info size={13}/> Sale values are the exact amount a sale would pay now, before your wallet confirms it. Read from {live.manifest.networkName}.</div></div>;
}

/// The chart panel in live mode: the API serves no price history yet, so the panel shows the mark it has and when.
export function LiveChart({ live, market }) {
  const m = market.live;
  return <div className="tb-empty"><Clock3 size={28}/><h3>{m.markWad == null ? 'No fresh mark' : `Mark ${Number(fromWad(m.markWad)).toLocaleString('en-US', { maximumFractionDigits: 4 })}`}</h3>
    <p>{m.markWad == null ? 'No fresh, cross-checked mark for this market: opens are closed; selling still works.' : `As of block ${live.status?.block ?? '-'}. Price history is not served by the API yet, so no chart is drawn.`}</p></div>;
}

/// Live market facts in the summary strip's place.
export function LiveSummary({ live, market }) {
  const m = market.live;
  const s = live.manifest.settlement;
  return <div className="terminal-overview" aria-label="Live market overview"><div><b className="terminal-overview-label">{m.market} / {s.symbol}</b><span>{m.kind === 'stock' ? 'Tokenized stock' : 'Crypto'}</span></div>
    <div><span>Mark</span><b>{m.markWad == null ? '-' : Number(fromWad(m.markWad)).toLocaleString('en-US', { maximumFractionDigits: 4 })}</b></div>
    <div><span>Board vol</span><b>{m.volBps == null ? '-' : `${(m.volBps / 100).toFixed(1)}%`}</b></div>
    <div><span>Strike step</span><b>{fromWad(m.strikeStepWad)}</b></div>
    <div><span>Notional cap used</span><b>{amount(m.caps.notionalUsed, s)} / {amount(m.caps.notional, s)}</b></div>
    <div><span>Opens</span><b>{m.opensPaused || live.status?.opens?.buysPaused ? 'Paused' : m.markWad == null ? 'Closed' : 'Open'}</b></div>
    <div><span>Mark source</span><b className="terminal-overview-status">Signer quorum</b></div></div>;
}

/// The exact cost of one unit of a Rise and a Fall at the ticket's strike and tempo, from the API (the cheapest
/// source now), in the quote-sources panel's place. No depth is shown: the live feed has none.
export function LiveQuotes({ live, market, strike, days }) {
  const s = live.manifest.settlement;
  const [q, setQ] = useState({ rise: null, fall: null, error: null });
  useEffect(() => {
    let stop = false;
    const id = setTimeout(async () => {
      try {
        const tempo = tempoSeconds(days);
        const ask = (shape) => live.api.quoteBuy({ market: market.symbol, legs: shapeLegs(shape, String(strike), ''), tempo, units: 10n ** 18n }, s.decimals);
        const [rise, fall] = await Promise.all([ask('Rise'), ask('Fall')]);
        if (!stop) setQ({ rise, fall, error: null });
      } catch (e) {
        if (!stop) setQ({ rise: null, fall: null, error: e.message });
      }
    }, 400);
    return () => { stop = true; clearTimeout(id); };
  }, [live.api, market.symbol, strike, days, s.decimals, live.at]);
  const cell = (r) => (!r ? '…' : r.quoted ? displayUnits(r.cost, s.decimals, 3) : 'none');
  return <section className="tb-panel terminal-depth" aria-label="Live executable quotes">
    <div className="tb-panel-heading"><h2>Quote sources</h2><span className="tb-tag">Live</span></div>
    <div className="terminal-quote-head"><span>Best now</span><span>Rise</span><span>Fall</span></div>
    <div className="terminal-source-rows"><div><span>{q.rise?.quoted ? q.rise.source : 'Cheapest'}</span><b>{cell(q.rise)}</b><b>{cell(q.fall)}</b></div></div>
    <p className="terminal-source-note">{q.error ? q.error : `Exact cost of one unit now, fee included · ${s.symbol}`}<br/>{q.rise && !q.rise.quoted ? q.rise.reason : 'The cheapest of the pool, maker quotes and written offers'}</p>
  </section>;
}

/// Runs live trades through the transaction machine and draws the review and progress in the dashboard's dialog.
export function useLiveTrade(onDone) {
  const [trade, setTrade] = useState(null);
  const lock = useRef({ busy: false });
  const start = useCallback(async (title, build) => {
    if (lock.current.busy) return;
    setTrade({ title, state: 'preparing' });
    let built;
    try {
      built = build((review) => new Promise((resolve) => setTrade((t) => ({ ...t, review, resolve }))));
    } catch (e) {
      setTrade({ title, state: 'failed', reason: e.message, done: true });
      return;
    }
    const r = await runTrade({ ...built.plan, lock: lock.current }, built.io, (state, info) => setTrade((t) => ({ ...t, state, hash: info.hash ?? t?.hash, resolve: state === 'ready-for-review' ? t?.resolve : null })));
    setTrade((t) => ({ ...t, state: r.state, reason: r.reason, result: r.result, hash: r.hash ?? t?.hash, done: true, resolve: null }));
    onDone?.(r);
  }, [onDone]);
  return { trade, start, close: () => { if (!trade || ENDINGS.has(trade.state) || trade.state === 'ready-for-review') { trade?.resolve?.(false); setTrade(null); } } };
}

export function LiveTradeDialog({ live, trade, onClose }) {
  const dialog = useRef(null);
  useEffect(() => {
    const d = dialog.current;
    if (trade && !d.open) d.showModal();
    else if (!trade && d.open) d.close();
  }, [trade]);
  const s = live.manifest?.settlement;
  const r = trade?.review;
  const busy = trade && !trade.done && trade.state !== 'ready-for-review';
  const explorer = live.manifest?.explorerUrl && trade?.hash ? `${live.manifest.explorerUrl.replace(/\/$/, '')}/tx/${trade.hash}` : null;
  return <dialog ref={dialog} className="tb-dialog" onCancel={(e) => { e.preventDefault(); onClose(); }}>{trade && <>
    <button className="tb-modal-close" aria-label="Close dialog" disabled={busy} onClick={onClose}><X size={20}/></button>
    <span className="tb-tag">LIVE TRANSACTION · {live.manifest.networkName.toUpperCase()}</span><h2>{trade.title}</h2>
    <p role="status">{busy && <Loader2 size={14} className="tb-spin"/>} {STEP_LABEL[trade.state] ?? trade.state}</p>
    {r && <div className="tb-modal-lines">
      {r.action === 'buy' && <><div><span>Exact cost now</span><b>{amount(r.cost, s)}</b></div><div><span>Most you can pay</span><b>{amount(r.maxCost, s)}</b></div><div><span>Filled by</span><b>{r.source}</b></div></>}
      {r.action === 'sell' && <><div><span>Exact proceeds now</span><b>{amount(r.net, s)}</b></div><div><span>Least you accept</span><b>{amount(r.minOut, s)}</b></div></>}
      {r.action === 'write' && <><div><span>Collateral locked</span><b>{amount(r.collateral, s)}</b></div><div><span>Credit now</span><b>{amount(r.credit, s)}</b></div><div><span>Least credit you accept</span><b>{amount(r.minCredit, s)}</b></div></>}
      <div><span>Valid until</span><b>{new Date(Number(r.deadline) * 1000).toLocaleTimeString()}</b></div>
    </div>}
    {trade.reason && <p className="tb-modal-note" role="alert">{trade.reason}</p>}
    {trade.state === 'reconciled' && trade.result && <p className="tb-modal-note">{trade.result.id != null && trade.result.cost != null ? `Position #${String(trade.result.id).slice(-6)} opened for ${amount(trade.result.cost, s)}.` : trade.result.net != null ? `Sold for ${amount(trade.result.net, s)}.` : trade.result.writeId != null ? `Write #${String(trade.result.writeId)} opened with ${amount(trade.result.locked, s)} locked.` : ''}</p>}
    {explorer && <a className="tb-sidebar-link" href={explorer} target="_blank" rel="noreferrer">View the transaction <ArrowUpRight size={13}/></a>}
    {trade.state === 'ready-for-review' && trade.resolve ? <><button className="tb-primary tb-full" onClick={() => trade.resolve(true)}>Confirm in wallet <Check size={16}/></button><button className="tb-text-button" onClick={() => trade.resolve(false)}>Cancel</button></>
      : trade.done && <button className="tb-primary tb-full" onClick={onClose}>Close</button>}
    <p className="tb-modal-note">You can never lose more than you paid for a buy. A write can lose its locked collateral. Nothing is sent until you confirm it in your wallet.</p>
  </>}</dialog>;
}

/// Builds the live trade for the ticket's config: a buy through OpenBook or a cash write through WriterBook.
export function ticketTrade({ live, wallet, market, mode, config, limit }) {
  const legsBuyer = shapeLegs(config.shape, String(config.strike), String(config.width ?? ''), 'buy');
  const movement = config.movement ? movementParts(config.movement.map((m) => ({ days: m.days, percent: Math.round(m.weight * 100) }))) : singleTempo(config.days);
  const unitsWad = toWad(String(config.size), 'size');
  return (confirm) => {
    const base = { provider: wallet.provider, account: wallet.address, market: market.symbol, movement, units: unitsWad, confirm };
    if (mode === 'buy') return live.chain.buy({ ...base, legs: legsBuyer, limit, positionsAgree: (id) => untilPositions(live, wallet.address, (rows) => rows.some((r) => r.id === id)) });
    return live.chain.write({ ...base, buyerLegs: legsBuyer, writerLegs: shapeLegs(config.shape, String(config.strike), String(config.width ?? ''), 'write') });
  };
}
