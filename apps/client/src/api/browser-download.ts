import type { FileDownload } from "./client";
import { OfficialNasError } from "./official-nas";
import { safeDownloadDiagnostic, safeOfficialDownloadDiagnostic, type DownloadFailureDiagnostic } from "./download-diagnostics";

export const BLOB_DOWNLOAD_LIMIT = 64 * 1024 * 1024;
const DIAGNOSTICS = ["WORKER_OWNER_LOST", "WORKER_PROTOCOL", "WORKER_SIZE_MISMATCH", "WORKER_SETUP_EXPIRED", "WORKER_INACTIVITY", "WORKER_SETUP_REJECTED", "WORKER_MESSAGE_ERROR", "BROWSER_CANCELLED", "PAGE_ABORTED", "WORKER_REPLACED", "PAGE_PROTOCOL", "PAGE_MESSAGE_ERROR", "PAGE_SETUP_TIMEOUT", "PAGE_PULL_TIMEOUT", "PAGE_ACK_TIMEOUT", "PAGE_END_TIMEOUT", "UPSTREAM_HEADERS_TIMEOUT", "UPSTREAM_READ_TIMEOUT", "SINK_WRITE_TIMEOUT", "SINK_CLOSE_TIMEOUT"] as const;
export type BrowserDownloadDiagnostic = typeof DIAGNOSTICS[number] | DownloadFailureDiagnostic;
const safeWorkerDiagnostic = (value: unknown): typeof DIAGNOSTICS[number] | undefined => typeof value === "string" && (DIAGNOSTICS as readonly string[]).includes(value) ? value as typeof DIAGNOSTICS[number] : undefined;
const safeDiagnostic = (value: unknown): BrowserDownloadDiagnostic | undefined => safeWorkerDiagnostic(value) ?? safeDownloadDiagnostic(value);
const diagnosticOf = (error: unknown) => error instanceof OfficialNasError ? safeOfficialDownloadDiagnostic(error.code, error.diagnostic) : error && typeof error === "object" && "diagnostic" in error ? safeWorkerDiagnostic(error.diagnostic) : undefined;
export type BrowserDownloadResult = {
  received: number; total?: number;
  outcome: "handed-to-browser"; method: "stream" | "blob"; diskCompletion: "unknown";
};
export type BrowserDownloadProgress = { received: number; total?: number };
export type BrowserDownloadSink = {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): void;
  onFailure?(callback: (diagnostic?: BrowserDownloadDiagnostic) => void): () => void;
};
export type BrowserDeliveryEnvironment = {
  openStream(name: string, size: number | undefined, signal: AbortSignal): Promise<BrowserDownloadSink>;
  saveBlob(blob: Blob, name: string): void;
  onPageUnload(callback: () => void): () => void;
};
export type BrowserDownloadOptions = {
  download: FileDownload;
  /** Explicit user-selected compatibility retry; auto remains streaming-first. */
  mode?: "auto" | "compatible";
  fetchDownload(id: string, options: { signal: AbortSignal }): Promise<Response>;
  isSessionCurrent(): boolean;
  signal?: AbortSignal;
  onProgress?(progress: BrowserDownloadProgress): void;
  environment?: BrowserDeliveryEnvironment;
};
export class BrowserDownloadError extends Error {
  readonly diskCompletion = "unknown";
  readonly mayHavePartial: boolean;
  readonly diagnostic?: BrowserDownloadDiagnostic;
  constructor(public readonly code: "DELIVERY_FAILED" | "CANCELLED" | "PAGE_UNLOADED" | "SESSION_CHANGED" | "BLOB_LIMIT" | "INVALID_DOWNLOAD", public readonly browserHandoffStarted: boolean, diagnostic?: BrowserDownloadDiagnostic) {
    super(code === "BLOB_LIMIT" ? "兼容下载最多支持 64 MiB；更大的文件请使用支持流式下载的浏览器或桌面客户端" :
      browserHandoffStarted ? "浏览器下载未完成，请检查下载管理器中的不完整文件" :
      code === "SESSION_CHANGED" ? "登录会话已改变，下载已停止" : code === "CANCELLED" ? "下载已取消" : code === "PAGE_UNLOADED" ? "页面已离开，下载未完成" : "浏览器下载未完成");
    this.name = "BrowserDownloadError";
    this.mayHavePartial = browserHandoffStarted;
    this.diagnostic = safeDiagnostic(diagnostic);
  }
}

