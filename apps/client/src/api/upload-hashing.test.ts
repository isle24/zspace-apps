// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { hashBrowserUpload, type UploadHashWorker } from './upload-hashing';
import { UPLOAD_HASH_CHUNK_SIZE, UploadHashError } from './upload-hashes';
import { installUploadHashWorker, type UploadHashWorkerScope } from '../workers/upload-hash.worker';

class SyntheticWorker implements UploadHashWorker {
  listeners = new Map<string, Set<(event: any) => void>>();
  sent: any[] = [];
  terminate = vi.fn(() => { this.dispose?.(); });
  dispose?: () => void;
  postMessage = vi.fn((message: unknown) => { this.sent.push(message); });
  addEventListener(type: string, listener: (event: any) => void) { const set = this.listeners.get(type) ?? new Set(); set.add(listener); this.listeners.set(type, set); }
  removeEventListener(type: string, listener: (event: any) => void) { this.listeners.get(type)?.delete(listener); }
  emit(data: unknown) { this.fire('message', { data }); }
  fire(type: string, event: unknown) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  get id() { return this.sent[0].operationId; }
  get listenerCount() { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0); }
}
function setup(file = new File(['abc'], 'example', { lastModified: 12 }), options: any = {}) {
  const worker = new SyntheticWorker();
  const promise = hashBrowserUpload(file, '/folder/测试.bin', { ...options, createWorker: () => worker });
  void promise.catch(() => {}); return { worker, promise, file };
}
const digest = (algorithm: string, data: string | Uint8Array) => createHash(algorithm).update(data).digest('hex');
function result(file: File, path = '/folder/测试.bin') { return { size: file.size, uuid: digest('sha1', String(file.lastModified + file.size) + path), quickHash: digest('sha1', '3abc'), md5: digest('md5', 'abc'), sha256: digest('sha256', 'abc') }; }
function progress(worker: SyntheticWorker, processedBytes: number, totalBytes = 3) { worker.emit({ type: 'PROGRESS', operationId: worker.id, progress: { processedBytes, totalBytes } }); }
function complete(worker: SyntheticWorker, file: File) { progress(worker, file.size, file.size); worker.emit({ type: 'RESULT', operationId: worker.id, result: result(file) }); }
async function error(promise: Promise<unknown>, code: string) { const e = await promise.catch(e => e); expect(e).toBeInstanceOf(UploadHashError); if (!(e instanceof UploadHashError)) throw new Error('Expected a static upload error'); expect(e.code).toBe(code); expect(e.cause).toBeUndefined(); expect(e.message + e.stack + JSON.stringify(e)).not.toContain('synthetic-private'); }
function cleaned(worker: SyntheticWorker) { expect(worker.terminate).toHaveBeenCalledTimes(1); expect(worker.listenerCount).toBe(0); }

