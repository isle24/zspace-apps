// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { deliverBrowserDownload, BLOB_DOWNLOAD_LIMIT, type BrowserDeliveryEnvironment } from "./browser-download";
import { OfficialNasError } from "./official-nas";

const descriptor = { id: "a".repeat(64), sessionId: "session-one", name: "资料.svg", size: 6 };
function fixture(overrides: Partial<BrowserDeliveryEnvironment> = {}) {
  const writes: Uint8Array[] = [];
  const blobs: Blob[] = [];
  const sink = { write: vi.fn(async (chunk: Uint8Array) => { writes.push(chunk.slice()); }), close: vi.fn(async () => {}), abort: vi.fn() };
  const environment: BrowserDeliveryEnvironment = {
    openStream: async () => sink,
    saveBlob: (blob) => { blobs.push(blob); },
    onPageUnload: () => () => {},
    ...overrides,
  };
  return { environment, sink, writes, blobs };
}
function response(bytes: Uint8Array[]) {
  return new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(byte); controller.close(); } }));
}
const options = (environment: BrowserDeliveryEnvironment, fetchDownload = async () => response([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])])) => ({
  download: descriptor, fetchDownload, isSessionCurrent: () => true, environment,
});

it.each(["auto", "compatible"] as const)("preserves only recognized SDK download classification in %s delivery", async mode => {
  const f = fixture();
  // Construct with the existing API so RED is an assertion failure, not a missing API error.
  const error = Object.assign(new OfficialNasError("synthetic-private-upstream", "INVALID_DOWNLOAD_RESPONSE", 502), { diagnostic: "DOWNLOAD_DISPOSITION_MISSING" });
  const failure = await deliverBrowserDownload({ ...options(f.environment, async () => { throw error; }), mode }).catch(error => error);
  expect(failure).toMatchObject({ code: "DELIVERY_FAILED", diagnostic: "DOWNLOAD_DISPOSITION_MISSING", mayHavePartial: mode === "auto" });
  expect(JSON.stringify(failure)).not.toContain("synthetic-private");
  expect(f.sink.close).not.toHaveBeenCalled(); expect(f.blobs).toHaveLength(0);
});
it.each(["arbitrary", "forged", "non-download"])("keeps %s diagnostic input generic", async kind => {
  const f = fixture();
  const error = Object.assign(kind === "non-download" ? new OfficialNasError("synthetic-private-upstream", "NO_SESSION", 401) : new Error("synthetic-private-upstream"), { diagnostic: kind === "arbitrary" ? "synthetic-private-diagnostic" : "DOWNLOAD_DISPOSITION_MISSING" });
  const failure = await deliverBrowserDownload({ ...options(f.environment, async () => { throw error; }), mode: "compatible" }).catch(error => error);
  expect(failure.diagnostic).toBeUndefined(); expect(failure.message).toBe("浏览器下载未完成");
  expect(JSON.stringify(failure)).not.toContain("synthetic-private");
});
it.each(["cancel", "session"])("keeps %s outcome ahead of SDK download classification", async fence => {
  const f = fixture(); const abort = new AbortController(); let current = true;
  const error = Object.assign(new OfficialNasError("synthetic-private-upstream", "INVALID_DOWNLOAD_RESPONSE", 502), { diagnostic: "DOWNLOAD_ENCODING" });
  const failure = await deliverBrowserDownload({ ...options(f.environment, async () => { if (fence === "cancel") abort.abort(); else current = false; throw error; }), mode: "compatible", signal: abort.signal, isSessionCurrent: () => current }).catch(error => error);
  expect(failure.code).toBe(fence === "cancel" ? "CANCELLED" : "SESSION_CHANGED");
  expect(failure.diagnostic).toBeUndefined();
});