function validName(name: string): boolean {
  return !!name && name.length <= 255 && name !== "." && name !== ".." && !/[\\/\u0000-\u001f\u007f]/.test(name);
}

/** Call from a user action. Lifetime belongs to the app transfer controller, not a Files window. */
export async function deliverBrowserDownload(options: BrowserDownloadOptions): Promise<BrowserDownloadResult> {
  const { download, fetchDownload, isSessionCurrent, onProgress } = options;
  const environment = options.environment ?? createBrowserDeliveryEnvironment();
  const controller = new AbortController();
  let cancellation: "CANCELLED" | "PAGE_UNLOADED" | "DELIVERY_FAILED" = "CANCELLED";
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const dispose = environment.onPageUnload(() => { cancellation = "PAGE_UNLOADED"; cancel(); });
  let sink: BrowserDownloadSink | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let received = 0;
  let total = download.size;
  let diagnostic: BrowserDownloadDiagnostic | undefined;
  let disposeFailure: (() => void) | undefined;
  const blobs: BlobPart[] = [];
  const check = () => {
    if (controller.signal.aborted) throw new BrowserDownloadError(cancellation, !!sink, diagnostic);
    if (!isSessionCurrent()) throw new BrowserDownloadError("SESSION_CHANGED", !!sink);
  };
  const stop = () => { sink?.abort(); void reader?.cancel().catch(() => {}); };
  controller.signal.addEventListener("abort", stop, { once: true });
  const wait = <T>(operation: Promise<T>, reason: BrowserDownloadDiagnostic, timeout = READ_TIMEOUT): Promise<T> => new Promise((resolve, reject) => {
    const aborted = () => { cleanup(); reject(new BrowserDownloadError(cancellation, !!sink, diagnostic)); };
    const timer = setTimeout(() => { diagnostic = reason; cancellation = "DELIVERY_FAILED"; controller.abort(); }, timeout);
    const cleanup = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", aborted); };
    controller.signal.addEventListener("abort", aborted, { once: true });
    operation.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    if (controller.signal.aborted) { aborted(); return; }
  });
  try {
    check();
    if (!/^[a-f0-9]{64}$/.test(download.id) || !download.sessionId || !validName(download.name) || (download.size !== undefined && (!Number.isSafeInteger(download.size) || download.size < 0))) {
      throw new BrowserDownloadError("INVALID_DOWNLOAD", false);
    }
    if (options.mode !== "compatible") {
      try { sink = await environment.openStream(download.name, download.size, controller.signal); }
      catch (error) {
        if (error instanceof BrowserDownloadError && error.browserHandoffStarted) throw error;
        diagnostic = error && typeof error === "object" && "diagnostic" in error ? safeWorkerDiagnostic(error.diagnostic) : undefined;
        check();
      }
    }
    disposeFailure = sink?.onFailure?.((reason) => {
      if (!controller.signal.aborted) { diagnostic = safeWorkerDiagnostic(reason) ?? "WORKER_PROTOCOL"; cancellation = "DELIVERY_FAILED"; controller.abort(); }
    });
    check();
    if (!sink && download.size !== undefined && download.size > BLOB_DOWNLOAD_LIMIT) throw new BrowserDownloadError("BLOB_LIMIT", false, diagnostic);
    const response = await wait(fetchDownload(download.id, { signal: controller.signal }), "UPSTREAM_HEADERS_TIMEOUT");
    check();
    if (!response.ok || !response.body) throw new BrowserDownloadError("DELIVERY_FAILED", !!sink);
    reader = response.body.getReader();
    const declared = response.headers.get("Content-Length");
    if (declared !== null) {
      const length = /^\d+$/.test(declared) ? Number(declared) : NaN;
      if (!Number.isSafeInteger(length) || (total !== undefined && total !== length)) throw new BrowserDownloadError("DELIVERY_FAILED", !!sink);
      total ??= length;
    }
    const range = response.headers.get("Content-Range");
    if (range) {
      const match = /^bytes 0-(\d+)\/(\d+)$/.exec(range);
      const size = match ? Number(match[2]) : NaN;
      if (!match || !Number.isSafeInteger(size) || Number(match[1]) + 1 !== size || (total !== undefined && total !== size)) throw new BrowserDownloadError("DELIVERY_FAILED", !!sink);
      total ??= size;
    }
    if (!sink && total !== undefined && total > BLOB_DOWNLOAD_LIMIT) throw new BrowserDownloadError("BLOB_LIMIT", false);
    for (;;) {
      check();
      const next = await wait(reader.read(), "UPSTREAM_READ_TIMEOUT");
      check();
      if (next.done) break;
      if (!ArrayBuffer.isView(next.value) || Object.prototype.toString.call(next.value) !== "[object Uint8Array]") throw new BrowserDownloadError("DELIVERY_FAILED", !!sink);
      const length = next.value.byteLength;
      if (!Number.isSafeInteger(received + length) || (total !== undefined && received + length > total)) throw new BrowserDownloadError("DELIVERY_FAILED", !!sink);
      if (!sink && received + length > BLOB_DOWNLOAD_LIMIT) throw new BrowserDownloadError("BLOB_LIMIT", false);
      if (sink) {
        // Never send an unbounded message or transfer the SDK's backing storage.
        for (let offset = 0; offset < length; offset += 1024 * 1024) {
          const chunk = next.value.slice(offset, offset + 1024 * 1024);
          check(); await wait(sink.write(chunk), "SINK_WRITE_TIMEOUT"); check();
          received += chunk.byteLength; onProgress?.({ received, total });
        }
      } else {
        blobs.push(next.value.slice().buffer); received += length; onProgress?.({ received, total });
      }
    }
    check();
    if (total !== undefined && received !== total) throw new BrowserDownloadError("DELIVERY_FAILED", !!sink);
    if (sink) await wait(sink.close(), "SINK_CLOSE_TIMEOUT");
    else environment.saveBlob(new Blob(blobs, { type: "application/octet-stream" }), download.name);
    check();
    return { received, total, outcome: "handed-to-browser", method: sink ? "stream" : "blob", diskCompletion: "unknown" };
  } catch (error) {
    let failure: BrowserDownloadError;
    if (error instanceof BrowserDownloadError) failure = error;
    else {
      const code = controller.signal.aborted ? cancellation : !isSessionCurrent() ? "SESSION_CHANGED" : "DELIVERY_FAILED";
      failure = new BrowserDownloadError(code, !!sink, code === "DELIVERY_FAILED" ? diagnosticOf(error) ?? diagnostic : undefined);
    }
    // Capture the originating reason before our own cleanup emits a port abort.
    controller.abort(); throw failure;
  } finally {
    blobs.length = 0;
    reader?.releaseLock();
    options.signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", stop);
    disposeFailure?.();
    dispose();
  }
}

