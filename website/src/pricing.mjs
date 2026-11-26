/** Illustrative floating-point port of TOURBILLON_Backend.md §3.
 * Not execution math: contracts, oracle, path accrual and signed quotes are unconnected.
 */
export function optionValue(spot, strike, sigma, days, kind = 'Rise') {
  if (![spot,strike,sigma,days].every(n=>Number.isFinite(n)&&n>0)) throw new RangeError('Positive finite pricing inputs required');
  const tempo=days/365, root=Math.sqrt(.25+2/(sigma*sigma*tempo)), plus=.5+root, minus=.5-root, x=spot/strike;
  const call=spot<=strike ? strike*Math.pow(x,plus)/(plus-minus) : spot-strike+strike*Math.pow(x,minus)/(plus-minus);
  return Math.max(0,kind==='Fall'?call-spot+strike:call);
}
export function intrinsic(spot,strike,shape,width=strike*.1) {
  if(shape==='Fall') return Math.max(0,strike-spot);
  if(shape==='Swing') return Math.abs(spot-strike);
  if(shape==='Spread') return Math.min(width,Math.max(0,spot-strike));
  return Math.max(0,spot-strike);
}
export function quote({spot,strike,sigma,days,shape='Rise',size=1,width=strike*.1}) {
  if (!Number.isFinite(size)||size<=0||!Number.isFinite(width)||width<=0) throw new RangeError('Invalid size or width');
  if (!Number.isFinite(days)||days<1/24||days>30) throw new RangeError('Tempo must be between one hour and 30 days');
  if (!['Rise','Fall','Spread','Swing'].includes(shape)) throw new RangeError('Unsupported demo shape');
  let value=optionValue(spot,strike,sigma,days,shape);
  if(shape==='Swing') value+=optionValue(spot,strike,sigma,days,'Fall');
  if(shape==='Spread') value-=optionValue(spot,strike+width,sigma,days,'Rise');
  const premium=Math.max(0,value)*size, fee=Math.max(.01,premium*.02)+spot*size*.0003;
  return {unit:value,premium,fee,total:premium+fee,daily:Math.max(0,value-intrinsic(spot,strike,shape,width))/days*size};
}
