import { beforeEach, describe, expect, it, vi } from "vitest";
import { Gateway, type Item } from "./client";
import { OfficialNas } from "./official-nas";
import { officialFixture, officialJson } from "./direct-test-fixture";

const nativeCore = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => nativeCore);
const parent: Item = { id: "p", name: "Display only", kind: "directory", path: "/real" };
const now = 1_790_000_000;
type Call = { path: string; form: URLSearchParams; init: RequestInit };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { resolve, promise }; }
function fixture(override?: (call: Call, index: number) => Response | Promise<Response> | undefined, native = false) {
  const calls: Call[] = [];
  const fetcher = officialFixture((url, init) => {
    const call = { path: url.pathname, form: new URLSearchParams(String(init.body)), init };
    calls.push(call);
    const custom = override?.(call, calls.length);
    if (custom) return custom;
    if (url.pathname === "/v2/file/newdir") return officialJson({ success: true, ts: now * 1000, data: { path: `/real/${call.form.get("name")}`, modify_time: now } });
    const path = call.form.get("path")!;
    return officialJson({ code: 200, data: { info: { path, name: path.slice(path.lastIndexOf("/") + 1), is_dir: true, size: 0, modify_time: now, token: "synthetic-official-token", stream: "http://nas.test:5055/private?token=synthetic-official-token" } } });
  });
  const nas = new OfficialNas(fetcher, { transport: native ? "native" : "browser" });
  return { nas, calls, fetcher };
}
const login = (nas: OfficialNas) => nas.login("http://nas.test:5055", "fixture", "synthetic-password");
beforeEach(() => { nativeCore.invoke.mockReset(); vi.unstubAllEnvs(); });