describe("browser stream delivery", () => {
  it("hands every verified byte to the browser with an honest outcome", async () => {
    const f = fixture(); const progress = vi.fn();
    const result = await deliverBrowserDownload({ ...options(f.environment), onProgress: progress });
    expect(f.writes.map((chunk) => [...chunk])).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(result).toEqual({ received: 6, total: 6, outcome: "handed-to-browser", method: "stream", diskCompletion: "unknown" });
    expect(f.sink.close).toHaveBeenCalledOnce();
    expect(progress.mock.calls.map(([value]) => value.received)).toEqual([3, 6]);
  });
  it("reports a total learned from the guarded response and preserves an empty file", async () => {
    const f = fixture(); const progress = vi.fn();
    const result = await deliverBrowserDownload({ ...options(f.environment, async () => new Response(new Uint8Array([1, 2]), { headers: { "Content-Length": "2" } })), download: { ...descriptor, size: undefined }, onProgress: progress });
    expect(result.total).toBe(2); expect(progress).toHaveBeenCalledWith({ received: 2, total: 2 });
    const empty = fixture();
    expect(await deliverBrowserDownload({ ...options(empty.environment, async () => response([])), download: { ...descriptor, size: 0 } })).toMatchObject({ received: 0, total: 0 });
    expect(empty.sink.write).not.toHaveBeenCalled(); expect(empty.sink.close).toHaveBeenCalledOnce();
  });
  it("splits oversized SDK chunks into bounded messages and reports accepted subchunks", async () => {
    const f = fixture(); const progress = vi.fn(); const bytes = new Uint8Array(1024 * 1024 * 2 + 9).fill(7);
    await deliverBrowserDownload({ ...options(f.environment, async () => response([bytes])), download: { ...descriptor, size: bytes.length }, onProgress: progress });
    expect(f.writes.map((chunk) => chunk.length)).toEqual([1024 * 1024, 1024 * 1024, 9]);
    expect(progress.mock.calls.map(([value]) => value.received)).toEqual([1024 * 1024, 1024 * 1024 * 2, bytes.length]);
  });
  it("waits for downstream acceptance before reading another source chunk", async () => {
    let release!: () => void; let pulls = 0;
    const accepted = new Promise<void>((resolve) => { release = resolve; });
    const f = fixture(); f.sink.write.mockImplementationOnce(() => accepted);
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulls++; if (pulls < 4) c.enqueue(new Uint8Array([pulls])); else c.close(); } }, { highWaterMark: 0 });
    const pending = deliverBrowserDownload({ ...options(f.environment, async () => new Response(body)), download: { ...descriptor, size: 3 } });
    await vi.waitFor(() => expect(f.sink.write).toHaveBeenCalledOnce());
    expect(pulls).toBe(1); release(); await pending;
    expect(pulls).toBe(4);
  });
  it("streams a file larger than the Blob limit without gathering it in memory", async () => {
    const f = fixture(); let n = 0; const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({ pull(c) { if (n++ < 65) c.enqueue(chunk); else c.close(); } }, { highWaterMark: 0 });
    const result = await deliverBrowserDownload({ ...options(f.environment, async () => new Response(body)), download: { ...descriptor, size: chunk.length * 65 } });
    expect(result.received).toBe(chunk.length * 65); expect(f.blobs).toHaveLength(0);
  });
  it("does not close a partial browser file when the SDK rejects EOF validation", async () => {
    const f = fixture(); let n = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { if (n++ === 0) c.enqueue(new Uint8Array([1])); else c.error(new Error("upstream secret must stay private")); } }, { highWaterMark: 0 });
    await expect(deliverBrowserDownload(options(f.environment, async () => new Response(body)))).rejects.toMatchObject({ code: "DELIVERY_FAILED", browserHandoffStarted: true, mayHavePartial: true, message: "浏览器下载未完成，请检查下载管理器中的不完整文件" });
    expect(f.sink.close).not.toHaveBeenCalled(); expect(f.sink.abort).toHaveBeenCalledOnce(); expect(f.blobs).toHaveLength(0);
  });
  it("cancels pending source reads and reports an incomplete browser handoff", async () => {
    const f = fixture(); const cancelled = vi.fn(); const abort = new AbortController();
    const body = new ReadableStream<Uint8Array>({ pull() {}, cancel: cancelled }, { highWaterMark: 0 });
    const pending = deliverBrowserDownload({ ...options(f.environment, async () => new Response(body)), signal: abort.signal });
    await vi.waitFor(() => expect(body.locked).toBe(true)); abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED", browserHandoffStarted: true, mayHavePartial: true });
    expect(cancelled).toHaveBeenCalledOnce(); expect(f.sink.close).not.toHaveBeenCalled();
  });
  it("rejects old sessions before acquiring a sink or fetching", async () => {
    const openStream = vi.fn(); const fetchDownload = vi.fn(); const f = fixture({ openStream });
    await expect(deliverBrowserDownload({ ...options(f.environment, fetchDownload), isSessionCurrent: () => false })).rejects.toMatchObject({ code: "SESSION_CHANGED", browserHandoffStarted: false, mayHavePartial: false });
    expect(openStream).not.toHaveBeenCalled(); expect(fetchDownload).not.toHaveBeenCalled();
  });
  it("rejects session replacement during a blocked sink write", async () => {
    let current = true; let finish!: () => void;
    const f = fixture(); f.sink.write.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const pending = deliverBrowserDownload({ ...options(f.environment), isSessionCurrent: () => current });
    await vi.waitFor(() => expect(f.sink.write).toHaveBeenCalledOnce()); current = false; finish();
    await expect(pending).rejects.toMatchObject({ code: "SESSION_CHANGED", browserHandoffStarted: true, mayHavePartial: true }); expect(f.sink.close).not.toHaveBeenCalled();
  });
  it("page unload cancels an active transfer while module/window closure is not a transport event", async () => {
    let unload!: () => void; const dispose = vi.fn(); const f = fixture({ onPageUnload(cb) { unload = cb; return dispose; } });
    const body = new ReadableStream<Uint8Array>({ pull() {} }, { highWaterMark: 0 });
    const pending = deliverBrowserDownload(options(f.environment, async () => new Response(body)));
    await vi.waitFor(() => expect(body.locked).toBe(true)); unload();
    await expect(pending).rejects.toMatchObject({ code: "PAGE_UNLOADED", browserHandoffStarted: true, mayHavePartial: true }); expect(dispose).toHaveBeenCalledOnce();
  });
  it("capability expiry is safe and cannot silently switch after a stream is started", async () => {
    const f = fixture();
    await expect(deliverBrowserDownload(options(f.environment, async () => { throw new Error("expired private URL"); }))).rejects.toMatchObject({ code: "DELIVERY_FAILED", browserHandoffStarted: true, mayHavePartial: true });
    expect(f.blobs).toHaveLength(0); expect(f.sink.close).not.toHaveBeenCalled();
  });
  it("bounds upstream header/read inactivity and cancels the SDK request", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); let upstreamSignal!: AbortSignal;
      const pending = deliverBrowserDownload(options(f.environment, async (_id?: unknown, opts?: any) => { upstreamSignal = opts.signal; return await new Promise<Response>(() => {}); }));
      void pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(30001);
      expect(upstreamSignal.aborted).toBe(true);
      await expect(pending).rejects.toMatchObject({ code: "DELIVERY_FAILED", browserHandoffStarted: true, diagnostic: "UPSTREAM_HEADERS_TIMEOUT" });
      const cancelled = vi.fn(); const body = new ReadableStream<Uint8Array>({ pull() {}, cancel: cancelled }, { highWaterMark: 0 });
      const read = deliverBrowserDownload(options(f.environment, async () => new Response(body))); void read.catch(() => {});
      await vi.advanceTimersByTimeAsync(30001);
      expect(cancelled).toHaveBeenCalledOnce(); await expect(read).rejects.toMatchObject({ code: "DELIVERY_FAILED", diagnostic: "UPSTREAM_READ_TIMEOUT" });
    } finally { vi.useRealTimers(); }
  });
});

