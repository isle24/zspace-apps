import { UPLOAD_HASH_CHUNK_SIZE, UploadHashError, computeUploadUUID, isUploadHashErrorCode, validateUploadHashInput,
  type UploadHashes, type UploadHashOptions, type UploadHashProgress } from './upload-hashes';

export interface UploadHashWorker {
  postMessage(message: unknown): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  terminate(): void;
}
export interface BrowserUploadHashOptions extends UploadHashOptions {
  /** Each call owns the newly created worker; never return a shared worker. */
  createWorker?: () => UploadHashWorker;
}
let nextOperation = 0;
function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function hex(value: unknown, length: number): value is string {
  return typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
}
function productionWorker(): UploadHashWorker {
  if (typeof Worker !== 'function') throw new UploadHashError('WORKER_UNAVAILABLE');
  return new Worker(new URL('../workers/upload-hash.worker.ts', import.meta.url), { type: 'module' });
}

/** Main thread validates bounded metadata/messages only. File bytes are read in the owned Worker. */
export async function hashBrowserUpload(file: File, targetPath: string, options: BrowserUploadHashOptions = {}): Promise<UploadHashes> {
  const signal = options.signal;
  if (signal?.aborted) throw new UploadHashError('CANCELLED');
  let size: number, lastModified: number;
  try {
    if (typeof File !== 'function' || !(file instanceof File)) throw new Error();
    size = file.size; lastModified = file.lastModified;
  } catch { throw new UploadHashError('INVALID_SOURCE'); }
  validateUploadHashInput(size, lastModified, targetPath);
  // This bounded metadata digest verifies the official identity without hashing file data on the main thread.
  const uuid = computeUploadUUID(size, lastModified, targetPath);
  const operationId = `upload-hash-${++nextOperation}`;
  let worker: UploadHashWorker;
  try { worker = (options.createWorker ?? productionWorker)(); }
  catch { throw new UploadHashError(signal?.aborted ? 'CANCELLED' : 'WORKER_UNAVAILABLE'); }
  return new Promise<UploadHashes>((resolve, reject) => {
    let settled = false, previous = 0, terminalProgress = false;
    const cleanup = () => {
      signal?.removeEventListener('abort', cancel);
      for (const [type, listener] of [['message', message], ['error', failed], ['messageerror', failed]] as const) {
        try { worker.removeEventListener(type, listener); } catch { /* Ownership cleanup continues. */ }
      }
      try { worker.terminate(); } catch { /* No raw worker exceptions cross the boundary. */ }
    };
    const fail = (code: ConstructorParameters<typeof UploadHashError>[0]) => {
      if (settled) return; settled = true; cleanup(); reject(new UploadHashError(code));
    };
    const cancel = () => {
      if (settled) return;
      try { worker.postMessage({ type: 'CANCEL', operationId }); } catch { /* Cancellation still terminates the owned worker. */ }
      fail('CANCELLED');
    };
    const current = () => {
      if (signal?.aborted) { cancel(); return false; }
      try { if (file.size !== size || file.lastModified !== lastModified) { fail('SOURCE_CHANGED'); return false; } }
      catch { fail('SOURCE_CHANGED'); return false; }
      return !settled;
    };
    const failed = (event: { preventDefault?: () => void }) => {
      try { event.preventDefault?.(); } catch { /* Do not echo browser error data. */ }
      if (!current()) return; fail('WORKER_FAILED');
    };
    const message = (event: { data: unknown }) => {
      if (settled || !current()) return;
      try {
        const data = event.data;
        if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.hasOwn(data, 'operationId') ||
          (data as Record<string, unknown>).operationId !== operationId) { fail('WORKER_PROTOCOL_ERROR'); return; }
        const type = (data as Record<string, unknown>).type;
        if (type === 'PROGRESS' && record(data, ['type', 'operationId', 'progress']) && record(data.progress, ['processedBytes', 'totalBytes'])) {
          const p = data.progress, count = p.processedBytes;
          if (p.totalBytes !== size || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > size || terminalProgress ||
              (size !== 0 && count <= previous) || count - previous > UPLOAD_HASH_CHUNK_SIZE) { fail('WORKER_PROTOCOL_ERROR'); return; }
          previous = count; terminalProgress = count === size;
          const progress: UploadHashProgress = { processedBytes: count, totalBytes: size };
          try { options.onProgress?.(progress); } catch { fail('HASH_FAILED'); return; }
          current(); return;
        }
        if (type === 'RESULT' && record(data, ['type', 'operationId', 'result']) && record(data.result, ['size', 'uuid', 'quickHash', 'md5', 'sha256'])) {
          const r = data.result;
          if (!terminalProgress || r.size !== size || r.uuid !== uuid || !hex(r.uuid, 40) || !hex(r.quickHash, 40) || !hex(r.md5, 32) || !hex(r.sha256, 64)) { fail('WORKER_PROTOCOL_ERROR'); return; }
          if (!current()) return;
          const result: UploadHashes = { size, uuid: r.uuid, quickHash: r.quickHash, md5: r.md5, sha256: r.sha256 };
          settled = true; cleanup(); resolve(result); return;
        }
        if (type === 'ERROR' && record(data, ['type', 'operationId', 'code']) && isUploadHashErrorCode(data.code)) { fail(data.code); return; }
        fail('WORKER_PROTOCOL_ERROR');
      } catch { fail('WORKER_PROTOCOL_ERROR'); }
    };
    try {
      if (signal?.aborted) { fail('CANCELLED'); return; }
      worker.addEventListener('message', message); worker.addEventListener('error', failed); worker.addEventListener('messageerror', failed);
      signal?.addEventListener('abort', cancel, { once: true });
      if (!current()) return;
      worker.postMessage({ type: 'START', operationId, file, targetPath });
      current();
    } catch { fail(signal?.aborted ? 'CANCELLED' : 'WORKER_FAILED'); }
  });
}
