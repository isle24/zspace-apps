// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { hashUpload, UPLOAD_HASH_CHUNK_SIZE, UploadHashError, type UploadHashSource } from './upload-hashes';

const digest = (algorithm: string, ...parts: (string | Uint8Array)[]) => {
  const hash = createHash(algorithm); for (const part of parts) hash.update(part); return hash.digest('hex');
};
function source(bytes: Uint8Array, lastModified = 123): UploadHashSource {
  return { size: bytes.length, lastModified, read: vi.fn(async (offset, length) => bytes.slice(offset, offset + length)) };
}
const bytes = (size: number) => Uint8Array.from({ length: size }, (_, i) => (i * 31 + 17) % 256);
function expected(data: Uint8Array, modified: number, path: string) {
  const samples = data.length <= 2048 ? [data] : [data.subarray(0, 1024), data.subarray(data.length - 1024)];
  return { size: data.length, uuid: digest('sha1', String(modified + data.length), path),
    quickHash: digest('sha1', String(data.length), ...samples), md5: digest('md5', data), sha256: digest('sha256', data) };
}
async function staticError(work: Promise<unknown>, code: string) {
  const error = await work.catch(e => e);
  expect(error).toBeInstanceOf(UploadHashError); if (!(error instanceof UploadHashError)) throw new Error('Expected a static upload error'); expect(error.code).toBe(code);
  expect(error.cause).toBeUndefined(); expect(JSON.stringify(error) + error.message + error.stack).not.toContain('synthetic-private');
}

