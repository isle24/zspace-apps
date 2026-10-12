import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import {
  api,
  Gateway,
  normalizeCollection,
  confirmInstallation,
  safeMediaUrl,
} from "./client";
import { officialFixture, officialJson } from "./direct-test-fixture";
const nativeBridge = vi.hoisted(() => ({ fetch: vi.fn(), invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: nativeBridge.fetch }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: nativeBridge.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: nativeBridge.listen }));
const login = (client: Gateway) =>
  client.login("http://synthetic.invalid:5055", "fixture", "synthetic-only");
afterEach(() => {
  api.logoutNas();
  api.storeSession = "";
  vi.unstubAllGlobals();
  localStorage.removeItem("space-store-address");
});
it("NAS login and reads call only official NAS paths without initializing a shop backend", async () => {
  const fetcher = vi.fn(officialFixture());
  const client = new Gateway(fetcher);
  await login(client);
  await client.read("files.roots");
  expect(
    fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname),
  ).toEqual(["/key/pub", "/auth/login", "/system/polling2"]);
  expect(
    fetcher.mock.calls.every(
      ([url]) =>
        new URL(String(url)).origin === "http://synthetic.invalid:5055",
    ),
  ).toBe(true);
  expect(client.base).toBe("");
});
it("NAS failures remain errors without sample data", async () => {
  const client = new Gateway(
    officialFixture(() =>
      officialJson({ code: 500, msg: "synthetic unavailable" }, 502),
    ),
  );
  await login(client);
  await expect(client.read("files.roots")).rejects.toBeInstanceOf(Error);
});
it("unknown successful data is rejected", () => {
  expect(() => normalizeCollection({ unexpected: true })).toThrow("数据结构");
});
it("unauthorized installs cannot send a request", async () => {
  const fetcher = vi.fn();
  const client = new Gateway(fetcher);
  await expect(
    confirmInstallation(client, { id: "p1" }, "p1", "request"),
  ).rejects.toThrow("登录");
  expect(fetcher).not.toHaveBeenCalled();
});
it("only the reviewed server plan can be installed", async () => {
  const fetcher = vi.fn();
  const client = new Gateway(fetcher);
  client.storeSession = "store";
  await expect(
    confirmInstallation(client, { id: "p1" }, "p2", "request"),
  ).rejects.toThrow("确认");
  expect(fetcher).not.toHaveBeenCalled();
});
it("does not submit a reviewed plan under a session replaced during store initialization", async () => {
  let initialized!: () => void;
  const ready = new Promise<void>((resolve) => { initialized = resolve; });
  const fetcher = vi.fn().mockResolvedValue(officialJson({ ok: true, data: { id: "j1" } }));
  const client = new Gateway(fetcher);
  vi.spyOn(client, "init").mockImplementationOnce(() => ready);
  client.storeSession = "reviewed-session";
  const pending = confirmInstallation(client, { id: "reviewed-plan" }, "reviewed-plan", "request");
  client.storeSession = "replacement-session";
  initialized();
  await expect(pending).rejects.toMatchObject({ code: "STORE_SESSION_CHANGED" });
  expect(fetcher).not.toHaveBeenCalled();
  expect(client.storeSession).toBe("replacement-session");
});
it("rejects a session changed away and back before sending a reviewed plan", async () => {
  const fetcher = vi.fn().mockResolvedValue(officialJson({ ok: true, data: {} }));
  const client = new Gateway(fetcher);
  client.storeSession = "reviewed-session";
  const pending = confirmInstallation(client, { id: "reviewed-plan" }, "reviewed-plan", "request");
  client.storeSession = "replacement-session";
  client.storeSession = "reviewed-session";
  await expect(pending).rejects.toMatchObject({ code: "STORE_SESSION_CHANGED" });
  expect(fetcher).not.toHaveBeenCalled();
});
it("rejects protected store data decoded after the authenticated session changed", async () => {
  let complete!: (data: unknown) => void;
  let decoding!: () => void;
  const started = new Promise<void>((resolve) => { decoding = resolve; });
  const response = officialJson({ ok: true, data: {} });
  response.json = async () => { decoding(); return new Promise((resolve) => { complete = resolve; }); };
  const client = new Gateway(async () => response);
  client.storeSession = "old-session";
  const pending = client.store("instances");
  await started;
  client.storeSession = "new-session";
  complete({ ok: true, data: { items: [{ id: "old-session-instance" }] } });
  await expect(pending).rejects.toMatchObject({ code: "STORE_SESSION_CHANGED" });
  expect(client.storeSession).toBe("new-session");
});
it("a delayed logout cannot clear the replacement store session", async () => {
  let complete!: (response: Response) => void;
  let started!: () => void;
  const called = new Promise<void>((resolve) => { started = resolve; });
  const client = new Gateway(async () => { started(); return new Promise((resolve) => { complete = resolve; }); });
  client.storeSession = "old-session";
  const pending = client.logoutStore();
  await called;
  client.storeSession = "new-session";
  complete(officialJson({ ok: true, data: {} }));
  await expect(pending).rejects.toMatchObject({ code: "STORE_SESSION_CHANGED" });
  expect(client.storeSession).toBe("new-session");
});
it("uses only independent store headers and the server plan id", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(officialJson({ ok: true, data: { id: "j1" } }));
  const client = new Gateway(fetcher);
  client.storeSession = "store";
  await confirmInstallation(client, { id: "p1" }, "p1", "request");
  const init = fetcher.mock.calls[0][1];
  expect(init.headers["X-Store-Session"]).toBe("store");
  expect(init.headers["X-NAS-Session"]).toBeUndefined();
  expect(JSON.parse(init.body)).toEqual({ planId: "p1", requestId: "request" });
});
it("accepts only verified official media paths on the logged-in NAS origin", async () => {
  vi.stubGlobal("fetch", officialFixture());
  await login(api);
  expect(safeMediaUrl("http://synthetic.invalid:5055/play/a.mp3")).toContain(
    "/play/a.mp3",
  );
  expect(
    safeMediaUrl("http://synthetic.invalid:5055/system/reboot"),
  ).toBeUndefined();
  expect(safeMediaUrl("https://foreign.invalid/play/a.mp3")).toBeUndefined();
});
it("broadcasts independent store session changes to sibling windows", () => {
  let session = "";
  const listener = () => {
    session = api.storeSession;
  };
  window.addEventListener("space-store-session", listener);
  api.storeSession = "sibling";
  expect(session).toBe("sibling");
  api.storeSession = "";
  window.removeEventListener("space-store-session", listener);
});
it("preserves official session-expiration details and clears NAS indicators", async () => {
  const client = new Gateway(
    officialFixture(() => officialJson({ code: "N001208", msg: "expired" })),
  );
  await login(client);
  await expect(client.read("files.roots")).rejects.toMatchObject({
    code: "SESSION_EXPIRED",
    status: 401,
  });
  expect(client.nasSession).toBe("");
});
it("revokes the server store session before clearing local privileges", async () => {
  let auth = "";
  const client = new Gateway(
    vi.fn(async () => {
      auth = client.storeSession;
      return officialJson({ ok: true, data: {} });
    }),
  );
  client.storeSession = "active";
  await client.logoutStore();
  expect(auth).toBe("active");
  expect(client.storeSession).toBe("");
});
it("a delayed expired store response cannot clear a newer store session", async () => {
  let complete: (response: Response) => void = () => {};
  const client = new Gateway(
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    ),
  );
  client.storeSession = "old";
  const pending = client.store("instances");
  await Promise.resolve();
  await Promise.resolve();
  client.storeSession = "new";
  complete(
    officialJson(
      { ok: false, error: { code: "NO_SESSION", message: "expired" } },
      401,
    ),
  );
  await expect(pending).rejects.toMatchObject({ code: "STORE_SESSION_CHANGED" });
  expect(client.storeSession).toBe("new");
});
it("changing independent store address sends no NAS request and persists no token", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(officialJson({ ok: true, data: { items: [] } }));
  const client = new Gateway(fetcher);
  await client.setStoreAddress("https://store.example.test/");
  await client.store("catalog", undefined, true);
  expect(fetcher.mock.calls[0][0]).toBe(
    "https://store.example.test/api/store/catalog",
  );
  expect(localStorage.getItem("space-store-address")).toBe(
    "https://store.example.test",
  );
  expect(JSON.stringify(localStorage)).not.toContain("token");
});
it("native official NAS access does not require or invoke the shop sidecar bridge", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  const fetcher = vi.fn(officialFixture());
  const client = new Gateway(fetcher);
  await login(client);
  await client.read("files.roots");
  expect(client.nasSession).not.toBe("");
  expect(client.base).toBe("");
  expect(fetcher.mock.calls).toHaveLength(3);
});

