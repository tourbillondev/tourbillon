// Deterministic display fixtures. Never use these for orders, risk or oracle inputs.
export function sampleCandles(market,period='1D'){
 const count=period==='1W'?84:period==='1M'?90:96;
 const start=market.spot/(1+market.change/100);
 const raw=Array.from({length:count},(_,i)=>{const t=i/(count-1),envelope=Math.sin(Math.PI*t);return start+(market.spot-start)*t+market.spot*envelope*(.024*Math.sin(t*10)+.007*Math.sin(i*1.7)+.009*Math.cos(i*.54))});
 return raw.map((close,i)=>{const open=i?raw[i-1]:start,wick=market.spot*(.0008+.002*Math.abs(Math.sin(i*2.1)));return {open,close,high:Math.max(open,close)+wick,low:Math.min(open,close)-wick,volume:(market.symbol==='BTC'?.08:market.symbol==='ETH'?2.4:165)*(1+Math.abs(Math.sin(i*.72))*3+Math.abs(close-open)/market.spot*220)}});
}
export function sampleDepth(market){
 const tick=market.spot>10000?5:market.spot>100?1:.01,scale=market.symbol==='BTC'?.01:market.symbol==='ETH'?.3:24;
 const make=side=>{let total=0;return Array.from({length:7},(_,i)=>{const size=scale*(4+(i*7+3)%19);total+=size;return{price:market.spot+side*(i+1)*tick,size,total}})};
 return {asks:make(1).reverse(),bids:make(-1),tick};
}