describe('browser upload hashing ownership and protocol', () => {
  it('sends only a bounded START contract, never reads on the main thread, and cleans success', async () => {
    const file = new File(['abc'], 'example', { lastModified: 12 }); const slice = vi.spyOn(file, 'slice'), arrayBuffer = vi.spyOn(file, 'arrayBuffer');
    const callback = vi.fn(); const { worker, promise } = setup(file, { onProgress: callback, token: 'synthetic-private' });
    expect(worker.sent).toEqual([{ type: 'START', operationId: expect.any(String), file, targetPath: '/folder/测试.bin' }]);
    complete(worker, file); expect(await promise).toEqual(result(file)); cleaned(worker);
    expect(slice).not.toHaveBeenCalled(); expect(arrayBuffer).not.toHaveBeenCalled(); expect(callback).toHaveBeenCalledTimes(1);
    complete(worker, file); expect(callback).toHaveBeenCalledTimes(1);
  });
  it('does not create a worker for invalid input or pre-abort', async () => {
    const createWorker = vi.fn(); const controller = new AbortController(); controller.abort('synthetic-private');
    await error(hashBrowserUpload(new File(['x'], 'a'), '/a', { signal: controller.signal, createWorker }), 'CANCELLED');
    await error(hashBrowserUpload(new File(['x'], 'a'), '/a/../b', { createWorker }), 'INVALID_TARGET_PATH'); expect(createWorker).not.toHaveBeenCalled();
  });
  it('rejects unsupported browsers explicitly', async () => { vi.stubGlobal('Worker', undefined); try { await error(hashBrowserUpload(new File(['abc'], 'a'), '/a'), 'WORKER_UNAVAILABLE'); } finally { vi.unstubAllGlobals(); } });
  it('uses an actual module Worker in the production factory', async () => {
    const worker = new SyntheticWorker(), ctor = vi.fn(function() { return worker; }); vi.stubGlobal('Worker', ctor);
    try { const file = new File(['abc'], 'a', { lastModified: 12 }); const work = hashBrowserUpload(file, '/folder/测试.bin'); void work.catch(() => {}); expect(ctor).toHaveBeenCalledWith(expect.any(URL), { type: 'module' }); complete(worker, file); await work; cleaned(worker); } finally { vi.unstubAllGlobals(); }
  });
  it('cleans a worker when aborted during its creation', async () => {
    const worker = new SyntheticWorker(), abort = new AbortController();
    await error(hashBrowserUpload(new File(['abc'], 'a'), '/a', { signal: abort.signal, createWorker: () => { abort.abort(); return worker; } }), 'CANCELLED'); cleaned(worker); expect(worker.sent).toEqual([]);
  });
  it('cancels a running worker and ignores late results', async () => {
    const abort = new AbortController(), callback = vi.fn(); const { worker, promise, file } = setup(undefined, { signal: abort.signal, onProgress: callback });
    const oldListener = [...worker.listeners.get('message')!][0]; abort.abort('synthetic-private'); await error(promise, 'CANCELLED');
    expect(worker.sent[1]).toEqual({ type: 'CANCEL', operationId: worker.id }); cleaned(worker);
    oldListener({ data: { type: 'RESULT', operationId: worker.id, result: result(file) } }); expect(callback).not.toHaveBeenCalled();
  });
  it('stops when callback aborts on terminal progress', async () => {
    const abort = new AbortController(); const { worker, promise, file } = setup(undefined, { signal: abort.signal, onProgress: () => abort.abort() });
    complete(worker, file); await error(promise, 'CANCELLED'); cleaned(worker);
  });
  it('sanitizes callback exceptions and cleans', async () => { const { worker, promise } = setup(undefined, { onProgress: () => { throw new Error('synthetic-private'); } }); progress(worker, 3); await error(promise, 'HASH_FAILED'); cleaned(worker); });
  it.each(['error', 'messageerror'])('cleans %s events without exporting their text', async type => { const { worker, promise } = setup(); worker.fire(type, { message: 'synthetic-private', error: new Error('synthetic-private'), preventDefault: vi.fn() }); await error(promise, 'WORKER_FAILED'); cleaned(worker); });
  it('sanitizes postMessage failures', async () => { const worker = new SyntheticWorker(); worker.postMessage.mockImplementation(() => { throw new Error('synthetic-private'); }); await error(hashBrowserUpload(new File(['a'], 'a'), '/a', { createWorker: () => worker }), 'WORKER_FAILED'); cleaned(worker); });
  it('sanitizes worker creation exceptions', async () => { await error(hashBrowserUpload(new File(['a'], 'a'), '/a', { createWorker: () => { throw new Error('synthetic-private'); } }), 'WORKER_UNAVAILABLE'); });
  it.each([
    null, [], {}, { type: 'other' }, { type: 'ERROR', code: 'synthetic-private' },
    { type: 'PROGRESS', progress: { processedBytes: 4, totalBytes: 3 } },
    { type: 'PROGRESS', progress: { processedBytes: -1, totalBytes: 3 } },
    { type: 'PROGRESS', progress: { processedBytes: NaN, totalBytes: 3 } },
    { type: 'PROGRESS', progress: { processedBytes: 1.5, totalBytes: 3 } },
    { type: 'PROGRESS', progress: { processedBytes: 1, totalBytes: 4 } },
    { type: 'PROGRESS', progress: { processedBytes: 1, totalBytes: 3, secret: 'synthetic-private' } },
    { type: 'ERROR', code: 'HASH_FAILED', message: 'synthetic-private' },
    { type: 'RESULT', result: { size: 3, uuid: 'x'.repeat(100_000), quickHash: '', md5: '', sha256: '' } },
  ])('rejects malformed/oversized output %#', async data => { const { worker, promise } = setup(); worker.emit(data && !Array.isArray(data) ? { ...data, operationId: worker.id } : data); await error(promise, 'WORKER_PROTOCOL_ERROR'); cleaned(worker); });
  it('rejects foreign operation ids', async () => { const { worker, promise } = setup(); worker.emit({ type: 'ERROR', operationId: 'foreign', code: 'HASH_FAILED' }); await error(promise, 'WORKER_PROTOCOL_ERROR'); cleaned(worker); });
  it.each(['duplicate', 'backwards', 'jump'])('rejects %s progress', async kind => { const { worker, promise } = setup(); progress(worker, 2); progress(worker, kind === 'duplicate' ? 2 : kind === 'backwards' ? 1 : 4); await error(promise, 'WORKER_PROTOCOL_ERROR'); cleaned(worker); });
  it('rejects progress jumps beyond one bounded read', async () => { const { worker, promise } = setup(new File([new Uint8Array(UPLOAD_HASH_CHUNK_SIZE + 1)], 'a')); progress(worker, UPLOAD_HASH_CHUNK_SIZE + 1, UPLOAD_HASH_CHUNK_SIZE + 1); await error(promise, 'WORKER_PROTOCOL_ERROR'); cleaned(worker); });
  it.each(['size', 'uuid', 'md5', 'sha256', 'extra', 'early'])('rejects invalid or premature result %s', async kind => {
    const { worker, promise, file } = setup(); const output: any = result(file); if (kind !== 'early') progress(worker, 3);
    if (kind === 'size') output.size = 4; if (kind === 'uuid') output.uuid = '0'.repeat(40); if (kind === 'md5') output.md5 = 'A'.repeat(32); if (kind === 'sha256') output.sha256 = 'a'.repeat(65); if (kind === 'extra') output.secret = 'synthetic-private';
    worker.emit({ type: 'RESULT', operationId: worker.id, result: output }); await error(promise, 'WORKER_PROTOCOL_ERROR'); cleaned(worker);
  });
  it('accepts only a static worker error code', async () => { const { worker, promise } = setup(); worker.emit({ type: 'ERROR', operationId: worker.id, code: 'SOURCE_READ_FAILED' }); await error(promise, 'SOURCE_READ_FAILED'); cleaned(worker); });
});

