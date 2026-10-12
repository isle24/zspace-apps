import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createUploadTask, uploadPieceHeaders, strictUploadSize, completeUploadListing, verifyUploadReplyTarget, OfficialUploadError } from './official-upload';
import { hashUpload, type UploadHashes } from './upload-hashes';
const cap = 2 << 20;
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }
function fixture(size = cap + 17, overrides: Record<string, any> = {}) {
    const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251), sent: {
        bytes: Uint8Array;
        seek: number;
        terminal: boolean;
        hashes: UploadHashes;
    }[] = [];
    const source = { size, lastModified: 1790000000123, read: async (o: number, n: number): Promise<Uint8Array> => bytes.slice(o, o + n), hash: (path: string, options: any) => hashUpload(source, path, options), release: async () => { } };
    const io = { assertCurrent: () => { }, verifyTarget: async () => { }, verifyParent: async () => { }, queryPartial: async () => ({ size: sent.reduce((n, p) => n + p.bytes.length, 0) }), sendChunk: async (p: any) => { sent.push({ ...p, bytes: p.bytes.slice() }); }, readFinalInfo: async () => ({ path: '/新目录/文件.bin', name: '文件.bin', is_dir: false, size }), ...overrides };
    const task = createUploadTask(source, '/新目录/文件.bin', io);
    return { task, sent, bytes, source };
}
describe('credential-free retained upload engine', () => {
    it('sends exact bytes sequentially over cap and terminal full MD5 only', async () => {
        const { task, sent, bytes } = fixture();
        const progress: number[] = [];
        await task.run({ onProgress: (s: any) => progress.push(s.confirmedBytes) });
        expect(sent.map(p => [p.seek, p.bytes.length, p.terminal])).toEqual([[0, cap, false], [cap, 17, true]]);
        expect(Buffer.compare(Buffer.concat(sent.map(p => Buffer.from(p.bytes))), Buffer.from(bytes))).toBe(0);
        expect(task.snapshot()).toMatchObject({ phase: 'completed', confirmedBytes: bytes.length, mayHavePartial: true });
        const hashes = (sent[0] as { hashes: UploadHashes }).hashes;
        expect(hashes.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
        expect(uploadPieceHeaders('/新目录/文件.bin', 1790000000123, hashes, 0, cap)).not.toHaveProperty('fileHash');
        expect(uploadPieceHeaders('/新目录/文件.bin', 1790000000123, hashes, cap, 17)).toMatchObject({ seek: String(cap), fileHash: createHash('md5').update(bytes).digest('hex'), fileHashCheckOption: 'complete', rename: '0', crtime: '', modify_time: '1790000001' });
        expect(progress).toEqual([cap, cap + 17]);
    });
    it('sends explicit zero terminal before strict zero readback', async () => { const { task, sent } = fixture(0); await task.run(); expect(sent.map(p => [p.seek, p.bytes.length, p.terminal])).toEqual([[0, 0, true]]); expect(task.snapshot().phase).toBe('completed'); });
    it('pauses only after in-flight confirmation and resumes at retained size', async () => {
        const gate = deferred<void>();
        let count = 0;
        const f = fixture(cap + 17, { sendChunk: async (p: any) => { f.sent.push({ ...p, bytes: p.bytes.slice() }); if (++count === 1)
                await gate.promise; } });
        const run = f.task.run();
        while (!count)
            await new Promise(r => setTimeout(r, 1));
        f.task.pause();
        expect(f.task.snapshot().phase).toBe('pausing');
        expect(f.task.snapshot().confirmedBytes).toBe(0);
        gate.resolve();
        await run;
        expect(f.task.snapshot().phase).toBe('paused');
        await f.task.resume();
        expect(f.sent.map(p => p.seek)).toEqual([0, cap]);
    });
    it.each([0, cap + 1, '12x', undefined, -1, 1.5])('preserves partial on resume mismatch %s', async (size) => { let f: any; f = fixture(cap + 17, { queryPartial: async () => ({ size }), sendChunk: async (p: any) => { f.sent.push(p); f.task.pause(); } }); await f.task.run(); await expect(f.task.resume()).rejects.toMatchObject({ code: 'UPLOAD_PARTIAL_MISMATCH', mayHavePartial: true }); expect(f.sent).toHaveLength(1); });
    it('cancels stalled send promptly and discards late confirmation', async () => { const gate = deferred<void>(); let entered = false; const f = fixture(4, { sendChunk: async () => { entered = true; await gate.promise; } }); const run = f.task.run(); while (!entered)
        await new Promise(r => setTimeout(r, 1)); f.task.cancel(); await expect(run).rejects.toMatchObject({ code: 'REQUEST_CANCELLED', mayHavePartial: true }); gate.resolve(); await Promise.resolve(); expect(f.task.snapshot()).toMatchObject({ phase: 'cancelled', confirmedBytes: 0 }); });
    it.each([{}, { path: '/other', name: '文件.bin', is_dir: false, size: 0 }, { path: '/新目录/文件.bin', name: '文件.bin', is_dir: false }, { path: '/新目录/文件.bin', name: '文件.bin', is_dir: true, size: 0 }])('never completes on ambiguous empty readback %#', async (info) => { const f = fixture(0, { readFinalInfo: async () => info }); await expect(f.task.run()).rejects.toMatchObject({ code: 'UPLOAD_READBACK_UNVERIFIED' }); expect(f.sent).toHaveLength(1); expect(f.task.snapshot().phase).toBe('failed'); });
    it('paused terminal verifies without resending', async () => { let f: any; f = fixture(4, { sendChunk: async (p: any) => { f.sent.push(p); f.task.pause(); } }); await f.task.run(); expect(f.task.snapshot().phase).toBe('completed'); expect(f.sent).toHaveLength(1); });
    it('callback cancellation cannot advance another piece', async () => { const f = fixture(); await expect(f.task.run({ onProgress: () => f.task.cancel() })).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' }); expect(f.sent).toHaveLength(1); });
    it('unknown target never reads/hashes/dispatches', async () => { const f = fixture(4, { verifyTarget: async () => { throw new Error('private raw'); } }); await expect(f.task.run()).rejects.toMatchObject({ code: 'UPLOAD_FAILED', mayHavePartial: false }); expect(f.sent).toHaveLength(0); });
});
describe('strict evidence parsers', () => {
    it.each([0, 12, '0', '12', Number.MAX_SAFE_INTEGER])('accepts safe canonical size %s', v => expect(strictUploadSize(v)).toBe(Number(v)));
    it.each([undefined, null, '', false, '01', '+1', '1.0', ' 1', '1e2', -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe size %s', v => expect(strictUploadSize(v)).toBeUndefined());
    it('requires explicit consistent raw listing bounds', () => { expect(completeUploadListing({ list: [], total: 0 })).toEqual([]); for (const v of [{ items: [], total: 0 }, { list: [] }, { list: [], total: '0' }, { list: [{}], total: 0 }, { list: [], total: 1 }])
        expect(completeUploadListing(v)).toBeUndefined(); });
});
describe('engine cancellation and source gates', () => {
    it('hash pause retains source and resumes a fresh full hash', async () => { const gate = deferred<any>(); const f = fixture(4); let calls = 0; const original = f.source.hash; f.source.hash = async (path, options) => ++calls === 1 ? gate.promise : original(path, options); const run = f.task.run(); while (!calls)
        await new Promise(r => setTimeout(r, 1)); f.task.pause(); await run; expect(f.task.snapshot().phase).toBe('paused'); await f.task.resume(); expect(calls).toBe(2); gate.resolve(await original('/新目录/文件.bin', {})); expect(f.sent).toHaveLength(1); });
    it('resume rehash refuses changed full bytes even at same size/mtime', async () => { let f: any; f = fixture(cap + 17, { sendChunk: async (p: any) => { f.sent.push(p); f.task.pause(); } }); await f.task.run(); f.bytes[0] ^= 1; await expect(f.task.resume()).rejects.toMatchObject({ code: 'UPLOAD_SOURCE_CHANGED' }); expect(f.sent).toHaveLength(1); });
    it('pauses a resumed hash at a retained confirmed boundary', async () => { let f: any; f = fixture(cap + 17, { sendChunk: async (p: any) => { f.sent.push(p); f.task.pause(); } }); await f.task.run(); const gate = deferred<any>(); let entered = false; f.source.hash = async () => { entered = true; return gate.promise; }; const run = f.task.resume(); while (!entered)
        await new Promise(r => setTimeout(r, 1)); f.task.pause(); await run; expect(f.task.snapshot()).toMatchObject({ phase: 'paused', confirmedBytes: cap }); gate.resolve({}); });
    it('short read fails before dispatch', async () => { const f = fixture(4); const hashes = await f.source.hash('/新目录/文件.bin', {}); f.source.hash = async () => hashes; f.source.read = async () => new Uint8Array(3); await expect(f.task.run()).rejects.toMatchObject({ code: 'UPLOAD_SOURCE_CHANGED', mayHavePartial: false }); expect(f.sent).toHaveLength(0); });
    it('source metadata mutation after read cannot dispatch', async () => { const f = fixture(4); const hashes = await f.source.hash('/新目录/文件.bin', {}); f.source.hash = async () => hashes; f.source.read = async () => { f.source.lastModified++; return new Uint8Array(4); }; await expect(f.task.run()).rejects.toMatchObject({ code: 'UPLOAD_SOURCE_CHANGED', mayHavePartial: false }); expect(f.sent).toHaveLength(0); });
    it('send failure retains partial without progress or retry', async () => { let calls = 0; const f = fixture(4, { sendChunk: async () => { calls++; throw new Error('token /local/path'); } }); await expect(f.task.run()).rejects.toMatchObject({ code: 'UPLOAD_FAILED', mayHavePartial: true }); expect(f.task.snapshot().confirmedBytes).toBe(0); expect(calls).toBe(1); });
});
describe('engine await fences and diagnostics', () => {
    it.each(['verifyParent', 'verifyTarget', 'readFinalInfo'])('cancels deferred %s and ignores late values', async (stage) => { const gate = deferred<any>(); let entered = false; const f = fixture(4, { [stage]: async () => { entered = true; return gate.promise; } }); const run = f.task.run(); while (!entered)
        await new Promise(r => setTimeout(r, 1)); f.task.cancel(); await expect(run).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' }); const before = f.task.snapshot(); gate.resolve(stage === 'readFinalInfo' ? { path: '/新目录/文件.bin', name: '文件.bin', is_dir: false, size: 4 } : undefined); await new Promise(r => setTimeout(r, 1)); expect(f.task.snapshot()).toEqual(before); });
    it('read cancellation does not dispatch late bytes', async () => { const f = fixture(4); const h = await f.source.hash('/新目录/文件.bin', {}); f.source.hash = async () => h; const gate = deferred<Uint8Array>(); let entered = false; f.source.read = async () => { entered = true; return gate.promise; }; const run = f.task.run(); while (!entered)
        await new Promise(r => setTimeout(r, 1)); f.task.cancel(); await expect(run).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' }); gate.resolve(new Uint8Array(4)); await Promise.resolve(); expect(f.sent).toHaveLength(0); });
    it('resume partial cancellation cannot accept a late size', async () => { let f: any; const gate = deferred<any>(); let entered = false; f = fixture(cap + 17, { sendChunk: async (p: any) => { f.sent.push(p); f.task.pause(); }, queryPartial: async () => { entered = true; return gate.promise; } }); await f.task.run(); const run = f.task.resume(); while (!entered)
        await new Promise(r => setTimeout(r, 1)); f.task.cancel(); await expect(run).rejects.toMatchObject({ code: 'REQUEST_CANCELLED', mayHavePartial: true }); gate.resolve({ size: cap }); await Promise.resolve(); expect(f.sent).toHaveLength(1); });
    it('hash callbacks use reviewed progress object and reentry cancellation fences', async () => { const f = fixture(4); const calls: any[] = []; await expect(f.task.run({ onHashProgress: (processed, total) => { calls.push([processed, total]); f.task.cancel(); } })).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' }); expect(calls).toEqual([[4, 4]]); expect(f.sent).toHaveLength(0); });
    it('a late paused hash settlement cannot disturb a resumed run', async () => { const f = fixture(4); const original = f.source.hash; const old = deferred<any>(); let hashes = 0, sending = false; f.source.hash = async (path, options) => ++hashes === 1 ? old.promise : original(path, options); const first = f.task.run(); while (!hashes)
        await new Promise(r => setTimeout(r, 1)); f.task.pause(); await first; const second = f.task.resume({ onHashProgress: () => { sending = true; } }); while (!sending)
        await new Promise(r => setTimeout(r, 1)); old.resolve({}); await Promise.resolve(); const final = await second; expect(final.phase).toBe('completed'); expect(f.sent).toHaveLength(1); });
    it('callback failure is static and retains partial', async () => { const f = fixture(4); const error = await f.task.run({ onProgress: () => { throw new Error('private token /local/path'); } }).catch(e => e); expect(error).toMatchObject({ code: 'UPLOAD_FAILED', mayHavePartial: true }); expect(String(error)).not.toMatch(/private|token|local/); expect(f.task.snapshot().phase).toBe('failed'); });
});
describe('hash lifetime versus bounded network waits', () => {
    it('does not timebox a whole large-source hash at30seconds', async () => {
        const f = fixture(4);
        const hashes = await f.source.hash('/新目录/文件.bin', {});
        const gate = deferred<any>();
        let entered = false;
        f.source.hash = async () => { entered = true; return gate.promise; };
        vi.useFakeTimers();
        try {
            const run = f.task.run();
            void run.catch(() => { });
            while (!entered)
                await Promise.resolve();
            await vi.advanceTimersByTimeAsync(30001);
            expect(f.task.snapshot().phase).toBe('hashing');
            gate.resolve(hashes);
            await run;
            expect(f.task.snapshot().phase).toBe('completed');
        }
        finally {
            vi.useRealTimers();
        }
    });
});

describe('retained partial identity', () => {
  it.each([{path:'/different/file'},{uuid:'b'.repeat(40)}])('rejects optional echoed identity mismatch %#', async identity => {
    let f: ReturnType<typeof fixture>;
    f = fixture(cap+17, {
      sendChunk: async (piece: any) => { f.sent.push(piece); f.task.pause(); },
      queryPartial: async () => ({size:cap,...identity}),
    });
    await f.task.run();
    await expect(f.task.resume()).rejects.toMatchObject({code:'UPLOAD_PARTIAL_MISMATCH',mayHavePartial:true});
    expect(f.sent).toHaveLength(1);
  });
});

describe('optional upload target echo', () => {
  it.each([{path:'/unexpected'},{name:'renamed.bin'}])('rejects renamed success target %#', value => {
    expect(() => verifyUploadReplyTarget(value,'/新目录/文件.bin')).toThrowError(expect.objectContaining({code:'UPLOAD_TARGET_UNVERIFIED',mayHavePartial:true}));
  });
  it('does not fabricate required upload response fields', () => {
    expect(() => verifyUploadReplyTarget({},'/新目录/文件.bin')).not.toThrow();
    expect(() => verifyUploadReplyTarget({path:'/新目录/文件.bin',name:'文件.bin'},'/新目录/文件.bin')).not.toThrow();
  });
});


describe('review regressions: caller continuation ownership', () => {
  it.each(['send','final'] as const)('rejects cancellation after inner %s acceptance before caller mutation', async stage => {
    let f: ReturnType<typeof fixture>, before: ReturnType<typeof f.task.snapshot> | undefined;
    const progress: number[] = [];
    const later = (remaining: number) => queueMicrotask(() => {
      if (remaining) later(remaining - 1);
      else { before = f.task.snapshot(); f.task.cancel(); }
    });
    f = fixture(4, {
      sendChunk: async (piece: any) => { f.sent.push(piece); if (stage === 'send') later(4); },
      readFinalInfo: async () => { if (stage === 'final') later(4); return {path:'/新目录/文件.bin',name:'文件.bin',is_dir:false,size:4}; },
    });
    const outcome = await f.task.run({onProgress: state => progress.push(state.confirmedBytes)})
      .then(value => ({value,error:undefined}), error => ({value:undefined,error}));
    // These assertions validate the cancellation schedule, rather than accepting an earlier cancel.
    expect(before).toMatchObject({phase:stage==='send'?'uploading':'verifying',confirmedBytes:stage==='send'?0:4,mayHavePartial:true});
    expect(outcome.error).toMatchObject({code:'REQUEST_CANCELLED',mayHavePartial:true});
    expect(outcome.value).toBeUndefined();
    expect(f.task.snapshot()).toMatchObject({phase:'cancelled',confirmedBytes:stage==='send'?0:4,mayHavePartial:true});
    expect(progress).toEqual(stage==='send'?[]:[4]);
    expect(f.sent).toHaveLength(1);
  });
});

describe('review regressions: pause at checking boundary', () => {
  it.each(['verifyParent','verifyTarget'] as const)('initial pause during pending %s starts no new hash', async stage => {
    const check = deferred<void>(), hash = deferred<UploadHashes>();
    let entered = false, hashes = 0;
    const f = fixture(4,{[stage]:async()=>{entered=true;await check.promise;}});
    f.source.hash=async()=>{hashes++;return hash.promise;};
    const run=f.task.run();void run.catch(()=>{});
    while(!entered)await new Promise(r=>setTimeout(r,1));
    f.task.pause();expect(f.task.snapshot().phase).toBe('pausing');check.resolve();
    // Let the already-resolved check's nested continuations settle; the hash remains held.
    await new Promise(r=>setTimeout(r,1));
    const atBoundary=f.task.snapshot(), hashCalls=hashes;
    if(atBoundary.phase!=='paused')f.task.cancel();
    await run.catch(()=>{});
    expect(hashCalls).toBe(0);
    expect(atBoundary).toMatchObject({phase:'paused',confirmedBytes:0,mayHavePartial:false});
    expect(f.sent).toHaveLength(0);
  });
  it('resumed pause during parent validation retains confirmed bytes without rehash', async()=>{
    const check=deferred<void>(), hash=deferred<UploadHashes>();let parentCalls=0, entered=false, hashes=0;
    let f:ReturnType<typeof fixture>;
    f=fixture(cap+17,{
      verifyParent:async()=>{if(++parentCalls===2){entered=true;await check.promise;}},
      sendChunk:async(piece:any)=>{f.sent.push(piece);f.task.pause();},
    });
    await f.task.run();const original=f.source.hash;
    f.source.hash=async()=>{hashes++;return hash.promise;};
    const resumed=f.task.resume();void resumed.catch(()=>{});
    while(!entered)await new Promise(r=>setTimeout(r,1));
    f.task.pause();check.resolve();await new Promise(r=>setTimeout(r,1));
    const atBoundary=f.task.snapshot(),hashCalls=hashes;
    if(atBoundary.phase!=='paused')f.task.cancel();await resumed.catch(()=>{});
    expect(hashCalls).toBe(0);expect(atBoundary).toMatchObject({phase:'paused',confirmedBytes:cap,mayHavePartial:true});
    expect(f.sent.map(piece=>piece.seek)).toEqual([0]);
    // The original source remains available; hash-only pause never releases it.
    f.source.hash=original;
  });
});

describe('review regressions: partial and static diagnostics',()=>{
  it('merges typed tmpinfo HTTP failure with retained partial uncertainty',async()=>{
    let queries=0, f:ReturnType<typeof fixture>;
    f=fixture(cap+17,{
      sendChunk:async(piece:any)=>{f.sent.push(piece);f.task.pause();},
      queryPartial:async()=>{queries++;throw new OfficialUploadError('NAS_HTTP_ERROR',false,502);},
    });
    await f.task.run();expect(f.task.snapshot()).toMatchObject({phase:'paused',confirmedBytes:cap,mayHavePartial:true});
    await expect(f.task.resume()).rejects.toMatchObject({code:'NAS_HTTP_ERROR',status:502,mayHavePartial:true});
    expect(f.task.snapshot()).toMatchObject({phase:'failed',confirmedBytes:cap,mayHavePartial:true});
    expect(f.sent.map(piece=>piece.seek)).toEqual([0]);expect(queries).toBe(1);
  });
  it.each([false,true])('unknown callback code never echoes through public error (typed=%s)',async typed=>{
    const f=fixture(4);const code='SYNTHETIC_PRIVATE_TOKEN_123';
    const error=await f.task.run({onProgress:()=>{throw typed?new OfficialUploadError(code,false,401):{code,status:401};}}).catch(e=>e);
    expect(error).toMatchObject({code:'UPLOAD_FAILED',status:502,mayHavePartial:true});
    expect(JSON.stringify(error)).not.toContain(code);expect(String(error)).not.toContain(code);
  });
  it.each([
    {code:'SOURCE_CHANGED',status:502},
    {code:'WORKER_UNAVAILABLE',status:502},
    {code:'SESSION_EXPIRED',status:401},
    {code:'NAS_BUSINESS_ERROR',status:502},
    {code:'UPLOAD_TIMEOUT',status:504},
  ])('preserves recognized static code/status $code',async diagnostic=>{
    const f=fixture(4,{verifyParent:async()=>{throw diagnostic;}});
    await expect(f.task.run()).rejects.toMatchObject({...diagnostic,mayHavePartial:false});
  });
});

it('review regressions: resumed pending target pause starts no new hash at zero boundary', async () => {
  const target = deferred<void>(), firstHash = deferred<UploadHashes>();
  let targetCalls = 0, hashStarted = false, resumedHashes = 0;
  const f = fixture(4, {verifyTarget:async()=>{if(++targetCalls===2)await target.promise;}});
  const actualHash=f.source.hash;
  f.source.hash=async()=>{hashStarted=true;return firstHash.promise;};
  const initial=f.task.run();
  while(!hashStarted)await new Promise(r=>setTimeout(r,1));
  f.task.pause();await initial;
  f.source.hash=async(path,options)=>{resumedHashes++;return actualHash(path,options);};
  const resumed=f.task.resume();void resumed.catch(()=>{});
  while(targetCalls<2)await new Promise(r=>setTimeout(r,1));
  f.task.pause();target.resolve();await resumed;
  expect(resumedHashes).toBe(0);
  expect(f.task.snapshot()).toMatchObject({phase:'paused',confirmedBytes:0,mayHavePartial:false});
  expect(f.sent).toHaveLength(0);
  firstHash.resolve(await actualHash('/新目录/文件.bin',{}));
});

it('review regressions: owner revocation in final caller continuation cannot complete', async () => {
  let current=true, before:ReturnType<ReturnType<typeof fixture>['task']['snapshot']>|undefined;
  let f:ReturnType<typeof fixture>;
  const later=(remaining:number)=>queueMicrotask(()=>{
    if(remaining)later(remaining-1);
    else {before=f.task.snapshot();current=false;}
  });
  f=fixture(4,{
    assertCurrent:()=>{if(!current)throw new OfficialUploadError('REQUEST_CANCELLED');},
    readFinalInfo:async()=>{later(4);return {path:'/新目录/文件.bin',name:'文件.bin',is_dir:false,size:4};},
  });
  await expect(f.task.run()).rejects.toMatchObject({code:'REQUEST_CANCELLED',mayHavePartial:true});
  expect(before).toMatchObject({phase:'verifying',confirmedBytes:4});
  expect(f.task.snapshot()).toMatchObject({phase:'failed',confirmedBytes:4,mayHavePartial:true});
});

it('review regressions: typed uncertainty merges into retained task before local dispatch', async () => {
  const f=fixture(4,{verifyParent:async()=>{throw new OfficialUploadError('NAS_HTTP_ERROR',true,502);}});
  await expect(f.task.run()).rejects.toMatchObject({code:'NAS_HTTP_ERROR',status:502,mayHavePartial:true});
  expect(f.task.snapshot()).toMatchObject({phase:'failed',confirmedBytes:0,mayHavePartial:true});
  expect(f.sent).toHaveLength(0);
});

it('review regressions: callback diagnostic getters cannot throw a raw replacement error', async () => {
  const f=fixture(4);
  const error=await f.task.run({onProgress:()=>{throw {get code(){throw new Error('SYNTHETIC_PRIVATE_TOKEN_123');}};}}).catch(e=>e);
  expect(error).toMatchObject({code:'UPLOAD_FAILED',status:502,mayHavePartial:true});
  expect(String(error)).not.toContain('SYNTHETIC_PRIVATE_TOKEN_123');
});
