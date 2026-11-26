// The live site's deployment manifest: the one versioned file that names the chain, the RPC, the API and the verified
// contract addresses (docs 03: "Keep chain addresses and capabilities in a versioned deployment manifest"). It is made
// from a deployment file by scripts/manifest.ts and served next to the site; nothing in it is secret.

export const MANIFEST_VERSION = 1;
/// Chains this site may run live on: a local anvil and the Robinhood Chain testnet. Mainnet (4663) waits for the
/// owner's explicit yes and is refused here until then.
export const LIVE_CHAINS = { 31337: 'Local test chain (anvil)', 46630: 'Robinhood Chain testnet' };
export const CONTRACTS = ['Engine', 'OpenBook', 'WriterBook', 'PathFundingBook', 'MainspringPool', 'MarkRouter', 'SettlementToken'];

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const isAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const isHttp = (u) => {
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || ((p.protocol === 'http:') && ['127.0.0.1', 'localhost'].includes(p.hostname));
  } catch {
    return false;
  }
};

/// Checks a manifest's shape and gives back a normalised copy, or throws ConfigError naming what is wrong.
export function checkManifest(m) {
  if (!m || typeof m !== 'object') throw new ConfigError('the deployment manifest is missing');
  if (m.version !== MANIFEST_VERSION) throw new ConfigError(`the deployment manifest is version ${m.version}, this site reads version ${MANIFEST_VERSION}`);
  const chainId = Number(m.chainId);
  if (!LIVE_CHAINS[chainId]) throw new ConfigError(`chain ${m.chainId} is not open for this site (local anvil and the Robinhood Chain testnet only)`);
  if (!isHttp(m.rpcUrl)) throw new ConfigError('the manifest needs an https RPC URL (http only on this computer)');
  if (!isHttp(m.apiUrl)) throw new ConfigError('the manifest needs an https API URL (http only on this computer)');
  if (m.explorerUrl != null && m.explorerUrl !== '' && !isHttp(m.explorerUrl)) throw new ConfigError('the explorer URL must be https');
  for (const c of CONTRACTS) if (!isAddress(m.contracts?.[c])) throw new ConfigError(`the manifest has no address for ${c}`);
  const s = m.settlement ?? {};
  if (typeof s.symbol !== 'string' || !/^[A-Z0-9]{2,11}$/.test(s.symbol)) throw new ConfigError('the manifest needs the settlement symbol');
  if (s.decimals !== 6) throw new ConfigError('the settlement token must have 6 decimals');
  if (!Array.isArray(m.markets) || !m.markets.length) throw new ConfigError('the manifest lists no market');
  if (!/^\d+$/.test(String(m.deployBlock ?? ''))) throw new ConfigError('the manifest needs the deployment block');
  return {
    version: MANIFEST_VERSION,
    chainId,
    networkName: m.networkName || LIVE_CHAINS[chainId],
    rpcUrl: m.rpcUrl,
    apiUrl: m.apiUrl.replace(/\/$/, ''),
    explorerUrl: m.explorerUrl || null,
    deployBlock: BigInt(m.deployBlock),
    contracts: Object.fromEntries(CONTRACTS.map((c) => [c, m.contracts[c]])),
    settlement: { symbol: s.symbol, decimals: s.decimals },
    markets: m.markets.map(String),
  };
}

/// The chain entry a wallet needs to add or switch to this network.
export function walletChain(m) {
  return {
    chainId: `0x${m.chainId.toString(16)}`,
    chainName: m.networkName,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: [m.rpcUrl],
    ...(m.explorerUrl ? { blockExplorerUrls: [m.explorerUrl] } : {}),
  };
}
