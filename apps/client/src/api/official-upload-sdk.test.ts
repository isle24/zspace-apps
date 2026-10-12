import { describe, it, expect } from 'vitest';
import { OfficialNas } from './official-nas';
import { Gateway } from './client';
import { officialFixture, officialJson } from './direct-test-fixture';
const parent = { id: 'p', kind: 'directory', name: 'Real', path: '/real' };
function fixture(candidate: unknown = { success: false, code: 'N001320' }) { const calls: string[] = []; const nas = new OfficialNas(officialFixture((url, init) => { calls.push(url.pathname); const path = new URLSearchParams(String(init.body)).get('path'); if (path === '/real')
    return officialJson({ success: true, data: { info: { path, name: 'real', is_dir: true } } }); return officialJson(candidate); })); return { nas, calls }; }
async function source(nas: OfficialNas) { await nas.login('http://nas.test:5055', 'fixture', 'synthetic-password'); return nas.selectBrowserUploadSource(new File([new Uint8Array(4)], '文件.bin', { lastModified: 123 })); }
describe('SDK upload preparation remains evidence gated', () => {
    it.each([{ success: false, code: 'N001320' }, { success: true, data: {} }, { success: true, data: { info: null } }, { success: true, data: { list: [], total: 0 } }])('unknown missing candidate never creates or uploads %#', async (candidate) => { const { nas, calls } = fixture(candidate); const s = await source(nas); await expect(nas.prepareUpload(s.sourceId, { parent, newDirectory: '新目录' })).rejects.toMatchObject({ code: 'UPLOAD_TARGET_UNKNOWN', mayHavePartial: false }); expect(calls).toEqual(['/v2/file/info', '/v2/file/info']); });
    it('explicit existing candidate is preserved', async () => { const { nas, calls } = fixture({ success: true, data: { info: { path: '/real/new', name: 'new', is_dir: true } } }); const s = await source(nas); await expect(nas.prepareUpload(s.sourceId, { parent, newDirectory: 'new' })).rejects.toMatchObject({ code: 'UPLOAD_TARGET_EXISTS' }); expect(calls).not.toContain('/v2/file/newdir'); });
    it('requires explicit new directory and source current session', async () => { const { nas, calls } = fixture(); const s = await source(nas); await expect(nas.prepareUpload(s.sourceId, { parent })).rejects.toMatchObject({ code: 'INVALID_UPLOAD_DESTINATION' }); nas.logout(); await expect(nas.prepareUpload(s.sourceId, { parent, newDirectory: 'new' })).rejects.toMatchObject({ code: 'NO_SESSION' }); expect(calls).toEqual([]); });
    it.each(['../x', 'a/b', 'a\\b', '', '.', '中'.repeat(86)])('validates new directory name %s before network', async (newDirectory) => { const { nas, calls } = fixture(); const s = await source(nas); await expect(nas.prepareUpload(s.sourceId, { parent, newDirectory })).rejects.toMatchObject({ code: 'INVALID_UPLOAD_DESTINATION' }); expect(calls).toEqual([]); });
    it('expiry keeps static error and revokes selected source', async () => { const { nas } = fixture({ success: false, code: 'N001208', message: 'synthetic-official-token' }); const s = await source(nas); const error = await nas.prepareUpload(s.sourceId, { parent, newDirectory: 'new' }).catch(e => e); expect(error).toMatchObject({ code: 'SESSION_EXPIRED', status: 401 }); expect(String(error)).not.toContain('synthetic'); expect(nas.session()).toBeNull(); });
    it('gateway wraps upload operations through existing generation guard', async () => { const g = new Gateway(); expect(typeof g.prepareUpload).toBe('function'); expect(typeof g.runUpload).toBe('function'); expect(typeof g.pauseUpload).toBe('function'); expect(typeof g.resumeUpload).toBe('function'); expect(typeof g.cancelUpload).toBe('function'); await expect(g.runUpload('unknown')).rejects.toMatchObject({ code: 'UPLOAD_TASK_MISSING' }); });
});
describe('SDK preparation asynchronous boundaries', () => {
    it.each(['logout', 'source', 'signal'])('revokes deferred preparation %s promptly', async (kind) => { let resolve!: (r: Response) => void; const gate = new Promise<Response>(r => resolve = r); let entered = false; const nas = new OfficialNas(officialFixture(() => { entered = true; return gate; })); const s = await source(nas); const controller = new AbortController(); const promise = nas.prepareUpload(s.sourceId, { parent, newDirectory: 'new' }, { signal: controller.signal }); while (!entered)
        await new Promise(r => setTimeout(r, 1)); if (kind === 'logout')
        nas.logout(); if (kind === 'source')
        await nas.releaseUploadSource(s.sourceId); if (kind === 'signal')
        controller.abort(); await expect(promise).rejects.toMatchObject({ code: 'REQUEST_CANCELLED', mayHavePartial: false }); resolve(officialJson({ success: true, data: { info: { path: '/real', name: 'real', is_dir: true } } })); await new Promise(r => setTimeout(r, 1)); });
    it('old expiry response after replacement cannot expire new login', async () => { let resolve!: (r: Response) => void; let entered = false; const nas = new OfficialNas(officialFixture(() => { entered = true; return new Promise<Response>(r => resolve = r); })); const s = await source(nas); const promise = nas.prepareUpload(s.sourceId, { parent, newDirectory: 'new' }); while (!entered)
        await new Promise(r => setTimeout(r, 1)); await nas.login('http://nas.test:5055', 'fixture', 'synthetic-password'); const current = nas.sessionId; await expect(promise).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' }); resolve(officialJson({ success: false, code: 'N001208' })); await new Promise(r => setTimeout(r, 1)); expect(nas.sessionId).toBe(current); });
    it('rejects oversized response and HTTP404 as unknown, never absence', async () => { for (const response of [new Response('missing', { status: 404 }), new Response('x'.repeat((64 << 10) + 1)), officialJson({ success: false, code: 'N001301' })]) {
        const nas = new OfficialNas(officialFixture((_url, init) => new URLSearchParams(String(init.body)).get('path') === '/real' ? officialJson({ success: true, data: { info: { path: '/real', name: 'real', is_dir: true } } }) : response));
        const s = await source(nas);
        await expect(nas.prepareUpload(s.sourceId, { parent, newDirectory: 'new' })).rejects.toMatchObject({ code: 'UPLOAD_TARGET_UNKNOWN' });
    } });
});

it('preserves fixture-owned existing marker before any write without claiming rename atomicity', async () => {
  const marker = new Uint8Array([1, 7, 0, 255]);
  const original = marker.slice();
  const calls: string[] = [];
  const nas = new OfficialNas(officialFixture((url, init) => {
    calls.push(url.pathname);
    if (url.pathname === '/v2/file/newdir' || url.pathname === '/v2/file/upload') {
      marker.fill(0);
      return officialJson({success:true,data:{}});
    }
    const path = new URLSearchParams(String(init.body)).get('path');
    return officialJson({success:true,data:{info:path==='/real'
      ? {path,name:'real',is_dir:true}
      : {path:'/real/marker',name:'marker',is_dir:false,size:marker.length}}});
  }));
  const selected = await source(nas);
  await expect(nas.prepareUpload(selected.sourceId,{parent,newDirectory:'marker'}))
    .rejects.toMatchObject({code:'UPLOAD_TARGET_EXISTS',mayHavePartial:false});
  expect(marker).toEqual(original);
  expect(calls).toEqual(['/v2/file/info','/v2/file/info']);
});
