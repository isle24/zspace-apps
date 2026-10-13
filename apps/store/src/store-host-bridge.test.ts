import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api/client';
import { receiveHostGrant, receiveHostTheme } from './store-host-bridge';
afterEach(()=>{vi.restoreAllMocks();api.storeSession='';delete document.documentElement.dataset.theme;delete document.documentElement.dataset.hostTheme});
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
