import { sha256 } from "@noble/hashes/sha2.js";
export type SnapshotProof = { sizeBytes: number; sha256: string };
const chunkBytes = 256 * 1024;
export function validateSnapshotProof(proof: SnapshotProof) {
  if (
    !Number.isSafeInteger(proof.sizeBytes) ||
    proof.sizeBytes < 0 ||
    typeof proof.sha256 !== "string" ||
    !/^[a-fA-F0-9]{64}$/.test(proof.sha256)
  )
    throw new Error("快照大小或 SHA256 记录无效，请重新读取备份列表");
}
/** Incremental SHA256 on bounded Blob slices; no full archive ArrayBuffer. */
export async function verifySnapshotBlob(
  blob: Blob,
  proof: SnapshotProof,
  signal: AbortSignal,
  current: () => void,
  onProgress?: (verified: number, total: number) => void,
) {
  const check = () => {
    current();
    if (signal.aborted) throw new DOMException("快照校验已取消", "AbortError");
  };
  check();
  validateSnapshotProof(proof);
  if (blob.size !== proof.sizeBytes)
    throw new Error("快照大小不一致，下载可能已中断，未保存文件");
  const hash = sha256.create();
  let verified = 0;
  try {
    onProgress?.(0, proof.sizeBytes);
    check();
    for (let offset = 0; offset < blob.size; offset += chunkBytes) {
      const slice = blob.slice(
        offset,
        Math.min(offset + chunkBytes, blob.size),
      );
      if (typeof slice.stream === "function") {
        const reader = slice.stream().getReader();
        const abort = () => {
          void reader.cancel().catch(() => {});
        };
        signal.addEventListener("abort", abort);
        try {
          while (true) {
            check();
            const part = await reader.read();
            check();
            if (part.done) break;
            if (
              part.value.byteLength > chunkBytes ||
              verified + part.value.byteLength > proof.sizeBytes
            )
              throw new Error("快照流大小无效，未保存文件");
            hash.update(part.value);
            verified += part.value.byteLength;
          }
        } finally {
          signal.removeEventListener("abort", abort);
          await reader.cancel().catch(() => {});
        }
      } else {
        // FileReader also supports LAN HTTP and older Blob implementations.
        const bytes = await new Promise<Uint8Array>((resolve, reject) => {
          const reader = new FileReader();
          const abort = () => reader.abort();
          signal.addEventListener("abort", abort);
          const cleanup = () => signal.removeEventListener("abort", abort);
          reader.onload = () => {
            cleanup();
            resolve(new Uint8Array(reader.result as ArrayBuffer));
          };
          reader.onerror = () => {
            cleanup();
            reject(new Error("快照分块读取失败，未保存文件"));
          };
          reader.onabort = () => {
            cleanup();
            reject(new DOMException("快照校验已取消", "AbortError"));
          };
          if (signal.aborted) {
            cleanup();
            reject(new DOMException("快照校验已取消", "AbortError"));
            return;
          }
          reader.readAsArrayBuffer(slice);
        });
        check();
        hash.update(bytes);
        verified += bytes.byteLength;
      }
      check();
      onProgress?.(verified, proof.sizeBytes);
      check();
      // Yield to timers and expiry/revocation events between bounded chunks.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      check();
    }
    if (verified !== proof.sizeBytes)
      throw new Error("快照大小不一致，未保存文件");
    const digest = Array.from(hash.digest(), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    check();
    if (digest !== proof.sha256.toLowerCase())
      throw new Error("快照 SHA256 校验不一致，文件可能已损坏，未保存文件");
  } finally {
    hash.destroy();
  }
}
