import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {CHAIN,SITE_URL,accountAddress,discoverWallets,mobileBrowseLink,normalizeChain,observeWallet,switchToRobinhood,walletError} from '../src/wallet.mjs';

test('wallet selection separates Phantom from MetaMask when both inject ethereum',()=>{
 const win=new EventTarget(),phantom={isPhantom:true,isMetaMask:true,request(){}},metamask={isMetaMask:true,request(){}};win.phantom={ethereum:phantom};win.ethereum={providers:[phantom,metamask]};let found={};const stop=discoverWallets(win,v=>found=v);assert.equal(found.phantom,phantom);assert.equal(found.metamask,metamask);stop();
});
test('EIP-6963 discovery accepts late announcements and cleans up',()=>{
 const win=new EventTarget();let found={};const stop=discoverWallets(win,v=>found=v);const provider={request(){}};const e=new Event('eip6963:announceProvider');e.detail={info:{rdns:'app.phantom'},provider};win.dispatchEvent(e);assert.equal(found.phantom,provider);stop();const m=new Event('eip6963:announceProvider');m.detail={info:{rdns:'io.metamask'},provider};win.dispatchEvent(m);assert.equal(found.metamask,undefined);
});
test('unknown MetaMask chain is added, switched and verified without signing',async()=>{
 let chain='0x1',added=false;const methods=[];const provider={request:async({method,params})=>{methods.push(method);if(method==='eth_chainId')return chain;if(method==='wallet_switchEthereumChain'){if(!added)throw{code:4902};chain=params[0].chainId;}if(method==='wallet_addEthereumChain'){assert.deepEqual(params[0],CHAIN);added=true}}};assert.equal(await switchToRobinhood(provider,{canAdd:true}),CHAIN.chainId);assert.deepEqual(methods,['eth_chainId','wallet_switchEthereumChain','wallet_addEthereumChain','wallet_switchEthereumChain','eth_chainId']);
});
test('rejection and Phantom unknown networks never silently fall back to add-chain',async()=>{
 for(const code of [4001,4902]){const methods=[];const provider={request:async({method})=>{methods.push(method);if(method==='eth_chainId')return'0x1';throw{code}}};await assert.rejects(switchToRobinhood(provider),e=>e.code===code);assert.equal(methods.includes('wallet_addEthereumChain'),false)}
 assert.match(walletError({code:4001}),/declined/);assert.match(walletError({code:-32002}),/already open/);
});
test('success response on wrong chain is not accepted as connected to Robinhood',async()=>{
 const provider={request:async({method})=>method==='eth_chainId'?'0x1':null};await assert.rejects(switchToRobinhood(provider),/Select Robinhood Chain/);
});
test('provider lifecycle handlers update accounts and network and are detached',()=>{
 const provider=new EventEmitter();let a,c,disconnected=false;const stop=observeWallet(provider,{accounts:v=>a=accountAddress(v),chain:v=>c=normalizeChain(v),disconnect:()=>disconnected=true});provider.emit('accountsChanged',['0x'+'a'.repeat(40)]);provider.emit('chainChanged',4663);assert.equal(a,'0x'+'a'.repeat(40));assert.equal(c,CHAIN.chainId);provider.emit('accountsChanged',[]);assert.equal(a,null);provider.emit('disconnect');assert.equal(disconnected,true);stop();assert.equal(provider.listenerCount('accountsChanged'),0);assert.equal(provider.listenerCount('chainChanged'),0);assert.equal(provider.listenerCount('disconnect'),0);
});
test('mobile app links open a fixed HTTPS site without accounts or secrets',()=>{
 // the site address is a build setting (VITE_TOURBILLON_SITE_URL); with none set, no mobile link is offered
 assert.equal(SITE_URL,null);assert.throws(()=>mobileBrowseLink('phantom'),/No public site address/);
 const SITE='https://tourbillon.example';
 const phantom=new URL(mobileBrowseLink('phantom',SITE));assert.equal(phantom.origin,'https://phantom.com');assert.equal(decodeURIComponent(phantom.pathname.slice('/ul/browse/'.length)),SITE+'/#/dashboard');assert.equal(phantom.searchParams.get('ref'),SITE);assert.match(mobileBrowseLink('metamask',SITE),/^https:\/\/link.metamask.io\/dapp\//);assert.throws(()=>mobileBrowseLink('phantom','javascript:alert(1)'));assert.equal(accountAddress(['bad']),null);
});
