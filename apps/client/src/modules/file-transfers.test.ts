import { describe, expect, it, vi } from "vitest";
import { FileTransfersController, downloadUnavailable, type TransferDependencies } from "./file-transfers";
import type { FileTransfer, Item } from "../api/client";
import { BrowserDownloadError, type BrowserDownloadOptions, type BrowserDownloadResult } from "../api/browser-download";
const file: Item = { id: "file", name: "report.json", path: "/report.json", kind: "file", metadata: { hidden: "private-retry-input" } };
const descriptor = { id: "a".repeat(64), sessionId: "session-one", name: file.name, size: 8 };
const nativeRow = (status: FileTransfer["status"] = "choosing", received = 0): FileTransfer => ({ id: "b".repeat(64), sessionId: "session-one", name: file.name, total: 8, received, status });
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; }
function fixture(native = false) {
  let session = "session-one", event: (row: FileTransfer) => void = () => { };
  const delivery = deferred<BrowserDownloadResult>();
  let options!: BrowserDownloadOptions;
  const deps: TransferDependencies = {
    session: () => session, native: () => native,
    prepare: vi.fn(async () => ({ ...descriptor })), fetch: vi.fn(),
    deliver: vi.fn((value) => { options = value; return delivery.promise; }),
    listen: vi.fn(async (value) => { event = value; return () => { }; }),
    startNative: vi.fn(async () => nativeRow()), cancelNative: vi.fn(async () => { }),
    nativeTasks: vi.fn(async () => []),
  };
  const controller = new FileTransfersController(deps);
  return { controller, deps, delivery, options: () => options, event: (row: FileTransfer) => event(row), session: (value: string) => { session = value; controller.syncSession(); } };
}
it.each([false, true])("publishes a static download failure label and preserves partial truth (%s)", async partial => {
  const f = fixture(); const pending = f.controller.download(file);
  await vi.waitFor(() => expect(f.deps.deliver).toHaveBeenCalledOnce());
  const error = Object.assign(new BrowserDownloadError("DELIVERY_FAILED", partial), { diagnostic: "DOWNLOAD_DISPOSITION_MISSING", message: "synthetic-private-upstream" });
  f.delivery.reject(error); await pending;
  const row = f.controller.getSnapshot()[0];
  expect(row.message).toBe(`浏览器下载未完成${partial ? "，请检查下载管理器中的不完整文件" : ""}；NAS 未提供下载文件名`);
  expect(row).toMatchObject({ status: "failed", received: 0 });
  expect(row.mayHavePartial).toBe(partial ? true : undefined); expect(row.retainedPartial).not.toBe(true);
  expect(JSON.stringify(f.controller.getSnapshot())).not.toMatch(/synthetic-private|DOWNLOAD_DISPOSITION|metadata/);
});
it.each(["unknown", "forged", "cancelled"])("keeps %s task diagnostics generic", async kind => {
  const f = fixture(); const pending = f.controller.download(file);
  await vi.waitFor(() => expect(f.deps.deliver).toHaveBeenCalledOnce());
  const error = Object.assign(kind === "forged" ? new Error("synthetic-private-upstream") : new BrowserDownloadError(kind === "cancelled" ? "CANCELLED" : "DELIVERY_FAILED", false), { diagnostic: kind === "unknown" ? "synthetic-private-diagnostic" : "DOWNLOAD_ENCODING" });
  f.delivery.reject(error); await pending;
  const row = f.controller.getSnapshot()[0];
  expect(row.message).toBe(kind === "forged" ? "无法安全准备或启动下载，请刷新文件列表后重试" : kind === "cancelled" ? "下载已取消" : "浏览器下载未完成");
  expect(JSON.stringify(row)).not.toMatch(/synthetic-private|DOWNLOAD_ENCODING/);
});
describe("global local file transfer lifecycle", () => {
  it("rejects directory and missing identities before preparation", async () => {
    expect(downloadUnavailable({ ...file, kind: "directory" })).toContain("文件夹");
    expect(downloadUnavailable({ ...file, path: undefined })).toContain("身份");
    const f = fixture();
    await f.controller.download({ ...file, path: undefined });
    expect(f.deps.prepare).not.toHaveBeenCalled();
  });
  it("deduplicates while preparing and preserves private retry inputs outside snapshots", async () => {
    const f = fixture();
    const preparing = deferred<typeof descriptor>();
    vi.mocked(f.deps.prepare).mockReturnValue(preparing.promise);
    const first = f.controller.download(file);
    await f.controller.download({ ...file });
    expect(f.deps.prepare).toHaveBeenCalledTimes(1);
    expect(f.controller.getSnapshot()).toHaveLength(1);
    expect(JSON.stringify(f.controller.getSnapshot())).not.toMatch(/private-retry-input|metadata|\/report.json/);
    preparing.resolve(descriptor);
    await vi.waitFor(() => expect(f.deps.deliver).toHaveBeenCalledOnce());
    f.delivery.resolve({ received: 8, total: 8, method: "blob", outcome: "handed-to-browser", diskCompletion: "unknown" });
    await first;
    expect(f.controller.getSnapshot()[0]).toMatchObject({ status: "completed", delivery: "browser", received: 8 });
    expect(f.controller.getSnapshot()[0].message).toContain("浏览器下载管理器");
    expect(f.controller.getSnapshot()[0].retainedPartial).not.toBe(true);
  });
  it("tracks real progress and explicit cancel without letting a late success revive a task", async () => {
    const f = fixture();
    const pending = f.controller.download(file);
    await vi.waitFor(() => expect(f.deps.deliver).toHaveBeenCalledOnce());
    f.options().onProgress?.({ received: 3 });
    expect(f.controller.getSnapshot()[0].received).toBe(3);
    const id = f.controller.getSnapshot()[0].id;
    await f.controller.cancel(id);
    expect(f.options().signal?.aborted).toBe(true);
    f.delivery.resolve({ received: 8, method: "stream", outcome: "handed-to-browser", diskCompletion: "unknown" });
    await pending;
    expect(f.controller.getSnapshot()[0].status).toBe("cancelled");
  });
  it("never silently retries failed streams and retries compatible only after explicit action", async () => {
    const f = fixture();
    const first = f.controller.download(file);
    await vi.waitFor(() => expect(f.deps.deliver).toHaveBeenCalledOnce());
    f.delivery.reject(new BrowserDownloadError("DELIVERY_FAILED", true));
    await first;
    const row = f.controller.getSnapshot()[0];
    expect(row.status).toBe("failed");
    expect(row.mayHavePartial).toBe(true);
    expect(row.retainedPartial).not.toBe(true);
    expect(f.deps.deliver).toHaveBeenCalledTimes(1);
    vi.mocked(f.deps.deliver).mockResolvedValue({ received: 8, method: "blob", outcome: "handed-to-browser", diskCompletion: "unknown" });
    await f.controller.retry(row.id, "compatible");
    expect(f.deps.prepare).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.deps.deliver).mock.calls[1][0].mode).toBe("compatible");
  });
  it("rejects session replacement during metadata preparation and stale browser callbacks", async () => {
    const f = fixture();
    const preparing = deferred<typeof descriptor>();
    vi.mocked(f.deps.prepare).mockReturnValue(preparing.promise);
    const pending = f.controller.download(file);
    f.session("session-two");
    preparing.resolve(descriptor);
    await pending;
    expect(f.deps.deliver).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot()).toEqual([]);
  });
  it("clears retry authority and aborts active transport on logout independent of store state", async () => {
    const f = fixture();
    const pending = f.controller.download(file);
    await vi.waitFor(() => expect(f.deps.deliver).toHaveBeenCalledOnce());
    const id = f.controller.getSnapshot()[0].id;
    f.session("");
    expect(f.options().signal?.aborted).toBe(true);
    expect(f.options().isSessionCurrent()).toBe(false);
    f.delivery.resolve({ received: 8, method: "blob", outcome: "handed-to-browser", diskCompletion: "unknown" });
    await pending;
    await f.controller.retry(id, "compatible");
    expect(f.deps.prepare).toHaveBeenCalledTimes(1);
    expect(f.controller.getSnapshot()).toEqual([]);
  });
  it("installs the native listener before start and does not replace a fast terminal event with choosing", async () => {
    const f = fixture(true);
    const order: string[] = [];
    const listen = vi.mocked(f.deps.listen).getMockImplementation()!;
    vi.mocked(f.deps.listen).mockImplementation(async (cb) => { order.push("listen"); return listen(cb); });
    vi.mocked(f.deps.startNative).mockImplementation(async () => { order.push("start"); f.event(nativeRow("completed", 8)); return nativeRow(); });
    await f.controller.download(file);
    expect(order).toEqual(["listen", "start"]);
    expect(f.controller.getSnapshot()).toHaveLength(1);
    expect(f.controller.getSnapshot()[0].status).toBe("completed");
  });
  it("deduplicates choosing and reflects save-dialog cancellation and retained partial failure", async () => {
    const f = fixture(true);
    await f.controller.download(file);
    await f.controller.download({ ...file });
    expect(f.deps.startNative).toHaveBeenCalledOnce();
    f.event(nativeRow("cancelled"));
    expect(f.controller.getSnapshot()[0].status).toBe("cancelled");
    vi.mocked(f.deps.startNative).mockResolvedValue({ ...nativeRow(), id: "c".repeat(64) });
    await f.controller.download(file);
    f.event({ ...nativeRow("failed", 3), id: "c".repeat(64), retainedPartial: true, message: "http://secret/raw-error?token=bad" });
    expect(f.controller.getSnapshot().at(-1)).toMatchObject({ received: 3, status: "failed", retainedPartial: true });
    expect(f.controller.getSnapshot().at(-1)?.message).toContain("不完整");
    expect(JSON.stringify(f.controller.getSnapshot())).not.toMatch(/secret|token|raw-error/);
  });
  it("does not apply a stale native snapshot over a newer live event", async () => {
    const f = fixture(true);
    await f.controller.download(file);
    const snapshot = deferred<FileTransfer[]>();
    vi.mocked(f.deps.nativeTasks).mockReturnValue(snapshot.promise);
    const refresh = f.controller.refresh();
    f.event(nativeRow("completed", 8));
    snapshot.resolve([nativeRow("running", 2)]);
    await refresh;
    expect(f.controller.getSnapshot()[0]).toMatchObject({ status: "completed", received: 8 });
  });
  it("recovers current native tasks on reopen and drops old-session snapshots/events", async () => {
    const f = fixture(true);
    vi.mocked(f.deps.nativeTasks).mockResolvedValue([nativeRow("running", 3)]);
    await f.controller.refresh();
    expect(f.controller.getSnapshot()[0].received).toBe(3);
    f.session("session-two");
    f.event(nativeRow("completed", 8));
    await f.controller.refresh();
    expect(f.controller.getSnapshot()).toEqual([]);
  });
  it("cancels native authority after progress and rejects out-of-order choosing or running", async () => {
    const f = fixture(true);
    await f.controller.download(file);
    f.event(nativeRow("running", 3));
    await f.controller.cancel(nativeRow().id);
    expect(f.deps.cancelNative).toHaveBeenCalledWith(nativeRow().id);
    f.event(nativeRow("choosing"));
    expect(f.controller.getSnapshot()[0]).toMatchObject({ status: "running", received: 3, cancelRequested: true });
    f.event(nativeRow("running", 4));
    expect(f.controller.getSnapshot()[0]).toMatchObject({ status: "running", received: 4, cancelRequested: true });
    f.event({ ...nativeRow("cancelled", 4), retainedPartial: true });
    expect(f.controller.getSnapshot()[0]).toMatchObject({ status: "cancelled", retainedPartial: true });
    f.event(nativeRow("running", 5));
    expect(f.controller.getSnapshot()[0].status).toBe("cancelled");
  });
});
it("does not turn an already completed native file into cancelled when cancel acknowledgment arrives late", async () => {
  const f = fixture(true);
  await f.controller.download(file);
  f.event(nativeRow("running", 3));
  const acknowledgement = deferred<void>();
  vi.mocked(f.deps.cancelNative).mockReturnValue(acknowledgement.promise);
  const cancel = f.controller.cancel(nativeRow().id);
  f.event(nativeRow("completed", 8));
  acknowledgement.resolve();
  await cancel;
  expect(f.controller.getSnapshot()[0].status).toBe("completed");
});
it("binds a late native start result to a cancelled provisional row without exposing a duplicate", async () => {
  const f = fixture(true), reply = deferred<FileTransfer>();
  vi.mocked(f.deps.startNative).mockReturnValue(reply.promise);
  const pending = f.controller.download(file);
  await vi.waitFor(() => expect(f.deps.startNative).toHaveBeenCalledOnce());
  await f.controller.cancel(f.controller.getSnapshot()[0].id);
  f.event(nativeRow("running", 3));
  reply.resolve(nativeRow());
  await pending;
  expect(f.deps.cancelNative).toHaveBeenCalledWith(nativeRow().id);
  expect(f.controller.getSnapshot()).toHaveLength(1);
  expect(f.controller.getSnapshot()[0]).toMatchObject({ status: "running", cancelRequested: true });
  f.event(nativeRow("completed", 8));
  expect(f.controller.getSnapshot()[0].status).toBe("completed");
});
it("rejects old progress and terminal callbacks after replacement while a new session transfer is active", async () => {
  const f = fixture();
  const first = f.controller.download(file);
  await vi.waitFor(() => expect(f.deps.deliver).toHaveBeenCalledOnce());
  const old = f.options();
  f.session("session-two");
  vi.mocked(f.deps.prepare).mockResolvedValue({ ...descriptor, sessionId: "session-two" });
  const second = f.controller.download(file);
  await vi.waitFor(() => expect(f.deps.deliver).toHaveBeenCalledTimes(2));
  const current = f.options();
  current.onProgress?.({ received: 2 });
  old.onProgress?.({ received: 7 });
  expect(f.controller.getSnapshot()[0].received).toBe(2);
  f.delivery.resolve({ received: 8, method: "blob", outcome: "handed-to-browser", diskCompletion: "unknown" });
  await Promise.all([first, second]);
  expect(f.controller.getSnapshot()).toHaveLength(1);
  expect(f.controller.getSnapshot()[0].sessionId).toBe("session-two");
});
it("keeps retry Items out of the runtime controller surface and freezes public row data", async () => {
  const f = fixture();
  const pending = f.controller.download(file);
  await vi.waitFor(() => expect(f.deps.deliver).toHaveBeenCalledOnce());
  expect(JSON.stringify(f.controller)).not.toMatch(/private-retry-input|metadata|\/report.json/);
  expect("runs" in f.controller).toBe(false);
  expect(Object.isFrozen(f.controller.getSnapshot())).toBe(true);
  expect(Object.isFrozen(f.controller.getSnapshot()[0])).toBe(true);
  f.delivery.resolve({ received: 8, method: "blob", outcome: "handed-to-browser", diskCompletion: "unknown" });
  await pending;
});
it("maps browser failure presentation from safe codes rather than mutable upstream messages", async () => {
  const f = fixture();
  const pending = f.controller.download(file);
  await vi.waitFor(() => expect(f.deps.deliver).toHaveBeenCalledOnce());
  const error = new BrowserDownloadError("BLOB_LIMIT", false);
  error.message = "http://private-nas?token=secret";
  f.delivery.reject(error);
  await pending;
  expect(f.controller.getSnapshot()[0].message).toContain("64 MiB");
  expect(JSON.stringify(f.controller.getSnapshot())).not.toMatch(/private-nas|token=secret/);
});

