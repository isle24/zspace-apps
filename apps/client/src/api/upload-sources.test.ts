import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as sources from './upload-sources';
import { hashUpload, UPLOAD_HASH_CHUNK_SIZE as CAP } from './upload-hashes';
const native = { id: 'a'.repeat(64), name: '选定.bin', size: 3, lastModified: 7, sessionId: 'public-session' };
const digest = (kind: string, data: string | Uint8Array) => createHash(kind).update(data).digest('hex');
const result = { size: 3, uuid: digest('sha1', '10/目标/选定.bin'), quickHash: digest('sha1', '3abc'), md5: digest('md5', 'abc'), sha256: digest('sha256', 'abc') };
function fixture(meta = native) {
  let callback: (event: { payload: unknown }) => void = () => {};
  const unlisten = vi.fn();
  const listen = vi.fn(async (_: string, cb: typeof callback) => { callback = cb; return unlisten; });
  const invoke = vi.fn(async (cmd: string) => {
    if (cmd === 'nas_upload_read') return new Uint8Array([97,98,99]);
    if (cmd === 'nas_upload_hash') { const args = invoke.mock.calls.at(-1)![1] as any; callback({ payload: { operationId: args.operationId, sourceId: meta.id, sessionId: meta.sessionId, processedBytes: meta.size, totalBytes: meta.size } }); return result; }
  }) as any;
  const adapter = sources.createNativeUploadSource(meta, () => true, { core: async () => ({ invoke }), events: async () => ({ listen }) });
  return { adapter, invoke, listen, unlisten, emit: (payload: unknown) => callback({ payload }) };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (value: unknown) => void; const promise = new Promise<T>((yes,no) => {resolve=yes;reject=no;}); return {promise,resolve,reject}; }
