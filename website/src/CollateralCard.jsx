import React,{useEffect,useRef,useState} from 'react';
import {ArrowLeft,ArrowRight,LockKeyhole,Rotate3D} from 'lucide-react';
import './collateral-card.css';

export default function CollateralCard({body}){
 const [flipped,setFlipped]=useState(false),[page,setPage]=useState(0),front=useRef(null),back=useRef(null),changed=useRef(false);
 useEffect(()=>{if(!changed.current)return;(flipped?back:front).current?.focus({preventScroll:true})},[flipped]);
 const flip=value=>{changed.current=true;setFlipped(value)};
 return <article className="collateral-card" data-flipped={flipped} onKeyDown={e=>{if(e.key==='Escape'&&flipped){e.preventDefault();flip(false)}}} aria-label="Collateral explained">
  <div className="collateral-rotor">
   <div className="collateral-face collateral-front" inert={flipped?true:undefined} aria-hidden={flipped?true:undefined}>
    <LockKeyhole size={27} strokeWidth={1.2}/><h3><small>05</small>Collateral</h3><p>{body}</p>
    <div className="collateral-equation" aria-label="Example: 10 USDG maximum payout per unit times 10 units equals 100 USDG collateral"><span><b>10</b><small>USDG / unit</small></span><i>×</i><span><b>10</b><small>Units</small></span><i>=</i><span className="collateral-result"><b>100</b><small>USDG locked</small><span className="collateral-cover"/></span></div>
    <button ref={front} className="collateral-flip-button" onClick={()=>flip(true)} aria-expanded={flipped} aria-controls="collateral-explanation">See how it works <Rotate3D size={14}/></button>
   </div>
   <div className="collateral-face collateral-back" id="collateral-explanation" inert={!flipped?true:undefined} aria-hidden={!flipped?true:undefined}>
    <div className="collateral-back-header"><span>05 / COLLATERAL</span><button ref={back} onClick={()=>flip(false)} aria-label="Return to collateral overview"><ArrowLeft size={13}/> Back</button></div>
    <div className="collateral-reading" key={page}>
     {page===0?<><h4>Set aside what you could owe.</h4><p>Collateral is the USDG set aside to cover an option you write. The planned contract locks its largest possible payout.</p><div className="collateral-example"><span>A 100 / 110 Rise Spread</span><strong>10 USDG × 10 units = 100 USDG</strong><p>Each unit can pay at most 10 USDG. Writing ten units locks 100 USDG. Fees and funding are separate.</p></div></>:<><h4>What can you lose?</h4><p>A writer can lose the collateral they commit. Exact collateral covers the specified payoff; contract, accounting and asset risks still matter.</p><h5>Why an uncovered Rise is refused</h5><p>Its payout keeps growing as the market rises. With no upper limit, there is no finite amount of cash that covers every outcome.</p><small className="collateral-demo-note">Illustrative design. This preview does not lock funds or submit a write.</small></>}
    </div>
    <div className="collateral-pages"><span>{page+1} / 2</span><button onClick={()=>setPage(page===0?1:0)}>{page===0?'The risks':'The example'} <ArrowRight size={13}/></button></div>
   </div>
  </div>
 </article>
}
