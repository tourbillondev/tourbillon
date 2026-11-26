import React,{useLayoutEffect,useRef,useState,useId} from 'react';
import './page-atmosphere.css';

// One continuous vector field, anchored to real section geometry rather than
// fixed percentages. Transitions span most of each neighbouring section so the
// boundary never reads as a seam or a bright band.
const sections=[['.site-header','#1c180d'],['.hero','#15151a'],['.stats','#1c180d'],['.features','#f8faff'],['.products','#f6f7fc'],['.shapes','#f8f9fc'],['.mechanics','#fafbff'],['.offer-intro','#f7f9ff'],['.case-study','#1c180d'],['.roadmap','#f5f7fc'],['.faq','#fafbff'],['.final-cta','#1c180d'],['.site-footer','#171820']];
const rgb=hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));
const lum=hex=>{const [r,g,b]=rgb(hex);return (r*.299+g*.587+b*.114)/255};
const mix=(a,b,t)=>`rgb(${rgb(a).map((v,i)=>Math.round(v+(rgb(b)[i]-v)*t)).join(',')})`;
// Gentle easing, flatter in the middle so no visible midpoint band.
const ease=t=>t*t*t*(t*(t*6-15)+10);
// Straight RGB-linear blends between a cool near-white and a dark warm pass
// through a dead grey. We route polarity swaps through warm neutrals instead,
// so the eye reads a slow warming into the dark rather than a grey seam.
// Blue bridge for polarity swaps: routes dark<->light transitions through
// deepening blues rather than a dead grey, so the eye reads a slow cool shift
// instead of a seam. Same palette in both directions (reversed for dark->light).
const blueBridge=['#cfd9ef','#8ea4d6','#4c6bb0','#1b2a55'];
const blendPolarity=(from,to,t)=>{const dark=lum(from)<lum(to),bridge=dark?[...blueBridge].reverse():blueBridge;
 // Build a polyline from->bridge[0..3]->to and sample along its parameter.
 const path=[from,...bridge,to];const segs=path.length-1;const u=Math.min(.9999,t)*segs;const i=Math.floor(u);const f=u-i;return mix(path[i],path[i+1],f)};