it("a store redirect cannot forward administrator authentication to another origin", async () => {
  const servers: Server[] = [];
  const listen = async (server: Server) => {
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture listener");
    return `http://127.0.0.1:${address.port}`;
  };
  let foreignHits = 0;
  try {
    const foreign = await listen(createServer((_request, response) => {
      foreignHits++;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: true, data: {} }));
    }));
    const original = await listen(createServer((_request, response) => {
      response.writeHead(307, { Location: foreign + "/capture" });
      response.end();
    }));
    const client = new Gateway(fetch);
    await client.setStoreAddress(original);
    client.storeSession = "synthetic-only";
    await expect(client.store("instances")).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(foreignHits).toBe(0);
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })));
  }
});

it("a successful login from the previous store is rejected after switching service", async () => {
  let complete!: (response: Response) => void;
  let started!: () => void;
  const called = new Promise<void>((resolve) => { started = resolve; });
  const client = new Gateway(async () => {
    started();
    return new Promise<Response>((resolve) => { complete = resolve; });
  });
  await client.setStoreAddress("https://store-a.test");
  const pending = client.store("login", { username: "synthetic", password: "synthetic-only" }, true);
  await called;
  await client.setStoreAddress("https://store-b.test");
  complete(officialJson({ ok: true, data: { sessionId: "synthetic-old-session" } }));
  await expect(pending).rejects.toMatchObject({ code: "STORE_SERVICE_CHANGED" });
  expect(client.storeSession).toBe("");
  expect(client.storeAddress).toBe("https://store-b.test");
});

