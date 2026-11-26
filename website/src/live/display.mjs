// How a live market is drawn in the existing design: its name, colour and logo by symbol (a display table only; a
// market's identity is its id from the deployment). Unknown symbols get the neutral look, never another market's.
import { fromWad } from './codec.mjs';

const LOOK = {
  BTC: { name: 'Bitcoin', color: '#edb367', logo: 'bitcoin.svg' },
  ETH: { name: 'Ethereum', color: '#a8b5e9', logo: 'ethereum.svg' },
  SPY: { name: 'S&P 500', color: '#8edac9', logo: 'spy.svg' },
};
const NEUTRAL = { color: '#9fb3dd', logo: 'tourbillon-white.svg' };

/// The dashboard's market shape ({symbol, name, spot, sigma, change, color, logo}) from a live market. `spot` and
/// `sigma` are display numbers for the model estimate only; every amount sent comes from the WAD values in `live`.
export function uiMarket(m) {
  const look = LOOK[m.market] ?? { ...NEUTRAL, name: m.kind === 'stock' ? 'Tokenized stock' : 'Market' };
  return {
    symbol: m.market,
    name: look.name,
    color: look.color,
    logo: look.logo,
    spot: m.markWad == null ? null : Number(fromWad(m.markWad)),
    sigma: m.volBps == null ? null : m.volBps / 10000,
    change: null,
    live: m,
  };
}