export function createBrowserDeliveryEnvironment(): BrowserDeliveryEnvironment {
  return {
    openStream: openWorkerStream,
    saveBlob(blob, name) {
      const url = URL.createObjectURL(blob);
      try { clickDownload(url, name); }
      finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
    },
    onPageUnload(callback) {
      window.addEventListener("pagehide", callback, { once: true });
      return () => window.removeEventListener("pagehide", callback);
    },
  };
}

function clickDownload(url: string, name?: string): void {
  const anchor = document.createElement("a");
  anchor.href = url; if (name !== undefined) anchor.download = name;
  anchor.rel = "noopener"; anchor.hidden = true;
  document.body.append(anchor);
  try { anchor.click(); } finally { anchor.remove(); }
}

const SETUP_TIMEOUT = 10000;
const READ_TIMEOUT = 30000;

function deadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const fail = () => { cleanup(); reject(new Error("Browser delivery unavailable")); };
    const timer = setTimeout(fail, SETUP_TIMEOUT);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", fail); };
    signal.addEventListener("abort", fail, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, () => fail());
    if (signal.aborted) { fail(); return; }
  });
}

function activeWorker(registration: ServiceWorkerRegistration, signal: AbortSignal): Promise<ServiceWorker> {
  return new Promise((resolve, reject) => {
    const watched = new Set<ServiceWorker>();
    const cleanup = () => {
      clearTimeout(timer); registration.removeEventListener("updatefound", check);
      signal.removeEventListener("abort", fail);
      for (const worker of watched) worker.removeEventListener("statechange", check);
    };
    const fail = () => { cleanup(); reject(new Error("Browser worker unavailable")); };
    const check = () => {
      if (signal.aborted) { fail(); return; }
      if (registration.active?.state === "activated") { cleanup(); resolve(registration.active); return; }
      const worker = registration.installing ?? registration.waiting ?? registration.active;
      if (worker?.state === "redundant") { fail(); return; }
      if (worker && !watched.has(worker)) { watched.add(worker); worker.addEventListener("statechange", check); }
    };
    const timer = setTimeout(fail, SETUP_TIMEOUT);
    signal.addEventListener("abort", fail, { once: true });
    registration.addEventListener("updatefound", check);
    check();
  });
}

