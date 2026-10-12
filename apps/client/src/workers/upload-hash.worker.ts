import { hashUpload, UPLOAD_HASH_CHUNK_SIZE, UploadHashError, isUploadHashErrorCode, validateUploadHashInput } from '../api/upload-hashes';

export interface UploadHashWorkerScope {
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
  close(): void;
}
function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 64 && /^[a-zA-Z0-9-]+$/.test(value); }

/** One operation owns this dedicated worker. Exported for message-contract tests with synthetic transport. */
export function installUploadHashWorker(scope: UploadHashWorkerScope): () => void {
  let closed = false, operationId: string | undefined, controller: AbortController | undefined;
  const dispose = () => {
    if (closed) return; closed = true; controller?.abort(); controller = undefined;
    try { scope.removeEventListener('message', message); } catch { /* Continue cleanup. */ }
    try { scope.close(); } catch { /* No worker environment details are exported. */ }
  };
  const post = (data: unknown) => {
    if (closed) return;
    try { scope.postMessage(data); } catch { dispose(); }
  };
  const protocolError = (id: unknown) => {
    if (validId(id)) post({ type: 'ERROR', operationId: id, code: 'WORKER_PROTOCOL_ERROR' });
    dispose();
  };
  const run = async (file: File, path: string, id: string, signal: AbortSignal) => {
    try {
      const size = file.size, lastModified = file.lastModified;
      validateUploadHashInput(size, lastModified, path);
      const hashes = await hashUpload({ size, lastModified, read: async (offset, length, readSignal) => {
        if (readSignal.aborted || closed) throw new UploadHashError('CANCELLED');
        if (file.size !== size || file.lastModified !== lastModified) throw new UploadHashError('SOURCE_CHANGED');
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || length > UPLOAD_HASH_CHUNK_SIZE || offset + length > size)
          throw new UploadHashError('SOURCE_READ_FAILED');
        const buffer = await file.slice(offset, offset + length).arrayBuffer();
        if (readSignal.aborted || closed) throw new UploadHashError('CANCELLED');
        if (file.size !== size || file.lastModified !== lastModified) throw new UploadHashError('SOURCE_CHANGED');
        if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== length) throw new UploadHashError('SOURCE_READ_FAILED');
        return new Uint8Array(buffer);
      } }, path, { signal, onProgress: progress => post({ type: 'PROGRESS', operationId: id, progress }) });
      if (!closed && !signal.aborted) post({ type: 'RESULT', operationId: id, result: hashes });
    } catch (error) {
      if (!closed && !signal.aborted) post({ type: 'ERROR', operationId: id, code: error instanceof UploadHashError && isUploadHashErrorCode(error.code) ? error.code : 'HASH_FAILED' });
    } finally { dispose(); }
  };
  const message = (event: { data: unknown }) => {
    if (closed) return;
    try {
      const data = event.data;
      const id = data && typeof data === 'object' ? (data as Record<string, unknown>).operationId : undefined;
      if (record(data, ['type', 'operationId']) && data.type === 'CANCEL' && operationId === id) { dispose(); return; }
      if (!record(data, ['type', 'operationId', 'file', 'targetPath']) || data.type !== 'START' || !validId(id) || operationId !== undefined ||
          typeof File !== 'function' || !(data.file instanceof File) || typeof data.targetPath !== 'string') { protocolError(operationId ?? id); return; }
      operationId = id; controller = new AbortController();
      void run(data.file, data.targetPath, id, controller.signal);
    } catch { protocolError(operationId); }
  };
  scope.addEventListener('message', message);
  return dispose;
}

// No installation in the main window or Node tests. Vite loads this module in a dedicated Worker.
const scope = globalThis as unknown as UploadHashWorkerScope;
if (typeof document === 'undefined' && typeof scope.addEventListener === 'function' && typeof scope.postMessage === 'function')
  installUploadHashWorker(scope);