describe("bounded Blob fallback", () => {
  function fallback() { return fixture({ openStream: async () => { throw new Error("worker unsupported"); } }); }
  it.each(["plain text", "{\"legal\":true}", "<svg>legal</svg>", "<html>legal</html>"])("saves legal attachment content %s only after complete EOF", async (text) => {
    const f = fallback(); const bytes = new TextEncoder().encode(text);
    const result = await deliverBrowserDownload({ ...options(f.environment, async () => response([bytes])), download: { ...descriptor, size: bytes.length } });
    expect(await f.blobs[0].text()).toBe(text); expect(f.blobs[0].type).toBe("application/octet-stream"); expect(result.method).toBe("blob");
  });
  it("rejects known large fallback before source fetch", async () => {
    const f = fallback(); const fetchDownload = vi.fn();
    await expect(deliverBrowserDownload({ ...options(f.environment, fetchDownload), download: { ...descriptor, size: BLOB_DOWNLOAD_LIMIT + 1 } })).rejects.toMatchObject({ code: "BLOB_LIMIT", browserHandoffStarted: false, mayHavePartial: false });
    expect(fetchDownload).not.toHaveBeenCalled(); expect(f.blobs).toHaveLength(0);
  });
  it("stops unknown-size fallback at the limit without issuing a truncated Blob", async () => {
    const f = fallback(); let n = 0; const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull(c) { n++; c.enqueue(new Uint8Array(1024 * 1024)); }, cancel: cancelled }, { highWaterMark: 0 });
    await expect(deliverBrowserDownload({ ...options(f.environment, async () => new Response(body)), download: { ...descriptor, size: undefined } })).rejects.toMatchObject({ code: "BLOB_LIMIT", browserHandoffStarted: false, mayHavePartial: false });
    expect(n).toBe(65); expect(cancelled).toHaveBeenCalled(); expect(f.blobs).toHaveLength(0);
  });
  it("rejects a large declared fallback body before reading any bytes", async () => {
    const f = fallback(); const cancelled = vi.fn(); const pulled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull: pulled, cancel: cancelled }, { highWaterMark: 0 });
    await expect(deliverBrowserDownload({ ...options(f.environment, async () => new Response(body, { headers: { "Content-Length": String(BLOB_DOWNLOAD_LIMIT + 1) } })), download: { ...descriptor, size: undefined } })).rejects.toMatchObject({ code: "BLOB_LIMIT" });
    expect(pulled).not.toHaveBeenCalled(); expect(cancelled).toHaveBeenCalledOnce(); expect(f.blobs).toHaveLength(0);
  });
  it("never emits a Blob on partial response or session-invalid EOF", async () => {
    const f = fallback(); const body = new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error("private partial")); } });
    await expect(deliverBrowserDownload(options(f.environment, async () => new Response(body)))).rejects.toMatchObject({ code: "DELIVERY_FAILED", browserHandoffStarted: false, mayHavePartial: false });
    expect(f.blobs).toHaveLength(0);
  });
});