async function openWorkerStream(name: string, size: number | undefined, signal: AbortSignal): Promise<BrowserDownloadSink> {
  if (!globalThis.isSecureContext || !navigator.serviceWorker || typeof MessageChannel === "undefined" || !validName(name)) throw new Error("Browser streaming unsupported");
  const base = new URL(`${import.meta.env.BASE_URL}browser-download/`, location.href);
  const script = new URL("worker.js?v=1", base);
  if (base.origin !== location.origin || script.origin !== location.origin) throw new Error("Browser worker origin mismatch");
  const registration = await deadline(navigator.serviceWorker.register(script.href, { scope: base.href, type: "module", updateViaCache: "none" }), signal);
  if (registration.scope !== base.href) throw new Error("Browser worker scope mismatch");
  const worker = await activeWorker(registration, signal);
  if (worker.scriptURL !== script.href) throw new Error("Browser worker identity mismatch");
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const channel = new MessageChannel();
  const port = channel.port1;
  type Message = { type: string; nonce: string; seq?: number };
  let queued: Message | undefined;
  let waiting: { type: string; seq?: number; resolve(message: Message): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined;
  let failure: (Error & { diagnostic: BrowserDownloadDiagnostic }) | undefined;
  let terminal = false;
  let seq = 0;
  const failureListeners = new Set<(diagnostic?: BrowserDownloadDiagnostic) => void>();
  const cleanup = () => {
    terminal = true; port.close(); signal.removeEventListener("abort", onAbort);
    registration.removeEventListener("updatefound", onReplacement); worker.removeEventListener("statechange", onState);
  };
  const fail = (reason: BrowserDownloadDiagnostic = "PAGE_PROTOCOL") => {
    if (terminal) return;
    failure = Object.assign(new Error("Browser stream incomplete"), { diagnostic: safeWorkerDiagnostic(reason) ?? "PAGE_PROTOCOL" });
    try { port.postMessage({ type: "abort", nonce }); } catch { /* port is already unavailable */ }
    if (waiting) { clearTimeout(waiting.timer); waiting.reject(failure); waiting = undefined; }
    queued = undefined; cleanup();
    for (const callback of failureListeners) callback(failure.diagnostic);
    failureListeners.clear();
  };
  const onAbort = () => fail("PAGE_ABORTED");
  const onReplacement = () => fail("WORKER_REPLACED");
  const onState = () => { if (worker.state !== "activated") onReplacement(); };
  const waitFor = (type: string, expectedSeq?: number): Promise<Message> => {
    if (failure || terminal) return Promise.reject(failure ?? new Error("Browser stream closed"));
    if (waiting) { fail(); return Promise.reject(failure); }
    if (queued) {
      const message = queued; queued = undefined;
      if (message.type !== type || message.seq !== expectedSeq) { fail(); return Promise.reject(failure); }
      return Promise.resolve(message);
    }
    return new Promise((resolve, reject) => {
      const reason = type === "ready" ? "PAGE_SETUP_TIMEOUT" : type === "pull" ? "PAGE_PULL_TIMEOUT" : type === "ack" ? "PAGE_ACK_TIMEOUT" : "PAGE_END_TIMEOUT";
      waiting = { type, seq: expectedSeq, resolve, reject, timer: setTimeout(() => fail(reason), type === "ready" ? SETUP_TIMEOUT : READ_TIMEOUT) };
    });
  };
  port.onmessage = (event: MessageEvent<Message>) => {
    const message = event.data;
    if (terminal) return;
    if (message?.nonce !== nonce) { fail(); return; }
    if (message.type === "error") { fail(safeWorkerDiagnostic((message as Message & { diagnostic?: unknown }).diagnostic) ?? "WORKER_PROTOCOL"); return; }
    if (waiting) {
      if (message.type !== waiting.type || message.seq !== waiting.seq) { fail(); return; }
      const pending = waiting; waiting = undefined; clearTimeout(pending.timer); pending.resolve(message);
    } else if (message.type === "pull" && message.seq === seq + 1 && !queued) queued = message;
    else fail();
  };
  port.onmessageerror = () => fail("PAGE_MESSAGE_ERROR"); port.start();
  signal.addEventListener("abort", onAbort, { once: true });
  registration.addEventListener("updatefound", onReplacement);
  worker.addEventListener("statechange", onState);
  try {
    if (signal.aborted) { fail(); throw failure; }
    const ready = waitFor("ready");
    try { worker.postMessage({ type: "setup", version: 1, nonce, name, size }, [channel.port2]); }
    catch { fail(); }
    await ready;
  } catch (error) { fail(); throw error; }
  const takePull = async () => { await waitFor("pull", seq + 1); seq++; };
  const sink: BrowserDownloadSink = {
    async write(chunk) {
      if (!ArrayBuffer.isView(chunk) || Object.prototype.toString.call(chunk) !== "[object Uint8Array]" || !chunk.byteLength || chunk.byteLength > 1024 * 1024) { fail(); throw new Error("Invalid browser chunk"); }
      await takePull();
      const bytes = chunk.slice().buffer;
      port.postMessage({ type: "chunk", nonce, seq, bytes }, [bytes]);
      await waitFor("ack", seq);
    },
    async close() {
      await takePull(); port.postMessage({ type: "end", nonce, seq });
      await waitFor("done", seq); cleanup();
    },
    abort: onAbort,
    onFailure(callback) {
      if (failure) callback(failure.diagnostic); else if (!terminal) failureListeners.add(callback);
      return () => failureListeners.delete(callback);
    },
  };
  // The main page is outside the dedicated worker scope. An ordinary navigation
  // URL-matches that registration; a download-attribute subresource does not.
  // The worker's attachment Content-Disposition supplies the filename.
  try { clickDownload(`${base.href}file/${nonce}/${encodeURIComponent(name)}`); }
  catch { fail(); throw new BrowserDownloadError("DELIVERY_FAILED", true); }
  return sink;
}
