import { MessageChannel } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { createBrowserDeliveryEnvironment, deliverBrowserDownload } from "./browser-download";
// @ts-expect-error Standalone module asset
import { installDownloadWorker } from "../../public/browser-download/worker.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
function browserFixture() {
  vi.stubGlobal("isSecureContext", true); vi.stubGlobal("MessageChannel", MessageChannel);
  const base = new URL("/browser-download/", location.href);
  const handlers = new Map<string, (event: any) => void>();
  const owner = { id: "browser-page", type: "window", url: location.href };
  const worker = new EventTarget() as EventTarget & { state: string; scriptURL: string; postMessage: (data: unknown, ports: unknown[]) => void };
  worker.state = "activated"; worker.scriptURL = new URL("worker.js?v=1", base).href;
  installDownloadWorker({ location, registration: { scope: base.href }, clients: { get: async () => owner }, addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler) });
  worker.postMessage = (data, ports) => { handlers.get("message")!({ data, ports, source: owner, waitUntil(p: Promise<void>) { void p.catch(() => {}); } }); };
  const registration = Object.assign(new EventTarget(), { active: worker, installing: null, waiting: null, scope: base.href });
  const register = vi.fn(async () => registration);
  const serviceWorker = { register, get ready(): never { throw new Error("must not wait for app scope control"); } };
  Object.defineProperty(navigator, "serviceWorker", { value: serviceWorker, configurable: true });
  const hrefs: string[] = []; const collected: Uint8Array[] = [];
  const downloadAttributes: Array<string | null> = []; let routed = 0;
  let completed!: Promise<void>;
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    hrefs.push(this.href);
    downloadAttributes.push(this.getAttribute("download"));
    if (this.href.startsWith("blob:")) return;
    // The app page is uncontrolled: download-attribute requests are subresources,
    // while ordinary navigation into the dedicated scope can reach the worker.
    if (this.hasAttribute("download")) return;
    routed++;
    let response!: Promise<Response>;
    handlers.get("fetch")!({ request: new Request(this.href, { referrer: location.href }), clientId: "", respondWith(p: Promise<Response>) { response = p; }, waitUntil() {} });
    completed = (async () => { const r = (await response).body!.getReader(); for (;;) { const next = await r.read(); if (next.done) break; collected.push(next.value); } })();
    void completed.catch(() => {});
  });
  return { register, worker, registration, hrefs, collected, downloadAttributes, routed: () => routed, click, completed: () => completed };
}

it("routes a stream link as navigation from an uncontrolled page", async () => {
  const fixture = browserFixture();
  const sink = await createBrowserDeliveryEnvironment().openStream("file.txt", 3, new AbortController().signal);
  try {
    expect(fixture.downloadAttributes).toEqual([null]); expect(fixture.routed()).toBe(1);
  } finally { sink.abort(); }
});

