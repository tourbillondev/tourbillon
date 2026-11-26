import {useEffect,useRef} from 'react';

// Local reflected light, never a tilt of controls or text.
export function useGlassResponse(){
 const ref=useRef(null);
 useEffect(()=>{const root=ref.current;if(!root)return;const motion=matchMedia('(prefers-reduced-motion: reduce)'),pointer=matchMedia('(hover:hover) and (pointer:fine)');let frame=0,current=null;
  const clear=()=>{cancelAnimationFrame(frame);if(current)delete current.dataset.glassActive;current=null};
  const move=e=>{if(motion.matches||!pointer.matches||document.hidden)return;const panel=e.target.closest('.tb-market-card,.tb-panel');if(panel!==current){clear();current=panel}if(!panel)return;const x=e.clientX,y=e.clientY;cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{const r=panel.getBoundingClientRect();panel.style.setProperty('--glass-x',`${x-r.left}px`);panel.style.setProperty('--glass-y',`${y-r.top}px`);panel.dataset.glassActive='true'})};
  root.addEventListener('pointermove',move);root.addEventListener('pointerleave',clear);motion.addEventListener('change',clear);document.addEventListener('visibilitychange',clear);
  return()=>{clear();root.removeEventListener('pointermove',move);root.removeEventListener('pointerleave',clear);motion.removeEventListener('change',clear);document.removeEventListener('visibilitychange',clear)};
 },[]);return ref;
}
