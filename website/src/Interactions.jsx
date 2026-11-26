import React,{useEffect,useRef,useState} from 'react';
import './interactions.css';

// Decorative feedback never delays the native control or its actual value.
export function ElasticRange({value,onChange,label,valueText,id}){
 const ref=useRef(null),previous=useRef(value),timer=useRef(0),kick=useRef(()=>{}),dragging=useRef(false);
 const [active,setActive]=useState(false);
 useEffect(()=>{const el=ref.current;if(!el)return;const mq=matchMedia('(prefers-reduced-motion: reduce)');let frame=0,last=0,bend=0,squash=0,vb=0,vs=0,visible=true;
  const paint=()=>{el.style.setProperty('--spring-bend',bend.toFixed(3));el.style.setProperty('--spring-stretch',squash.toFixed(4))};
  const stop=()=>{cancelAnimationFrame(frame);frame=0;last=0;bend=0;squash=0;vb=0;vs=0;paint()};
  const step=time=>{if(mq.matches||document.hidden||!visible){stop();return}const dt=last?Math.min((time-last)/1000,1/30):1/60;last=time;vb+=(-260*bend-22*vb)*dt;vs+=(-300*squash-24*vs)*dt;bend+=vb*dt;squash+=vs*dt;paint();if(Math.abs(bend)+Math.abs(vb)+Math.abs(squash)*30+Math.abs(vs)<.025){stop();return}frame=requestAnimationFrame(step)};
  kick.current=delta=>{if(!delta||mq.matches||document.hidden||!visible)return;bend=Math.max(-13,Math.min(13,bend+delta*.9));squash=Math.min(.24,squash+Math.abs(delta)*.012);vb+=Math.sign(delta)*8;if(!frame){last=0;frame=requestAnimationFrame(step)}};
  const sync=()=>{if(mq.matches||document.hidden)stop()};
  const ob=new IntersectionObserver(([e])=>{visible=e.isIntersecting;if(!visible)stop()});ob.observe(el);mq.addEventListener('change',sync);document.addEventListener('visibilitychange',sync);
  return()=>{stop();clearTimeout(timer.current);ob.disconnect();mq.removeEventListener('change',sync);document.removeEventListener('visibilitychange',sync);kick.current=()=>{}};
 },[]);
 useEffect(()=>{kick.current(value-previous.current);previous.current=value},[value]);
 const wake=()=>{clearTimeout(timer.current);setActive(true)};
 const settle=()=>{clearTimeout(timer.current);if(!dragging.current)timer.current=setTimeout(()=>setActive(false),700)};
 return <div ref={ref} className="elastic-range" data-active={active} style={{'--range':`${value}%`}}><div className="elastic-rail" aria-hidden="true"><i/><span className="elastic-ticks">{Array.from({length:16},(_,i)=><b key={i}/>)}</span><span className="elastic-thumb"><span className="elastic-value">{valueText}</span><span className="elastic-handle"><b/></span></span></div><input id={id} type="range" min="0" max="100" step="1" value={value} onChange={e=>{wake();onChange(Number(e.target.value));settle()}} onPointerDown={e=>{dragging.current=true;e.currentTarget.setPointerCapture(e.pointerId);wake()}} onPointerUp={()=>{dragging.current=false;settle()}} onPointerCancel={()=>{dragging.current=false;settle()}} onFocus={wake} onBlur={()=>{dragging.current=false;clearTimeout(timer.current);setActive(false)}} aria-label={label} aria-valuetext={valueText}/></div>;
}

export function ProductGlyph({kind='direction'}){
 const ref=useRef(null);useEffect(()=>{const ob=new IntersectionObserver(([e])=>{if(ref.current)ref.current.dataset.inView=String(e.isIntersecting)});ob.observe(ref.current);return()=>ob.disconnect()},[]);
 return <svg ref={ref} className={`product-glyph glyph-${kind.toLowerCase()}`} viewBox="0 0 44 44" fill="none" aria-hidden="true"><path className="glyph-grid" d="M6 33H38M11 8V37"/><g className="glyph-motion">{kind==='movement'?<><path className="glyph-trace" pathLength="100" d="M6 31H13L20 23H27L38 10"/><path className="glyph-echo" d="M6 37H17L24 29H31L38 21"/><circle cx="20" cy="23" r="2.4"/></>:kind==='write'?<><path className="glyph-frame" d="M11 18 22 12 33 18V31L22 37 11 31Z"/><path className="glyph-trace" pathLength="100" d="M17 15V11a5 5 0 0 1 10 0v4M17 25l4 4 7-8"/></>:kind==='Swing'?<path className="glyph-trace" pathLength="100" d="M6 12 22 32 38 12"/>:kind==='Spread'?<path className="glyph-trace" pathLength="100" d="M6 32H15L29 12H38"/>:kind==='Fall'?<path className="glyph-trace" pathLength="100" d="M6 12 26 32H38M6 12v8M6 12h8"/>:<><path className="glyph-trace" pathLength="100" d="M6 32H17L36 12M28 12h8v8"/>{kind==='direction'&&<path className="glyph-echo" d="M7 11 18 22"/>}</>}</g></svg>;
}

export function useHeroResponse(paused){
 const ref=useRef(null);
 useEffect(()=>{const el=ref.current;if(!el)return;const mq=matchMedia('(prefers-reduced-motion: reduce)'),fine=matchMedia('(hover:hover) and (pointer:fine)');let raf=0,visible=true;
  const reset=()=>{el.style.setProperty('--hero-x','0px');el.style.setProperty('--hero-y','0px');el.style.setProperty('--light-x','50%');el.style.setProperty('--light-y','65%')};
  const move=e=>{if(paused||mq.matches||!fine.matches||!visible||document.hidden)return;cancelAnimationFrame(raf);const x=e.clientX,y=e.clientY;raf=requestAnimationFrame(()=>{const r=el.getBoundingClientRect();el.style.setProperty('--hero-x',`${((x-r.left)/r.width-.5)*24}px`);el.style.setProperty('--hero-y',`${((y-r.top)/r.height-.5)*16}px`);el.style.setProperty('--light-x',`${(x-r.left)/r.width*100}%`);el.style.setProperty('--light-y',`${(y-r.top)/r.height*100}%`)})};
  const ob=new IntersectionObserver(([e])=>{visible=e.isIntersecting;if(!visible)reset()});ob.observe(el);el.addEventListener('pointermove',move);el.addEventListener('pointerleave',reset);mq.addEventListener('change',reset);if(paused)reset();return()=>{cancelAnimationFrame(raf);ob.disconnect();el.removeEventListener('pointermove',move);el.removeEventListener('pointerleave',reset);mq.removeEventListener('change',reset)};
 },[paused]);return ref;
}

export function TactileFeedback(){
 useEffect(()=>{const mq=matchMedia('(prefers-reduced-motion: reduce)');const click=e=>{const el=e.target.closest('.pill,.round-button,.tb-primary,.tb-secondary,.tb-mini-button');if(!el||el.disabled||mq.matches)return;const r=el.getBoundingClientRect();el.style.setProperty('--press-x',`${e.clientX-r.left}px`);el.style.setProperty('--press-y',`${e.clientY-r.top}px`);el.getAnimations().filter(a=>a.id==='press-feedback').forEach(a=>a.cancel());const a=el.animate([{boxShadow:'0 0 0 0 #91a7ff55'},{boxShadow:'0 0 0 9px #91a7ff00'}],{duration:450,easing:'cubic-bezier(.16,1,.3,1)'});a.id='press-feedback'};document.addEventListener('pointerdown',click);return()=>document.removeEventListener('pointerdown',click)},[]);return null;
}