describe("explicit official directory action", () => {
  it.each(["中文 文件夹 + &", " spaced ", "中".repeat(85), "a".repeat(255), "😊".repeat(63) + "abc"])("validates actual parent and reads back ready directory without media: %s", async (name) => {
    const { nas, calls } = fixture(undefined, true); const session = await login(nas);
    const result = await nas.createDirectory(parent, name);
    expect(result).toEqual({ sessionId: session.sessionId, outcome: "directory-ready", item: { id: `/real/${name}`, name, kind: "directory", path: `/real/${name}`, size: 0, metadata: { is_dir: true, modify_time: now } } });
    expect(calls.map((call) => call.path)).toEqual(["/v2/file/info", "/v2/file/newdir", "/v2/file/info"]);
    expect(calls[0].form.get("path")).toBe("/real"); expect(calls[2].form.get("path")).toBe(`/real/${name}`);
    const write = calls[1]; expect(write.init.method).toBe("POST"); expect(write.init.redirect).toBe("error"); expect(write.init.credentials).toBe("omit");
    expect(write.form.get("parent")).toBe("/real"); expect(write.form.get("name")).toBe(name); expect(write.form.get("rename")).toBe("0");
    expect([...write.form.keys()].sort()).toEqual(["_l", "device", "device_id", "name", "nasid", "parent", "plat", "rename", "rnd", "token", "version", "webagent"].sort());
    expect(new Headers(write.init.headers).get("Cookie")).toContain("zenithtoken=");
    expect(JSON.stringify(result)).not.toMatch(/token|nas\.test|stream|thumbnail/); expect(nativeCore.invoke).not.toHaveBeenCalled();
  });
  it("supports the actual slash root without constructing a double slash", async () => {
    const { nas, calls } = fixture((call) => {
      if (call.path === "/v2/file/newdir") return officialJson({ code: 200, ts: now * 1000, data: { path: "/child", modify_time: now } });
    }); await login(nas);
    expect((await nas.createDirectory({ ...parent, kind: "root", path: "/" }, "child")).item.path).toBe("/child");
    expect(calls[1].form.get("parent")).toBe("/");
  });
  it.each(["", " \t ", ".", "..", "a/b", "a\\b", "a\0", "a\n", "a\u007f", "a\u0085", "\ud800", "a".repeat(256), "中".repeat(86)])("rejects invalid names before any authenticated request: %j", async (name) => {
    const { nas, calls } = fixture(); await login(nas);
    await expect(nas.createDirectory(parent, name)).rejects.toMatchObject({ code: "INVALID_DIRECTORY_NAME", mayHaveCreated: false }); expect(calls).toHaveLength(0);
  });
  it.each([{ ...parent, path: undefined }, { ...parent, path: "relative" }, { ...parent, path: "E.encrypted" }, { ...parent, path: "//real" }, { ...parent, path: "/real/../other" }, { ...parent, path: "/real\u0085" }, { ...parent, path: "/" + "a".repeat(8192) }, { ...parent, kind: "file" }, { ...parent, metadata: { encrypted_path: "E.secret" } }])("rejects unsupported parent before requests %#", async (item) => {
    const { nas, calls } = fixture(); await login(nas);
    await expect(nas.createDirectory(item, "child")).rejects.toMatchObject({ code: "INVALID_DIRECTORY_PARENT", mayHaveCreated: false }); expect(calls).toHaveLength(0);
  });
  it("rejects no-session actions and cannot reach newdir through the read map", async () => {
    const { nas, calls } = fixture(); await expect(nas.createDirectory(parent, "child")).rejects.toMatchObject({ code: "NO_SESSION", mayHaveCreated: false });
    await login(nas); await expect(nas.read("files.createDirectory", { parent: "/real", name: "child" })).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" }); expect(calls).toHaveLength(0);
  });
  it.each([{ path: "/other", is_dir: true }, { path: "/real", is_dir: false }, { path: "/real" }, { path: "/real", is_dir: true, encrypted_path: "E.actual" }])("requires authoritative ordinary parent identity %#", async (info) => {
    const { nas, calls } = fixture((_call, index) => index === 1 ? officialJson({ code: 200, data: { info } }) : undefined); await login(nas);
    await expect(nas.createDirectory(parent, "child")).rejects.toMatchObject({ code: "INVALID_DIRECTORY_PARENT", mayHaveCreated: false }); expect(calls).toHaveLength(1);
  });
  it.each(["N001301", "N001322"])("reports explicit %s conflict safely without retry/readback", async (code) => {
    const { nas, calls } = fixture((call) => call.path === "/v2/file/newdir" ? officialJson({ success: false, code, message: "synthetic-official-token credential body" }) : undefined); await login(nas);
    const error = await nas.createDirectory(parent, "child").catch((e) => e);
    expect(error).toMatchObject({ code: "DIRECTORY_CONFLICT", mayHaveCreated: false }); expect(String(error)).not.toMatch(/synthetic|credential/); expect(calls).toHaveLength(2);
  });
  it.each([{ ts: now * 1000, modify_time: now - 3 }, { ts: now * 1000, modify_time: now + 3 }, { modify_time: now }, { ts: now * 1000 }, { ts: "bad", modify_time: now }, { ts: now * 1000, modify_time: "bad" }, { ts: -1, modify_time: 0 }, { ts: "1.79e12", modify_time: now }, { ts: now * 1000, modify_time: `0x${now.toString(16)}` }, { ts: ` ${now * 1000}`, modify_time: now }])("cannot promote missing/malformed/stale freshness evidence %#", async ({ ts, modify_time }) => {
    const { nas, calls } = fixture((call) => call.path === "/v2/file/newdir" ? officialJson({ code: 200, ts, data: { path: "/real/child", modify_time } }) : undefined); await login(nas);
    await expect(nas.createDirectory(parent, "child")).rejects.toMatchObject({ code: "DIRECTORY_UNVERIFIED", mayHaveCreated: true }); expect(calls).toHaveLength(2);
  });
  it("allows official two-second guard while promising only ready, never ownership or a new inode", async () => {
    const { nas } = fixture((call) => call.path === "/v2/file/newdir" ? officialJson({ success: true, ts: now * 1000 + 999, data: { path: "/real/child", modify_time: now - 2 } }) : undefined); await login(nas);
    const result = await nas.createDirectory(parent, "child"); expect(result.outcome).toBe("directory-ready"); expect(Object.keys(result)).toEqual(["sessionId", "outcome", "item"]);
  });
  it.each(["/other/child", "/real/renamed", "/real/child/extra", "//real/child", "E.result", undefined])("rejects create result outside exact requested child: %s", async (path) => {
    const { nas, calls } = fixture((call) => call.path === "/v2/file/newdir" ? officialJson({ code: 200, ts: now * 1000, data: { path, modify_time: now } }) : undefined); await login(nas);
    await expect(nas.createDirectory(parent, "child")).rejects.toMatchObject({ code: "DIRECTORY_UNVERIFIED", mayHaveCreated: true }); expect(calls).toHaveLength(2);
  });
  it.each([{ path: "/other/child", name: "child", is_dir: true }, { path: "/real/child", name: "renamed", is_dir: true }, { path: "/real/child", name: "child", is_dir: false }, { path: "/real/child", is_dir: true }, { path: "/real/child", name: "child", is_dir: true, encrypted_path: "E.actual" }, {}])("rejects unverified readback identity %#", async (info) => {
    const { nas, calls } = fixture((_call, index) => index === 3 ? officialJson({ code: 200, data: { info } }) : undefined); await login(nas);
    await expect(nas.createDirectory(parent, "child")).rejects.toMatchObject({ code: "DIRECTORY_UNVERIFIED", mayHaveCreated: true }); expect(calls).toHaveLength(3);
  });
  it.each(["network", "business", "http", "redirect", "malformed", "oversized"])("marks %s after write as uncertain and never retries", async (mode) => {
    const { nas, calls } = fixture((call) => {
      if (call.path !== "/v2/file/newdir") return;
      if (mode === "network") throw new Error("synthetic-official-token");
      if (mode === "business") return officialJson({ success: false, code: "arbitrary synthetic-official-token", message: "secret" });
      if (mode === "http") return officialJson({}, 500);
      if (mode === "redirect") { const response = officialJson({}); Object.defineProperty(response, "redirected", { value: true }); return response; }
      if (mode === "malformed") return new Response("synthetic-official-token");
      return officialJson({ code: 200, data: "a".repeat(65_536) });
    }); await login(nas);
    const error = await nas.createDirectory(parent, "child").catch((e) => e); expect(error.mayHaveCreated).toBe(true); expect(String(error)).not.toMatch(/synthetic|secret/); expect(calls).toHaveLength(2);
  });
  it.each(["parent", "create", "readback"] as const)("aborts on logout at %s and fences ignored-abort responses", async (phase) => {
    const pending = deferred<Response>(), entered = deferred<void>(); const stopIndex = { parent: 1, create: 2, readback: 3 }[phase];
    const { nas, calls } = fixture((_call, index) => { if (index === stopIndex) { entered.resolve(); return pending.promise; } }); await login(nas);
    const action = nas.createDirectory(parent, "child"); const outcome = action.catch((e) => e); await entered.promise; nas.logout();
    expect(calls[stopIndex - 1].init.signal?.aborted).toBe(true);
    pending.resolve(officialJson({ code: 200, ts: now * 1000, data: { path: "/real/child", modify_time: now, name: "child", is_dir: true } }));
    expect(await outcome).toMatchObject({ code: "REQUEST_CANCELLED", mayHaveCreated: phase !== "parent" }); expect(calls).toHaveLength(stopIndex);
  });
  it.each(["before", "parent", "create", "readback"] as const)("honors caller abort %s with accurate dispatch boundary", async (phase) => {
    const controller = new AbortController(), pending = deferred<Response>(), entered = deferred<void>(); const stopIndex = { before: 0, parent: 1, create: 2, readback: 3 }[phase];
    const { nas, calls } = fixture((_call, index) => { if (index === stopIndex) { entered.resolve(); return pending.promise; } }); await login(nas);
    if (phase === "before") controller.abort();
    const action = nas.createDirectory(parent, "child", { signal: controller.signal }); const outcome = action.catch((e) => e);
    if (phase !== "before") { await entered.promise; controller.abort(); expect(calls[stopIndex - 1].init.signal?.aborted).toBe(true); pending.resolve(officialJson({ code: 200, data: {} })); }
    expect(await outcome).toMatchObject({ code: "REQUEST_CANCELLED", mayHaveCreated: stopIndex >= 2 }); expect(calls).toHaveLength(stopIndex);
  });
  it("prevents same-session duplicate writes and preserves new-session locks against stale cleanup/expiry", async () => {
    const old = deferred<Response>(), fresh = deferred<Response>(), enteredOld = deferred<void>(), enteredFresh = deferred<void>(); let writes = 0;
    const { nas, calls } = fixture((call) => { if (call.path === "/v2/file/newdir") { if (++writes === 1) { enteredOld.resolve(); return old.promise; } enteredFresh.resolve(); return fresh.promise; } }); await login(nas);
    const oldAction = nas.createDirectory(parent, "child").catch((e) => e); await enteredOld.promise;
    await expect(nas.createDirectory(parent, "child")).rejects.toMatchObject({ code: "DIRECTORY_IN_FLIGHT", mayHaveCreated: false }); expect(calls).toHaveLength(2);
    const session = await login(nas); const newAction = nas.createDirectory(parent, "child"); await enteredFresh.promise;
    old.resolve(officialJson({}, 401)); expect(await oldAction).toMatchObject({ code: "REQUEST_CANCELLED", mayHaveCreated: true }); expect(nas.sessionId).toBe(session.sessionId);
    await expect(nas.createDirectory(parent, "child")).rejects.toMatchObject({ code: "DIRECTORY_IN_FLIGHT" }); expect(writes).toBe(2);
    fresh.resolve(officialJson({ code: 200, ts: now * 1000, data: { path: "/real/child", modify_time: now } })); expect((await newAction).sessionId).toBe(session.sessionId);
  });
  it("Gateway exposes direct action independently of shop init and reports current expiry only", async () => {
    const { fetcher, calls } = fixture((call) => call.path === "/v2/file/newdir" ? officialJson({}, 401) : undefined); const gateway = new Gateway(fetcher);
    const init = vi.spyOn(gateway, "init").mockRejectedValue(new Error("shop unavailable")); await gateway.login("http://nas.test:5055", "fixture", "password");
    const listener = vi.fn(); window.addEventListener("space-session-expired", listener);
    try { await expect(gateway.createDirectory(parent, "child")).rejects.toMatchObject({ code: "SESSION_EXPIRED", mayHaveCreated: true }); expect(gateway.nasSession).toBe(""); expect(listener).toHaveBeenCalledTimes(1); expect(init).not.toHaveBeenCalled(); expect(calls).toHaveLength(2); }
    finally { window.removeEventListener("space-session-expired", listener); }
  });
  it("cannot initiate a write with the superseded generation while replacement login is pending", async () => {
    const key = deferred<Response>(), entered = deferred<void>(); const { fetcher, calls } = fixture(); let keys = 0;
    const nas = new OfficialNas(async (input, init) => { if (new URL(String(input)).pathname === "/key/pub" && ++keys === 2) { entered.resolve(); return key.promise; } return fetcher(input, init); });
    await login(nas); const replacing = login(nas).catch((error) => error); await entered.promise;
    await expect(nas.createDirectory(parent, "child")).rejects.toMatchObject({ code: "REQUEST_CANCELLED", mayHaveCreated: false }); expect(calls).toHaveLength(0);
    key.resolve(officialJson({}, 500)); await replacing;
  });
  it.each(["parent", "create", "readback"] as const)("replacement login at %s aborts old authority without expiring new session", async (phase) => {
    const pending = deferred<Response>(), entered = deferred<void>(); const stop = { parent: 1, create: 2, readback: 3 }[phase];
    const { nas, calls } = fixture((_call, index) => { if (index === stop) { entered.resolve(); return pending.promise; } }); await login(nas);
    const outcome = nas.createDirectory(parent, "child").catch((error) => error); await entered.promise;
    const session = await login(nas); expect(calls[stop - 1].init.signal?.aborted).toBe(true); pending.resolve(officialJson({}, 401));
    expect(await outcome).toMatchObject({ code: "REQUEST_CANCELLED", mayHaveCreated: phase !== "parent" }); expect(nas.sessionId).toBe(session.sessionId); expect(calls).toHaveLength(stop);
  });
  it.each(["parent", "readback"] as const)("bounded %s response reading aborts and fences each stream await", async (phase) => {
    const entered = deferred<void>(); let stream!: ReadableStreamDefaultController<Uint8Array>; const cancelled = vi.fn(); const stop = phase === "parent" ? 1 : 3;
    const { nas, calls } = fixture((_call, index) => {
      if (index !== stop) return;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, pull() { entered.resolve(); }, cancel: cancelled }));
    }); await login(nas); const outcome = nas.createDirectory(parent, "child").catch((error) => error); await entered.promise;
    stream.enqueue(new TextEncoder().encode('{"code":200,"data":')); await Promise.resolve(); nas.logout();
    expect(await outcome).toMatchObject({ code: "REQUEST_CANCELLED", mayHaveCreated: phase === "readback" }); expect(cancelled).toHaveBeenCalledTimes(1); expect(calls).toHaveLength(stop);
  });
  it.each(["http", "business", "network", "oversized", "declared-oversized"])("never writes after %s parent verification failure", async (mode) => {
    const { nas, calls } = fixture((_call, index) => {
      if (index !== 1) return;
      if (mode === "network") throw new Error("synthetic-official-token");
      if (mode === "business") return officialJson({ success: false, code: "N001316", message: "synthetic-official-token" });
      if (mode === "http") return officialJson({}, 500);
      if (mode === "declared-oversized") return new Response("{}", { headers: { "Content-Length": "65537" } });
      return officialJson({ code: 200, data: "x".repeat(65_536) });
    }); await login(nas); const error = await nas.createDirectory(parent, "child").catch((e) => e);
    expect(error.mayHaveCreated).toBe(false); expect(String(error)).not.toMatch(/synthetic/); expect(calls).toHaveLength(1);
  });
  it("snapshots caller identity rather than using later-mutated display labels or paths", async () => {
    const pending = deferred<Response>(), entered = deferred<void>(); const { nas, calls } = fixture((_call, index) => { if (index === 1) { entered.resolve(); return pending.promise; } }); await login(nas);
    const selection = { ...parent }; const outcome = nas.createDirectory(selection, "child"); await entered.promise;
    selection.path = "/other"; selection.name = "untrusted display"; pending.resolve(officialJson({ code: 200, data: { path: "/real", is_dir: true } }));
    expect((await outcome).item.path).toBe("/real/child"); expect(calls[1].form.get("parent")).toBe("/real");
  });
  it("Gateway ignores old expiry after replacement during creation", async () => {
    const pending = deferred<Response>(), entered = deferred<void>(); const { fetcher } = fixture((call) => { if (call.path === "/v2/file/newdir") { entered.resolve(); return pending.promise; } });
    const gateway = new Gateway(fetcher); await gateway.login("http://nas.test:5055", "fixture", "password"); const listener = vi.fn(); window.addEventListener("space-session-expired", listener);
    try {
      const outcome = gateway.createDirectory(parent, "child").catch((error) => error); await entered.promise;
      const fresh = await gateway.login("http://nas.test:5055", "fixture", "password"); pending.resolve(officialJson({}, 401));
      expect(await outcome).toMatchObject({ code: "REQUEST_CANCELLED", mayHaveCreated: true }); expect(gateway.nasSession).toBe(fresh.sessionId); expect(listener).not.toHaveBeenCalled();
    } finally { window.removeEventListener("space-session-expired", listener); }
  });
  it("bounds outstanding directory contexts and releases old-session contexts on logout", async () => {
    const pending = deferred<Response>(); let hold = true;
    const { nas, calls } = fixture(() => hold ? pending.promise : undefined); await login(nas);
    const actions = Array.from({ length: 64 }, (_, index) => nas.createDirectory(parent, `child-${index}`).catch((error) => error));
    const overflow = nas.createDirectory(parent, "overflow").catch((error) => error);
    try {
      expect(calls).toHaveLength(64);
      expect(await overflow).toMatchObject({ code: "DIRECTORY_LIMIT", mayHaveCreated: false });
      nas.logout(); hold = false; await login(nas); expect((await nas.createDirectory(parent, "fresh")).outcome).toBe("directory-ready");
    } finally { nas.logout(); pending.resolve(officialJson({ code: 200, data: {} })); await overflow; }
    expect((await Promise.all(actions)).every((error) => error.code === "REQUEST_CANCELLED")).toBe(true);
  });
  it("rejects a private token split across the requested parent/name join before any authenticated request", async () => {
    const token = "synthetic-prefix/synthetic-suffix", path = "/synthetic-prefix", name = "synthetic-suffix";
    const { fetcher, calls } = fixture((call) => call.path === "/v2/file/newdir" ? officialJson({ code: 200, ts: now * 1000, data: { path: `${path}/${name}`, modify_time: now } }) : undefined);
    const nas = new OfficialNas(async (input, init) => new URL(String(input)).pathname === "/auth/login"
      ? officialJson({ code: 200, data: { token, nasid: "synthetic", username: "fixture" } }) : fetcher(input, init));
    await login(nas); const outcome = await nas.createDirectory({ ...parent, path }, name).catch((error) => error);
    expect(outcome).toMatchObject({ code: "INVALID_DIRECTORY_NAME", mayHaveCreated: false }); expect(JSON.stringify(outcome)).not.toContain(token); expect(calls).toHaveLength(0);
  });
  it.each(["parent", "create", "readback"] as const)("disposes open %s response resources on early status/header rejection", async (phase) => {
    const stop = { parent: 1, create: 2, readback: 3 }[phase];
    for (const mode of ["declared-oversized", "invalid-length", "http", "redirect", "foreign-response", "expiry"]) {
      const cancelled = vi.fn(); let resourceAlive = true; let response!: Response;
      const { nas, calls } = fixture((_call, index) => {
        if (index !== stop) return;
        response = new Response(new ReadableStream({ cancel() { cancelled(); resourceAlive = false; } }), {
          status: mode === "http" ? 500 : mode === "expiry" ? 401 : 200,
          headers: mode === "declared-oversized" ? { "Content-Length": "65537" } : mode === "invalid-length" ? { "Content-Length": "bad" } : {},
        });
        if (mode === "redirect") Object.defineProperty(response, "redirected", { value: true });
        if (mode === "foreign-response") Object.defineProperty(response, "url", { value: "http://foreign.test/private" });
        return response;
      });
      await login(nas); const error = await nas.createDirectory(parent, "child").catch((value) => value);
      expect(error.mayHaveCreated).toBe(phase !== "parent"); expect(calls).toHaveLength(stop); expect(cancelled).toHaveBeenCalledTimes(1);
      expect(resourceAlive).toBe(false); expect(calls[stop - 1].init.signal?.aborted).toBe(true); expect(response.body?.locked).toBe(false);
    }
  });
  it.each(["parent", "create", "readback"] as const)("disposes a late %s response that ignored caller abort", async (phase) => {
    const stop = { parent: 1, create: 2, readback: 3 }[phase], pending = deferred<Response>(), entered = deferred<void>(), cancelled = vi.fn();
    const { nas, calls } = fixture((_call, index) => { if (index === stop) { entered.resolve(); return pending.promise; } }); await login(nas);
    const controller = new AbortController(); const outcome = nas.createDirectory(parent, "child", { signal: controller.signal }).catch((error) => error);
    await entered.promise; controller.abort(); const response = new Response(new ReadableStream({ cancel: cancelled })); pending.resolve(response);
    expect(await outcome).toMatchObject({ code: "REQUEST_CANCELLED", mayHaveCreated: phase !== "parent" }); expect(cancelled).toHaveBeenCalledTimes(1);
    expect(calls[stop - 1].init.signal?.aborted).toBe(true); expect(response.body?.locked).toBe(false); expect(calls).toHaveLength(stop);
  });
  it.each(["reject", "hang"] as const)("observes %s body cleanup without leaking cleanup errors or hanging the action", async (mode) => {
    const cancelled = vi.fn(); const { nas, calls } = fixture((_call, index) => index === 1 ? new Response(new ReadableStream({ cancel() {
      cancelled(); if (mode === "reject") return Promise.reject(new Error("synthetic-official-token cleanup")); return new Promise<void>(() => {});
    } }), { status: 500 }) : undefined); await login(nas);
    const outcome = await nas.createDirectory(parent, "child").catch((error) => error); await Promise.resolve();
    expect(outcome).toMatchObject({ code: "NAS_HTTP_ERROR", mayHaveCreated: false }); expect(JSON.stringify(outcome)).not.toMatch(/synthetic|cleanup/);
    expect(cancelled).toHaveBeenCalledTimes(1); expect(calls[0].init.signal?.aborted).toBe(true);
    expect((await nas.createDirectory(parent, "child")).outcome).toBe("directory-ready");
  });
  it("cancels/aborts streamed oversized input but keeps completed success bodies and signals intact", async () => {
    const cancelled = vi.fn(); const { nas, calls } = fixture((_call, index) => index === 1 ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65_537)); }, cancel: cancelled })) : undefined);
    await login(nas); await expect(nas.createDirectory(parent, "child")).rejects.toMatchObject({ code: "INVALID_RESPONSE", mayHaveCreated: false });
    expect(cancelled).toHaveBeenCalledTimes(1); expect(calls[0].init.signal?.aborted).toBe(true);
    const normal = fixture(); await login(normal.nas); await normal.nas.createDirectory(parent, "child");
    expect(normal.calls.every((call) => !call.init.signal?.aborted)).toBe(true);
  });
  it("removes the original caller abort listener even when caller options are reassigned during an await", async () => {
    const pending = deferred<Response>(), entered = deferred<void>(); const { nas } = fixture((_call, index) => { if (index === 1) { entered.resolve(); return pending.promise; } }); await login(nas);
    const original = new AbortController(), replacement = new AbortController(), options = { signal: original.signal };
    const added = vi.spyOn(original.signal, "addEventListener"), removed = vi.spyOn(original.signal, "removeEventListener"), otherRemoved = vi.spyOn(replacement.signal, "removeEventListener");
    const action = nas.createDirectory(parent, "child", options); await entered.promise; options.signal = replacement.signal;
    pending.resolve(officialJson({ code: 200, data: { path: "/real", is_dir: true } })); await action;
    expect(added).toHaveBeenCalledTimes(1); expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0][1]); expect(otherRemoved).not.toHaveBeenCalled();
  });
  it.each(["success", "malformed", "business", "stale-stamp"] as const)("leaves fully consumed %s response resources settled without unnecessary cancellation", async (mode) => {
    const cancelled = vi.fn(); const { nas, calls } = fixture((call, index) => {
      if (index !== 2) return;
      const value = mode === "malformed" ? "{" : JSON.stringify(mode === "business" ? { success: false, code: "N001316" } : { code: 200, ts: now * 1000, data: { path: `/real/${call.form.get("name")}`, modify_time: now - (mode === "stale-stamp" ? 3 : 0) } });
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(value)); controller.close(); }, cancel: cancelled }));
    }); await login(nas); const outcome = await nas.createDirectory(parent, "child").catch((error) => error);
    if (mode === "success") expect(outcome.outcome).toBe("directory-ready"); else expect(outcome.mayHaveCreated).toBe(true);
    expect(cancelled).not.toHaveBeenCalled(); expect(calls.every((call) => !call.init.signal?.aborted)).toBe(true);
  });
});
