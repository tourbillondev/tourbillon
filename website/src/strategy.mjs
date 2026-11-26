import {optionValue,intrinsic} from './pricing.mjs';
export const DEMO_SHAPES=['Rise','Fall','Spread','Swing','Band'];
export function legsFor(shape,strike,width){
 if(!DEMO_SHAPES.includes(shape)||!Number.isFinite(strike)||strike<=0||!Number.isFinite(width)||width<=0)throw new RangeError('Invalid strategy');
 if(shape==='Band'&&strike-2*width<=0)throw new RangeError('Band wings must have positive strikes');
 const leg=(kind,k,weight)=>({kind,strike:k,weight});
 if(shape==='Fall')return[leg('Fall',strike,1)];
 if(shape==='Swing')return[leg('Rise',strike,1),leg('Fall',strike,1)];
 if(shape==='Spread')return[leg('Rise',strike,1),leg('Rise',strike+width,-1)];
 if(shape==='Band')return[leg('Rise',strike-2*width,1),leg('Rise',strike-width,-1),leg('Rise',strike+width,-1),leg('Rise',strike+2*width,1)];
 return[leg('Rise',strike,1)];
}
export function strategyPayoff(spot,shape,strike,width){return legsFor(shape,strike,width).reduce((s,l)=>s+l.weight*intrinsic(spot,l.strike,l.kind),0)}
export function validateMovement(movement){
 if(!Array.isArray(movement)||movement.length<1||movement.length>4||movement.some(m=>!Number.isFinite(m.days)||m.days<1/24||m.days>30||!Number.isFinite(m.weight)||m.weight<=0||m.weight>1)||Math.abs(movement.reduce((s,m)=>s+m.weight,0)-1)>1e-8)throw new RangeError('Use one to four tempos with positive weights totaling 100%');
 return movement;
}
export function strategyQuote(config){
 const {spot,strike,sigma,days,shape='Rise',size=1,width=strike*.1,movement}=config;
 const legs=legsFor(shape,strike,width);
 if(!Number.isFinite(days)||days<1/24||days>30)throw new RangeError('Tempo must be between one hour and 30 days');
 if(!Number.isFinite(size)||size<=0||size>1e6)throw new RangeError('Invalid size');
 const blend=validateMovement(movement??[{days,weight:1}]);
 let unit=0,daily=0;
 for(const part of blend){
  const value=legs.reduce((sum,l)=>sum+l.weight*optionValue(spot,l.strike,sigma,part.days,l.kind),0);
  unit+=value*part.weight;
  // Instantaneous illustration. Historical path accrual is not implemented.
  daily+=Math.max(0,value-strategyPayoff(spot,shape,strike,width))/part.days*part.weight*size;
 }
 unit=Math.max(0,unit);const premium=unit*size,fee=Math.max(.01,premium*.02)+spot*size*.0003;
 return{unit,premium,fee,total:premium+fee,daily,legs};
}
export function writerCollateral(shape,strike,width,size=1){
 const legs=legsFor(shape,strike,width);
 if(!Number.isFinite(size)||size<=0||size>1e6)throw new RangeError('Invalid size');
 // Short the full long strategy. Check zero, all knots, and the terminal slope.
 const shortSlope=-legs.filter(l=>l.kind==='Rise').reduce((sum,l)=>sum+l.weight,0);
 if(shortSlope<0)return Infinity;
 const knots=[0,...legs.map(l=>l.strike)];
 return Math.max(0,...knots.map(s=>strategyPayoff(s,shape,strike,width)))*size;
}
export function positionQuote(p,market){return strategyQuote({...p,spot:market.spot,sigma:market.sigma})}