it("a store response still being decoded cannot return data after switching service", async () => {
  let complete!: (data: unknown) => void;
  let decoding!: () => void;
  const started = new Promise<void>((resolve) => { decoding = resolve; });
  const response = officialJson({ ok: true, data: {} });
  response.json = async () => {
    decoding();
    return new Promise((resolve) => { complete = resolve; });
  };
  const client = new Gateway(async () => response);
  await client.setStoreAddress("https://store-a.test");
  const pending = client.store("catalog", undefined, true);
  await started;
  await client.setStoreAddress("https://store-b.test");
  complete({ ok: true, data: { items: [{ id: "old-store-item" }] } });
  await expect(pending).rejects.toMatchObject({ code: "STORE_SERVICE_CHANGED" });
});


it.each([401, 403])("Gateway media expiry %s clears the current NAS session and dispatches the App expiry event once", async status => {
  const client = new Gateway(officialFixture(() => new Response(null, { status })));
  await login(client);
  const listener = vi.fn();
  window.addEventListener("space-session-expired", listener);
  try {
    await expect(client.fetchMedia("/transcode/thumb?file_path=a.jpg")).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect(client.nasSession).toBe("");
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ scope: "nas", message: "NAS 登录已失效，请重新登录" });
    await expect(client.fetchMedia("/transcode/thumb?file_path=a.jpg")).rejects.toBeInstanceOf(Error);
    expect(listener).toHaveBeenCalledTimes(1);
  } finally { window.removeEventListener("space-session-expired", listener); }
});

it("a delayed old media failure cannot clear a replacement NAS session or dispatch expiry", async () => {
  let finish!: (response: Response) => void;
  const client = new Gateway(officialFixture(() => new Promise<Response>(resolve => { finish = resolve; })));
  await login(client);
  const listener = vi.fn();
  window.addEventListener("space-session-expired", listener);
  try {
    const pending = client.fetchMedia("/transcode/thumb?file_path=a.jpg");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await login(client);
    const current = client.nasSession;
    finish(new Response(null, { status: 401 }));
    await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(client.nasSession).toBe(current);
    expect(listener).not.toHaveBeenCalled();
  } finally { window.removeEventListener("space-session-expired", listener); client.logoutNas(); }
});


it("routes native auth expiry into the existing App event only for the current normal session", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  nativeBridge.fetch.mockImplementation(officialFixture());
  nativeBridge.invoke.mockImplementation(async command => command === "nas_media_register" ? `nas-media://localhost/${"a".repeat(64)}` : undefined);
  let expire!: (event: { payload: unknown }) => void;
  nativeBridge.listen.mockImplementation(async (_event, listener) => { expire = listener; return () => {}; });
  const client = new Gateway();
  const listener = vi.fn();
  window.addEventListener("space-session-expired", listener);
  try {
    await login(client);
    const old = client.nasSession;
    await client.imagePreview({ name: "a.jpg", path: "/my/a.jpg" });
    await login(client);
    const current = client.nasSession;
    expire({ payload: old });
    expect(client.nasSession).toBe(current);
    expect(listener).not.toHaveBeenCalled();
    expire({ payload: current });
    expect(client.nasSession).toBe("");
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ scope: "nas", message: "NAS 登录已失效，请重新登录" });
    expire({ payload: current });
    expect(listener).toHaveBeenCalledTimes(1);
  } finally { window.removeEventListener("space-session-expired", listener); client.logoutNas(); }
});

