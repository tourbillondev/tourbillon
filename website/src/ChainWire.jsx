import React,{useId} from 'react';

// Exact feather geometry from Robinhood Chain's documentation asset.
// The wire treatment is decorative; the official wordmark is displayed unchanged.
export default function ChainWire(){
 const clip=useId().replace(/:/g,'')+'-feather';
 const shape='M0.237711 42H1.14916C1.31483 42 1.48056 41.9157 1.53587 41.7753C8.41284 23.9672 15.8974 15.1474 20.5926 9.86673C20.786 9.64201 20.7031 9.47355 20.4269 9.47355H12.0309C11.727 9.47355 11.4702 9.59707 11.2576 9.86673L5.23667 17.4507C4.3529 18.5742 4.13199 19.6134 4.13199 21.1021V28.8546C2.17104 34.4442 0.92819 38.2362 0.0168015 41.663C-0.038442 41.882 0.0444232 42 0.237711 42ZM30.5353 1.13119C29.2372 -0.273195 23.3821 -0.329391 20.6754 0.738011C20.1121 0.959852 19.5707 1.33622 19.3221 1.5525C16.8364 3.71537 15.1794 5.4288 13.6051 7.11409C13.4117 7.31068 13.4947 7.50727 13.7709 7.50727H23.0783C23.9345 7.50727 24.4316 8.01291 24.4316 8.88359V19.5573C24.4316 19.8382 24.6525 19.9225 24.8183 19.6696L30.4248 12.2261C31.3362 11.0183 31.6124 10.6532 31.8609 8.96792C32.1924 6.49613 31.999 2.70423 30.5353 1.13119ZM18.5212 29.4445L22.3601 23.0121C22.4431 22.8437 22.4706 22.647 22.4706 22.5066V11.7767C22.4706 11.4958 22.2773 11.3836 22.0841 11.6082C16.3118 18.1529 11.8099 25.0346 7.6395 33.3207C7.53455 33.5285 7.66712 33.7139 7.91572 33.6297L16.5327 30.9332C17.5048 30.6298 18.0517 30.231 18.5212 29.4445Z';
 return <svg className="tb-chain-wire" viewBox="-29 -6 90 54" fill="none" aria-hidden="true" focusable="false">
  <defs><clipPath id={clip}><path d={shape}/></clipPath></defs>
  <path className="chain-wire-base" d={shape}/>
  <g clipPath={`url(#${clip})`} className="chain-wire-mesh">
   {Array.from({length:12},(_,i)=><path key={'h'+i} d={`M-4 ${i*4}H36`}/>)}
   {Array.from({length:12},(_,i)=><path key={'d'+i} d={`M${i*4-25} -4l32 52`}/>)}
  </g>
  <path className="chain-wire-trace" d={shape} pathLength="100"/>
  <g className="chain-hud"><path d="M-23 6V0h7M48 0h7v6M-23 34v7h7M48 41h7v-7"/><path d="M-24 18h11m-11 4h6M45 18h11m-6 4h6"/><circle cx="-13" cy="18" r=".7"/><circle cx="45" cy="18" r=".7"/></g>
 </svg>;
}
