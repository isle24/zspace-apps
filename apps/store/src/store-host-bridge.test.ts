import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api/client';
import { installStoreHostBridge, receiveHostGrant, receiveHostTheme } from './store-host-bridge';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();api.storeSession='';history.replaceState({},'',location.pathname);document.body.innerHTML='';delete document.documentElement.dataset.theme;delete document.documentElement.dataset.hostTheme});
it('follows the host theme only for the matching parent, origin and handshake nonce',()=>{
 const event={origin:location.origin,source:window.parent,data:{type:'space-store-host-theme',nonce:'theme-nonce',theme:'dark'}} as MessageEvent;
 expect(receiveHostTheme(event,'wrong',window.parent,location.origin)).toBe(false);
 expect(receiveHostTheme({...event,origin:'https://evil.test'} as MessageEvent,'theme-nonce',window.parent,location.origin)).toBe(false);
 expect(receiveHostTheme({...event,source:{} as Window} as MessageEvent,'theme-nonce',window.parent,location.origin)).toBe(false);
 expect(document.documentElement.dataset.theme).toBeUndefined();
 expect(receiveHostTheme(event,'theme-nonce',window.parent,location.origin)).toBe(true);
 expect(document.documentElement.dataset.theme).toBe('dark');
 expect(document.documentElement.dataset.hostTheme).toBe('true');
 expect(receiveHostTheme({...event,data:{...event.data,theme:'light'}} as MessageEvent,'theme-nonce',window.parent,location.origin)).toBe(true);
 expect(document.documentElement.dataset.theme).toBe('light');
 expect(receiveHostTheme({...event,data:{...event.data,theme:'evil'}} as MessageEvent,'theme-nonce',window.parent,location.origin)).toBe(false);
});
it('rejects messages from unrelated windows and origins before adopting a grant',async()=>{
 const adopt=vi.spyOn(api,'adoptStoreGrant');
 await expect(receiveHostGrant({origin:'https://evil.test',source:{} as Window,data:{}} as MessageEvent,'nonce',window.parent,'http://localhost:3000')).resolves.toBe(false);
 expect(adopt).not.toHaveBeenCalled();
});
it('accepts only a matching nonce and same store origin',async()=>{
 const address=vi.spyOn(api,'setStoreAddress').mockResolvedValue();const adopt=vi.spyOn(api,'adoptStoreGrant').mockImplementation(()=>{});
 const event={origin:'http://localhost:3000',source:window.parent,data:{type:'space-store-host-grant',nonce:'nonce',grant:{sessionId:'a'.repeat(48),expiresAt:new Date(Date.now()+60000).toISOString(),storeAddress:'http://localhost:3000'}}} as MessageEvent;
 expect(await receiveHostGrant(event,'wrong',window.parent,'http://localhost:3000')).toBe(false);
 expect(await receiveHostGrant(event,'nonce',window.parent,'http://localhost:3000')).toBe(true);expect(address).toHaveBeenCalledWith('http://localhost:3000');expect(adopt).toHaveBeenCalledOnce();
});

it.each(['tauri://localhost','http://tauri.localhost','https://tauri.localhost',location.origin])('returns logout to the authenticated host origin %s', async origin => {
 const hostFrame=document.createElement('iframe');document.body.append(hostFrame);
 const host=hostFrame.contentWindow!;
 vi.stubGlobal('parent',host);
 history.replaceState({},'','?embedded=1');
 vi.spyOn(api,'setStoreAddress').mockResolvedValue();
 vi.spyOn(api,'adoptStoreGrant').mockImplementation(grant=>{api.storeSession=grant.sessionId});
 const post=vi.spyOn(host,'postMessage');
 const dispose=installStoreHostBridge();
 try {
  const nonce=(post.mock.calls.find(([data])=>data.type==='space-store-host-ready')![0] as {nonce:string}).nonce;
  window.dispatchEvent(new MessageEvent('message',{origin,source:host,data:{type:'space-store-host-grant',nonce,grant:{sessionId:'a'.repeat(48),storeAddress:location.origin,expiresAt:new Date(Date.now()+60000).toISOString()}}}));
  await vi.waitFor(()=>expect(post).toHaveBeenCalledWith({type:'space-store-host-connected',nonce},origin));
  api.storeSession='';
  expect(post).toHaveBeenCalledWith({type:'space-store-host-ended',nonce,reason:'expired'},origin);
  api.storeSession='a'.repeat(48);
  vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({ok:true,data:{}})));
  await api.logoutStore();
  expect(post).toHaveBeenCalledWith({type:'space-store-host-ended',nonce,reason:'logout'},origin);
 } finally { dispose(); }
});