export default function PageAtmosphere(){
 const ref=useRef(null),id=useId().replace(/:/g,'');
 const [field,setField]=useState(null);
 useLayoutEffect(()=>{
  const root=ref.current.parentElement;let frame=0,disposed=false;
  const measure=()=>{frame=0;if(disposed)return;const origin=root.getBoundingClientRect().top;
   const rows=sections.map(([selector,color])=>{const el=root.querySelector(selector);if(!el)return null;const box=el.getBoundingClientRect();return{key:selector,color,y:box.top-origin,height:box.height}}).filter(Boolean);
   const height=root.getBoundingClientRect().height;const boundaries=[];const leaks=[];
   // 1) Collect each boundary's requested span and decorative leak.
   rows.slice(1).forEach((row,i)=>{const previous=rows[i],boundary=row.y;
    const polaritySwap=Math.abs(lum(previous.color)-lum(row.color))>.35;
    const goingDark=polaritySwap&&lum(row.color)<lum(previous.color);
    const wantBefore=polaritySwap?Math.min(previous.height*(goingDark?.65:.9),goingDark?900:1300):Math.min(previous.height*.6,720);
    const wantAfter=polaritySwap?Math.min(row.height*(goingDark?.9:.3),goingDark?1300:420):Math.min(row.height*.55,760);
    boundaries.push({previous,row,boundary,polaritySwap,goingDark,wantBefore,wantAfter,i});
    const dark=i<2||i===7||i===10||i===11;
    const base=dark?.18:.09;
    const opacity=polaritySwap?base*.25:base;
    leaks.push({y:boundary,x:i%2?1250:100,rx:dark?1150:1050,ry:dark?380:560,opacity});
   });
   // 2) Clip overlapping spans proportionally so consecutive transitions
   // never share Y pixels. Overlap was the cause of a hard visible seam:
   // SVG clamps out-of-order gradient stops to a step.
   boundaries.forEach((b,k)=>{const prevBoundary=k===0?0:boundaries[k-1].boundary;const nextBoundary=k===boundaries.length-1?height:boundaries[k+1].boundary;
    const gapAbove=b.boundary-prevBoundary;const prevAfter=k===0?0:boundaries[k-1].wantAfter;const totalAbove=b.wantBefore+prevAfter;
    const before=totalAbove<=gapAbove?b.wantBefore:gapAbove*(b.wantBefore/Math.max(totalAbove,.001));
    const gapBelow=nextBoundary-b.boundary;const nextBefore=k===boundaries.length-1?0:boundaries[k+1].wantBefore;const totalBelow=b.wantAfter+nextBefore;
    const after=totalBelow<=gapBelow?b.wantAfter:gapBelow*(b.wantAfter/Math.max(totalBelow,.001));
    b.before=Math.max(before,1);b.after=Math.max(after,1);
   });
   const points=[{y:0,color:rows[0].color}];
   boundaries.forEach(b=>{const {previous,row,boundary,polaritySwap,before,after}=b;
    const stops=polaritySwap?[0,.04,.08,.14,.2,.28,.36,.44,.52,.6,.68,.76,.84,.9,.96,1]:[0,.14,.32,.5,.68,.86,1];
    stops.forEach(t=>{const e=ease(t);const color=polaritySwap?blendPolarity(previous.color,row.color,e):mix(previous.color,row.color,e);points.push({y:boundary-before+(before+after)*t,color})});
   });points.push({y:height,color:rows.at(-1).color});
   // 3) Belt-and-braces: strictly monotonic Y for SVG stops.
   points.sort((a,b)=>a.y-b.y);for(let k=1;k<points.length;k++)if(points[k].y<=points[k-1].y)points[k].y=points[k-1].y+.01;
   const hero=rows[1];
   setField({height,points,leaks,heroY:hero.y+hero.height*.76});
  };
  const schedule=()=>{if(!disposed&&!frame)frame=requestAnimationFrame(measure)};
  const observer=new ResizeObserver(schedule);observer.observe(root);sections.forEach(([s])=>{const el=root.querySelector(s);if(el)observer.observe(el)});
  document.fonts.ready.then(schedule);measure();
  return()=>{disposed=true;observer.disconnect();cancelAnimationFrame(frame)};
 },[]);
 return <div ref={ref} className="page-atmosphere" aria-hidden="true">{field&&<svg viewBox={`0 0 1440 ${field.height}`} preserveAspectRatio="none" focusable="false" data-sections={sections.length}>
  <defs>
   <linearGradient id={`${id}-base`} x1="0" x2="0" y1="0" y2="1">{field.points.map((point,i)=><stop key={i} offset={point.y/field.height} stopColor={point.color}/>)}</linearGradient>
   {[['blue','#4664f7'],['lavender','#9d94ea'],['ice','#8bb8df']].map(([name,color])=><radialGradient id={`${id}-${name}`} key={name}><stop stopColor={color}/><stop offset=".3" stopColor={color} stopOpacity=".6"/><stop offset=".7" stopColor={color} stopOpacity=".15"/><stop offset="1" stopColor={color} stopOpacity="0"/></radialGradient>)}
  </defs>
  <rect width="1440" height={field.height} fill={`url(#${id}-base)`}/>
  <ellipse cx="480" cy={field.heroY} rx="900" ry="520" fill={`url(#${id}-blue)`} opacity=".42"/>
  <ellipse cx="1250" cy={field.heroY+110} rx="760" ry="500" fill={`url(#${id}-ice)`} opacity=".2"/>
  {field.leaks.map((leak,i)=><g key={i} data-flow-boundary={sections[i+1][0]}><ellipse cx={leak.x} cy={leak.y} rx={leak.rx} ry={leak.ry} fill={`url(#${id}-blue)`} opacity={leak.opacity}/><ellipse cx={1440-leak.x} cy={leak.y+90} rx="900" ry={leak.ry*1.2} fill={`url(#${id}-${i%2?'ice':'lavender'})`} opacity={leak.opacity*.6}/></g>)}
 </svg>}</div>;
}
