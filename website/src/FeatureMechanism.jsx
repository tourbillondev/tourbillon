import React,{useEffect,useId,useRef} from 'react';
import marketTraces from './feature-traces.json';

const shapePaths=['M239 728H425L650 540','M852 568L1022 746L1200 566','M1391 727H1510L1685 559H1815'];
const collateral='M270 800H490L853 502H1124';
const smooth=x=>x*x*(3-2*x);

// Vector layers register to the original 2048x1360 artwork. The PNG is untouched.
export default function FeatureMechanism({type,running}){
 const ref=useRef(null),elapsed=useRef(0),uid=useId().replaceAll(':','');
 useEffect(()=>{const svg=ref.current;if(!svg||!running)return;let frame=0,last=0;
  const find=n=>svg.querySelector(`[data-part="${n}"]`);
  const paths=[...svg.querySelectorAll('[data-flow]')],travel=[...svg.querySelectorAll('[data-travel]')].map(dot=>{const path=find(dot.dataset.travel);return{dot,path,length:path.getTotalLength()}});
  const draw=now=>{if(last)elapsed.current+=Math.min(now-last,50);last=now;const t=(elapsed.current%8400)/8400;
   if(type==='tempo'){
    const anchors=[.5,0,.9,.5],part=Math.min(2,Math.floor(t*3)),blend=smooth(Math.max(0,Math.min(1,(t*3-part-.18)/.64))),p=anchors[part]+(anchors[part+1]-anchors[part])*blend;
    const days=p<.5?Math.exp(Math.log(1/24)+(p/.5)*Math.log(7*24)):7*Math.exp(((p-.5)/.4)*Math.log(30/7));
    const value=days<1?Math.max(1,Math.round(days*24)):Math.min(30,Math.round(days)),unit=days<1?'hour':'day',label=`${value} ${unit}${value===1?'':'s'}`;
    find('tempo-label').textContent=label;find('thumb').setAttribute('cx',String(215+1615*p));find('fill').setAttribute('x2',String(215+1615*p));
    const decay=1.8+(1-p)*7,pts=Array.from({length:65},(_,i)=>{const x=i/64;return `${i?'L':'M'}${284+x*1564},${1110-256*Math.exp(-x*decay)}`}).join(' ');
    find('curve').setAttribute('d',pts);find('curve-area').setAttribute('d',pts+'L1848 1110H284Z');
    const progress=(t*2)%1;find('decay-dot').setAttribute('cx',String(284+progress*1564));find('decay-dot').setAttribute('cy',String(1110-256*Math.exp(-progress*decay)));
    for(const el of svg.querySelectorAll('[data-preset]')){const x=Number(el.dataset.preset);el.setAttribute('fill',Math.abs(x-p)<.015?'#4664f7':'#223144')}
   }else{
    paths.forEach((p,i)=>{const phase=(t*1.6-i*.16+2)%1;p.style.strokeDashoffset=String(100-phase*128);p.style.opacity=String(Math.sin(Math.PI*phase)*.9+.1)});
    for(const {dot,path,length} of travel){const p=path.getPointAtLength(length*((t*1.6+Number(dot.dataset.offset||0))%1));dot.setAttribute('cx',p.x);dot.setAttribute('cy',p.y)}
    const cursor=find('scan');if(cursor)cursor.setAttribute('transform',`translate(${Math.round(t*1180)} 0)`);
    if(type==='write'){find('coverage-ring').setAttribute('stroke-dashoffset',String(100-100*smooth(Math.min(1,t*2))));}
   }
   frame=requestAnimationFrame(draw);
  };frame=requestAnimationFrame(draw);return()=>cancelAnimationFrame(frame);
 },[type,running]);
 const trace=(d,key)=> <g key={key}><path data-part={key} d={d} fill="none" stroke="#5d85ff" strokeWidth="6" opacity=".65"/><path data-flow d={d} pathLength="100" fill="none" stroke="#d1e3ff" strokeWidth="5" strokeLinecap="round" strokeDasharray="23 105"/><circle data-travel={key} data-offset={key==='rise'?.1:0} r="8" fill="#d8e9ff" className="feature-motion-dot"/></g>;
 return <svg ref={ref} className="feature-mechanism" viewBox="0 0 2048 1360" aria-hidden="true" focusable="false">
  <defs><linearGradient id={`${uid}-panel`} x2="1" y2="1"><stop stopColor="#202e3f"/><stop offset="1" stopColor="#172536"/></linearGradient><linearGradient id={`${uid}-area`} x2="0" y2="1"><stop stopColor="#4664f7" stopOpacity=".35"/><stop offset="1" stopColor="#4664f7" stopOpacity=".01"/></linearGradient></defs>
  {type==='tempo'?<>
   <rect x="143" y="278" width="1766" height="451" rx="26" fill={`url(#${uid}-panel)`} stroke="#7c96bf45" strokeWidth="2"/>
   <text data-part="tempo-label" x="1024" y="392" textAnchor="middle" fill="#f4f7ff" fontSize="76" fontWeight="400">7 days</text>
   <line x1="215" x2="1830" y1="463" y2="463" stroke="#6e8bc780" strokeWidth="27" strokeLinecap="round"/>
   <line data-part="fill" x1="215" x2="1020" y1="463" y2="463" stroke="#4e72ff" strokeWidth="27" strokeLinecap="round"/>
   <circle data-part="thumb" cx="1020" cy="463" r="26" fill="#537bff" stroke="#f2f8ff" strokeWidth="6" className="feature-motion-dot"/>
   {Array.from({length:12},(_,i)=><line key={i} x1={212+i*147.4} x2={212+i*147.4} y1="504" y2="525" stroke="#abc1e4" strokeWidth="3"/>)}
   <text x="200" y="565" fill="#aebfe0" fontSize="32">1 hour</text><text x="1845" y="565" fill="#aebfe0" fontSize="32" textAnchor="end">30 days</text>
   {['1h','1d','7d','30d'].map((label,i)=><g key={label}><rect data-preset={[0,.25,.5,.9][i]} x={176+i*430} y="602" width="407" height="96" rx="23" fill={i===2?'#4664f7':'#223144'} stroke="#9ab5e345" strokeWidth="2"/><text x={379+i*430} y="663" textAnchor="middle" fill="#f3f7ff" fontSize="37">{label}</text></g>)}
   <rect x="279" y="839" width="1574" height="275" fill="#192738"/>
   {[0,1,2,3,4].map(i=><line key={i} x1="284" x2="1848" y1={842+i*67} y2={842+i*67} stroke="#45608380" strokeDasharray="8 7"/>)}
   {Array.from({length:10},(_,i)=><line key={i} x1={284+i*173.8} x2={284+i*173.8} y1="842" y2="1110" stroke="#45608366" strokeDasharray="8 7"/>)}
   <path data-part="curve-area" fill={`url(#${uid}-area)`}/><path data-part="curve" fill="none" stroke="#5c82ff" strokeWidth="6"/><circle data-part="decay-dot" r="9" fill="#c4dbff" className="feature-motion-dot"/>
  </>:type==='shape'?<>{shapePaths.map((d,i)=>trace(d,['rise','swing','guard'][i]))}</>:type==='write'?<>{trace(collateral,'obligation')}<rect x="1195" y="378" width="685" height="2" fill="#b7cfff" opacity=".4"/><rect x="1654" y="758" width="231" height="80" rx="40" stroke="#b9d0ff" fill="none" strokeWidth="3" pathLength="100" strokeDasharray="100" data-part="coverage-ring"/></>:<>
   {['market','btc','eth','spy'].map(key=>trace(marketTraces[key],key))}
   <g data-part="scan"><line x1="657" x2="657" y1="291" y2="587" stroke="#cbdcff" opacity=".35" strokeWidth="2" strokeDasharray="7 8"/></g>
  </>}
 </svg>;
}
