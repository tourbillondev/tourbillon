import React,{useMemo,useState} from 'react';
import {ChartCandlestick,ChartNoAxesCombined,ChartColumnIncreasing,Activity} from 'lucide-react';
import {sampleCandles,sampleDepth} from './market-fixtures.mjs';
import {optionValue} from './pricing.mjs';
const number=(n,d=2)=>new Intl.NumberFormat('en-US',{maximumFractionDigits:d,minimumFractionDigits:d}).format(n);

export function TerminalChart({market,period,onPeriod}){
 const [cursor,setCursor]=useState(null),[style,setStyle]=useState('candles'),[volume,setVolume]=useState(true),[average,setAverage]=useState(false);
 const bars=useMemo(()=>sampleCandles(market,period),[market,period]);
 const low=Math.min(...bars.map(b=>b.low)),high=Math.max(...bars.map(b=>b.high)),padding=(high-low)*.12,min=low-padding,max=high+padding;
 const chartBottom=volume?332:440,y=p=>24+(max-p)/(max-min)*(chartBottom-24),x=i=>12+i/(bars.length-1)*776;
 const current=bars[cursor??bars.length-1],decimal=market.spot>10000?1:2,maxVolume=Math.max(...bars.map(b=>b.volume));
 const line=bars.map((b,i)=>`${i?'L':'M'}${x(i)},${y(b.close)}`).join(' '),ma=bars.map((b,i)=>{const arr=bars.slice(Math.max(0,i-7),i+1);return `${i?'L':'M'}${x(i)},${y(arr.reduce((s,v)=>s+v.close,0)/arr.length)}`}).join(' ');
 const move=e=>{const r=e.currentTarget.getBoundingClientRect();setCursor(Math.max(0,Math.min(bars.length-1,Math.round((e.clientX-r.left)/r.width*(bars.length-1)))))};
 return <div className="terminal-chart">
  <div className="terminal-toolbar"><div className="terminal-periods" aria-label="Chart interval">{[['1D','15m'],['1W','2h'],['1M','8h']].map(([key,label])=><button key={key} aria-pressed={period===key} onClick={()=>{onPeriod(key);setCursor(null)}}>{label}</button>)}</div><div className="terminal-chart-tools"><button aria-label="Candlestick chart" aria-pressed={style==='candles'} onClick={()=>setStyle('candles')}><ChartCandlestick size={16}/></button><button aria-label="Line chart" aria-pressed={style==='line'} onClick={()=>setStyle('line')}><ChartNoAxesCombined size={16}/></button><span/><button aria-label="Show moving average" aria-pressed={average} onClick={()=>setAverage(!average)}><Activity size={15}/><span>MA</span></button><button aria-label="Show sample volume" aria-pressed={volume} onClick={()=>setVolume(!volume)}><ChartColumnIncreasing size={15}/></button></div></div>
  <div className="terminal-ohlc"><span>{market.symbol}/USDG <small>· Sample</small></span><div>{[['O',current.open],['H',current.high],['L',current.low],['C',current.close]].map(([label,v])=><span key={label}>{label} <b className={current.close>=current.open?'up':'down'}>{number(v,decimal)}</b></span>)}</div></div>
  <div className="terminal-plot-wrap"><div className="terminal-plot" tabIndex="0" role="group" aria-label={`Sample ${market.symbol} chart. Use arrow keys to inspect candles.`} onPointerMove={move} onPointerLeave={()=>setCursor(null)} onKeyDown={e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();setCursor(i=>e.key==='Home'?0:e.key==='End'?bars.length-1:Math.max(0,Math.min(bars.length-1,(i??bars.length-1)+(e.key==='ArrowRight'?1:-1))))}} onBlur={()=>setCursor(null)}>
   <svg viewBox="0 0 800 470" preserveAspectRatio="none" role="img" aria-label={`Illustrative ${style} and ${volume?'volume':'price'} chart, not live market data`}>
    {[0,1,2,3,4].map(i=><line key={i} x1="0" x2="800" y1={24+i*(chartBottom-24)/4} y2={24+i*(chartBottom-24)/4} className="terminal-grid"/>)}{[0,1,2,3,4,5,6].map(i=><line key={i} x1={i*133.33} x2={i*133.33} y1="0" y2="470" className="terminal-grid"/>)}
    <line x1="0" x2="800" y1={y(market.spot)} y2={y(market.spot)} className="terminal-mark-line"/>
    {style==='candles'?bars.map((b,i)=><g key={i} className={b.close>=b.open?'candle-up':'candle-down'} opacity={cursor===null||cursor===i?1:.7}><line x1={x(i)} x2={x(i)} y1={y(b.high)} y2={y(b.low)} strokeWidth="1"/><rect x={x(i)-2.6} y={Math.min(y(b.open),y(b.close))} width="5.2" height={Math.max(1.1,Math.abs(y(b.open)-y(b.close)))} rx=".4"/></g>):<path d={line} fill="none" stroke="#819dff" strokeWidth="2.3"/>}
    {average&&<path d={ma} fill="none" stroke="#d5bc83" strokeWidth="1.6" opacity=".9"/>}
    {volume&&<><line x1="0" x2="800" y1="360" y2="360" className="terminal-grid"/>{bars.map((b,i)=><rect key={i} x={x(i)-2.6} y={453-b.volume/maxVolume*67} width="5.2" height={b.volume/maxVolume*67} fill={b.close>=b.open?'#6589ec':'#ab7594'} opacity=".65"/>)}</>}
    {cursor!==null&&<><line x1={x(cursor)} x2={x(cursor)} y1="0" y2="470" stroke="#bdcee6" strokeWidth="1" strokeDasharray="4 5"/><line x1="0" x2="800" y1={y(current.close)} y2={y(current.close)} stroke="#b5c8e6" strokeWidth="1" strokeDasharray="4 5"/><circle cx={x(cursor)} cy={y(current.close)} r="4" fill="#dbe7ff"/></>}
   </svg>
   {volume&&<span className="terminal-volume-label">Volume <b>{number(current.volume,market.symbol==='BTC'?2:0)}</b> {market.symbol}</span>}
  </div><div className="terminal-price-axis">{[0,1,2,3,4].map(i=><span key={i} style={{top:`${(24+i*(chartBottom-24)/4)/470*100}%`}}>{number(max-(max-min)*i/4,decimal)}</span>)}<b style={{top:`${y(market.spot)/470*100}%`}}>{number(market.spot,decimal)}</b></div></div>
  <div className="terminal-time-axis">{(period==='1D'?['00:00','04:00','08:00','12:00','16:00','20:00']:period==='1W'?['Mon','Tue','Wed','Thu','Fri','Sat']:['01','06','11','16','21','26']).map(t=><span key={t}>{t}</span>)}</div>
  <div className="terminal-chart-caption"><span>Illustrative OHLCV</span><span>{bars.length} sample candles · No live feed</span></div>
 </div>;
}