function paired() {
  const worker = new SyntheticWorker(); let receiver!: (event: { data: unknown }) => void;
  const scope: UploadHashWorkerScope = { addEventListener: (_type, callback) => { receiver = callback; }, removeEventListener: vi.fn(),
    postMessage: vi.fn(data => queueMicrotask(() => worker.emit(data))), close: vi.fn() };
  worker.postMessage.mockImplementation(data => { worker.sent.push(data); queueMicrotask(() => receiver({ data })); });
  worker.dispose = installUploadHashWorker(scope);
  return { worker, scope, receive: (data: unknown) => receiver({ data }) };
}
describe('real worker message handler with synthetic transport', () => {
  it.each([0, 1, 2048, 2049, 2 * 1024 * 1024 + 500])('reads bounded slices and hashes real bytes for %i', async size => {
    const data = Uint8Array.from({ length: size }, (_, i) => i % 251), file = new File([data], 'test', { lastModified: 123 });
    const slice = vi.spyOn(file, 'slice'), { worker, scope } = paired(), callback = vi.fn();
    const output = await hashBrowserUpload(file, '/file', { createWorker: () => worker, onProgress: callback });
    const samples = size <= 2048 ? data : Buffer.concat([data.subarray(0, 1024), data.subarray(size - 1024)]);
    expect(output).toEqual({ size, uuid: digest('sha1', String(123 + size) + '/file'), quickHash: createHash('sha1').update(String(size)).update(samples).digest('hex'), md5: digest('md5', data), sha256: digest('sha256', data) });
    expect(slice.mock.calls.every(([start, end]) => end! - start! <= UPLOAD_HASH_CHUNK_SIZE)).toBe(true);
    expect(slice).toHaveBeenCalledTimes(Math.ceil(size / UPLOAD_HASH_CHUNK_SIZE)); cleaned(worker); expect(scope.close).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls.filter(([p]) => p.processedBytes === size)).toHaveLength(1);
  });
  it('closes and suppresses late output after cancelling a stalled File slice', async () => {
    const file = new File(['abc'], 'a'); let finish!: (buffer: ArrayBuffer) => void;
    vi.spyOn(file, 'slice').mockReturnValue({ arrayBuffer: () => new Promise(resolve => { finish = resolve; }) } as Blob);
    const abort = new AbortController(), { worker, scope } = paired(); const work = hashBrowserUpload(file, '/file', { signal: abort.signal, createWorker: () => worker }); void work.catch(() => {});
    await Promise.resolve(); await Promise.resolve(); abort.abort(); await error(work, 'CANCELLED');
    finish(new ArrayBuffer(3)); await Promise.resolve(); await Promise.resolve();
    expect(scope.postMessage).not.toHaveBeenCalled(); cleaned(worker); expect(scope.close).toHaveBeenCalledTimes(1);
  });
  it('sanitizes actual File read errors', async () => {
    const file = new File(['abc'], 'a'); vi.spyOn(file, 'slice').mockImplementation(() => { throw new Error('synthetic-private'); });
    const { worker, scope } = paired(); await error(hashBrowserUpload(file, '/file', { createWorker: () => worker }), 'SOURCE_READ_FAILED'); cleaned(worker);
    expect(JSON.stringify(vi.mocked(scope.postMessage).mock.calls)).not.toContain('synthetic-private'); expect(scope.close).toHaveBeenCalledTimes(1);
  });
  it('refuses request fields outside the explicit file contract', async () => {
    const { receive, scope } = paired(); receive({ type: 'START', operationId: 'test', file: new File(['abc'], 'a'), targetPath: '/a', token: 'synthetic-private' });
    await Promise.resolve(); expect(scope.postMessage).toHaveBeenCalledWith({ type: 'ERROR', operationId: 'test', code: 'WORKER_PROTOCOL_ERROR' }); expect(scope.close).toHaveBeenCalledTimes(1);
  });
});

