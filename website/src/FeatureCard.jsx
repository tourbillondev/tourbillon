import React,{useEffect,useRef,useState} from 'react';
import {ArrowLeft,ArrowUpRight,Rotate3D} from 'lucide-react';
import {MotionSurface} from './Atelier.jsx';
import FeaturePhoto from './FeaturePhoto.jsx';
import Mark from './Mark.jsx';
import {featureGuides} from './feature-guides.mjs';
import './feature-flip.css';

export default function FeatureCard({title,body,type}){
 const guide=featureGuides[type], [flipped,setFlipped]=useState(false),[tab,setTab]=useState(0);
 const frontButton=useRef(null),backButton=useRef(null),tabButtons=useRef([]),panel=useRef(null),previous=useRef(false);
 useEffect(()=>{if(previous.current===flipped)return;previous.current=flipped;(flipped?backButton:frontButton).current?.focus({preventScroll:true})},[flipped]);
 useEffect(()=>{if(panel.current)panel.current.scrollTop=0},[tab]);
 const changeTab=i=>{setTab(i);tabButtons.current[i]?.focus({preventScroll:true})};
 const keyboardTabs=e=>{const keys={ArrowRight:(tab+1)%guide.tabs.length,ArrowLeft:(tab+guide.tabs.length-1)%guide.tabs.length,Home:0,End:guide.tabs.length-1};if(e.key in keys){e.preventDefault();changeTab(keys[e.key])}};
 return <MotionSurface as="article" className="feature-card feature-flip" data-flipped={flipped} aria-label={title} onKeyDown={e=>{if(e.key==='Escape'&&flipped){e.preventDefault();setFlipped(false)}}}>
  <div className="feature-flip-rotor">
   <div className="feature-face feature-front" inert={flipped?true:undefined} aria-hidden={flipped?true:undefined} onClick={e=>{if(!e.target.closest('button,a'))setFlipped(true)}}>
    <FeaturePhoto type={type} active={!flipped} onFlip={()=>setFlipped(true)}/>
    <div className="feature-front-copy"><div className="feature-front-heading"><h3>{title}</h3><span>{guide.number}</span></div><p>{body}</p><button ref={frontButton} className="feature-flip-trigger" onClick={()=>setFlipped(true)} aria-expanded={flipped} aria-controls={`feature-guide-${type}`} aria-label={`Explore ${title} in depth`}><span>Explore in depth</span><Rotate3D size={17}/></button></div>
   </div>
   <section className="feature-face feature-back" id={`feature-guide-${type}`} inert={!flipped?true:undefined} aria-hidden={!flipped?true:undefined} aria-label={`${title} detailed guide`}>
    <header className="feature-back-head"><div className="feature-guide-brand"><Mark/><span>TOURBILLON <i>/ {guide.number}</i></span><button ref={backButton} onClick={()=>setFlipped(false)} aria-label={`Return to ${title} artwork`}><ArrowLeft size={15}/><span>Back</span></button></div><div className="feature-back-title"><div><span>{guide.eyebrow}</span><h3>{title}</h3></div><div className="feature-guide-metric"><b>{guide.metric[0]}</b><small>{guide.metric[1]}</small></div></div></header>
    <div className="feature-guide-tabs" role="tablist" aria-label={`${title} topics`} onKeyDown={keyboardTabs}>{guide.tabs.map((section,i)=><button key={section.label} ref={el=>{tabButtons.current[i]=el}} role="tab" id={`guide-${type}-tab-${i}`} aria-selected={tab===i} aria-controls={`guide-${type}-panel`} tabIndex={tab===i?0:-1} onClick={()=>setTab(i)}><span>{String(i+1).padStart(2,'0')}</span>{section.label}</button>)}</div>
    <div ref={panel} className="feature-guide-scroll" id={`guide-${type}-panel`} role="tabpanel" tabIndex={0} aria-labelledby={`guide-${type}-tab-${tab}`}>
     <div key={tab} className="feature-guide-chapter">{guide.tabs[tab].blocks.map((block,i)=><div className="feature-guide-block" key={block.heading}><span className="feature-guide-step" aria-hidden="true">{String(i+1).padStart(2,'0')}</span><div><h4>{block.heading}</h4><p>{block.text}</p></div></div>)}<span className="feature-guide-end">End of {guide.tabs[tab].label.toLowerCase()}</span></div>
    </div>
    <footer className="feature-guide-footer"><span><i/> Product design · Demo only</span><a href="#/docs/mechanics">Product guide <ArrowUpRight size={13}/></a></footer>
   </section>
  </div>
 </MotionSurface>;
}
