import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { RuntimeSettings } from "./RuntimeSettings";

const active = { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", requestId: "pause-a", purpose: "store-update", status: "quiesced", createdAt: "2026-10-12T00:00:00Z" };
const resumed = { ...active, status: "resumed", resumedAt: "2026-10-12T01:00:00Z" };
const ready = { state: "ready" };
const paused = { state: "quiesced", current: active };
function reply(data: unknown, status = 200) { return new Response(JSON.stringify({ ok: true, data }), { status }); }
function failure(status: number, code: string, message: string) { return new Response(JSON.stringify({ ok: false, error: { code, message } }), { status }); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
let view: unknown;
let handler: (path: string, init?: RequestInit) => Promise<Response>;
let writes: { path: string; body: any }[];
let reads: number;
beforeEach(() => {
  api.storeSession = "test-maintenance";
  view = ready; writes = []; reads = 0;
  handler = async (path, init) => {
    if (init?.method === "POST") { writes.push({ path, body: JSON.parse(String(init.body)) }); return reply(path.endsWith("resume") ? resumed : active); }
    reads++; return reply(view);
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split("/api/store/")[1];
    if (path?.startsWith("v2/maintenance")) return handler(path, init);
    if (path === "v2/settings") return init?.method === "POST" ? failure(423, "store_maintenance", "商店维护中，暂停接收新操作") : reply({ theme: "light", updateCheckEnabled: true, updateCheckHours: 6 });
    return reply(path === "roots" ? { items: [] } : {});
  }));
});
afterEach(async () => { cleanup(); api.storeSession = ""; await api.setStoreAddress(""); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function renderReady() { render(<RuntimeSettings />); return screen.findByRole("button", { name: "暂停接收新操作" }); }
async function pause() { const button = await renderReady(); fireEvent.click(screen.getByRole("checkbox", { name: /我已确认/ })); fireEvent.click(button); }

it("loads maintenance and requires explicit confirmation; explains running applications and separate software switch", async () => {
  const pending = deferred<Response>(); handler = () => pending.promise;
  render(<RuntimeSettings />);
  expect(screen.getByText("正在读取维护状态…")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "暂停接收新操作" })).not.toBeInTheDocument();
  await act(async () => pending.resolve(reply(ready)));
  const button = await screen.findByRole("button", { name: "暂停接收新操作" });
  expect(button).toBeDisabled();
  expect(screen.getByText(/暂停接收新操作后，现有应用继续运行/)).toBeInTheDocument();
  expect(screen.getByText(/软件版本切换仍须独立审核/)).toBeInTheDocument();
  fireEvent.click(button); expect(writes).toHaveLength(0);
});
it("posts exact pause body and gets current view, resets confirmation and makes fresh intent nonce", async () => {
  handler = async (path, init) => {
    if (init?.method === "POST") { writes.push({ path, body: JSON.parse(String(init.body)) }); return reply(resumed); }
    reads++; return reply(ready);
  };
  await pause();
  await waitFor(() => expect(reads).toBe(2));
  const button = await screen.findByRole("button", { name: "暂停接收新操作" });
  expect(button).toBeDisabled(); expect(Object.keys(writes[0].body)).toEqual(["requestId"]);
  fireEvent.click(screen.getByRole("checkbox", { name: /我已确认/ })); fireEvent.click(button);
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1].body.requestId).not.toBe(writes[0].body.requestId);
});
it("keeps same pause requestId after network failure and suppresses duplicate action", async () => {
  const pending = deferred<Response>(); let attempt = 0;
  handler = async (path, init) => {
    if (init?.method !== "POST") { reads++; return reply(view); }
    writes.push({ path, body: JSON.parse(String(init.body)) }); attempt++;
    if (attempt === 1) return pending.promise;
    view = paused; return reply(active, 201);
  };
  await pause();
  fireEvent.click(screen.getByRole("button", { name: "处理中…" })); expect(writes).toHaveLength(1);
  await act(async () => pending.reject(new Error("network")));
  await screen.findByText(/无法连接独立商店服务/);
  fireEvent.click(screen.getByRole("button", { name: "暂停接收新操作" }));
  await screen.findByRole("button", { name: "恢复接收操作" });
  expect(writes[1].body).toEqual(writes[0].body);
});
it("uses current GET when quiesce replays history and another maintenance is active", async () => {
  handler = async (path, init) => {
    if (init?.method === "POST") { writes.push({ path, body: JSON.parse(String(init.body)) }); view = { ...paused, current: { ...active, id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } }; return reply(resumed); }
    return reply(view);
  };
  await pause(); await screen.findByRole("button", { name: "恢复接收操作" });
  expect(screen.getByText("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBeInTheDocument();
  expect(screen.queryByText("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).not.toBeInTheDocument();
});
it("binds resume retries to captured id and rereads current state after success", async () => {
  view = paused; let attempt = 0;
  handler = async (path, init) => {
    if (init?.method !== "POST") { reads++; return reply(view); }
    writes.push({ path, body: JSON.parse(String(init.body)) });
    if (++attempt === 1) throw new Error("network");
    view = ready; return reply(resumed);
  };
  render(<RuntimeSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "恢复接收操作" }));
  await screen.findByText(/无法连接独立商店服务/);
  fireEvent.click(screen.getByRole("button", { name: "恢复接收操作" }));
  expect(await screen.findByRole("button", { name: "暂停接收新操作" })).toBeDisabled();
  expect(writes).toEqual([{ path: "v2/maintenance/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/resume", body: {} }, { path: "v2/maintenance/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/resume", body: {} }]);
  expect(reads).toBe(2);
});
it.each([[409, "busy", "仍有任务运行，暂时不能暂停"], [423, "store_maintenance", "已有维护记录，请重新读取"], [503, "maintenance_unverified", "维护证据无法核验"]])("shows actual %s write error and keeps current record", async (status, code, text) => {
  view = paused;
  handler = async (_path, init) => init?.method === "POST" ? failure(Number(status), String(code), String(text)) : reply(view);
  render(<RuntimeSettings />); fireEvent.click(await screen.findByRole("button", { name: "恢复接收操作" }));
  expect(await screen.findByText(String(text))).toBeInTheDocument();
  expect(screen.getByText("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeInTheDocument();
});
it("keeps maintenance recovery available after settings save is rejected with 423", async () => {
  view = paused; render(<RuntimeSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "保存设置" }));
  await screen.findByText("商店维护中，暂停接收新操作");
  expect(screen.getByRole("button", { name: "恢复接收操作" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "保存设置" })).toBeEnabled();
});
it("fails closed on bad maintenance view and allows fresh read after server failure", async () => {
  view = { state: "quiesced" }; render(<RuntimeSettings />);
  await screen.findByText("维护状态无法核验，请重新读取");
  expect(screen.queryByRole("button", { name: "暂停接收新操作" })).not.toBeInTheDocument();
  view = ready; fireEvent.click(screen.getByRole("button", { name: "重新读取维护状态" }));
  await screen.findByRole("button", { name: "暂停接收新操作" });
});
it.each(["read", "write"])("discards late %s results and clears intent on session replacement", async (phase) => {
  const pending = deferred<Response>();
  handler = async (_path, init) => phase === "read" || init?.method === "POST" ? pending.promise : reply(ready);
  if (phase === "write") await pause(); else render(<RuntimeSettings />);
  await act(async () => { api.storeSession = "replacement"; });
  await act(async () => pending.resolve(reply(phase === "read" ? paused : active)));
  expect(screen.queryByText("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "恢复接收操作" })).not.toBeInTheDocument();
  handler = async () => reply(ready);
  fireEvent.click(screen.getByRole("button", { name: "重新读取维护状态" }));
  expect(await screen.findByRole("button", { name: "暂停接收新操作" })).toBeDisabled();
});
it("clears state and controls on revoked credentials using existing SDK teardown", async () => {
  view = paused; render(<RuntimeSettings />);
  const button = await screen.findByRole("button", { name: "恢复接收操作" });
  handler = async () => failure(401, "store_auth_required", "登录已失效"); fireEvent.click(button);
  await waitFor(() => expect(api.storeSession).toBe(""));
  expect(screen.queryByText("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "恢复接收操作" })).not.toBeInTheDocument();
});
it.each([
  { id: undefined }, { id: "_unsafe" }, { id: "a".repeat(65) },
  { requestId: undefined }, { createdAt: 123 }, { status: "resumed" },
])("rejects malformed active record %j without permitting resume", async (override) => {
  view = { ...paused, current: { ...active, ...override } };
  render(<RuntimeSettings />);
  expect(await screen.findByText("维护状态无法核验，请重新读取")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "恢复接收操作" })).not.toBeInTheDocument();
});
it.each(["read", "write"])("drops late %s after address change and requires fresh confirmation", async (phase) => {
  const pending = deferred<Response>();
  handler = async (_path, init) => phase === "read" || init?.method === "POST" ? pending.promise : reply(ready);
  if (phase === "write") await pause(); else render(<RuntimeSettings />);
  await act(async () => { await api.setStoreAddress("https://maintenance-changed.example"); });
  await act(async () => pending.resolve(reply(phase === "read" ? paused : active)));
  expect(screen.queryByText("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "重新读取维护状态" })).toBeDisabled();
  await act(async () => { api.storeSession = "new-service-session"; });
  handler = async () => reply(ready);
  fireEvent.click(screen.getByRole("button", { name: "重新读取维护状态" }));
  expect(await screen.findByRole("button", { name: "暂停接收新操作" })).toBeDisabled();
});
it("ignores old read arriving after fresh scope read has completed", async () => {
  const pending = deferred<Response>(); handler = () => pending.promise;
  render(<RuntimeSettings />);
  await act(async () => { api.storeSession = "replacement"; });
  handler = async () => reply(ready);
  fireEvent.click(screen.getByRole("button", { name: "重新读取维护状态" }));
  await screen.findByRole("button", { name: "暂停接收新操作" });
  await act(async () => pending.resolve(reply(paused)));
  expect(screen.getByRole("button", { name: "暂停接收新操作" })).toBeDisabled();
  expect(screen.queryByText("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).not.toBeInTheDocument();
});
it.each(["read", "write"])("does not process late %s after unmount or schedule current view read", async (phase) => {
  const pending = deferred<Response>(); let maintenanceCalls = 0;
  handler = async (_path, init) => { maintenanceCalls++; return phase === "read" || init?.method === "POST" ? pending.promise : reply(ready); };
  if (phase === "write") await pause(); else render(<RuntimeSettings />);
  cleanup(); const count = maintenanceCalls;
  await act(async () => pending.resolve(reply(phase === "read" ? paused : active)));
  expect(maintenanceCalls).toBe(count);
  expect(screen.queryByText("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).not.toBeInTheDocument();
});
it("expires NAS grant immediately and discards pending write with no new session replay", async () => {
  const pending = deferred<Response>();
  api.adoptStoreGrant({ sessionId: "short-lived-grant", expiresAt: new Date(Date.now() + 60000).toISOString(), storeAddress: api.storeAddress }, api.captureStoreScope());
  handler = async (_path, init) => init?.method === "POST" ? pending.promise : reply(ready);
  await pause();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61000);
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(api.storeSession).toBe("");
  await act(async () => pending.resolve(reply(active)));
  expect(screen.queryByRole("button", { name: "恢复接收操作" })).not.toBeInTheDocument();
  expect(screen.queryByText("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).not.toBeInTheDocument();
  vi.restoreAllMocks();
});
it("retains wrong-id conflict evidence until reread, then binds new resume to newly read id", async () => {
  view = paused;
  handler = async (path, init) => {
    if (init?.method === "POST") { writes.push({ path, body: JSON.parse(String(init.body)) }); return failure(409, "maintenance_conflict", "当前维护记录不匹配"); }
    return reply(view);
  };
  render(<RuntimeSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "恢复接收操作" }));
  await screen.findByText("当前维护记录不匹配");
  expect(screen.getByText("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeInTheDocument();
  view = { ...paused, current: { ...active, id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } };
  fireEvent.click(screen.getByRole("button", { name: "重新读取维护状态" }));
  await screen.findByText("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  fireEvent.click(screen.getByRole("button", { name: "恢复接收操作" }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1].path).toBe("v2/maintenance/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/resume");
});
it("hides speculative state after successful pause when current GET fails and can reread", async () => {
  let getCount = 0;
  handler = async (path, init) => {
    if (init?.method === "POST") { writes.push({ path, body: JSON.parse(String(init.body)) }); return reply(active, 201); }
    if (++getCount === 2) return failure(503, "maintenance_unverified", "当前维护状态读取失败");
    return reply(getCount > 2 ? paused : ready);
  };
  await pause(); await screen.findByText("当前维护状态读取失败");
  expect(screen.queryByRole("button", { name: "恢复接收操作" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重新读取维护状态" }));
  await screen.findByRole("button", { name: "恢复接收操作" });
  expect(writes).toHaveLength(1);
});
it("supports LAN HTTP where randomUUID is unavailable", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
  try {
    handler = async (path, init) => {
      if (init?.method === "POST") { writes.push({ path, body: JSON.parse(String(init.body)) }); view = paused; return reply(active, 201); }
      return reply(view);
    };
    await pause();
    await screen.findByRole("button", { name: "恢复接收操作" });
    expect(writes[0].body.requestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
  } finally {
    if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor);
    else delete (crypto as any).randomUUID;
  }
});

// Contract regressions: invalid evidence must never grant a recovery control.
it.each([
  ["nonexistent calendar day", { createdAt: "2026-02-30T00:00:00Z" }],
  ["non RFC3339 date", { createdAt: "12/31/2026" }],
  ["already resumed active record", { resumedAt: "2026-10-12T01:00:00Z" }],
  ["null resumed timestamp", { resumedAt: null }],
  ["null creation timestamp", { createdAt: null }],
  ["non-leap century", { createdAt: "2100-02-29T00:00:00Z" }],
  ["zero day", { createdAt: "2026-10-00T00:00:00Z" }],
  ["invalid month", { createdAt: "2026-13-12T00:00:00Z" }],
  ["normalized hour", { createdAt: "2026-10-12T24:00:00Z" }],
  ["invalid minute", { createdAt: "2026-10-12T00:60:00Z" }],
  ["invalid second", { createdAt: "2026-10-12T00:00:60Z" }],
  ["missing zone", { createdAt: "2026-10-12T00:00:00" }],
  ["noncanonical offset", { createdAt: "2026-10-12T00:00:00+08:00" }],
  ["excess fractional precision", { createdAt: "2026-10-12T00:00:00.1234567890Z" }],
  ["Go zero time", { createdAt: "0001-01-01T00:00:00Z" }],
  ["short id", { id: "a".repeat(47) }],
  ["long id", { id: "a".repeat(49) }],
  ["nonhex id", { id: "g".repeat(48) }],
  ["invalid request segment", { requestId: "pause/a" }],
  ["wrong purpose", { purpose: "other" }],
  ["unknown status", { status: "unknown" }],
])("fails closed on %s", async (_label, override) => {
  view = { ...paused, current: { ...active, ...override } };
  render(<RuntimeSettings />);
  expect(await screen.findByText("维护状态无法核验，请重新读取")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "恢复接收操作" })).not.toBeInTheDocument();
  expect(writes).toHaveLength(0);
});
it.each([
  { state: "ready", current: active },
  { state: "ready", current: null },
  { state: "ready", current: false },
  { state: "quiesced", current: resumed },
  { state: "unknown", current: active },
])("rejects contradictory current view %j", async (invalidView) => {
  view = invalidView;
  render(<RuntimeSettings />);
  expect(await screen.findByText("维护状态无法核验，请重新读取")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "恢复接收操作" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "暂停接收新操作" })).not.toBeInTheDocument();
});
it.each(["2000-02-29T23:59:59Z", "2026-10-12T00:00:00.1Z", "2026-10-12T00:00:00.123456789Z"])("accepts real backend UTC timestamp %s", async (createdAt) => {
  view = { ...paused, current: { ...active, createdAt } };
  render(<RuntimeSettings />);
  expect(await screen.findByRole("button", { name: "恢复接收操作" })).toBeEnabled();
});
