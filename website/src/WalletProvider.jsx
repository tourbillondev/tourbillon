import React,{createContext,useContext,useEffect,useRef,useState} from 'react';
import {ArrowUpRight,Check,Copy,LogOut,Wallet,X} from 'lucide-react';
import Mark from './Mark.jsx';
import {CHAIN,SITE_URL,accountAddress,discoverWallets,mobileBrowseLink,normalizeChain,observeWallet,shortAddress,switchToRobinhood,walletError} from './wallet.mjs';
import {useLive} from './live/LiveProvider.jsx';
import './wallet.css';

const WalletContext=createContext(null);
export const useWallet=()=>useContext(WalletContext);
export function WalletButton({className=''}){const w=useContext(WalletContext);return <button className={`wallet-connect ${className}`} onClick={()=>w.open()}><Wallet size={15}/><span>{w.busy?'Connecting…':w.address?shortAddress(w.address):'Connect wallet'}</span>{w.address&&<i data-ready={w.chain===w.target.chainId}/>}</button>}
export default function WalletProvider({children}){
 const [visible,setVisible]=useState(false),[providers,setProviders]=useState({}),[session,setSession]=useState(null),[address,setAddress]=useState(null),[chain,setChain]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[mobile,setMobile]=useState(null),[qr,setQR]=useState(''),[copied,setCopied]=useState(false);
 const [device,setDevice]=useState('browser'),[missing,setMissing]=useState(null);
 const dialog=useRef(null),lock=useRef(false),generation=useRef(0),sessionRef=useRef(null);
 // the network to connect to: the live deployment's chain, or the planned Robinhood Chain in the demo
 const live=useLive(),target=live.walletChain??CHAIN,isLive=live.mode==='live',mobileOk=Boolean(SITE_URL);
 useEffect(()=>discoverWallets(window,setProviders),[]);
 useEffect(()=>{const d=dialog.current;if(visible&&!d.open)d.showModal();else if(!visible&&d.open)d.close()},[visible]);
 useEffect(()=>{if(!mobile){setQR('');return}let active=true;setQR('');import('qrcode').then(m=>m.default.toDataURL(mobileBrowseLink(mobile),{width:240,margin:2,errorCorrectionLevel:'M',color:{dark:'#14223b',light:'#ffffff'}})).then(url=>{if(active)setQR(url)}).catch(()=>{if(active)setError('The QR code could not load. Use the app link below.')});return()=>{active=false}},[mobile]);
 useEffect(()=>{if(!session)return;return observeWallet(session.provider,{accounts:a=>{setAddress(accountAddress(a));if(!accountAddress(a)){generation.current++;sessionRef.current=null;setSession(null);setChain(null)}},chain:c=>setChain(normalizeChain(c)),disconnect:()=>{generation.current++;sessionRef.current=null;setSession(null);setAddress(null);setChain(null)}})},[session]);
 useEffect(()=>()=>{generation.current++},[]);
 const open=()=>{setError('');setMobile(null);setMissing(null);setDevice('browser');window.dispatchEvent(new Event('eip6963:requestProvider'));setVisible(true)};
 const connect=async name=>{
  if(lock.current)return;
  if(!providers[name]){setMissing(name);setError(`${name==='metamask'?'MetaMask':'Phantom'} is not available in this browser. Open this page in Chrome with the extension enabled, then try again.`);window.dispatchEvent(new Event('eip6963:requestProvider'));return}
  lock.current=true;setBusy(true);setError('');const token=++generation.current;
  try{
   const provider=providers[name];
   await provider.request({method:'eth_requestAccounts'});
   if(token!==generation.current)return;
   const current=accountAddress(await provider.request({method:'eth_accounts'}));if(!current)throw new Error('No account returned');
   const currentChain=normalizeChain(await provider.request({method:'eth_chainId'}));if(token!==generation.current)return;
   const next={name,provider};sessionRef.current=next;setSession(next);setAddress(current);setChain(currentChain);
   try{const result=await switchToRobinhood(provider,{canAdd:name==='metamask',chain:target});if(token===generation.current)setChain(result)}catch(err){if(token===generation.current)setError(walletError(err))}
   if(token===generation.current)setVisible(true);
  }catch(err){if(token===generation.current){setError(walletError(err));setVisible(true)}}finally{lock.current=false;setBusy(false)}
 };
 const switchNetwork=async()=>{if(lock.current||!sessionRef.current)return;lock.current=true;setBusy(true);setError('');const token=generation.current,s=sessionRef.current;try{const result=await switchToRobinhood(s.provider,{canAdd:s.name==='metamask',chain:target});if(token===generation.current)setChain(result)}catch(err){if(token===generation.current)setError(walletError(err))}finally{lock.current=false;setBusy(false)}};
 const disconnect=()=>{if(lock.current)return;generation.current++;sessionRef.current=null;setSession(null);setAddress(null);setChain(null);setError('Disconnected here. To revoke access too, remove this site in your wallet’s connected apps.');setMobile(null)};
 const copy=async()=>{try{await navigator.clipboard.writeText(address);setCopied(true);setTimeout(()=>setCopied(false),1800)}catch{setError('Copy is unavailable. Select the address above to copy it.')}};
 return <WalletContext.Provider value={{open,address,chain,busy,target,provider:session?.provider??null}}>{children}
  {busy&&!visible&&<button className="wallet-waiting" onClick={()=>setVisible(true)}><span/> Waiting for your wallet… <ArrowUpRight size={14}/></button>}
  <dialog ref={dialog} className="wallet-dialog" aria-labelledby="wallet-heading" onCancel={()=>setVisible(false)} onClick={e=>{if(e.target===dialog.current)setVisible(false)}}>
   <button className="wallet-close" onClick={()=>setVisible(false)} aria-label="Close wallet connection"><X size={18}/></button>
   <div className="wallet-brand"><Mark/><span>TOURBILLON</span></div>
   <span className="wallet-kicker">{isLive?target.chainName.toUpperCase():'ROBINHOOD CHAIN · MAINNET'}</span><h2 id="wallet-heading">{address?'Your wallet.':mobile?'Continue on mobile.':'Connect your wallet.'}</h2>
   {address?<><div className="wallet-connected"><img src={`/assets/logos/${session?.name}.svg`} alt=""/><div><b>{session?.name==='phantom'?'Phantom':'MetaMask'}</b><span>{chain===target.chainId?`Connected to ${target.chainName}`:'Connected · switch network'}</span></div><Check size={18}/></div><div className="wallet-address"><code>{address}</code><button onClick={copy} aria-label="Copy wallet address">{copied?<Check size={16}/>:<Copy size={16}/>}</button></div>{chain!==target.chainId&&<button className="wallet-primary" disabled={busy} onClick={switchNetwork}>{busy?'Check your wallet…':`Switch to ${target.chainName}`}</button>}<a className="wallet-primary" href="#/dashboard" onClick={()=>setVisible(false)}>Open dashboard <ArrowUpRight size={15}/></a><button className="wallet-disconnect" disabled={busy} onClick={disconnect}><LogOut size={13}/> Disconnect from this site</button></>:mobile?<><p>Open TOURBILLON in {mobile==='phantom'?'Phantom':'MetaMask'}’s browser, then tap Connect wallet there.</p><div className="wallet-qr">{qr?<img src={qr} width="200" height="200" alt={`Scan to open TOURBILLON in ${mobile==='phantom'?'Phantom':'MetaMask'}`}/>:<span>Preparing QR code…</span>}</div><a className="wallet-primary" href={mobileBrowseLink(mobile)}>Open {mobile==='phantom'?'Phantom':'MetaMask'} app <ArrowUpRight size={15}/></a><small className="wallet-mobile-note">Opens the hosted site on your phone. This preview requires its owner’s site access. The connection stays in the wallet’s browser.</small><a className="wallet-back" href={mobile==='phantom'?'https://phantom.com/download':'https://metamask.io/download'} target="_blank" rel="noreferrer">Get the browser extension <ArrowUpRight size={12}/></a><button className="wallet-back" onClick={()=>setMobile(null)}>Back to wallets</button></>:<><p>{device==='browser'?'Connect directly to your wallet extension.':'Open this site in your wallet’s mobile browser.'}</p><div className="wallet-device-switch" aria-label="Connection method"><button aria-pressed={device==='browser'} disabled={busy} onClick={()=>{setDevice('browser');setError('');setMissing(null)}}>Browser extension</button><button aria-pressed={device==='mobile'} disabled={busy||!mobileOk} title={mobileOk?undefined:'Mobile wallet links need the site’s public address'} onClick={()=>{setDevice('mobile');setError('');setMissing(null)}}>Mobile app</button></div><div className="wallet-options">{['metamask','phantom'].map(name=><div key={name}><button className="wallet-option" disabled={busy} onClick={()=>{if(device==='mobile'){setMobile(name);setError('')}else connect(name)}}><img src={`/assets/logos/${name}.svg`} alt=""/><span><b>{name==='phantom'?'Phantom':'MetaMask'}</b><small>{device==='mobile'?'Open in mobile app':providers[name]?'Extension detected':'Browser extension'}</small></span><ArrowUpRight size={17}/></button></div>)}</div></>}
   {missing&&device==='browser'&&!mobile&&<a className="wallet-back" href={missing==='phantom'?'https://phantom.com/download':'https://metamask.io/download'} target="_blank" rel="noreferrer">Get the {missing==='phantom'?'Phantom':'MetaMask'} extension <ArrowUpRight size={12}/></a>}{busy&&visible&&<p className="wallet-status" role="status">Finish the connection request in your wallet.</p>}{error&&<p className="wallet-error" role="alert">{error}</p>}
   <div className="wallet-footnote"><LockNote/><p>{isLive?`Connecting shares your public address and network. Each approval and trade on ${target.chainName} is shown for review first and sent only when you confirm it in your wallet.`:'Connecting shares your public address and network. Trades here are simulated. No signature, token approval or transaction is requested.'}</p></div>
  </dialog>
 </WalletContext.Provider>
}
function LockNote(){return <svg width="14" height="16" viewBox="0 0 14 16" fill="none" aria-hidden="true"><rect x="2" y="7" width="10" height="7" rx="2" stroke="currentColor"/><path d="M4 7V5a3 3 0 0 1 6 0v2" stroke="currentColor"/></svg>}
