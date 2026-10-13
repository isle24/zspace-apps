import { api } from './api/client';
const hostOrigins = (origin: string) => [origin, 'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];
export function receiveHostTheme(event: MessageEvent, nonce: string, parent: Window, origin: string): boolean {
  const data = event.data;
  if (event.source !== parent || !hostOrigins(origin).includes(event.origin) ||
      data?.type !== 'space-store-host-theme' || data.nonce !== nonce || !['light', 'dark'].includes(data.theme)) return false;
  document.documentElement.dataset.hostTheme = 'true';
  document.documentElement.dataset.theme = data.theme;
  return true;
}
/** The trusted host hands over an already-issued store grant, never NAS credentials. */
export async function receiveHostGrant(event: MessageEvent, nonce: string, parent: Window, origin: string): Promise<boolean> {
  if (event.source !== parent || !hostOrigins(origin).includes(event.origin)) return false;
  const data=event.data;
  if (!data || data.type!=='space-store-host-grant' || data.nonce!==nonce || !data.grant || data.grant.storeAddress!==origin) return false;
  const grant=data.grant;
  if (typeof grant.sessionId!=='string' || !/^[a-f0-9]{48}$/.test(grant.sessionId) || typeof grant.expiresAt!=='string' || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt)<=Date.now()) return false;
  await api.setStoreAddress(origin);
  if (event.source !== parent) return false;
  api.adoptStoreGrant(grant,api.captureStoreScope());
  return true;
}
export function installStoreHostBridge() {
  if (window.parent===window || new URLSearchParams(location.search).get('embedded')!=='1') return ()=>{};
  const nonce=crypto.randomUUID ? crypto.randomUUID() : [...crypto.getRandomValues(new Uint8Array(16))].map(b=>b.toString(16).padStart(2,'0')).join('');
  let active=true,connected=false;
  const receive=(event: MessageEvent)=>{
    if (!active) return;
    if (receiveHostTheme(event,nonce,window.parent,location.origin)) return;
    void receiveHostGrant(event,nonce,window.parent,location.origin).then(accepted=>{
      if(accepted)connected=true;
      if (active && accepted) window.parent.postMessage({type:'space-store-host-connected',nonce},event.origin);
    }).catch(()=>{ /* Login remains available; no credentials enter diagnostics. */ });
  };
  const sessionChanged=()=>{if(active&&connected&&!api.storeSession)window.parent.postMessage({type:'space-store-host-ended',nonce},location.origin)};
  window.addEventListener('space-store-session',sessionChanged);
  window.addEventListener('message',receive);
  for (const origin of [location.origin,'tauri://localhost','http://tauri.localhost','https://tauri.localhost']) {
    try { window.parent.postMessage({type:'space-store-host-ready',nonce},origin); } catch { /* Inapplicable platform origin. */ }
  }
  return ()=>{active=false;window.removeEventListener('message',receive);window.removeEventListener('space-store-session',sessionChanged);};
}
