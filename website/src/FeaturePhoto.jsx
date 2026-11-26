import React,{useEffect,useRef,useState} from 'react';
import {Expand,X,Play,Pause,Rotate3D} from 'lucide-react';
import FeatureMechanism from './FeatureMechanism.jsx';
import './feature-photo.css';

const scenes={tempo:{file:'tempo',title:'Any tempo',alt:'Seven-day tempo with a one-hour to thirty-day slider and an illustrative unit-decay curve'},shape:{file:'shape',title:'Any shape',alt:'Rise, Swing and planned Guard payoff diagrams'},write:{file:'collateral',title:'Anyone can write',alt:'A bounded payoff with 100 USDG maximum obligation, 100 USDG locked and 100 percent coverage'},market:{file:'market',title:'24/7',alt:'Around-the-clock Robinhood Chain markets with BTC, ETH and SPY sample charts'}};

export default function FeaturePhoto({type,active=true,onFlip}){
 const data=scenes[type],dialog=useRef(null),root=useRef(null),[open,setOpen]=useState(false),[hover,setHover]=useState(false),[focus,setFocus]=useState(false),[mode,setMode]=useState('auto'),[visible,setVisible]=useState(false),[allowed,setAllowed]=useState(true);
 useEffect(()=>{const el=root.current,card=el.closest('.feature-card'),mq=matchMedia('(prefers-reduced-motion:reduce)');const enter=()=>{if(matchMedia('(hover:hover) and (pointer:fine)').matches)setHover(true)},leave=()=>setHover(false),sync=()=>setAllowed(!document.hidden&&!mq.matches);const ob=new IntersectionObserver(([entry])=>setVisible(entry.isIntersecting));ob.observe(el);card.addEventListener('pointerenter',enter);card.addEventListener('pointerleave',leave);mq.addEventListener('change',sync);document.addEventListener('visibilitychange',sync);sync();return()=>{ob.disconnect();card.removeEventListener('pointerenter',enter);card.removeEventListener('pointerleave',leave);mq.removeEventListener('change',sync);document.removeEventListener('visibilitychange',sync)}},[]);
 const requested=mode==='play'||(mode==='auto'&&(hover||focus)),running=requested&&visible&&allowed&&!open&&active;
 useEffect(()=>{if(open)dialog.current.showModal();else dialog.current?.close()},[open]);
 return <div ref={root} className={`feature-photo photo-${type}`} data-running={running} data-mode={mode} onFocus={()=>setFocus(true)} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))setFocus(false)}}>
  <button type="button" className="feature-photo-open" onClick={()=>onFlip?onFlip():setOpen(true)} aria-label={onFlip?`Flip ${data.title} to detailed guide`:`Enlarge ${data.title} interface`}>
   <img src={`/assets/feature-scenes/${data.file}.webp`} width="2048" height="1360" loading="lazy" alt={`${data.alt}. Illustrative interface, sample data.`}/>
   <FeatureMechanism type={type} running={running}/>
   <span className="feature-photo-light" aria-hidden="true"/>
   <svg className="feature-photo-frame" viewBox="0 0 600 399" fill="none" aria-hidden="true"><path pathLength="100" d="M45 32H30V47M555 32H570V47M30 352V367H45M570 352V367H555"/></svg>
   <span className="feature-photo-expand">{onFlip?<Rotate3D size={13}/>:<Expand size={13}/>}<span>{onFlip?'Explore guide':'View detail'}</span></span>
  </button>
  {onFlip&&<button className="feature-photo-enlarge" type="button" onClick={()=>setOpen(true)} aria-label={`Enlarge ${data.title} interface`}><Expand size={13}/></button>}
  <button type="button" className="feature-motion-toggle" onClick={()=>setMode(running?'paused':'play')} aria-label={`${running?'Pause':'Play'} ${data.title} animation`} aria-pressed={requested}>{running?<Pause size={13}/>:<Play size={13}/>}</button>
  <dialog ref={dialog} className="interface-dialog feature-photo-dialog" aria-label={`${data.title} interface detail`} onCancel={()=>setOpen(false)} onClick={e=>{if(e.target===e.currentTarget)setOpen(false)}}>
   <button type="button" className="interface-close" onClick={()=>setOpen(false)} aria-label="Close feature detail"><X/></button>
   <img src={`/assets/feature-scenes/${data.file}.webp`} width="2048" height="1360" alt={data.alt}/><p>{data.title} · Illustrative interface · Sample data</p>
  </dialog>
 </div>;
}