it("self-hosts a dedicated-scope worker and passes only opaque local links to the DOM", async () => {
  const fixture = browserFixture(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const progress = vi.fn();
  const result = await deliverBrowserDownload({ download: { id: "a".repeat(64), name: "数据.json", size: 7, sessionId: "local-session" }, isSessionCurrent: () => true,
    fetchDownload: async () => new Response("{\"x\":1}"), onProgress: progress });
  await fixture.completed();
  expect(result).toMatchObject({ method: "stream", received: 7, diskCompletion: "unknown" });
  expect(fixture.register).toHaveBeenCalledWith(new URL("/browser-download/worker.js?v=1", location.href).href, { scope: new URL("/browser-download/", location.href).href, type: "module", updateViaCache: "none" });
  expect(fixture.hrefs).toHaveLength(1);
  const url = new URL(fixture.hrefs[0]); expect(url.origin).toBe(location.origin); expect(url.search).toBe(""); expect(url.pathname).toMatch(/\/browser-download\/file\/[a-f0-9]{64}\//);
  expect(fixture.hrefs[0]).not.toContain("local-session"); expect(fixture.hrefs[0]).not.toContain("a".repeat(64)); expect(fetch).not.toHaveBeenCalled();
  expect(new TextDecoder().decode(fixture.collected[0])).toBe("{\"x\":1}"); expect(document.querySelectorAll("a")).toHaveLength(0);
});
it("rejects worker replacement and never falls back after a stream link was launched", async () => {
  const fixture = browserFixture(); const environment = createBrowserDeliveryEnvironment();
  const blob = vi.spyOn(environment, "saveBlob");
  const sink = await environment.openStream("file.txt", 3, new AbortController().signal);
  fixture.registration.dispatchEvent(new Event("updatefound"));
  await expect(sink.write(new Uint8Array([1, 2, 3]))).rejects.toThrow(); expect(blob).not.toHaveBeenCalled();
  await expect(fixture.completed()).rejects.toThrow("incomplete");
});
it("rejects a wrong-origin registration before any DOM navigation", async () => {
  const fixture = browserFixture(); fixture.registration.scope = "https://external.test/browser-download/";
  await expect(createBrowserDeliveryEnvironment().openStream("file.txt", 3, new AbortController().signal)).rejects.toThrow();
  expect(fixture.click).not.toHaveBeenCalled();
});
it("cleans up a setup postMessage failure before launching any download link", async () => {
  const fixture = browserFixture(); fixture.worker.postMessage = () => { throw new Error("worker unavailable"); };
  await expect(createBrowserDeliveryEnvironment().openStream("file.txt", 3, new AbortController().signal)).rejects.toThrow();
  expect(fixture.click).not.toHaveBeenCalled();
});
it("observes a rejected registration promise when registration synchronously cancels the caller", async () => {
  const fixture = browserFixture(); const abort = new AbortController();
  const sentinel = new Error("synthetic registration rejection sentinel");
  const operation = Promise.reject<typeof fixture.registration>(sentinel);
  const observed = vi.spyOn(operation, "then");
  // A plain callback is essential: mock promise-result tracking would itself
  // observe the rejected promise and mask the deadline helper's missing handler.
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register() { abort.abort(); return operation; } } });
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { if (error === sentinel) unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const failure = await deliverBrowserDownload({ download: { id: "a".repeat(64), name: "cancelled.txt", size: 3, sessionId: "session" }, signal: abort.signal, isSessionCurrent: () => true, fetchDownload: vi.fn() }).catch((error) => error);
    expect(failure).toMatchObject({ code: "CANCELLED", browserHandoffStarted: false, message: "下载已取消" });
    expect(observed.mock.calls.some(([, reject]) => typeof reject === "function")).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(unhandled).toHaveLength(0); expect(fixture.click).not.toHaveBeenCalled();
  } finally {
    void operation.catch(() => {}); process.removeListener("unhandledRejection", onUnhandled);
  }
});
it("worker replacement promptly aborts an SDK stream even while waiting for source bytes", async () => {
  const fixture = browserFixture(); const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ pull() {}, cancel }, { highWaterMark: 0 });
  const pending = deliverBrowserDownload({ download: { id: "a".repeat(64), name: "waiting.bin", sessionId: "session" }, isSessionCurrent: () => true, fetchDownload: async () => new Response(body) });
  void pending.catch(() => {});
  await vi.waitFor(() => expect(body.locked).toBe(true));
  fixture.registration.dispatchEvent(new Event("updatefound"));
  await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
  await expect(pending).rejects.toMatchObject({ code: "DELIVERY_FAILED", browserHandoffStarted: true, diagnostic: "WORKER_REPLACED" });
});
it.each(["arbitrary", "SDK-only"])("never promotes %s worker diagnostic text into public errors", async kind => {
  const fixture = browserFixture();
  fixture.worker.postMessage = (data: any, ports: any[]) => { ports[0].postMessage({ type: "error", nonce: data.nonce, diagnostic: kind === "arbitrary" ? "synthetic-private-diagnostic" : "DOWNLOAD_DISPOSITION_MISSING" }); };
  const environment = createBrowserDeliveryEnvironment();
  await expect(environment.openStream("file.txt", 3, new AbortController().signal)).rejects.toMatchObject({ diagnostic: "WORKER_PROTOCOL" });
  expect(fixture.click).not.toHaveBeenCalled();
});
it("uses only a Blob object URL on unsupported browsers and revokes it later", async () => {
  const fixture = browserFixture(); vi.stubGlobal("isSecureContext", false);
  const create = vi.fn(() => "blob:synthetic-browser-only"); const revoke = vi.fn();
  Object.defineProperties(URL, { createObjectURL: { configurable: true, value: create }, revokeObjectURL: { configurable: true, value: revoke } });
  vi.useFakeTimers();
  try {
    const result = await deliverBrowserDownload({ download: { id: "a".repeat(64), name: "legal.svg", size: 6, sessionId: "session" }, isSessionCurrent: () => true, fetchDownload: async () => new Response("<svg/>") });
    expect(result.method).toBe("blob"); expect(fixture.register).not.toHaveBeenCalled(); expect(fixture.hrefs).toEqual(["blob:synthetic-browser-only"]); expect(create).toHaveBeenCalledOnce();
    expect(fixture.downloadAttributes).toEqual(["legal.svg"]);
    await vi.advanceTimersByTimeAsync(60000); expect(revoke).toHaveBeenCalledWith("blob:synthetic-browser-only");
  } finally { vi.useRealTimers(); }
});
it("compatible mode bypasses an available worker registration and preserves attachment bytes", async () => {
  const fixture = browserFixture();
  Object.defineProperties(URL, { createObjectURL: { configurable: true, value: vi.fn(() => "blob:explicit-compatible") }, revokeObjectURL: { configurable: true, value: vi.fn() } });
  vi.useFakeTimers();
  try {
    const result = await deliverBrowserDownload({ download: { id: "a".repeat(64), name: "compatible.json", size: 7, sessionId: "session" }, mode: "compatible", isSessionCurrent: () => true, fetchDownload: async () => new Response('{"x":1}') });
    expect(result.method).toBe("blob"); expect(fixture.register).not.toHaveBeenCalled(); expect(fixture.hrefs).toEqual(["blob:explicit-compatible"]); expect(fixture.downloadAttributes).toEqual(["compatible.json"]);
    await vi.advanceTimersByTimeAsync(60000);
  } finally { vi.useRealTimers(); }
});