it("an old media auth response cannot cancel a replacement NAS login still waiting for a fresh challenge", async () => {
  let keyCount = 0;
  let finishKey!: (response: Response) => void;
  let finishMedia!: (response: Response) => void;
  const official = officialFixture(() => new Promise<Response>(resolve => { finishMedia = resolve; }));
  const client = new Gateway(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/key/pub" && ++keyCount === 2) return new Promise<Response>(resolve => { finishKey = resolve; });
    return official(input, init);
  });
  await login(client);
  const old = client.nasSession;
  const media = client.fetchMedia("/transcode/thumb?file_path=a.jpg");
  await vi.waitFor(() => expect(finishMedia).toBeTypeOf("function"));
  const replacement = login(client);
  await vi.waitFor(() => expect(finishKey).toBeTypeOf("function"));
  const listener = vi.fn();
  window.addEventListener("space-session-expired", listener);
  try {
    finishMedia(new Response(null, { status: 401 }));
    await expect(media).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(listener).not.toHaveBeenCalled();
    finishKey(await official("http://synthetic.invalid:5055/key/pub"));
    await expect(replacement).resolves.toHaveProperty("sessionId");
    expect(client.nasSession).not.toBe(old);
  } finally { window.removeEventListener("space-session-expired", listener); client.logoutNas(); }
});

it.each([401,403])("Gateway download expiry %s dispatches once for the current session", async status => {
  const client = new Gateway(officialFixture(url => new URL(String(url)).pathname === "/v2/file/info" ? officialJson({ code: 200, data: { path: "/my/a", name: "a", is_dir: false } }) : new Response(null,{status})));
  await login(client); const descriptor = await client.prepareDownload({id:"a",name:"a",path:"/my/a"});
  const listener = vi.fn(); window.addEventListener("space-session-expired",listener);
  try { await expect(client.fetchDownload(descriptor.id)).rejects.toMatchObject({code:"SESSION_EXPIRED"}); expect(client.nasSession).toBe(""); expect(listener).toHaveBeenCalledTimes(1); }
  finally { window.removeEventListener("space-session-expired",listener); }
});
it("delayed download metadata auth failure cannot expire a replacement Gateway session", async () => {
  let finish!: (response:Response)=>void;
  const client = new Gateway(officialFixture(()=>new Promise<Response>(resolve=>{finish=resolve;})));
  await login(client); const listener=vi.fn(); window.addEventListener("space-session-expired",listener);
  try {
    const pending=client.prepareDownload({id:"a",name:"a",path:"/my/a"});
    await vi.waitFor(()=>expect(finish).toBeTypeOf("function")); await login(client); const session=client.nasSession;
    finish(new Response(null,{status:401})); await expect(pending).rejects.toBeInstanceOf(Error);
    expect(client.nasSession).toBe(session); expect(listener).not.toHaveBeenCalled();
  } finally {window.removeEventListener("space-session-expired",listener);client.logoutNas();}
});

it('Gateway exposes credential-free upload selection/release without affecting shop or download APIs',async()=> {
  const client=new Gateway(officialFixture()); await login(client); client.storeSession='synthetic-shop-session';
  const source=await client.selectBrowserUploadSource(new File(['abc'],'chosen.txt',{lastModified:7}));
  expect(Object.keys(source).sort()).toEqual(['lastModified','name','sessionId','size','sourceId']); expect(source.sessionId).toBe(client.nasSession);
  await client.releaseUploadSource(source.sourceId); expect(client.storeSession).toBe('synthetic-shop-session');
  await expect(client.pickUploadSource()).rejects.toMatchObject({code:'UPLOAD_PICKER_UNAVAILABLE'}); expect(client.nasSession).toBe(source.sessionId);
});
it('late Gateway upload picker auth error cannot expire a replacement session',async()=> {
  const client=new Gateway(officialFixture()); await login(client); let reject!:(e:unknown)=>void;
  vi.spyOn(client.nas,'pickUploadSource').mockImplementation(()=>new Promise((_,no)=>{reject=no;}));
  const pending=client.pickUploadSource(); await login(client); const current=client.nasSession;
  const listener=vi.fn(); window.addEventListener('space-session-expired',listener);
  try {reject({code:'SESSION_EXPIRED',status:401}); await expect(pending).rejects.toMatchObject({code:'SESSION_EXPIRED'}); expect(client.nasSession).toBe(current); expect(listener).not.toHaveBeenCalled();}
  finally {window.removeEventListener('space-session-expired',listener);client.logoutNas();}
});