const tick = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };
describe('selected upload adapters', () => {
  it('exports narrow source factories', () => { expect(sources.createBrowserUploadSource).toBeTypeOf('function'); expect(sources.createNativeUploadSource).toBeTypeOf('function'); });
  it('reads a browser source sequentially at cap plus tail and hashes all real bytes', async () => {
    const bytes = new Uint8Array(CAP+17).map((_,i) => i%251);
    const file = new File([bytes], 'test.bin', {lastModified: 7});
    const slices: number[][] = [];
    vi.spyOn(file,'slice').mockImplementation((start=0,end=file.size) => { slices.push([start,end]); return { arrayBuffer: async () => bytes.slice(start,end).buffer } as Blob; });
    const adapter = sources.createBrowserUploadSource(file, () => true);
    const hashes = await hashUpload(adapter,'/目标/test.bin');
    expect(hashes.md5).toBe(digest('md5',bytes)); expect(hashes.sha256).toBe(digest('sha256',bytes));
    expect(slices).toEqual([[0,CAP],[CAP,CAP+17]]);
    await expect(adapter.read(0,CAP+1,new AbortController().signal)).rejects.toMatchObject({code:'INVALID_SOURCE'});
    expect(Object.isFrozen(adapter)).toBe(true);
  });
  it('checks zero reads, captured metadata and old ownership', async () => {
    let current=true; const file = new File([], 'empty', {lastModified:0});
    vi.spyOn(file,'slice').mockReturnValue({arrayBuffer:async()=>new ArrayBuffer(0)} as Blob);
    const adapter = sources.createBrowserUploadSource(file,()=>current);
    expect(await adapter.read(0,0,new AbortController().signal)).toEqual(new Uint8Array());
    current=false; await expect(adapter.read(0,0,new AbortController().signal)).rejects.toMatchObject({code:'CANCELLED'});
  });
  it.each(['../bad','a/b','a\\b','\u0000',' ','.','..','中'.repeat(86),'\ud800'])('rejects unsafe basename %j without echo', name => {
    const file=new File([],name,{lastModified:0}); Object.defineProperty(file,'name',{value:name});
    expect(()=>sources.createBrowserUploadSource(file,()=>true)).toThrow('Invalid upload source');
  });
  it.each([[],[1,2,3],new Uint8Array(2),new ArrayBuffer(4),'private/path'].map(value=>[value]))('rejects wrong native binary response %j', async value => {
    const f=fixture(); f.invoke.mockResolvedValue(value); await expect(f.adapter.read(0,3,new AbortController().signal)).rejects.toMatchObject({code:'SOURCE_READ_FAILED'});
  });
  it('accepts exact raw ArrayBuffer and preserves source on exact hash cancel',async()=> {
    const f=fixture(); f.invoke.mockResolvedValueOnce(new Uint8Array([97,98,99]).buffer);
    expect(await f.adapter.read(0,3,new AbortController().signal)).toEqual(new Uint8Array([97,98,99]));
    const pending=deferred<unknown>(); f.invoke.mockImplementation((cmd:string)=>cmd==='nas_upload_hash'?pending.promise:Promise.resolve());
    const c=new AbortController(); const hash=f.adapter.hash('/目标/选定.bin',{signal:c.signal}); await tick(); c.abort();
    await expect(hash).rejects.toMatchObject({code:'CANCELLED'}); expect(f.unlisten).toHaveBeenCalledTimes(1);
    const args=f.invoke.mock.calls.find((x:any[])=>x[0]==='nas_upload_hash')[1];
    expect(f.invoke).toHaveBeenCalledWith('nas_upload_hash_cancel',{id:native.id,sessionId:native.sessionId,operationId:args.operationId});
    expect(f.invoke.mock.calls.some((x:any[])=>x[0]==='nas_upload_release')).toBe(false);
    pending.reject(new Error('private/path')); await tick();
  });
  it('registers before invoke and validates independent result UUID/hashes', async()=> {
    const f=fixture(); expect(await f.adapter.hash('/目标/选定.bin')).toEqual(result);
    expect(f.listen).toHaveBeenCalledWith('nas-upload-hash-progress',expect.any(Function)); expect(f.unlisten).toHaveBeenCalledTimes(1);
  });
  it.each([{...result,uuid:'b'.repeat(40)}, {...result,extra:'private'}, {...result,md5:'A'.repeat(32)}, {...result,size:4}])('rejects malformed result',async value=> {
    const f=fixture(); const initial=f.invoke.getMockImplementation(); f.invoke.mockImplementation(async(cmd:string,args:any)=> {if(cmd==='nas_upload_hash'){ await initial(cmd,args); return value;} });
    await expect(f.adapter.hash('/目标/选定.bin')).rejects.toMatchObject({code:'NATIVE_PROTOCOL_ERROR'}); expect(f.unlisten).toHaveBeenCalledTimes(1);
  });
  it('ignores stale identities and rejects matching malformed progress',async()=> {
    const f=fixture(); f.invoke.mockImplementation(async(cmd:string,args:any)=> { if(cmd==='nas_upload_hash') { f.emit({operationId:'old',sourceId:native.id,sessionId:native.sessionId,processedBytes:3,totalBytes:3}); f.emit({operationId:args.operationId,sourceId:native.id,sessionId:native.sessionId,processedBytes:4,totalBytes:3}); return result; } });
    const progress=vi.fn(); await expect(f.adapter.hash('/目标/选定.bin',{onProgress:progress})).rejects.toMatchObject({code:'NATIVE_PROTOCOL_ERROR'}); expect(progress).not.toHaveBeenCalled();
  });
  it('rejects reentrant callback cancellation immediately and ignores late events',async()=> {
    const f=fixture(); const c=new AbortController(); const progress=vi.fn(()=>c.abort());
    await expect(f.adapter.hash('/目标/选定.bin',{signal:c.signal,onProgress:progress})).rejects.toMatchObject({code:'CANCELLED'}); expect(progress).toHaveBeenCalledTimes(1); expect(f.unlisten).toHaveBeenCalledTimes(1);
  });
  it('cancels stalled read promptly and handles eventual rejection',async()=> {
    const f=fixture(); const pending=deferred<unknown>(); f.invoke.mockReturnValue(pending.promise); const c=new AbortController();
    const read=f.adapter.read(0,3,c.signal); await tick(); c.abort(); await expect(read).rejects.toMatchObject({code:'CANCELLED'}); pending.reject(new Error('private')); await tick();
  });
  it('releases source once and revokes in-flight operations',async()=> { const f=fixture(); await f.adapter.release(); await f.adapter.release(); expect(f.invoke).toHaveBeenCalledTimes(1); await expect(f.adapter.hash('/目标/选定.bin')).rejects.toMatchObject({code:'CANCELLED'}); });
});