describe('bounded upload hashes', () => {
  it.each([0, 1, 2048, 2049, 2 * 1024 * 1024 + 3077])('matches independent full and quick vectors for %i bytes', async size => {
    const data = bytes(size), input = source(data), progress: number[] = [];
    const path = '/资料/ spaced 中文 😊.bin';
    expect(await hashUpload(input, path, { onProgress: p => { expect(p.totalBytes).toBe(size); progress.push(p.processedBytes); } })).toEqual(expected(data, 123, path));
    const calls = vi.mocked(input.read).mock.calls;
    expect(calls.map(([offset, length]) => [offset, length])).toEqual(size === 0 ? [] : Array.from({ length: Math.ceil(size / UPLOAD_HASH_CHUNK_SIZE) }, (_, i) => [i * UPLOAD_HASH_CHUNK_SIZE, Math.min(UPLOAD_HASH_CHUNK_SIZE, size - i * UPLOAD_HASH_CHUNK_SIZE)]));
    expect(progress.filter(n => n === size)).toHaveLength(1);
    expect(progress.every((n, i) => n >= 0 && n <= size && (i === 0 || n > progress[i - 1]))).toBe(true);
  });
  it('hashes empty and known abc vectors', async () => {
    expect(await hashUpload(source(new TextEncoder().encode('abc'), 0), '/abc')).toMatchObject({ md5: '900150983cd24fb0d6963f7d28e17f72', sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' });
    expect(await hashUpload(source(new Uint8Array(), 0), '/empty')).toMatchObject({ md5: 'd41d8cd98f00b204e9800998ecf8427e', quickHash: digest('sha1', '0') });
  });
  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid size %s without reading', async value => {
    const input = source(bytes(1)); input.size = value;
    await staticError(hashUpload(input, '/file'), 'INVALID_SOURCE'); expect(input.read).not.toHaveBeenCalled();
  });
  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid mtime %s', async value => {
    const input = source(bytes(1)); input.lastModified = value; await staticError(hashUpload(input, '/file'), 'INVALID_SOURCE');
  });
  it('rejects unsafe numeric addition', async () => { await staticError(hashUpload({ ...source(bytes(1)), lastModified: Number.MAX_SAFE_INTEGER }, '/file'), 'INVALID_SOURCE'); });
  it.each(['', '/', 'relative/file', '/a/', '/a//b', '/a/../b', '/./a', '/a\\b', '/a\u0000b', '/a\u0085b', '/a\ud800', '/a\udc00', '/   ', '/' + '中'.repeat(86), '/' + Array(33).fill('x'.repeat(255)).join('/')])('rejects invalid target path %j', async path => {
    const input = source(bytes(1)); await staticError(hashUpload(input, path), 'INVALID_TARGET_PATH'); expect(input.read).not.toHaveBeenCalled();
  });
  it('preserves valid UTF8 filename limit and whitespace', async () => {
    const path = '/' + '中'.repeat(85); expect(await hashUpload(source(bytes(1)), path)).toEqual(expected(bytes(1), 123, path));
  });
  it.each(['short', 'long', 'wrong', 'throws'])('rejects bad read %s with a private static error', async kind => {
    const input = source(bytes(3)); input.read = vi.fn(async () => { if (kind === 'throws') throw new Error('synthetic-private'); return (kind === 'wrong' ? new ArrayBuffer(3) : bytes(kind === 'short' ? 2 : 4)) as Uint8Array; });
    await staticError(hashUpload(input, '/file'), 'SOURCE_READ_FAILED'); expect(input.read).toHaveBeenCalledTimes(1);
  });
  it('checks cancellation before any read', async () => {
    const abort = new AbortController(); abort.abort('synthetic-private'); const input = source(bytes(3));
    await staticError(hashUpload(input, '/file', { signal: abort.signal }), 'CANCELLED'); expect(input.read).not.toHaveBeenCalled();
  });
  it('rejects cancellation during a stalled read promptly and ignores the late bytes', async () => {
    const abort = new AbortController(); let finish!: (value: Uint8Array) => void;
    const input = source(bytes(UPLOAD_HASH_CHUNK_SIZE + 1)); input.read = vi.fn(() => new Promise<Uint8Array>(resolve => { finish = resolve; }));
    const progress = vi.fn(), work = hashUpload(input, '/file', { signal: abort.signal, onProgress: progress });
    await Promise.resolve(); abort.abort('synthetic-private'); await staticError(work, 'CANCELLED'); finish(bytes(UPLOAD_HASH_CHUNK_SIZE));
    await Promise.resolve(); expect(input.read).toHaveBeenCalledTimes(1); expect(progress).not.toHaveBeenCalled();
  });
  it('stops immediately when a completed read cancels its signal', async () => {
    const abort = new AbortController(), input = source(bytes(UPLOAD_HASH_CHUNK_SIZE + 1));
    input.read = vi.fn(async (_offset, length) => { abort.abort(); return bytes(length); });
    await staticError(hashUpload(input, '/file', { signal: abort.signal }), 'CANCELLED'); expect(input.read).toHaveBeenCalledTimes(1);
  });
  it('stops when progress cancels between hashing chunks', async () => {
    const abort = new AbortController(), input = source(bytes(UPLOAD_HASH_CHUNK_SIZE + 1));
    await staticError(hashUpload(input, '/file', { signal: abort.signal, onProgress: () => abort.abort() }), 'CANCELLED'); expect(input.read).toHaveBeenCalledTimes(1);
  });
  it('sanitizes thrown progress callbacks', async () => { const input = source(bytes(3)); await staticError(hashUpload(input, '/file', { onProgress: () => { throw new Error('synthetic-private'); } }), 'HASH_FAILED'); expect(input.read).toHaveBeenCalledTimes(1); });
  it('rejects changed source metadata after await', async () => {
    const input = source(bytes(3)); input.read = vi.fn(async () => { input.lastModified++; return bytes(3); });
    await staticError(hashUpload(input, '/file'), 'SOURCE_CHANGED');
  });
});

