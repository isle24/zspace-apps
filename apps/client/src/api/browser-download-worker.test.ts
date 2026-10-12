// @vitest-environment node
import { MessageChannel } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
// Public asset is intentionally standalone JavaScript, served unchanged by Vite.
// @ts-expect-error no declarations for the standalone service-worker asset
import { installDownloadWorker } from "../../public/browser-download/worker.js";

const nonce = "b".repeat(64);
const scopeUrl = "https://app.test/browser-download/";
const name = "资料.svg";
const source = { id: "owner", type: "window", url: "https://app.test/index.html" };
const openPorts: Array<{ close(): void }> = [];
afterEach(() => { for (const port of openPorts.splice(0)) port.close(); });
function host(timeout = 5000) {
  const handlers = new Map<string, (event: any) => void>();
  const clients = new Map([[source.id, source]]);
  const scope = { location: { origin: "https://app.test" }, registration: { scope: scopeUrl }, clients: { get: async (id: string) => clients.get(id) }, addEventListener: (name: string, cb: (event: any) => void) => handlers.set(name, cb) };
  installDownloadWorker(scope, { setupTimeoutMs: timeout, readTimeoutMs: timeout });
  async function setup(data: Record<string, unknown> = {}, owner: any = source) {
    const channel = new MessageChannel(); openPorts.push(channel.port1, channel.port2);
    const messages: any[] = []; channel.port1.on("message", (message) => messages.push(message));
    let ready!: Promise<void>;
    handlers.get("message")!({ data: { type: "setup", version: 1, nonce, name, size: 3, ...data }, source: owner, ports: [channel.port2], waitUntil: (p: Promise<void>) => { ready = p; } });
    await ready;
    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));
    return { port: channel.port1, messages };
  }
  async function fetch(options: { url?: string; clientId?: string; headers?: Record<string, string>; method?: string; referrer?: string } = {}) {
    let result: Promise<Response> | undefined;
    handlers.get("fetch")!({ request: new Request(options.url ?? `${scopeUrl}file/${nonce}/${encodeURIComponent(name)}`, { method: options.method ?? "GET", headers: options.headers, referrer: options.referrer ?? "https://app.test/index.html" }), clientId: options.clientId ?? "owner", respondWith: (p: Promise<Response>) => { result = p; }, waitUntil() {} });
    return result;
  }
  return { clients, setup, fetch };
}