describe('upload adapter asynchronous ownership fences',()=> {
  it('preserves explicit Worker unavailable error through the adapter',async()=> {
    vi.stubGlobal('Worker',undefined);
    try { const adapter=sources.createBrowserUploadSource(new File([],'empty',{lastModified:0}),()=>true); await expect(adapter.hash('/empty')).rejects.toMatchObject({code:'WORKER_UNAVAILABLE'}); }
    finally {vi.unstubAllGlobals();}
  });
  it.each(['core','events','listen'] as const)('cancels hash while %s is pending and cleans late listener',async stage=> {
    const pending=deferred<any>(), unlisten=vi.fn(), invoke=vi.fn(); let listen=vi.fn(async()=>unlisten);
    if(stage==='listen')listen=vi.fn(()=>pending.promise);
    const boundary={core:()=>stage==='core'?pending.promise:Promise.resolve({invoke}),events:()=>stage==='events'?pending.promise:Promise.resolve({listen})};
    const adapter=sources.createNativeUploadSource(native,()=>true,boundary); const c=new AbortController(); const hash=adapter.hash('/目标/选定.bin',{signal:c.signal}); await tick(); c.abort();
    await expect(hash).rejects.toMatchObject({code:'CANCELLED'});
    pending.resolve(stage==='listen'?unlisten:stage==='core'?{invoke}:{listen}); await tick(); expect(invoke).not.toHaveBeenCalled(); expect(unlisten).toHaveBeenCalledTimes(stage==='listen'?1:0);
  });
  it('cancels read during core import before native dispatch',async()=> {
    const pending=deferred<any>(),invoke=vi.fn(); const adapter=sources.createNativeUploadSource(native,()=>true,{core:()=>pending.promise,events:async()=>({listen:vi.fn()})});
    const c=new AbortController(); const read=adapter.read(0,0,c.signal); c.abort(); await expect(read).rejects.toMatchObject({code:'CANCELLED'}); pending.resolve({invoke}); await tick(); expect(invoke).not.toHaveBeenCalled();
  });
  it.each(['duplicate','backwards','jump','extra','fraction','negative','wrong-total'] as const)('rejects matching %s progress before accepting result',async kind=> {
    const f=fixture(); f.invoke.mockImplementation(async(cmd:string,args:any)=> {if(cmd!=='nas_upload_hash')return;
      const payload={operationId:args.operationId,sourceId:native.id,sessionId:native.sessionId,processedBytes:2,totalBytes:3}; f.emit(payload);
      f.emit(kind==='extra'?{...payload,extra:'private'}:kind==='wrong-total'?{...payload,totalBytes:4}:{...payload,processedBytes:kind==='duplicate'?2:kind==='backwards'?1:kind==='jump'?4:kind==='fraction'?2.5:-1}); return result;
    });
    await expect(f.adapter.hash('/目标/选定.bin')).rejects.toMatchObject({code:'NATIVE_PROTOCOL_ERROR'}); expect(f.unlisten).toHaveBeenCalledTimes(1);
  });
  it('ignores all three stale identities and validates exact cap progress',async()=> {
    const f=fixture(); const progress=vi.fn(); f.invoke.mockImplementation(async(cmd:string,args:any)=> {if(cmd!=='nas_upload_hash')return;
      const p={operationId:args.operationId,sourceId:native.id,sessionId:native.sessionId,processedBytes:3,totalBytes:3};
      for(const key of ['operationId','sourceId','sessionId']) f.emit({...p,[key]:'old',extra:'private'}); f.emit(p); return result;
    }); expect(await f.adapter.hash('/目标/选定.bin',{onProgress:progress})).toEqual(result); expect(progress).toHaveBeenCalledTimes(1);
  });
  it('rejects progress greater than2MiB even when below source size',async()=> {
    const f=fixture({...native,size:CAP+17}); f.invoke.mockImplementation(async(cmd:string,args:any)=> {if(cmd==='nas_upload_hash'){f.emit({operationId:args.operationId,sourceId:native.id,sessionId:native.sessionId,processedBytes:CAP+1,totalBytes:CAP+17});return result;} });
    await expect(f.adapter.hash('/目标/选定.bin')).rejects.toMatchObject({code:'NATIVE_PROTOCOL_ERROR'});
  });
  it('native empty hash requires one terminal event and independent empty digests',async()=> {
    const f=fixture({...native,size:0,lastModified:0}); f.invoke.mockImplementation(async(cmd:string,args:any)=> {if(cmd==='nas_upload_read')return new ArrayBuffer(0); if(cmd==='nas_upload_hash'){f.emit({operationId:args.operationId,sourceId:native.id,sessionId:native.sessionId,processedBytes:0,totalBytes:0});return {size:0,uuid:digest('sha1','0/empty'),quickHash:digest('sha1','0'),md5:digest('md5',''),sha256:digest('sha256','')};} });
    expect(await f.adapter.read(0,0,new AbortController().signal)).toEqual(new Uint8Array()); expect((await f.adapter.hash('/empty')).md5).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });
  it('rechecks original metadata after read including zero bytes',async()=> {
    const meta={...native,size:0}; const pending=deferred<any>();const invoke=vi.fn(()=>pending.promise);const adapter=sources.createNativeUploadSource(meta,()=>true,{core:async()=>({invoke:invoke as any}),events:async()=>({listen:vi.fn()})});
    const read=adapter.read(0,0,new AbortController().signal); await tick(); meta.lastModified=8; pending.resolve(new ArrayBuffer(0)); await expect(read).rejects.toMatchObject({code:'SOURCE_CHANGED'});
  });
  it('listener rejection and invoke rejection use static errors and clean all owned listeners',async()=> {
    const f=fixture(); f.listen.mockRejectedValueOnce(new Error('/private/token'));
    await expect(f.adapter.hash('/目标/选定.bin')).rejects.toMatchObject({code:'HASH_FAILED',message:'Could not hash upload source'}); expect(f.invoke).not.toHaveBeenCalled();
    f.invoke.mockRejectedValueOnce(new Error('/private/token')); await expect(f.adapter.hash('/目标/选定.bin')).rejects.toMatchObject({code:'HASH_FAILED'}); expect(f.unlisten).toHaveBeenCalledTimes(1);
  });
  it('sanitizes unlisten throws and callback throws without reviving old frames',async()=> {
    const f=fixture(); f.unlisten.mockImplementation(()=>{throw new Error('/private/token');});const progress=vi.fn(()=>{throw new Error('/private/token');});
    await expect(f.adapter.hash('/目标/选定.bin',{onProgress:progress})).rejects.toMatchObject({code:'HASH_FAILED',message:'Could not hash upload source'}); expect(progress).toHaveBeenCalledTimes(1);
  });
});

