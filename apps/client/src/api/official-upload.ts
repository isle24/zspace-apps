import type { Item } from './client';
import type { UploadSourceAdapter } from './upload-sources';
import {
  computeUploadUUID, validateUploadHashInput, UPLOAD_HASH_CHUNK_SIZE, isUploadHashErrorCode,
  type UploadHashes,
} from './upload-hashes';

export interface UploadDestination {
  parent: Item;
  /** Initial single-file flow requires an explicit new directory name. */
  newDirectory?: string;
  name?: string;
}
export type UploadPhase = 'prepared' | 'checking' | 'hashing' | 'uploading' |
  'pausing' | 'paused' | 'verifying' | 'completed' | 'failed' | 'cancelled';
export interface UploadState {
  size: number;
  phase: UploadPhase;
  confirmedBytes: number;
  mayHavePartial: boolean;
}
export interface UploadSnapshot extends UploadState {
  taskId: string;
  sourceId: string;
  sessionId: string;
  name: string;
}
export interface UploadEngineCallbacks {
  signal?: AbortSignal;
  onProgress?: (state: UploadState) => void;
  onHashProgress?: (processedBytes: number, totalBytes: number) => void;
}
export interface UploadCallbacks extends Omit<UploadEngineCallbacks, 'onProgress'> {
  onProgress?: (snapshot: UploadSnapshot) => void;
}
const messages: Record<string, string> = {
  SESSION_EXPIRED: 'NAS 登录已失效，请重新登录',
  UPLOAD_TARGET_UNKNOWN: '尚未确认目标不存在，已停止上传',
  UPLOAD_TARGET_EXISTS: '目标已存在，请选择新的文件夹或名称',
  UPLOAD_PARTIAL_UNKNOWN: '临时上传状态尚未确认，已停止上传',
  UPLOAD_PARTIAL_EXISTS: '目标已有临时上传数据，请选择新的文件夹或名称',
  UPLOAD_PARTIAL_MISMATCH: '临时上传状态与当前任务不一致，已保留已有数据',
  UPLOAD_SOURCE_CHANGED: '来源文件已改变，请重新选择文件',
  UPLOAD_READBACK_UNVERIFIED: '上传结果尚未确认，请检查目标文件',
  REQUEST_CANCELLED: '上传已中断，已有数据将保留',
};
// Closed upload/source/SDK diagnostics. Never accept a code merely because its characters look safe.
const uploadErrorCodes = new Set([
  'NATIVE_PROTOCOL_ERROR', 'SOURCE_RELEASE_FAILED', 'BUSY',
  'NO_SESSION', 'INVALID_UPLOAD_SOURCE', 'INVALID_UPLOAD_DESTINATION', 'INVALID_UPLOAD_PARENT',
  'UPLOAD_SOURCE_LIMIT', 'UPLOAD_PICKER_UNAVAILABLE', 'UPLOAD_PICK_FAILED', 'UPLOAD_SOURCE_RELEASE_FAILED',
  'UPLOAD_TASK_LIMIT', 'UPLOAD_TASK_MISSING', 'UPLOAD_TASK_STATE', 'UPLOAD_TARGET_BUSY',
  'UPLOAD_TARGET_EXISTS', 'UPLOAD_TARGET_UNKNOWN', 'UPLOAD_TARGET_UNVERIFIED', 'UPLOAD_DIRECTORY_UNVERIFIED',
  'UPLOAD_PARTIAL_EXISTS', 'UPLOAD_PARTIAL_UNKNOWN', 'UPLOAD_PARTIAL_MISMATCH',
  'INVALID_UPLOAD_REQUEST', 'INVALID_UPLOAD_PIECE', 'UPLOAD_HEADER_LIMIT', 'UPLOAD_HASH_INVALID',
  'UPLOAD_SOURCE_CHANGED', 'UPLOAD_READBACK_UNVERIFIED', 'UPLOAD_PREPARATION_FAILED',
  'UPLOAD_TRANSPORT_FAILED', 'UPLOAD_TIMEOUT', 'UPLOAD_FAILED', 'REQUEST_CANCELLED',
  'SESSION_EXPIRED', 'NAS_REDIRECT_BLOCKED', 'NAS_HTTP_ERROR', 'NAS_UNAVAILABLE', 'NAS_BUSINESS_ERROR',
  'INVALID_REQUEST', 'INVALID_RESPONSE', 'CHALLENGE_REQUIRED', 'LOGIN_FAILED',
]);
const uploadErrorStatuses = new Set([400, 401, 403, 409, 413, 429, 500, 501, 502, 503, 504]);
function uploadErrorDetails(error: unknown) {
  try {
    const value = error as { code?: unknown; status?: unknown; mayHavePartial?: unknown } | null;
    const candidate = value?.code;
    const known = typeof candidate === 'string' && (uploadErrorCodes.has(candidate) || isUploadHashErrorCode(candidate));
    const status = value?.status;
    return {
      code: known ? candidate : 'UPLOAD_FAILED',
      status: known && typeof status === 'number' && uploadErrorStatuses.has(status) ? status : 502,
      mayHavePartial: value?.mayHavePartial === true,
    };
  } catch {
    // Callback-owned getters must not replace the static diagnostic boundary either.
    return { code: 'UPLOAD_FAILED', status: 502, mayHavePartial: false };
  }
}
export class OfficialUploadError extends Error {
  constructor(
    public readonly code: string,
    public readonly mayHavePartial = false,
    public readonly status = 409,
  ) {
    super(messages[code] ?? '上传未完成，请检查任务状态');
    this.name = 'OfficialUploadError';
  }
}
export function strictUploadSize(value: unknown): number | undefined {
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) value = Number(value);
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
/** Raw complete-page shape only; this does not certify hidden-item or absence semantics. */
export function completeUploadListing(value: unknown): unknown[] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const data = value as Record<string, unknown>;
  if (Array.isArray(data.list) && typeof data.total === 'number' &&
      strictUploadSize(data.total) !== undefined && data.list.length === data.total && data.total <= 200) {
    return data.list;
  }
}
export function uploadPieceHeaders(
  path: string, lastModified: number, hashes: UploadHashes, seek: number, length: number,
): Record<string, string> {
  validateUploadHashInput(hashes.size, lastModified, path);
  if (strictUploadSize(seek) === undefined || strictUploadSize(length) === undefined ||
      length > UPLOAD_HASH_CHUNK_SIZE || seek + length > hashes.size ||
      (length === 0 && hashes.size !== 0) ||
      hashes.uuid !== computeUploadUUID(hashes.size, lastModified, path) ||
      !/^[a-f0-9]{32}$/.test(hashes.md5)) {
    throw new OfficialUploadError('INVALID_UPLOAD_PIECE');
  }
  return {
    'Content-Type': 'application/octet-stream', app: 'file', path: encodeURIComponent(path),
    size: String(hashes.size), uuid: hashes.uuid, seek: String(seek), crtime: '',
    modify_time: String(Math.ceil(lastModified / 1000)), rename: '0', split: '1',
    'remote-port': '8050', 'request-purpose': '4',
    ...(seek + length === hashes.size ? { fileHash: hashes.md5, fileHashCheckOption: 'complete' } : {}),
  };
}
/** Optional identity fields are checked without inventing mandatory server fields. */
export function verifyUploadReplyTarget(data: unknown, target: string): void {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  const value = data as Record<string, unknown>;
  if ((Object.hasOwn(value, 'path') && value.path !== target) ||
      (Object.hasOwn(value, 'name') && value.name !== target.slice(target.lastIndexOf('/') + 1))) {
    throw new OfficialUploadError('UPLOAD_TARGET_UNVERIFIED', true, 502);
  }
}
export interface UploadPiece {
  bytes: Uint8Array;
  seek: number;
  terminal: boolean;
  hashes: UploadHashes;
}
/** Internal credential-free boundary. Callback success is explicit evidence, not inferred absence. */
export interface UploadIO {
  assertCurrent(): void;
  verifyTarget(signal: AbortSignal): Promise<void>;
  verifyParent(signal: AbortSignal): Promise<void>;
  queryPartial(hashes: UploadHashes, signal: AbortSignal): Promise<unknown>;
  sendChunk(piece: UploadPiece, signal: AbortSignal): Promise<void>;
  readFinalInfo(signal: AbortSignal): Promise<unknown>;
}
export type RetainedUploadTask = ReturnType<typeof createUploadTask>;
export function createUploadTask(source: UploadSourceAdapter, target: string, io: UploadIO) {
  const size = source.size, mtime = source.lastModified;
  validateUploadHashInput(size, mtime, target);
  let phase: UploadPhase = 'prepared', confirmedBytes = 0, mayHavePartial = false;
  let hashes: UploadHashes | undefined, terminal = false, pauseRequested = false, hashPaused = false;
  let epoch = 0, controller: AbortController | undefined;
  const snapshot = (): UploadState => ({ size, phase, confirmedBytes, mayHavePartial });
  const failure = (code: string, status = 409) => new OfficialUploadError(code, mayHavePartial, status);
  const assert = (run: number, signal: AbortSignal) => {
    io.assertCurrent();
    if (run !== epoch || signal.aborted || phase === 'cancelled') throw failure('REQUEST_CANCELLED');
    if (source.size !== size || source.lastModified !== mtime) throw failure('UPLOAD_SOURCE_CHANGED');
  };
  async function execute(resume: boolean, callbacks: UploadEngineCallbacks = {}) {
    if (controller || (resume ? phase !== 'paused' : phase !== 'prepared')) throw failure('UPLOAD_TASK_STATE');
    const run = ++epoch, owned = new AbortController();
    controller = owned;
    pauseRequested = false;
    hashPaused = false;
    const abort = () => owned.abort();
    callbacks.signal?.addEventListener('abort', abort, { once: true });
    if (callbacks.signal?.aborted) abort();
    const wait = async <T>(operation: () => Promise<T>, bounded = true): Promise<T> => {
      assert(run, owned.signal);
      let cleanup = () => {};
      const interrupted = new Promise<never>((_, reject) => {
        const cancel = () => reject(failure('REQUEST_CANCELLED'));
        const timer = bounded ? setTimeout(() => {
          reject(failure('UPLOAD_TIMEOUT', 504));
          owned.abort();
        }, 30000) : undefined;
        owned.signal.addEventListener('abort', cancel, { once: true });
        cleanup = () => {
          if (timer !== undefined) clearTimeout(timer);
          owned.signal.removeEventListener('abort', cancel);
        };
      });
      try {
        const value = await Promise.race([Promise.resolve().then(operation), interrupted]);
        assert(run, owned.signal);
        return value;
      } finally {
        cleanup();
      }
    };
    const pauseAtBoundary = () => {
      if (!pauseRequested || terminal) return false;
      phase = 'paused';
      return true;
    };
    try {
      phase = 'checking';
      await wait(() => io.verifyParent(owned.signal));
      assert(run, owned.signal);
      if (pauseAtBoundary()) return snapshot();
      if (!resume || !mayHavePartial) {
        await wait(() => io.verifyTarget(owned.signal));
        assert(run, owned.signal);
        if (pauseAtBoundary()) return snapshot();
      }
      phase = 'hashing';
      // Full-file hashing can legitimately take longer than one bounded request.
      const next = await wait(() => source.hash(target, {
        signal: owned.signal,
        onProgress: ({ processedBytes, totalBytes }) => {
          assert(run, owned.signal);
          callbacks.onHashProgress?.(processedBytes, totalBytes);
          assert(run, owned.signal);
        },
      }), false);
      assert(run, owned.signal);
      if (next.size !== size || next.uuid !== computeUploadUUID(size, mtime, target) ||
          !/^[a-f0-9]{32}$/.test(next.md5) || !/^[a-f0-9]{40}$/.test(next.quickHash) ||
          !/^[a-f0-9]{64}$/.test(next.sha256)) throw failure('UPLOAD_HASH_INVALID');
      if (hashes && (Object.keys(hashes) as (keyof UploadHashes)[]).some(k => hashes![k] !== next[k])) {
        throw failure('UPLOAD_SOURCE_CHANGED');
      }
      hashes = Object.freeze({ ...next });
      phase = 'checking';
      if (pauseAtBoundary()) return snapshot();
      if (resume && mayHavePartial && !terminal) {
        const partial = await wait(() => io.queryPartial(hashes!, owned.signal));
        assert(run, owned.signal);
        const metadata = partial && typeof partial === 'object' && !Array.isArray(partial)
          ? partial as Record<string, unknown> : undefined;
        const value = strictUploadSize(metadata?.size);
        if (value !== confirmedBytes || value === undefined || value >= size ||
            (metadata && Object.hasOwn(metadata, 'path') && metadata.path !== target) ||
            (metadata && Object.hasOwn(metadata, 'uuid') && metadata.uuid !== hashes.uuid)) {
          throw failure('UPLOAD_PARTIAL_MISMATCH');
        }
      }
      if (pauseAtBoundary()) return snapshot();
      if (!mayHavePartial) {
        await wait(() => io.verifyTarget(owned.signal));
        assert(run, owned.signal);
        if (pauseAtBoundary()) return snapshot();
      }
      while (!terminal) {
        if (pauseRequested) { phase = 'paused'; return snapshot(); }
        phase = 'uploading';
        const length = Math.min(UPLOAD_HASH_CHUNK_SIZE, size - confirmedBytes), seek = confirmedBytes;
        const bytes = await wait(() => source.read(seek, length, owned.signal));
        assert(run, owned.signal);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) throw failure('UPLOAD_SOURCE_CHANGED');
        if (pauseRequested) { phase = 'paused'; return snapshot(); }
        mayHavePartial = true;
        await wait(() => io.sendChunk({ bytes, seek, terminal: seek + length === size, hashes: hashes! }, owned.signal));
        assert(run, owned.signal);
        confirmedBytes = seek + length;
        terminal = confirmedBytes === size;
        callbacks.onProgress?.(snapshot());
        assert(run, owned.signal);
      }
      phase = 'verifying';
      const info = await wait(() => io.readFinalInfo(owned.signal));
      assert(run, owned.signal);
      const value = info && typeof info === 'object' && !Array.isArray(info) ? info as Record<string, unknown> : {};
      if (value.path !== target || value.name !== target.slice(target.lastIndexOf('/') + 1) ||
          value.is_dir !== false || value.encrypted_path || strictUploadSize(value.size) !== size) {
        throw failure('UPLOAD_READBACK_UNVERIFIED', 502);
      }
      phase = 'completed';
      return snapshot();
    } catch (error) {
      if (run === epoch && phase !== 'cancelled') {
        if (hashPaused && owned.signal.aborted) { phase = 'paused'; return snapshot(); }
        phase = 'failed';
      }
      const safe = uploadErrorDetails(error);
      mayHavePartial ||= safe.mayHavePartial;
      throw failure(safe.code, safe.status);
    } finally {
      callbacks.signal?.removeEventListener('abort', abort);
      if (run === epoch && controller === owned) controller = undefined;
    }
  }
  return {
    snapshot,
    run: (callbacks?: UploadEngineCallbacks) => execute(false, callbacks),
    resume: (callbacks?: UploadEngineCallbacks) => execute(true, callbacks),
    pause: () => {
      if (!controller) return;
      pauseRequested = true;
      const hashing = phase === 'hashing';
      phase = 'pausing';
      if (hashing) { hashPaused = true; controller.abort(); }
    },
    cancel: () => { phase = 'cancelled'; epoch++; controller?.abort(); controller = undefined; },
  };
}