export function QuoteDepth({market,strike,days}){
 const depth=useMemo(()=>sampleDepth(market),[market]),rise=optionValue(market.spot,strike,market.sigma,days),fall=optionValue(market.spot,strike,market.sigma,days,'Fall'),maxTotal=Math.max(...depth.asks.map(r=>r.total),...depth.bids.map(r=>r.total));
 return <section className="tb-panel terminal-depth" aria-label="Illustrative quote sources and underlying market depth">
  <div className="tb-panel-heading"><h2>Quote sources</h2><span className="tb-tag">Sample</span></div>
  <div className="terminal-quote-head"><span>Source</span><span>Rise</span><span>Fall</span></div>
  <div className="terminal-source-rows">{[['Makers',1.012],['Writers',1.006],['Mainspring',1]].map(([name,m])=><div key={name}><span>{name}</span><b>{number(rise*m,3)}</b><b>{number(fall*m,3)}</b></div>)}</div>
  <p className="terminal-source-note">Model illustration · USDG / unit<br/>No executable quotes connected</p>
  <div className="terminal-depth-title"><strong>Underlying depth</strong><span>Sample</span></div>
  <div className="terminal-book-head"><span>Price <small>USDG</small></span><span>Size <small>{market.symbol}</small></span><span>Total <small>{market.symbol}</small></span></div>
  {['asks','bids'].map(side=><React.Fragment key={side}>{side==='bids'&&<div className="terminal-mid"><strong>{number(market.spot,market.spot>10000?1:2)}</strong><span>Sample mark</span></div>}<div className={`terminal-book-rows ${side}`}>{depth[side].map((r,i)=><div key={i} style={{'--depth':`${r.total/maxTotal*100}%`}}><b>{number(r.price,market.spot>10000?1:2)}</b><span>{number(r.size,market.symbol==='SPY'?0:2)}</span><span>{number(r.total,market.symbol==='SPY'?0:2)}</span></div>)}</div></React.Fragment>)}
  <div className="terminal-book-footer"><span>Bid</span><div><i/></div><span>Ask</span></div>
 </section>;
}