describe('source static errors and terminal ownership',()=> {
  it.each([{...native,size:-1},{...native,lastModified:0.5},{...native,size:Number.MAX_SAFE_INTEGER,lastModified:1},{...native,sessionId:'/private/path'}])('rejects invalid native metadata', meta=> {
    expect(()=>sources.createNativeUploadSource(meta,()=>true)).toThrow();
  });
  it('sanitizes random identity failures and releases the operation slot',async()=> {
    const f=fixture(); const random=vi.spyOn(crypto,'getRandomValues').mockImplementationOnce(()=>{throw new Error('/private/token');});
    try {await expect(f.adapter.hash('/目标/选定.bin')).rejects.toMatchObject({code:'HASH_FAILED',message:'Could not hash upload source'}); expect(await f.adapter.hash('/目标/选定.bin')).toEqual(result);}
    finally {random.mockRestore();}
  });
  it('sanitizes synchronous release import failures and remains idempotent',async()=> {
    const core=vi.fn(()=>{throw new Error('/private/token');});const adapter=sources.createNativeUploadSource(native,()=>true,{core,events:async()=>({listen:vi.fn()})});
    await expect(adapter.release()).rejects.toMatchObject({code:'SOURCE_RELEASE_FAILED'}); await expect(adapter.release()).rejects.toMatchObject({code:'SOURCE_RELEASE_FAILED'}); expect(core).toHaveBeenCalledTimes(1);
  });
  it('revokes a source from terminal callback and prevents a late terminal result',async()=> {
    const f=fixture(); await expect(f.adapter.hash('/目标/选定.bin',{onProgress:()=>{void f.adapter.release();}})).rejects.toMatchObject({code:'CANCELLED'});
    expect(f.unlisten).toHaveBeenCalledTimes(1); expect(f.invoke.mock.calls.filter((x:any[])=>x[0]==='nas_upload_release')).toHaveLength(1);
  });
});

