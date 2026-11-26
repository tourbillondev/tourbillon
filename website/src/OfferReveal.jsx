import React,{useEffect,useRef} from 'react';
import './offer-reveal.css';

// Source: Overview introduction and Any tempo. Planned status remains explicit.
const statement='We’re building no-expiry options on tokenized stocks and crypto, on Robinhood Chain. Choose a shape and a tempo from 1 hour to 30 days.';
export default function OfferReveal(){
 const ref=useRef(null);
 useEffect(()=>{const el=ref.current;const mq=matchMedia('(prefers-reduced-motion:reduce)');if(mq.matches){el.dataset.revealed='true';return}el.dataset.ready='true';const ob=new IntersectionObserver(([entry])=>{if(entry.isIntersecting){el.dataset.revealed='true';ob.disconnect()}},{threshold:.3});ob.observe(el);return()=>ob.disconnect()},[]);
 return <section ref={ref} className="section offer-intro" aria-labelledby="offer-intro-title"><span className="eyebrow">TOURBILLON</span><h2 id="offer-intro-title" aria-label={statement}>{statement.split(' ').map((word,i)=><React.Fragment key={i}><span aria-hidden="true" className="offer-word" style={{'--word':i}}>{word}</span>{' '}</React.Fragment>)}</h2></section>;
}