it('cleans partially registered listeners and keeps initialization failures private', async () => {
  const worker = new SyntheticWorker(); const original = worker.addEventListener.bind(worker);
  worker.addEventListener = (type, listener) => { original(type, listener); if (type === 'error') throw new Error('synthetic-private'); };
  await error(hashBrowserUpload(new File(['a'], 'a'), '/a', { createWorker: () => worker }), 'WORKER_FAILED'); cleaned(worker);
});
it('continues settling safely if owned worker termination throws', async () => {
  const { worker, promise, file } = setup(); worker.terminate.mockImplementation(() => { throw new Error('synthetic-private'); });
  complete(worker, file); expect(await promise).toEqual(result(file)); cleaned(worker);
});
it.each(['short', 'long', 'wrong'])('sanitizes Worker File read %s data', async kind => {
  const file = new File(['abc'], 'a');
  vi.spyOn(file, 'slice').mockReturnValue({ arrayBuffer: async () => kind === 'wrong' ? new Uint8Array(3) : new ArrayBuffer(kind === 'short' ? 2 : 4) } as Blob);
  const { worker, scope } = paired(); await error(hashBrowserUpload(file, '/file', { createWorker: () => worker }), 'SOURCE_READ_FAILED'); cleaned(worker); expect(scope.close).toHaveBeenCalledTimes(1);
});
it('aborts on actual Worker progress before starting the next bounded read', async () => {
  const file = new File([new Uint8Array(UPLOAD_HASH_CHUNK_SIZE + 1)], 'a'), slice = vi.spyOn(file, 'slice');
  const abort = new AbortController(), { worker, scope } = paired();
  await error(hashBrowserUpload(file, '/file', { createWorker: () => worker, signal: abort.signal, onProgress: () => abort.abort() }), 'CANCELLED');
  expect(slice).toHaveBeenCalledTimes(1); cleaned(worker); expect(scope.close).toHaveBeenCalledTimes(1);
});
it('allows one empty terminal progress and rejects a duplicate', async () => {
  const { worker, promise } = setup(new File([], 'a')); progress(worker, 0, 0); progress(worker, 0, 0);
  await error(promise, 'WORKER_PROTOCOL_ERROR'); cleaned(worker);
});
it('rejects a changed browser metadata snapshot', async () => {
  const { worker, promise, file } = setup(); Object.defineProperty(file, 'lastModified', { value: 13 }); progress(worker, 3);
  await error(promise, 'SOURCE_CHANGED'); cleaned(worker);
});
it('prevents default browser error reporting and exports only a static failure', async () => {
  const { worker, promise } = setup(), preventDefault = vi.fn(); worker.fire('error', { message: 'synthetic-private', preventDefault });
  await error(promise, 'WORKER_FAILED'); expect(preventDefault).toHaveBeenCalledTimes(1); cleaned(worker);
});
it('suppresses results from a duplicate START while a read is outstanding', async () => {
  const { receive, scope } = paired(), file = new File(['abc'], 'a'); let finish!: (buffer: ArrayBuffer) => void;
  vi.spyOn(file, 'slice').mockReturnValue({ arrayBuffer: () => new Promise(resolve => { finish = resolve; }) } as Blob);
  const start = { type: 'START', operationId: 'one', file, targetPath: '/a' };
  receive(start); receive(start); finish(new ArrayBuffer(3)); await Promise.resolve(); await Promise.resolve();
  expect(scope.postMessage).toHaveBeenCalledTimes(1); expect(scope.postMessage).toHaveBeenCalledWith({ type: 'ERROR', operationId: 'one', code: 'WORKER_PROTOCOL_ERROR' }); expect(scope.close).toHaveBeenCalledTimes(1);
});