describe("explicit compatible mode", () => {
  it("observes a rejected source promise when its callback synchronously cancels the caller", async () => {
    const f = fixture(); const abort = new AbortController();
    const sentinel = new Error("synthetic wait rejection sentinel");
    const operation = Promise.reject<Response>(sentinel);
    const observed = vi.spyOn(operation, "then");
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { if (error === sentinel) unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const failure = await deliverBrowserDownload({ ...options(f.environment, () => { abort.abort(); return operation; }), signal: abort.signal, mode: "compatible" }).catch((error) => error);
      expect(failure).toMatchObject({ code: "CANCELLED", browserHandoffStarted: false, message: "下载已取消" });
      expect(observed.mock.calls.some(([, reject]) => typeof reject === "function")).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toHaveLength(0); expect(f.blobs).toHaveLength(0);
    } finally {
      // Keep the intentionally failing red probe from emitting a second global error.
      void operation.catch(() => {}); process.removeListener("unhandledRejection", onUnhandled);
    }
  });
  it("selects complete bounded Blob delivery without worker setup or stream links", async () => {
    const openStream = vi.fn(); const f = fixture({ openStream });
    const result = await deliverBrowserDownload({ ...options(f.environment), mode: "compatible" });
    expect(openStream).not.toHaveBeenCalled(); expect(f.writes).toHaveLength(0);
    expect(new Uint8Array(await f.blobs[0].arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    expect(result).toEqual({ received: 6, total: 6, outcome: "handed-to-browser", method: "blob", diskCompletion: "unknown" });
  });
  it("rejects known large files before worker setup or source fetch", async () => {
    const openStream = vi.fn(); const fetchDownload = vi.fn(); const f = fixture({ openStream });
    await expect(deliverBrowserDownload({ ...options(f.environment, fetchDownload), mode: "compatible", download: { ...descriptor, size: BLOB_DOWNLOAD_LIMIT + 1 } })).rejects.toMatchObject({ code: "BLOB_LIMIT", browserHandoffStarted: false, message: "兼容下载最多支持 64 MiB；更大的文件请使用支持流式下载的浏览器或桌面客户端" });
    expect(openStream).not.toHaveBeenCalled(); expect(fetchDownload).not.toHaveBeenCalled(); expect(f.blobs).toHaveLength(0);
  });
  it("honors stale sessions and cancellation before any compatible source request", async () => {
    const f = fixture(); const fetchDownload = vi.fn();
    await expect(deliverBrowserDownload({ ...options(f.environment, fetchDownload), mode: "compatible", isSessionCurrent: () => false })).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    const abort = new AbortController(); abort.abort();
    await expect(deliverBrowserDownload({ ...options(f.environment, fetchDownload), mode: "compatible", signal: abort.signal })).rejects.toMatchObject({ code: "CANCELLED" });
    expect(fetchDownload).not.toHaveBeenCalled(); expect(f.blobs).toHaveLength(0);
  });
  it("never emits compatible output on capability expiry or an invalid EOF", async () => {
    const f = fixture();
    await expect(deliverBrowserDownload({ ...options(f.environment, async () => { throw new Error("expired private upstream"); }), mode: "compatible" })).rejects.toMatchObject({ code: "DELIVERY_FAILED", browserHandoffStarted: false });
    const body = new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error("invalid private framing")); } });
    await expect(deliverBrowserDownload({ ...options(f.environment, async () => new Response(body)), mode: "compatible" })).rejects.toMatchObject({ code: "DELIVERY_FAILED", browserHandoffStarted: false });
    expect(f.blobs).toHaveLength(0);
  });
  it("never emits compatible output after a source changes the current session", async () => {
    const f = fixture(); let current = true;
    await expect(deliverBrowserDownload({ ...options(f.environment, async () => { current = false; return response([new Uint8Array(6)]); }), mode: "compatible", isSessionCurrent: () => current })).rejects.toMatchObject({ code: "SESSION_CHANGED", browserHandoffStarted: false });
    expect(f.blobs).toHaveLength(0);
  });
  it("stops unknown compatible files at the bound instead of emitting truncated output", async () => {
    const f = fixture(); const cancel = vi.fn(); let read = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { if (read < 65) { read++; c.enqueue(new Uint8Array(1024 * 1024)); } else c.close(); }, cancel }, { highWaterMark: 0 });
    await expect(deliverBrowserDownload({ ...options(f.environment, async () => new Response(body)), mode: "compatible", download: { ...descriptor, size: undefined } })).rejects.toMatchObject({ code: "BLOB_LIMIT", browserHandoffStarted: false });
    expect(read).toBe(65); expect(cancel).toHaveBeenCalledOnce(); expect(f.blobs).toHaveLength(0);
  });
});
