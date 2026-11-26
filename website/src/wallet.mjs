export const CHAIN={chainId:'0x1237',chainName:'Robinhood Chain',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:['https://rpc.mainnet.chain.robinhood.com'],blockExplorerUrls:['https://robinhoodchain.blockscout.com']};
import {SITE_URL as CONFIGURED_SITE} from './live/config.mjs';
// The public site address for mobile wallet links comes from the build (VITE_TOURBILLON_SITE_URL); none set, none offered.
export const SITE_URL=CONFIGURED_SITE;
export const normalizeChain=value=>{try{return `0x${BigInt(value).toString(16)}`}catch{return null}};
export const accountAddress=accounts=>Array.isArray(accounts)&&/^0x[\da-f]{40}$/i.test(accounts[0])?accounts[0]:null;
export const shortAddress=value=>value?`${value.slice(0,6)}…${value.slice(-4)}`:'';
export function discoverWallets(win,onChange){
 const found=new Map();
 const remember=(name,provider)=>{if(provider&&typeof provider.request==='function'&&!found.has(name)){found.set(name,provider);onChange(Object.fromEntries(found))}};
 const announce=event=>{const {info,provider}=event.detail||{};if(info?.rdns==='app.phantom')remember('phantom',provider);if(info?.rdns==='io.metamask')remember('metamask',provider)};
 const scan=()=>{win.dispatchEvent(new Event('eip6963:requestProvider'));remember('phantom',win.phantom?.ethereum);for(const provider of win.ethereum?.providers||[win.ethereum]){if(provider?.isPhantom)remember('phantom',provider);else if(provider?.isMetaMask)remember('metamask',provider)}};
 win.addEventListener('eip6963:announceProvider',announce);win.addEventListener('ethereum#initialized',scan);win.addEventListener('focus',scan);scan();
 return()=>{win.removeEventListener('eip6963:announceProvider',announce);win.removeEventListener('ethereum#initialized',scan);win.removeEventListener('focus',scan)};
}
export async function switchToRobinhood(provider,{canAdd=false,chain=CHAIN}={}){
 if(normalizeChain(await provider.request({method:'eth_chainId'}))===chain.chainId)return chain.chainId;
 try{await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:chain.chainId}]})}catch(error){
  if(Number(error?.code??error?.data?.originalError?.code)!==4902||!canAdd)throw error;
  await provider.request({method:'wallet_addEthereumChain',params:[chain]});
  await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:chain.chainId}]});
 }
 const actual=normalizeChain(await provider.request({method:'eth_chainId'}));
 if(actual!==chain.chainId)throw new Error(`Select ${chain.chainName} in your wallet, then try again.`);
 return actual;
}
export function walletError(error){const code=Number(error?.code??error?.data?.originalError?.code);if(code===4001)return 'The request was declined. You can try again when you’re ready.';if(code===-32002)return 'A request is already open in your wallet. Please finish or dismiss it there.';if([4902,4200].includes(code))return 'Update your wallet, enable Robinhood Chain, then try again.';return 'The wallet could not finish connecting. Check that it is unlocked and try again.'}
export function mobileBrowseLink(name,origin=SITE_URL){if(!origin)throw new Error('No public site address is set for mobile wallets.');const parsed=new URL(origin);if(parsed.protocol!=='https:')throw new Error('Mobile wallets require an HTTPS website.');const target=`${parsed.origin}/#/dashboard`;return name==='phantom'?`https://phantom.com/ul/browse/${encodeURIComponent(target)}?ref=${encodeURIComponent(parsed.origin)}`:`https://link.metamask.io/dapp/${parsed.host}/`}
export function observeWallet(provider,{accounts,chain,disconnect}){provider.on?.('accountsChanged',accounts);provider.on?.('chainChanged',chain);provider.on?.('disconnect',disconnect);return()=>{provider.removeListener?.('accountsChanged',accounts);provider.removeListener?.('chainChanged',chain);provider.removeListener?.('disconnect',disconnect)}}
