import React,{useEffect,useRef,useState} from 'react';
import {Expand,Pause,Play,X} from 'lucide-react';
import {MotionSurface} from './Atelier.jsx';
import {ProductGlyph} from './Interactions.jsx';
import './product-interface.css';
const scenes={direction:{file:'rise-fall',label:'Rise / Fall',note:'Trace the market and its payoff'},movement:{file:'movement',label:'Movement',note:'Four tempos. One composition.'},write:{file:'write',label:'Write',note:'Bounded obligation. Exact collateral.'}};
function Traces({type}){return <svg className="interface-traces" viewBox="0 0 1000 750" aria-hidden="true">{type==='direction'?<><path className="interface-trace trace-price" pathLength="100" d="M90 292 100 355 135 338 170 363 205 401 240 449 280 396 320 397 355 446 390 407 425 413 450 394 470 402"/><path className="interface-trace trace-payoff" pathLength="100" d="M789 399H853L943 326"/><line className="interface-cursor" x1="100" x2="100" y1="240" y2="490"/><circle className="interface-point" cx="943" cy="326" r="5"/></>:type==='movement'?<>{[0,1,2,3].map((n)=><g key={n} style={{'--sequence':n}}><path className="interface-trace tempo-trace" pathLength="100" d={`M329 ${215+n*103}C345 ${265+n*103} 425 ${263+n*101} 883 ${263+n*101}`}/><rect className="interface-highlight tempo-highlight" x="910" y={224+n*103} width="40" height="50" rx="8"/></g>)}</>:<><path className="interface-trace collateral-trace" pathLength="100" d="M275 412H365L501 296H631"/><rect className="interface-highlight collateral-highlight" x="663" y="222" width="267" height="255" rx="12"/><circle className="interface-point" cx="631" cy="296" r="5"/></>}</svg>}
export default function ProductInterface({type}){
 const data=scenes[type],dialog=useRef(null),[playing,setPlaying]=useState('auto'),[open,setOpen]=useState(false);
 useEffect(()=>{setPlaying('auto')},[type]);
 useEffect(()=>{if(open)dialog.current.showModal();else dialog.current?.close()},[open]);
 return <MotionSurface className={`product-interface interface-${type}`} data-playing={playing}>
  <div className="interface-toolbar"><span><ProductGlyph kind={type}/>{data.label}</span><div><button type="button" onClick={()=>setPlaying(playing===true?false:true)} aria-pressed={playing===true} aria-label={`${playing===true?'Pause':'Play'} ${data.label} illustration`}>{playing===true?<Pause/>:<Play/>}</button><button type="button" onClick={()=>setOpen(true)} aria-label={`Enlarge ${data.label} interface`}><Expand/></button></div></div>
  <button type="button" className="interface-image-button" onClick={()=>setOpen(true)} aria-label={`Enlarge ${data.label} dashboard illustration`}><img src={`/assets/product-scenes/${data.file}.webp`} width="2336" height="1744" loading="lazy" alt={`${data.label} illustrative dashboard with sample data`}/><Traces type={type}/><span className="interface-enlarge"><Expand size={12}/> Explore the detail</span></button>
  <div className="interface-caption"><span>{data.note}</span><small>ILLUSTRATIVE INTERFACE · SAMPLE DATA</small></div>
  <dialog ref={dialog} className="interface-dialog" onCancel={()=>setOpen(false)} onClick={e=>{if(e.target===e.currentTarget)setOpen(false)}} aria-label={`${data.label} interface detail`}><button className="interface-close" onClick={()=>setOpen(false)} aria-label="Close interface detail"><X/></button><img src={`/assets/product-scenes/${data.file}.webp`} width="2336" height="1744" alt={`${data.label} illustrative dashboard, enlarged`}/><p>{data.label} · Illustrative interface · Sample data</p></dialog>
 </MotionSurface>;
}