describe("self-hosted delivery worker", () => {
  it("binds setup to a live same-origin window and a private port", async () => {
    const h = host(); const delivery = await h.setup(); expect(delivery.messages[0]).toEqual({ type: "ready", nonce });
    const foreign = await host().setup({}, { ...source, url: "https://external.test/" }); expect(foreign.messages[0].type).toBe("error");
    const missing = host(); missing.clients.clear(); expect((await missing.setup()).messages[0].type).toBe("error");
    expect((await host().setup({ version: 0 })).messages[0].type).toBe("error");
  });
  it("rejects setup nonce replay even after a cancelled delivery", async () => {
    const h = host(); const delivery = await h.setup(); delivery.port.postMessage({ type: "abort", nonce });
    await vi.waitFor(() => expect(delivery.messages.some((m) => m.type === "error")).toBe(true));
    expect((await h.setup()).messages[0].type).toBe("error");
  });
  it("only claims exact same-origin one-use GET basename URLs", async () => {
    const h = host(); await h.setup();
    expect((await h.fetch({ method: "POST" }))?.status).toBe(405);
    expect((await h.fetch({ url: `${scopeUrl}file/${nonce}/${encodeURIComponent(name)}?token=untrusted` }))?.status).toBe(400);
    expect((await h.fetch({ headers: { Range: "bytes=0-" } }))?.status).toBe(416);
    expect((await h.fetch({ clientId: "other" }))?.status).toBe(403);
    expect((await h.fetch({ referrer: "https://external.test/" }))?.status).toBe(403);
    const response = await h.fetch(); expect(response?.status).toBe(200);
    expect((await h.fetch())?.status).toBe(410); await response?.body?.cancel();
  });
  it("allows empty download clientId using the one-use nonce while rechecking owner liveness", async () => {
    const h = host(); await h.setup(); const response = await h.fetch({ clientId: "", referrer: "" }); expect(response?.status).toBe(200); await response?.body?.cancel();
    const dead = host(); await dead.setup(); dead.clients.clear(); expect((await dead.fetch({ clientId: "" }))?.status).toBe(410);
  });
  it("uses real stream pull/ack backpressure and completes only after matched EOF", async () => {
    const h = host(); const d = await h.setup(); const response = (await h.fetch())!;
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(response.headers.get("cache-control")).toContain("no-store");
    await new Promise<void>((resolve) => setTimeout(resolve, 10)); expect(d.messages).toHaveLength(1);
    const reader = response.body!.getReader(); const first = reader.read();
    await vi.waitFor(() => expect(d.messages.at(-1)).toMatchObject({ type: "pull", seq: 1 }));
    d.port.postMessage({ type: "chunk", nonce, seq: 1, bytes: new Uint8Array([1, 2, 3]).buffer });
    expect((await first).value).toEqual(new Uint8Array([1, 2, 3]));
    await vi.waitFor(() => expect(d.messages.at(-1)).toMatchObject({ type: "ack", seq: 1 }));
    const eof = reader.read(); await vi.waitFor(() => expect(d.messages.at(-1)).toMatchObject({ type: "pull", seq: 2 }));
    d.port.postMessage({ type: "end", nonce, seq: 2 }); expect((await eof).done).toBe(true);
    await vi.waitFor(() => expect(d.messages.at(-1)).toMatchObject({ type: "done", seq: 2 }));
  });
  it.each([{ nonce: "c".repeat(64), seq: 1 }, { nonce, seq: 99 }, { nonce, seq: 1, bytes: new ArrayBuffer(1024 * 1024 + 1) }])("errors on mismatched nonce/sequence or oversized messages (%j)", async (change) => {
    const h = host(); const d = await h.setup(); const response = (await h.fetch())!; const read = response.body!.getReader().read(); const failed = expect(read).rejects.toThrow("incomplete");
    await vi.waitFor(() => expect(d.messages.at(-1).type).toBe("pull"));
    d.port.postMessage(Object.assign({ type: "chunk", nonce, seq: 1, bytes: new Uint8Array([1]).buffer }, change)); await failed;
    await vi.waitFor(() => expect(d.messages.at(-1)).toMatchObject({ type: "error", diagnostic: "WORKER_PROTOCOL" }));
  });
  it("errors a declared-size partial EOF without closing successfully", async () => {
    const h = host(); const d = await h.setup(); const response = (await h.fetch())!; const read = response.body!.getReader().read(); const failed = expect(read).rejects.toThrow("incomplete");
    await vi.waitFor(() => expect(d.messages.at(-1).type).toBe("pull")); d.port.postMessage({ type: "end", nonce, seq: 1 }); await failed;
    expect(d.messages.some((m) => m.type === "done")).toBe(false);
    await vi.waitFor(() => expect(d.messages.at(-1)).toMatchObject({ diagnostic: "WORKER_SIZE_MISMATCH" }));
  });
  it("rejects expired setup and read inactivity without keeping a dangling stream", async () => {
    const h = host(60); const d = await h.setup(); await vi.waitFor(() => expect(d.messages.at(-1).type).toBe("error")); expect((await h.fetch())?.status).toBe(410);
    expect(d.messages.at(-1).diagnostic).toBe("WORKER_SETUP_EXPIRED");
    const active = host(80); const started = await active.setup(); const response = (await active.fetch())!; const pending = response.body!.getReader().read();
    await expect(pending).rejects.toThrow("incomplete"); expect(started.messages.some((m) => m.type === "done")).toBe(false);
    await vi.waitFor(() => expect(started.messages.at(-1).diagnostic).toBe("WORKER_INACTIVITY"));
  });
  it("browser cancel and a disappearing initiating client both terminate delivery", async () => {
    const h = host(); const d = await h.setup(); const response = (await h.fetch())!; await response.body!.cancel(); await vi.waitFor(() => expect(d.messages.at(-1).type).toBe("error"));
    const dead = host(); const gone = await dead.setup(); const body = (await dead.fetch())!.body!; dead.clients.clear(); await expect(body.getReader().read()).rejects.toThrow("incomplete");
    await vi.waitFor(() => expect(gone.messages.at(-1).diagnostic).toBe("WORKER_OWNER_LOST"));
  });
});