it("accepts authoritative native completion after cancellation acknowledgment arrives first", async () => {
  const f = fixture(true);
  await f.controller.download(file);
  f.event(nativeRow("running", 3));
  await f.controller.cancel(nativeRow().id);
  expect(f.controller.getSnapshot()[0]).toMatchObject({ status: "running", received: 3, cancelRequested: true });
  expect(f.controller.canRetry(nativeRow().id)).toBe(false);
  f.event(nativeRow("completed", 8));
  expect(f.controller.getSnapshot()[0]).toMatchObject({ status: "completed", received: 8, message: "文件已保存到本机" });
  expect(f.controller.getSnapshot()[0]).not.toHaveProperty("cancelRequested");
  expect(f.controller.canRetry(nativeRow().id)).toBe(false);
});
it("accepts a current native completed snapshot after cancellation acknowledgment arrives first", async () => {
  const f = fixture(true);
  await f.controller.download(file);
  f.event(nativeRow("running", 3));
  await f.controller.cancel(nativeRow().id);
  vi.mocked(f.deps.nativeTasks).mockResolvedValue([nativeRow("completed", 8)]);
  await f.controller.refresh();
  expect(f.controller.getSnapshot()[0]).toMatchObject({ status: "completed", received: 8, message: "文件已保存到本机" });
  expect(f.controller.getSnapshot()[0]).not.toHaveProperty("cancelRequested");
});
it("waits for the native dialog cancellation callback and prevents duplicate starts while cancellation is pending", async () => {
  const f = fixture(true);
  await f.controller.download(file);
  await f.controller.cancel(nativeRow().id);
  expect(f.controller.getSnapshot()[0]).toMatchObject({ status: "choosing", cancelRequested: true });
  expect(f.controller.getSnapshot()[0].message).toContain("请关闭保存对话框");
  await f.controller.download(file); await f.controller.cancel(nativeRow().id);
  expect(f.deps.prepare).toHaveBeenCalledTimes(1); expect(f.deps.cancelNative).toHaveBeenCalledTimes(1);
  expect(f.controller.canRetry(nativeRow().id)).toBe(false);
  f.event(nativeRow("cancelled"));
  expect(f.controller.getSnapshot()[0]).toMatchObject({ status: "cancelled", received: 0 });
  expect(f.controller.getSnapshot()[0]).not.toHaveProperty("cancelRequested");
  expect(f.controller.getSnapshot()[0].retainedPartial).not.toBe(true);
  expect(f.controller.canRetry(nativeRow().id)).toBe(true);
});
it("keeps immediate cancellation when native preparation has not invoked start", async () => {
  const f = fixture(true), preparation = deferred<typeof descriptor>();
  vi.mocked(f.deps.prepare).mockReturnValue(preparation.promise);
  const pending = f.controller.download(file);
  await vi.waitFor(() => expect(f.deps.prepare).toHaveBeenCalledOnce());
  await f.controller.cancel(f.controller.getSnapshot()[0].id);
  preparation.resolve(descriptor); await pending;
  expect(f.controller.getSnapshot()[0].status).toBe("cancelled");
  expect(f.deps.startNative).not.toHaveBeenCalled();
  expect(f.deps.cancelNative).not.toHaveBeenCalled();
});
it("clears pending cancellation after a rejected native command without asserting a terminal result", async () => {
  const f = fixture(true), acknowledgement = deferred<void>();
  await f.controller.download(file); f.event(nativeRow("running", 3));
  vi.mocked(f.deps.cancelNative).mockReturnValue(acknowledgement.promise);
  const cancel = f.controller.cancel(nativeRow().id);
  expect(f.controller.getSnapshot()[0]).toMatchObject({ status: "running", cancelRequested: true });
  acknowledgement.reject(new Error("http://private-nas?token=secret")); await cancel;
  expect(f.controller.getSnapshot()[0]).toMatchObject({ status: "running", received: 3, message: "取消未成功，请重试" });
  expect(f.controller.getSnapshot()[0].cancelRequested).not.toBe(true);
  expect(JSON.stringify(f.controller.getSnapshot())).not.toMatch(/private-nas|token=secret/);
  f.event(nativeRow("completed", 8)); expect(f.controller.getSnapshot()[0].status).toBe("completed");
});
it("does not leave pending cancellation forever when the delayed native start command rejects", async () => {
  const f = fixture(true), reply = deferred<FileTransfer>();
  vi.mocked(f.deps.startNative).mockReturnValue(reply.promise);
  const pending = f.controller.download(file); await vi.waitFor(() => expect(f.deps.startNative).toHaveBeenCalledOnce());
  await f.controller.cancel(f.controller.getSnapshot()[0].id);
  expect(f.controller.getSnapshot()[0]).toMatchObject({ status: "choosing", cancelRequested: true });
  reply.reject(new Error("http://private-nas?token=secret")); await pending;
  expect(f.controller.getSnapshot()[0]).toMatchObject({ status: "failed", message: "无法确认保存任务结果，请刷新本机任务" });
  expect(f.controller.getSnapshot()[0].cancelRequested).not.toBe(true);
  expect(JSON.stringify(f.controller.getSnapshot())).not.toMatch(/private-nas|token=secret/);
});
