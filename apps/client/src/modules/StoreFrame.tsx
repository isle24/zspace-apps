import { useEffect, useRef, useState } from 'react';
import { api, message } from '../api/client';
export function StoreFrame() {
 const frame=useRef<HTMLIFrameElement>(null), [url,setURL]=useState(''), [error,setError]=useState('');
 useEffect(()=>{
  let active=true;let expected='',nonce='';const session=api.storeSession,address=api.storeAddress;
  void api.init().then(()=>{
   if (!active) return;
   const base=new URL(api.base || location.origin);expected=base.origin;
   setURL(new URL('/space-store/?embedded=1',base).href);
  }).catch(e=>{if(active)setError(message(e))});
  const receive=async(event:MessageEvent)=>{
   if (!active || event.source!==frame.current?.contentWindow || event.origin!==expected)return;
   if(event.data?.type==='space-store-host-ended'&&nonce&&event.data.nonce===nonce){void api.logoutStore();return}
   if(event.data?.type!=='space-store-host-ready'||typeof event.data.nonce!=='string'||!/^[a-f0-9-]{16,64}$/.test(event.data.nonce))return;
   nonce=event.data.nonce;
   try{
    const grant=await api.grantForStoreFrame();
    if(!active||session!==api.storeSession||address!==api.storeAddress||grant.storeAddress!==expected)return;
    frame.current?.contentWindow?.postMessage({type:'space-store-host-grant',nonce:event.data.nonce,grant},expected);
   }catch(e){if(active)setError(message(e))}
  };
  window.addEventListener('message',receive);
  return()=>{active=false;window.removeEventListener('message',receive)};
 },[api.storeSession,api.storeAddress]);
 return <div className="embedded-complete-store">{error&&<p className="error-text" role="alert">{error}</p>}{url?<iframe ref={frame} title="空间商店" src={url} referrerPolicy="no-referrer" />:<p role="status">正在连接空间商店…</p>}</div>;
}
