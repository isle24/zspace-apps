import { Blob as NativeBlob } from "node:buffer";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { Gateway } from "./client";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  vi.useRealTimers();
});
it("adopts only a valid unexpired trusted memory grant", () => {
  const gateway = new Gateway();
  expect(() =>
    gateway.adoptStoreGrant(
      {
        sessionId: "grant",
        expiresAt: "bad",
        storeAddress: gateway.storeAddress,
      },
      gateway.captureStoreScope(),
    ),
  ).toThrow();
  expect(gateway.storeSession).toBe("");
  gateway.adoptStoreGrant(
    {
      sessionId: "grant",
      storeAddress: gateway.storeAddress,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
    gateway.captureStoreScope(),
  );
  expect(gateway.storeSession).toBe("grant");
  expect(gateway.storeAuthSource).toBe("nas-grant");
  expect(localStorage.getItem("store-session")).toBeNull();
  gateway.storeSession = "";
});
it("stream sends authenticated header, parses persisted jobs, and aborts on replacement", async () => {
  const gateway = new Gateway();
  gateway.storeSession = "old";
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const fetcher = vi.fn(
    async () =>
      new Response(stream, {
        headers: { "Content-Type": "text/event-stream" },
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const seen = vi.fn();
  const pending = gateway.streamStore(
    "v2/jobs/events",
    seen,
    new AbortController().signal,
  );
  await Promise.resolve();
  controller.enqueue(
    encoder.encode('data: {"items":[{"id":"job","stage":"health"}]}\n\n'),
  );
  await new Promise((done) => setTimeout(done, 0));
  expect(seen).toHaveBeenCalledWith({
    items: [{ id: "job", stage: "health" }],
  });
  expect(fetcher).toHaveBeenCalledWith(
    expect.not.stringContaining("old"),
    expect.objectContaining({
      headers: expect.objectContaining({ "X-Store-Session": "old" }),
    }),
  );
  gateway.storeSession = "new";
  controller.close();
  await expect(pending).rejects.toThrow();
});
it("binary snapshot download fences replaced sessions", async () => {
  const gateway = new Gateway();
  gateway.storeSession = "old";
  let resolve!: (value: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>((done) => (resolve = done))),
  );
  const pending = gateway.downloadStore("v2/snapshots/s/download");
  gateway.storeSession = "new";
  resolve(new Response("archive"));
  await expect(pending).rejects.toThrow("已改变");
});
it("auth-expired event clears captured session while a replacement cannot be cleared", async () => {
  const gateway = new Gateway();
  gateway.storeSession = "old";
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response('event: auth-expired\ndata: {"reason":"expired"}\n\n', {
          headers: { "Content-Type": "text/event-stream" },
        }),
    ),
  );
  await expect(
    gateway.streamStore(
      "v2/jobs/events",
      vi.fn(),
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(gateway.storeSession).toBe("");
});
it("rejects a store grant issued for another service", () => {
  const gateway = new Gateway();
  expect(() =>
    gateway.adoptStoreGrant(
      {
        sessionId: "grant",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        storeAddress: "https://other.example",
      },
      gateway.captureStoreScope(),
    ),
  ).toThrow();
  expect(gateway.storeSession).toBe("");
});
it("requires grant issuer service binding even with a valid deadline", () => {
  const gateway = new Gateway();
  expect(() =>
    gateway.adoptStoreGrant(
      {
        sessionId: "grant",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      } as any,
      gateway.captureStoreScope(),
    ),
  ).toThrow();
  expect(gateway.storeSession).toBe("");
});
it("rejects a grant obtained during a replacement login at the same service", () => {
  const gateway = new Gateway();
  const issuedFor = gateway.captureStoreScope();
  gateway.storeSession = "replacement";
  expect(() =>
    gateway.adoptStoreGrant(
      {
        sessionId: "old-grant",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        storeAddress: gateway.storeAddress,
      },
      issuedFor,
    ),
  ).toThrow("已改变");
  expect(gateway.storeSession).toBe("replacement");
});
it("fences grant adoption when an old session deadline passes while timers were suspended", () => {
  vi.useFakeTimers();
  const gateway = new Gateway();
  gateway.adoptStoreGrant(
    {
      sessionId: "old-grant",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      storeAddress: gateway.storeAddress,
    },
    gateway.captureStoreScope(),
  );
  const issuedFor = gateway.captureStoreScope();
  vi.setSystemTime(Date.now() + 120000);
  expect(() =>
    gateway.adoptStoreGrant(
      {
        sessionId: "new-grant",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        storeAddress: gateway.storeAddress,
      },
      issuedFor,
    ),
  ).toThrow("已改变");
  expect(gateway.storeSession).toBe("");
  vi.useRealTimers();
});
it("publishes the trusted grant source atomically with its session event", () => {
  const gateway = new Gateway();
  const sources: string[] = [];
  const observer = () => sources.push(gateway.storeAuthSource);
  window.addEventListener("space-store-session", observer);
  gateway.adoptStoreGrant(
    {
      sessionId: "grant",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      storeAddress: gateway.storeAddress,
    },
    gateway.captureStoreScope(),
  );
  window.removeEventListener("space-store-session", observer);
  expect(sources).toEqual(["nas-grant"]);
  gateway.storeSession = "";
});
it("incrementally verifies SHA256 without crypto.subtle or a full archive ArrayBuffer", async () => {
  const gateway = new Gateway();
  gateway.storeSession = "test";
  const blob = await new Response("private archive").blob();
  const fullRead = vi.fn(() => Promise.reject(new Error("禁止全量读入")));
  Object.defineProperty(blob, "arrayBuffer", { value: fullRead });
  vi.stubGlobal("crypto", {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Length": "15" }),
      blob: async () => blob,
    })),
  );
  const progress = vi.fn();
  const verified = await gateway.downloadStore(
    "v2/snapshots/s/download",
    {
      sizeBytes: 15,
      sha256:
        "229cc317ac5ffab2a6b7c3142731fc59e9cc5dab5303dd5fe7444933ab36ab45",
    },
    new AbortController().signal,
    progress,
  );
  expect(verified).toBe(blob);
  expect(fullRead).not.toHaveBeenCalled();
  expect(progress).toHaveBeenLastCalledWith(15, 15);
});
it("fences replacement sessions while an archive is being hashed", async () => {
  const gateway = new Gateway();
  gateway.storeSession = "old";
  const blob = await new Response("private archive").blob();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      blob: async () => blob,
    })),
  );
  await expect(
    gateway.downloadStore(
      "v2/snapshots/s/download",
      {
        sizeBytes: 15,
        sha256:
          "229cc317ac5ffab2a6b7c3142731fc59e9cc5dab5303dd5fe7444933ab36ab45",
      },
      new AbortController().signal,
      (verified) => {
        if (verified > 0) gateway.storeSession = "new";
      },
    ),
  ).rejects.toThrow("已改变");
  expect(gateway.storeSession).toBe("new");
});
it("refuses scoped abort during snapshot hashing before exposing the Blob", async () => {
  const gateway = new Gateway();
  gateway.storeSession = "old";
  const blob = await new Response("private archive").blob();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      blob: async () => blob,
    })),
  );
  const controller = new AbortController();
  await expect(
    gateway.downloadStore(
      "v2/snapshots/s/download",
      {
        sizeBytes: 15,
        sha256:
          "229cc317ac5ffab2a6b7c3142731fc59e9cc5dab5303dd5fe7444933ab36ab45",
      },
      controller.signal,
      (verified) => {
        if (verified > 0) controller.abort();
      },
    ),
  ).rejects.toThrow();
});
it("uses bounded native Blob streams for large snapshots and preserves exact verified progress", async () => {
  const gateway = new Gateway();
  gateway.storeSession = "test";
  const data = new Uint8Array(1048593);
  const blob = new NativeBlob([data]) as unknown as Blob;
  const digest = createHash("sha256").update(data).digest("hex");
  const fullRead = vi.spyOn(blob, "arrayBuffer");
  const slice = vi.spyOn(blob, "slice");
  const progress = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      blob: async () => blob,
    })),
  );
  await expect(
    gateway.downloadStore(
      "v2/snapshots/s/download",
      { sizeBytes: blob.size, sha256: digest },
      new AbortController().signal,
      progress,
    ),
  ).resolves.toBe(blob);
  expect(fullRead).not.toHaveBeenCalled();
  expect(slice.mock.calls.length).toBe(5);
  expect(
    slice.mock.calls.every(([start, end]) => end! - start! <= 256 * 1024),
  ).toBe(true);
  expect(progress).toHaveBeenLastCalledWith(blob.size, blob.size);
});
it("rejects a server announced length that differs from authenticated snapshot metadata", async () => {
  const gateway = new Gateway();
  gateway.storeSession = "test";
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("private archive", { headers: { "Content-Length": "7" } }),
    ),
  );
  await expect(
    gateway.downloadStore("v2/snapshots/s/download", {
      sizeBytes: 15,
      sha256:
        "229cc317ac5ffab2a6b7c3142731fc59e9cc5dab5303dd5fe7444933ab36ab45",
    }),
  ).rejects.toThrow("大小不一致");
});
it("honors a passed session deadline during hashing even when expiry timers were delayed", async () => {
  const gateway = new Gateway();
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  gateway.adoptStoreGrant(
    {
      sessionId: "grant",
      storeAddress: gateway.storeAddress,
      expiresAt: new Date(now + 60000).toISOString(),
    },
    gateway.captureStoreScope(),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("private archive")),
  );
  await expect(
    gateway.downloadStore(
      "v2/snapshots/s/download",
      {
        sizeBytes: 15,
        sha256:
          "229cc317ac5ffab2a6b7c3142731fc59e9cc5dab5303dd5fe7444933ab36ab45",
      },
      new AbortController().signal,
      (verified) => {
        if (verified > 0) clock.mockReturnValue(now + 120000);
      },
    ),
  ).rejects.toThrow("已改变");
  expect(gateway.storeSession).toBe("");
});
it("propagates a failed network body read without exposing a partial archive", async () => {
  const gateway = new Gateway();
  gateway.storeSession = "test";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      blob: async () => {
        throw new Error("transfer interrupted");
      },
    })),
  );
  await expect(
    gateway.downloadStore("v2/snapshots/s/download", {
      sizeBytes: 15,
      sha256:
        "229cc317ac5ffab2a6b7c3142731fc59e9cc5dab5303dd5fe7444933ab36ab45",
    }),
  ).rejects.toThrow();
});
