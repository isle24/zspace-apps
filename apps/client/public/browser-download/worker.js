// App-owned, same-origin browser delivery protocol v1. No NAS requests or caches.
// This is a standalone module so its real streams can also be exercised in-process.
export function installDownloadWorker(scope, { setupTimeoutMs = 30000, readTimeoutMs = 30000 } = {}) {
  const deliveries = new Map();
  const usedNonces = new Set();
  const origin = scope.location.origin;
  const base = new URL(scope.registration.scope);
  const maxChunk = 1024 * 1024;
  const validName = (name) => typeof name === "string" && name.length > 0 && name.length <= 255 && name !== "." && name !== ".." && !/[\\/\u0000-\u001f\u007f]/.test(name);
  const liveOwner = async (id) => {
    const client = await scope.clients.get(id);
    return client?.type === "window" && new URL(client.url).origin === origin;
  };
  const deny = (status) => new Response("Browser download unavailable", { status, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain", "X-Content-Type-Options": "nosniff" } });
  scope.addEventListener("message", (event) => {
    if (event.data?.type !== "setup") return;
    event.waitUntil((async () => {
      const data = event.data;
      const port = event.ports?.[0];
      const nonce = data.nonce;
      const reject = () => { port?.postMessage({ type: "error", nonce, diagnostic: "WORKER_SETUP_REJECTED" }); port?.close(); };
      if (event.ports?.length !== 1 || !event.source?.id || event.source.type !== "window" || new URL(event.source.url).origin !== origin ||
          data.version !== 1 || typeof nonce !== "string" || !/^[a-f0-9]{64}$/.test(nonce) || !validName(data.name) ||
          (data.size !== undefined && (!Number.isSafeInteger(data.size) || data.size < 0)) || usedNonces.has(nonce) || usedNonces.size >= 4096 || deliveries.size >= 32 ||
          !(await liveOwner(event.source.id))) { reject(); return; }
      // Recheck after the asynchronous liveness lookup to prevent racing setup replay.
      if (usedNonces.has(nonce)) { reject(); return; }
      usedNonces.add(nonce);
      let finish;
      const finished = new Promise((resolve) => { finish = resolve; });
      const delivery = { nonce, name: data.name, size: data.size, owner: event.source.id, port, claimed: false, terminal: false, received: 0, seq: 0, pending: undefined, controller: undefined, timer: undefined, finished };
      const arm = (ms, reason = "WORKER_INACTIVITY") => { clearTimeout(delivery.timer); delivery.timer = setTimeout(() => fail(reason), ms); };
      const cleanup = () => { clearTimeout(delivery.timer); deliveries.delete(nonce); delivery.terminal = true; delivery.pending?.resolve(); delivery.pending = undefined; finish(); port.close(); };
      const fail = (diagnostic = "WORKER_PROTOCOL") => {
        if (delivery.terminal) return;
        port.postMessage({ type: "error", nonce, diagnostic });
        delivery.controller?.error(new Error("Browser download incomplete"));
        cleanup();
      };
      delivery.fail = fail;
      delivery.arm = arm;
      port.onmessage = (messageEvent) => {
        const message = messageEvent.data;
        if (delivery.terminal) return;
        if (message?.nonce !== nonce) { fail(); return; }
        if (message.type === "abort") { fail("PAGE_ABORTED"); return; }
        const pending = delivery.pending;
        if (!pending || message.seq !== delivery.seq) { fail(); return; }
        if (message.type === "chunk") {
          if (Object.prototype.toString.call(message.bytes) !== "[object ArrayBuffer]" || message.bytes.byteLength > maxChunk || message.bytes.byteLength === 0) { fail(); return; }
          if (delivery.size !== undefined && delivery.received + message.bytes.byteLength > delivery.size) { fail("WORKER_SIZE_MISMATCH"); return; }
          delivery.received += message.bytes.byteLength;
          delivery.controller.enqueue(new Uint8Array(message.bytes));
          delivery.pending = undefined;
          port.postMessage({ type: "ack", nonce, seq: delivery.seq });
          pending.resolve(); arm(readTimeoutMs);
        } else if (message.type === "end") {
          if (delivery.size !== undefined && delivery.received !== delivery.size) { fail("WORKER_SIZE_MISMATCH"); return; }
          delivery.controller.close(); port.postMessage({ type: "done", nonce, seq: delivery.seq }); cleanup();
        } else fail();
      };
      port.onmessageerror = () => fail("WORKER_MESSAGE_ERROR");
      port.start(); deliveries.set(nonce, delivery); arm(setupTimeoutMs, "WORKER_SETUP_EXPIRED");
      port.postMessage({ type: "ready", nonce });
    })());
  });
  scope.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== origin || !url.pathname.startsWith(`${base.pathname}file/`)) return;
    event.respondWith((async () => {
      if (event.request.method !== "GET") return deny(405);
      if (event.request.headers.has("range")) return deny(416);
      if (url.search || url.hash) return deny(400);
      const nonce = url.pathname.slice(`${base.pathname}file/`.length).split("/")[0];
      const delivery = deliveries.get(nonce);
      if (!delivery || delivery.claimed || delivery.terminal) return deny(410);
      if (url.href !== `${base.href}file/${nonce}/${encodeURIComponent(delivery.name)}`) return deny(400);
      if ((event.clientId && event.clientId !== delivery.owner) || (event.request.referrer && new URL(event.request.referrer).origin !== origin)) return deny(403);
      if (!(await liveOwner(delivery.owner))) { delivery.fail("WORKER_OWNER_LOST"); return deny(410); }
      if (delivery.claimed || delivery.terminal) return deny(410);
      delivery.claimed = true; delivery.arm(readTimeoutMs);
      // A browser download fetch may have no clientId. Setup source, private port,
      // unpredictable single-use nonce and live owner remain the binding in that case.
      const body = new ReadableStream({
        start(controller) { delivery.controller = controller; },
        async pull() {
          if (delivery.terminal) return;
          if (!(await liveOwner(delivery.owner))) { delivery.fail("WORKER_OWNER_LOST"); return; }
          if (delivery.terminal) return;
          delivery.seq++;
          await new Promise((resolve) => { delivery.pending = { resolve }; delivery.port.postMessage({ type: "pull", nonce, seq: delivery.seq }); delivery.arm(readTimeoutMs); });
        },
        cancel() { delivery.fail("BROWSER_CANCELLED"); },
      }, { highWaterMark: 0 });
      event.waitUntil(delivery.finished);
      return new Response(body, { headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(delivery.name)}`,
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "X-Content-Type-Options": "nosniff",
        // Deliberately no Content-Length: verified EOF must travel through the
        // protocol even when a browser has already received the known byte count.
      } });
    })());
  });
}

if (typeof ServiceWorkerGlobalScope !== "undefined" && globalThis instanceof ServiceWorkerGlobalScope) {
  installDownloadWorker(globalThis);
}
