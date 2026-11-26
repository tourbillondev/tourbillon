import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { MANIFEST_URL, MODE, REFRESH_MS } from './config.mjs';
import { checkManifest, walletChain } from './manifest.mjs';

// The live data behind the dashboard. In a demo build it provides only { mode: 'demo' }. In a live build it loads the
// deployment manifest, checks it against the RPC, the contracts and the API, and refreshes the status and markets;
// any failure puts it in an error state the dashboard shows. It never substitutes sample data.

const LiveContext = createContext({ mode: 'demo' });
export const useLive = () => useContext(LiveContext);

export default function LiveProvider({ children }) {
  const [state, setState] = useState(MODE === 'live' ? { mode: 'live', phase: 'loading' } : { mode: 'demo' });
  const deps = useRef(null);

  const refresh = useCallback(async () => {
    const d = deps.current;
    if (!d) return;
    try {
      const status = await d.api.status();
      const markets = await d.api.markets(d.manifest.settlement.decimals);
      setState((s) => ({ ...s, phase: 'ready', error: null, status, markets, at: Date.now() }));
    } catch (e) {
      setState((s) => ({ ...s, phase: 'error', error: e.message, status: null, markets: [] }));
    }
  }, []);

  useEffect(() => {
    if (MODE !== 'live') return;
    let stop = false;
    let timer;
    (async () => {
      try {
        const res = await fetch(MANIFEST_URL, { cache: 'no-store' }).catch(() => null);
        if (!res || !res.ok) throw new Error('The deployment manifest could not be loaded.');
        const manifest = checkManifest(await res.json());
        // loaded only in a live build, so the demo carries no chain code
        const [{ apiClient }, { liveChain }] = await Promise.all([import('./api.mjs'), import('./chain.mjs')]);
        const api = apiClient(manifest.apiUrl);
        const chain = liveChain(manifest);
        const status = await api.status();
        const problems = await chain.verify(status);
        if (problems.length) throw new Error(problems.join(' '));
        deps.current = { manifest, api, chain };
        if (stop) return;
        setState({ mode: 'live', phase: 'loading', manifest, api, chain, walletChain: walletChain(manifest), refresh });
        await refresh();
        timer = setInterval(refresh, REFRESH_MS);
      } catch (e) {
        if (!stop) setState({ mode: 'live', phase: 'error', error: e.message });
      }
    })();
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [refresh]);

  return <LiveContext.Provider value={state}>{children}</LiveContext.Provider>;
}