it('rejects source failures that impersonate a public error without exporting arbitrary fields', async () => {
  const input = source(bytes(3));
  input.read = vi.fn(async () => { const e = new UploadHashError('HASH_FAILED'); Object.assign(e, { message: 'synthetic-private', cause: 'synthetic-private' }); throw e; });
  await staticError(hashUpload(input, '/file'), 'SOURCE_READ_FAILED');
});
it('sanitizes throwing source metadata and missing read methods', async () => {
  const input = source(bytes(3)); Object.defineProperty(input, 'size', { get() { throw new Error('synthetic-private'); } });
  await staticError(hashUpload(input, '/file'), 'INVALID_SOURCE');
  await staticError(hashUpload({ size: 3, lastModified: 123, read: undefined } as unknown as UploadHashSource, '/file'), 'INVALID_SOURCE');
});
it('includes the tail exactly once when it crosses a full read boundary', async () => {
  const data = bytes(UPLOAD_HASH_CHUNK_SIZE + 1); expect(await hashUpload(source(data), '/file')).toEqual(expected(data, 123, '/file'));
});


describe('NAS-compatible full target path byte boundary', () => {
  it.each([18, 32])('preserves all text and hashes a target with %i valid 255-byte components', async components => {
    const path = '/' + Array(components).fill('中'.repeat(85)).join('/');
    expect(new TextEncoder().encode(path)).toHaveLength(components * 256);
    const data = bytes(3), input = source(data);
    expect(await hashUpload(input, path)).toEqual(expected(data, 123, path));
    expect(input.read).toHaveBeenCalledTimes(1);
  });
  it.each([8193, 8448])('rejects %i UTF8-byte targets before reading the source', async byteLength => {
    const path = byteLength === 8193
      ? '/' + Array(31).fill('中'.repeat(85)).join('/') + '/' + '中'.repeat(84) + 'ab/a'
      : '/' + Array(33).fill('中'.repeat(85)).join('/');
    expect(new TextEncoder().encode(path)).toHaveLength(byteLength);
    const input = source(bytes(3));
    await staticError(hashUpload(input, path), 'INVALID_TARGET_PATH');
    expect(input.read).not.toHaveBeenCalled();
  });
});

describe("与原生实现(Rust)共用同一组向量", () => {
  /**
   * 上传分片哈希在两端各有一份实现：网页版是 TS（本文件），客户端是 Rust
   * （`src-tauri/src/upload_hash.rs`）。**两边算出来的值必须一模一样**，
   * 否则同一份文件在浏览器里能传、在 Mac 客户端里就会失败 —— 而且只在一边坏。
   *
   * 下面这组值来自 Rust 侧那条名为 `independent_python_vectors_full_and_quick_boundaries`
   * 的测试（它自己又是用 Python 独立算出来的），我另外用 Python 复算核对过一遍。
   * 现在两端都钉在同一组数字上：任何一边改了规则，都会有一边红。
   *
   * 内容规则：size 为 3 时是 b"abc"，其余是 (i % 251)；
   * lastModified = 1700000000123，目标路径 "/新目录/资料.txt"。
   */
  const TARGET = "/新目录/资料.txt";
  const LAST_MODIFIED = 1700000000123;
  const content = (n: number) =>
    n === 3 ? new TextEncoder().encode("abc") : Uint8Array.from({ length: n }, (_, i) => i % 251);

  it.each([
    [0, "d41d8cd98f00b204e9800998ecf8427e", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "b6589fc6ab0dc82cf12099d1c2d40ab994e8410c", "ebe4d3fe294d243b9efe8292866000300d8df522"],
    [3, "900150983cd24fb0d6963f7d28e17f72", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "849a2d6d722dd7429b22eaad96c44aee92450bb7", "24a82a3b2a733f66fb5ccd8c0b00e82af519c4bc"],
    [2049, "cb7fabac9ac9fd2cb4e79a6d12c8308e", "26e1e2808e3a6cf967ca03f6749a063c5ed55f92f5874653a1faabed78346f00", "41e22fffb471e98bc81424506d8fd49f29c8a8dc", "cfdf31ec130cbc5acabb5aec1800c7d13f97c6d6"],
  ])("size=%i 的 md5/sha256/quickHash/uuid 与 Rust 一致", async (size, md5, sha256, quickHash, uuid) => {
    const data = content(size);
    const result = await hashUpload(source(data, LAST_MODIFIED), TARGET);
    expect(result).toEqual({ size, md5, sha256, quickHash, uuid });
  });
});