describe('browser full target path byte boundary', () => {
  it.each([18, 32])('preserves a target with %i valid components through the real worker handler', async components => {
    const path = '/' + Array(components).fill('中'.repeat(85)).join('/');
    const file = new File(['abc'], 'a', { lastModified: 12 }), { worker } = paired();
    const output = await hashBrowserUpload(file, path, { createWorker: () => worker });
    expect(output).toEqual(result(file, path));
    expect(worker.sent[0].targetPath).toBe(path); cleaned(worker);
  });
  it.each([8193, 8448])('rejects %i UTF8-byte targets before constructing a worker', async byteLength => {
    const path = byteLength === 8193
      ? '/' + Array(31).fill('中'.repeat(85)).join('/') + '/' + '中'.repeat(84) + 'ab/a'
      : '/' + Array(33).fill('中'.repeat(85)).join('/');
    expect(new TextEncoder().encode(path)).toHaveLength(byteLength);
    const createWorker = vi.fn(), file = new File(['abc'], 'a');
    const slice = vi.spyOn(file, 'slice'), arrayBuffer = vi.spyOn(file, 'arrayBuffer');
    await error(hashBrowserUpload(file, path, { createWorker }), 'INVALID_TARGET_PATH');
    expect(createWorker).not.toHaveBeenCalled(); expect(slice).not.toHaveBeenCalled(); expect(arrayBuffer).not.toHaveBeenCalled();
  });
});
