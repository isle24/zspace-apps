import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api/client';
import { receiveHostGrant } from './store-host-bridge';
afterEach(()=>{vi.restoreAllMocks();api.storeSession=''});
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
