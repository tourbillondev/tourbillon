import React, {useRef, useState} from 'react';
import {ArrowRight, ArrowUpRight, LockKeyhole} from 'lucide-react';
import {rolloutWaves} from './rollout-data.mjs';
import './roadmap.css';

export default function Roadmap() {
  const [selected, setSelected] = useState(0);
  const tabs = useRef([]);
  const wave = rolloutWaves[selected];
  function navigate(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rolloutWaves.length - 1
      : (selected + (event.key === 'ArrowRight' ? 1 : rolloutWaves.length - 1)) % rolloutWaves.length;
    setSelected(next);
    tabs.current[next]?.focus({preventScroll: true});
  }
  return <section className="section roadmap rollout" id="roadmap" aria-labelledby="rollout-title">
    <div className="rollout-heading">
      <div><span className="eyebrow">THE ROLLOUT</span><h2 id="rollout-title">Each wave has a gate.<br/>The gates set the pace.</h2></div>
      <div className="rollout-context"><span className="rollout-status"><i aria-hidden="true"/>FIVE PLANNED WAVES</span><p>Start with the core markets. Add shapes, strengthen the infrastructure, then open the book and expand.</p><small>No fixed dates. Each release depends on the checks below.</small></div>
    </div>
    <div className="rollout-tabs" role="tablist" aria-label="Rollout waves" onKeyDown={navigate}>
      {rolloutWaves.map((item, index) => <button key={item.id} ref={el => {tabs.current[index] = el;}} type="button" role="tab" id={`rollout-tab-${index}`} aria-controls="rollout-panel" aria-selected={selected === index} tabIndex={selected === index ? 0 : -1} onClick={() => setSelected(index)}>
        <span className="rollout-step"><b>{item.id}</b><span>PLANNED</span><ArrowUpRight size={16} aria-hidden="true"/></span>
        <strong>{item.name}</strong><small>{item.short}</small>
      </button>)}
    </div>
    <div id="rollout-panel" role="tabpanel" aria-labelledby={`rollout-tab-${selected}`} tabIndex={0} className="rollout-panel">
      <div key={wave.id} className="rollout-panel-content">
        <div className="rollout-scope">
          <div className="rollout-wave-label"><span>{wave.id}</span><span>WHAT THIS WAVE ADDS</span></div>
          <h3>{wave.title}</h3><p className="rollout-intro">{wave.intro}</p>
          <dl>{wave.scope.map(([title, body]) => <div key={title}><dt>{title}</dt><dd>{body}</dd></div>)}</dl>
        </div>
        <aside className="rollout-gates" aria-label={`${wave.id} release requirements`}>
          <div className="rollout-gate-label"><LockKeyhole size={17} aria-hidden="true"/><span>BEFORE THIS SHIPS</span></div>
          <h4>The release gate</h4><p className="rollout-gate-caption">Required evidence, not a completion report.</p>
          <ol>{wave.gates.map(([title, body], index) => <li key={title}><span className="rollout-check-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><div><h5>{title}</h5><p>{body}</p></div></li>)}</ol>
          <div className="rollout-gate-foot"><span aria-hidden="true"/>Planned · release status unconfirmed</div>
        </aside>
        <div className="rollout-outcome"><div><span>FOR THE USER</span><p>{wave.outcome}</p></div><a href={`#/docs/${wave.link}`}>{wave.linkText}<ArrowUpRight size={16} aria-hidden="true"/></a></div>
      </div>
    </div>
    <div className="rollout-footer"><p>This is the planned product sequence. The current website is an interactive preview; live contracts, liquidity and release gates are not yet verified.</p>{selected < rolloutWaves.length - 1 && <button type="button" onClick={() => {setSelected(selected + 1);tabs.current[selected + 1]?.focus();}}>Explore {rolloutWaves[selected + 1].id}<ArrowRight size={17} aria-hidden="true"/></button>}</div>
  </section>;
}
