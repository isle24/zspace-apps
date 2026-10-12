import { md5, sha1 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const UPLOAD_HASH_CHUNK_SIZE = 2 * 1024 * 1024;
const MAX_UPLOAD_TARGET_PATH_BYTES = 8192;
export interface UploadHashSource {
  size: number;
  lastModified: number;
  read(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array>;
}
export interface UploadHashProgress { processedBytes: number; totalBytes: number; }
export interface UploadHashes { size: number; uuid: string; quickHash: string; md5: string; sha256: string; }
export interface UploadHashOptions { signal?: AbortSignal; onProgress?: (progress: UploadHashProgress) => void; }
const errorMessages = {
  INVALID_SOURCE: 'Invalid upload source',
  INVALID_TARGET_PATH: 'Invalid upload target path',
  SOURCE_CHANGED: 'Upload source changed',
  SOURCE_READ_FAILED: 'Could not read upload source',
  CANCELLED: 'Upload hashing cancelled',
  HASH_FAILED: 'Could not hash upload source',
  WORKER_UNAVAILABLE: 'Upload hashing worker is unavailable',
  WORKER_FAILED: 'Upload hashing worker failed',
  WORKER_PROTOCOL_ERROR: 'Invalid upload hashing worker response',
} as const;
export type UploadHashErrorCode = keyof typeof errorMessages;
export class UploadHashError extends Error {
  readonly code: UploadHashErrorCode;
  constructor(code: UploadHashErrorCode) {
    super(errorMessages[code]); this.name = 'UploadHashError'; this.code = code;
  }
}
export function isUploadHashErrorCode(value: unknown): value is UploadHashErrorCode {
  return typeof value === 'string' && Object.hasOwn(errorMessages, value);
}

function validText(value: string, byteLimit: number): boolean {
  if (value.length > byteLimit || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return new TextEncoder().encode(value).length <= byteLimit;
}
/** Validates the actual absolute destination without normalizing names or spaces. */
export function validateUploadHashInput(size: number, lastModified: number, targetPath: string): void {
  if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(lastModified) || lastModified < 0 || !Number.isSafeInteger(size + lastModified))
    throw new UploadHashError('INVALID_SOURCE');
  if (typeof targetPath !== 'string' || !validText(targetPath, MAX_UPLOAD_TARGET_PATH_BYTES) || !targetPath.startsWith('/') || targetPath.includes('\\') ||
      !targetPath.slice(1).split('/').every(part => !!part.trim() && part !== '.' && part !== '..' && validText(part, 255)))
    throw new UploadHashError('INVALID_TARGET_PATH');
}
/** Bounded metadata-only official upload identity shared by all source consumers. */
export function computeUploadUUID(size: number, lastModified: number, targetPath: string): string {
  validateUploadHashInput(size, lastModified, targetPath);
  return bytesToHex(sha1(new TextEncoder().encode(String(lastModified + size) + targetPath)));
}
function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new UploadHashError('CANCELLED');
}
/** A stalled source does not delay cancellation; late reads are never hashed. */
function readOrCancel(read: () => Promise<Uint8Array>, signal: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(new UploadHashError('CANCELLED')); };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    let result: Promise<Uint8Array>;
    try { result = read(); } catch { signal.removeEventListener('abort', cancel); reject(new UploadHashError(signal.aborted ? 'CANCELLED' : 'SOURCE_READ_FAILED')); return; }
    Promise.resolve(result).then(value => {
      signal.removeEventListener('abort', cancel);
      if (signal.aborted) reject(new UploadHashError('CANCELLED')); else resolve(value);
    }, () => {
      signal.removeEventListener('abort', cancel);
      reject(new UploadHashError(signal.aborted ? 'CANCELLED' : 'SOURCE_READ_FAILED'));
    });
  });
}
/** Allow Worker CANCEL messages to run even when a source resolves immediately. */
function yieldOrCancel(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(new UploadHashError('CANCELLED')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, 0);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

/** Sequential full-file hashing with at most one 2 MiB source read in flight. */
export async function hashUpload(source: UploadHashSource, targetPath: string, options: UploadHashOptions = {}): Promise<UploadHashes> {
  const signal = options.signal ?? new AbortController().signal;
  assertNotCancelled(signal);
  let size: number, lastModified: number, read: UploadHashSource['read'];
  try { size = source.size; lastModified = source.lastModified; read = source.read; }
  catch { throw new UploadHashError('INVALID_SOURCE'); }
  validateUploadHashInput(size, lastModified, targetPath);
  if (typeof read !== 'function') throw new UploadHashError('INVALID_SOURCE');
  const assertCurrent = () => {
    assertNotCancelled(signal);
    let same: boolean;
    try { same = source.size === size && source.lastModified === lastModified; } catch { same = false; }
    if (!same) throw new UploadHashError('SOURCE_CHANGED');
  };
  const fullMd5 = md5.create(), fullSha256 = sha256.create(), quick = sha1.create();
  try {
    quick.update(new TextEncoder().encode(String(size)));
    for (let offset = 0; offset < size;) {
      assertCurrent();
      const length = Math.min(UPLOAD_HASH_CHUNK_SIZE, size - offset);
      const data = await readOrCancel(() => read.call(source, offset, length, signal), signal);
      assertCurrent();
      if (!(data instanceof Uint8Array) || data.byteLength !== length) throw new UploadHashError('SOURCE_READ_FAILED');
      fullMd5.update(data); fullSha256.update(data);
      if (size <= 2048) quick.update(data);
      else {
        if (offset < 1024) quick.update(data.subarray(0, Math.min(length, 1024 - offset)));
        const tailStart = Math.max(offset, size - 1024);
        if (tailStart < offset + length) quick.update(data.subarray(tailStart - offset));
      }
      offset += length;
      assertCurrent();
      try { options.onProgress?.({ processedBytes: offset, totalBytes: size }); }
      catch { throw new UploadHashError('HASH_FAILED'); }
      assertCurrent();
      if (offset < size) { await yieldOrCancel(signal); assertCurrent(); }
    }
    const result = { size, uuid: computeUploadUUID(size, lastModified, targetPath),
      quickHash: bytesToHex(quick.digest()), md5: bytesToHex(fullMd5.digest()), sha256: bytesToHex(fullSha256.digest()) };
    assertCurrent();
    if (size === 0) {
      try { options.onProgress?.({ processedBytes: 0, totalBytes: 0 }); } catch { throw new UploadHashError('HASH_FAILED'); }
      assertCurrent();
    }
    return result;
  } catch (error) {
    // Only errors made here are exported. Source and observer exceptions are replaced above.
    if (error instanceof UploadHashError) throw error;
    throw new UploadHashError('HASH_FAILED');
  } finally {
    fullMd5.destroy(); fullSha256.destroy(); quick.destroy();
  }
}