it('browser adapter uses the existing production Worker wrapper without main-thread whole-file reads',async()=> {
  const {installUploadHashWorker}=await import('../workers/upload-hash.worker');
  const bytes=new Uint8Array(CAP+17).map((_,i)=>i%251), file=new File([bytes],'chosen.bin',{lastModified:7});
  const slices:number[][]=[]; vi.spyOn(file,'slice').mockImplementation((start=0,end=file.size)=>{slices.push([start,end]);return {arrayBuffer:async()=>bytes.slice(start,end).buffer} as Blob;});
  const whole=vi.fn(()=>{throw new Error('Whole source read is forbidden');});Object.defineProperty(file,'arrayBuffer',{value:whole}); const posted:any[]=[]; const listeners=new Map<string,Set<(event:any)=>void>>();
  let receive!:(event:any)=>void;
  const dispose=installUploadHashWorker({postMessage:message=> {for(const cb of listeners.get('message')??[])cb({data:message});},addEventListener:(_type,cb)=>{receive=cb;},removeEventListener:()=>{},close:()=>{}});
  const terminate=vi.fn(dispose), worker={postMessage:(message:any)=>{posted.push(message);receive({data:message});},addEventListener:(type:string,cb:any)=>{const set=listeners.get(type)??new Set();set.add(cb);listeners.set(type,set);},removeEventListener:(type:string,cb:any)=>{listeners.get(type)?.delete(cb);},terminate};
  vi.stubGlobal('Worker',vi.fn(function(){return worker;}));
  try {
    const adapter=sources.createBrowserUploadSource(file,()=>true); const hashes=await adapter.hash('/目标/chosen.bin');
    expect(hashes.md5).toBe(digest('md5',bytes));expect(hashes.sha256).toBe(digest('sha256',bytes));expect(hashes.uuid).toBe(digest('sha1',String(bytes.length+7)+'/目标/chosen.bin'));
    expect(slices).toEqual([[0,CAP],[CAP,CAP+17]]);expect(whole).not.toHaveBeenCalled();expect(terminate).toHaveBeenCalledTimes(1);expect(Object.keys(posted[0]).sort()).toEqual(['file','operationId','targetPath','type']);
  } finally {vi.unstubAllGlobals();dispose();}
});
it('native adapter reads cap plus tail with exact offsets and never requests whole source',async()=> {
  const meta={...native,size:CAP+17}; const f=fixture(meta);
  f.invoke.mockImplementation(async(cmd:string,args:any)=> {if(cmd==='nas_upload_read')return new Uint8Array(args.length).fill(args.offset?8:7);});
  expect((await f.adapter.read(0,CAP,new AbortController().signal)).length).toBe(CAP);
  expect(await f.adapter.read(CAP,17,new AbortController().signal)).toEqual(new Uint8Array(17).fill(8));
  expect(f.invoke.mock.calls.map((call:any[])=>call[1])).toEqual([{id:meta.id,sessionId:meta.sessionId,offset:0,length:CAP},{id:meta.id,sessionId:meta.sessionId,offset:CAP,length:17}]);
  for(const [offset,length] of [[-1,0],[0,0.5],[CAP+17,1],[Number.MAX_SAFE_INTEGER,1],[0,CAP+1]])await expect(f.adapter.read(offset,length,new AbortController().signal)).rejects.toMatchObject({code:'INVALID_SOURCE'});
  expect(f.invoke).toHaveBeenCalledTimes(2);
});
