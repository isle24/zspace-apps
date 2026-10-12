import { hashBrowserUpload } from './upload-hashing';
import { computeUploadUUID, validateUploadHashInput, UPLOAD_HASH_CHUNK_SIZE, UploadHashError,
  type UploadHashSource, type UploadHashes, type UploadHashOptions } from './upload-hashes';

export interface UploadSourceDescriptor { sourceId: string; name: string; size: number; lastModified: number; sessionId: string; }
/** SDK internal: never return this capability in a UI/task descriptor. */
export interface UploadSourceAdapter extends UploadHashSource {
  hash(targetPath: string, options?: UploadHashOptions): Promise<UploadHashes>;
  release(): Promise<void>;
}
export interface NativeUploadSource { id: string; name: string; size: number; lastModified: number; sessionId: string; }
type Invoke = <T = unknown>(command: string, args: Record<string, unknown>) => Promise<T>;
type Listen = (event: string, callback: (event: { payload: unknown }) => void) => Promise<() => void>;
/** Narrow dynamic native boundaries; no URL, header or filesystem access. */
export interface UploadNativeBoundary {
  core(): Promise<{ invoke: Invoke }>;
  events(): Promise<{ listen: Listen }>;
}
const nativeBoundary: UploadNativeBoundary = {
  core: () => import('@tauri-apps/api/core'),
  events: () => import('@tauri-apps/api/event'),
};
const messages = {
  INVALID_SOURCE: 'Invalid upload source', SOURCE_CHANGED: 'Upload source changed',
  SOURCE_READ_FAILED: 'Could not read upload source', CANCELLED: 'Upload source operation cancelled',
  HASH_FAILED: 'Could not hash upload source', NATIVE_PROTOCOL_ERROR: 'Invalid native upload source response',
  SOURCE_RELEASE_FAILED: 'Could not release upload source', BUSY: 'Upload source operation is busy',
} as const;
export class UploadSourceError extends Error {
  constructor(public readonly code: keyof typeof messages) { super(messages[code]); this.name = 'UploadSourceError'; }
}
const failure = (code: keyof typeof messages) => new UploadSourceError(code);
function exact(value: unknown, fields: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(k => Object.hasOwn(value, k));
}
const hex = (v: unknown, length: number): v is string => typeof v === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(v);
export function validateUploadSourceMetadata(name: unknown, size: unknown, lastModified: unknown): void {
  try {
    if (typeof name !== 'string' || /[/\\]/.test(name)) throw 0;
    validateUploadHashInput(size as number, lastModified as number, '/' + name);
  } catch { throw failure('INVALID_SOURCE'); }
}
export function validateNativeUploadSource(value: unknown, sessionId: string): NativeUploadSource {
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(sessionId) || !exact(value, ['id','name','size','lastModified','sessionId']) || !hex(value.id,64) || value.sessionId !== sessionId)
    throw failure('NATIVE_PROTOCOL_ERROR');
  validateUploadSourceMetadata(value.name,value.size,value.lastModified);
  return { id: value.id, name: value.name as string, size: value.size as number, lastModified: value.lastModified as number, sessionId };
}
function operationId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2,'0')).join('');
}
/** Races only renderer ownership. A late native promise remains handled. */
function ownedAwait<T>(pending: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve,reject) => {
    let ended = false;
    const cancel = () => { if (ended) return; ended=true; signal.removeEventListener('abort',cancel); reject(failure('CANCELLED')); };
    signal.addEventListener('abort',cancel,{once:true});
    Promise.resolve(pending).then(value => {
      signal.removeEventListener('abort',cancel);
      if (ended) { try { late?.(value); } catch { /* Late cleanup has no authority. */ } return; }
      ended=true; if (signal.aborted) { try { late?.(value); } catch {} reject(failure('CANCELLED')); } else resolve(value);
    }, error => { signal.removeEventListener('abort',cancel); if (!ended) { ended=true; reject(signal.aborted ? failure('CANCELLED') : error instanceof UploadHashError || error instanceof UploadSourceError ? error : failure('HASH_FAILED')); } });
    if (signal.aborted) cancel();
  });
}
function lifetime(current: () => boolean, metadata: () => boolean) {
  let released = false, busy = false;
  const controllers = new Set<AbortController>();
  const assert = (signal?: AbortSignal) => {
    if (released || signal?.aborted || !current()) throw failure('CANCELLED');
    let same = false; try { same=metadata(); } catch {}
    if (!same) throw failure('SOURCE_CHANGED');
  };
  return {
    assert,
    begin(signal?: AbortSignal) {
      assert(signal); if (busy) throw failure('BUSY'); busy=true;
      const controller=new AbortController(); controllers.add(controller);
      const cancel=()=>controller.abort(); signal?.addEventListener('abort',cancel,{once:true});
      if (signal?.aborted) controller.abort();
      return { signal:controller.signal, end:()=> { controllers.delete(controller); signal?.removeEventListener('abort',cancel); busy=false; } };
    },
    release() { if (released) return false; released=true; for(const c of controllers)c.abort(); return true; },
  };
}
function range(size: number, offset: number, length: number) {
  if (!Number.isSafeInteger(offset) || offset<0 || !Number.isSafeInteger(length) || length<0 || length>UPLOAD_HASH_CHUNK_SIZE || !Number.isSafeInteger(offset+length) || offset+length>size)
    throw failure('INVALID_SOURCE');
}
export function createBrowserUploadSource(file: File, current: () => boolean): UploadSourceAdapter {
  let size: number, lastModified: number, name: string;
  try { if (typeof File !== 'function' || !(file instanceof File)) throw 0; size=file.size; lastModified=file.lastModified; name=file.name; }
  catch { throw failure('INVALID_SOURCE'); }
  validateUploadSourceMetadata(name,size,lastModified);
  const owner=lifetime(current,()=>file.size===size && file.lastModified===lastModified && file.name===name);
  return Object.freeze({ size,lastModified,
    async read(offset: number,length: number,signal: AbortSignal) {
      const op=owner.begin(signal);
      try {
        range(size,offset,length); owner.assert(op.signal);
        const bytes=await ownedAwait(file.slice(offset,offset+length).arrayBuffer(),op.signal);
        owner.assert(op.signal);
        if (!(bytes instanceof ArrayBuffer) || bytes.byteLength!==length) throw failure('SOURCE_READ_FAILED');
        return new Uint8Array(bytes);
      } catch(error) { if(error instanceof UploadSourceError && error.code!=='HASH_FAILED')throw error; throw failure(op.signal.aborted?'CANCELLED':'SOURCE_READ_FAILED'); }
      finally { op.end(); }
    },
    async hash(targetPath: string,options: UploadHashOptions={}) {
      const op=owner.begin(options.signal);
      try {
        owner.assert(op.signal);
        const result=await ownedAwait(hashBrowserUpload(file,targetPath,{signal:op.signal,onProgress:progress=> {
          owner.assert(op.signal); options.onProgress?.(progress); owner.assert(op.signal);
        }}),op.signal);
        owner.assert(op.signal); return result;
      } catch(error) { if(error instanceof UploadSourceError || error instanceof UploadHashError)throw error; throw failure(op.signal.aborted?'CANCELLED':'HASH_FAILED'); }
      finally { op.end(); }
    },
    async release() { owner.release(); },
  });
}
export function createNativeUploadSource(value: NativeUploadSource,current: () => boolean,boundary: UploadNativeBoundary=nativeBoundary): UploadSourceAdapter {
  const source=validateNativeUploadSource(value,value.sessionId);
  const {id,sessionId,size,lastModified}=source;
  const owner=lifetime(current,()=>value.id===id && value.sessionId===sessionId && value.name===source.name && value.size===size && value.lastModified===lastModified);
  let releasePromise: Promise<void> | undefined;
  return Object.freeze({size,lastModified,
    async read(offset: number,length: number,signal: AbortSignal) {
      const op=owner.begin(signal);
      try {
        range(size,offset,length); owner.assert(op.signal);
        const {invoke}=await ownedAwait(boundary.core(),op.signal); owner.assert(op.signal);
        const raw=await ownedAwait(invoke('nas_upload_read',{id,sessionId,offset,length}),op.signal); owner.assert(op.signal);
        if (!(raw instanceof ArrayBuffer) && !(raw instanceof Uint8Array)) throw failure('SOURCE_READ_FAILED');
        if (raw.byteLength!==length) throw failure('SOURCE_READ_FAILED');
        return raw instanceof Uint8Array?raw:new Uint8Array(raw);
      } catch(error) { if(error instanceof UploadSourceError && error.code!=='HASH_FAILED')throw error; throw failure(op.signal.aborted?'CANCELLED':'SOURCE_READ_FAILED'); }
      finally { op.end(); }
    },
    async hash(targetPath: string,options: UploadHashOptions={}) {
      const op=owner.begin(options.signal);
      let invoke: Invoke | undefined, unlisten: (()=>void) | undefined, dispatched=false, done=false, previous=0, terminal=false;
      let operation = "";
      let protocolError: UploadSourceError | undefined;
      let rejectProgress: ((error: unknown)=>void) | undefined;
      const remove=()=> { const remove=unlisten; unlisten=undefined; try { remove?.(); } catch { /* Static cleanup only; never revive ownership. */ } };
      const cancelNative=()=> { if(dispatched && invoke) { dispatched=false; try { void invoke('nas_upload_hash_cancel',{id,sessionId,operationId:operation}).catch(()=>{}); } catch {} } };
      const cancel=()=> { done=true; remove(); cancelNative(); };
      op.signal.addEventListener('abort',cancel,{once:true});
      try {
        operation=operationId();
        const uuid=computeUploadUUID(size,lastModified,targetPath); owner.assert(op.signal);
        const core=await ownedAwait(boundary.core(),op.signal); owner.assert(op.signal); invoke=core.invoke;
        const events=await ownedAwait(boundary.events(),op.signal); owner.assert(op.signal);
        unlisten=await ownedAwait(events.listen('nas-upload-hash-progress',event=> {
          if(done || op.signal.aborted)return;
          const p=event.payload;
          // Already-dispatched frames from older owners are inert, even if malformed.
          if(!p || typeof p!=='object' || (p as any).operationId!==operation || (p as any).sourceId!==id || (p as any).sessionId!==sessionId)return;
          try {
            owner.assert(op.signal);
            if(!exact(p,['operationId','sourceId','sessionId','processedBytes','totalBytes']) || p.totalBytes!==size || typeof p.processedBytes!=='number' || !Number.isSafeInteger(p.processedBytes) || p.processedBytes<0 || p.processedBytes>size || terminal || (size!==0 && p.processedBytes<=previous) || p.processedBytes-previous>UPLOAD_HASH_CHUNK_SIZE)
              throw failure('NATIVE_PROTOCOL_ERROR');
            previous=p.processedBytes; terminal=previous===size;
            options.onProgress?.({processedBytes:previous,totalBytes:size}); owner.assert(op.signal);
          } catch(error) {
            protocolError=error instanceof UploadSourceError?error:failure('HASH_FAILED');
            cancel(); // Reject even when the native invoke is still pending.
            rejectProgress?.(protocolError);
          }
        }),op.signal,remove=> { try {remove();}catch{} });
        owner.assert(op.signal); if(protocolError)throw protocolError;
        const progressFailure=new Promise<never>((_,reject)=>{ rejectProgress=reject; });
        dispatched=true;
        const raw=await ownedAwait(Promise.race([invoke('nas_upload_hash',{id,sessionId,operationId:operation,targetPath}),progressFailure]),op.signal);
        owner.assert(op.signal); if(protocolError)throw protocolError;
        if(!terminal || !exact(raw,['size','uuid','quickHash','md5','sha256']) || raw.size!==size || raw.uuid!==uuid || !hex(raw.uuid,40) || !hex(raw.quickHash,40) || !hex(raw.md5,32) || !hex(raw.sha256,64))
          throw failure('NATIVE_PROTOCOL_ERROR');
        done=true; dispatched=false;
        return {size,uuid:raw.uuid,quickHash:raw.quickHash,md5:raw.md5,sha256:raw.sha256};
      } catch(error) {
        cancelNative();
        if(protocolError)throw protocolError;
        if(error instanceof UploadSourceError || error instanceof UploadHashError)throw error;
        throw failure(op.signal.aborted?'CANCELLED':'HASH_FAILED');
      } finally { done=true; remove(); op.signal.removeEventListener('abort',cancel); op.end(); }
    },
    release() {
      if(releasePromise)return releasePromise;
      owner.release();
      releasePromise=(async()=> {
        try { const {invoke}=await boundary.core(); await invoke('nas_upload_release',{id,sessionId}); }
        catch {throw failure('SOURCE_RELEASE_FAILED');}
      })();
      return releasePromise;
    },
  });
}
