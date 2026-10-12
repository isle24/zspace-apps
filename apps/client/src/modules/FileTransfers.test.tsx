import { afterEach, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FileTransfersProvider, FileTransferTasks, createFileTransfersController, useFileTransfers } from "./FileTransfers";
import { FileTransfersController, type TransferDependencies } from "./file-transfers";
import { NasModule } from "./NasModule";
import { api, type FileTransfer } from "../api/client";
import type { BrowserDownloadResult, BrowserDownloadOptions } from "../api/browser-download";
import { BrowserDownloadError } from "../api/browser-download";
const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), unlisten: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));
const item = { id: "actual-file", name: "实际资料.txt", path: "/actual-file.txt", kind: "file", size: 8, metadata: { private: "never-render-input" } };
function fixture() {
  let options!: BrowserDownloadOptions, finish!: (value: BrowserDownloadResult) => void;
  const deps: TransferDependencies = {
    session: () => "nas-session", native: () => false,
    prepare: vi.fn(async () => ({ id: "a".repeat(64), sessionId: "nas-session", name: item.name, size: 8 })),
    fetch: vi.fn(), deliver: vi.fn(value => { options = value; return new Promise<BrowserDownloadResult>(resolve => { finish = resolve; }); }),
    listen: vi.fn(), startNative: vi.fn(), cancelNative: vi.fn(), nativeTasks: vi.fn(),
  };
  return { controller: new FileTransfersController(deps), deps, options: () => options, finish: () => finish({ received: 8, total: 8, method: "blob", outcome: "handed-to-browser", diskCompletion: "unknown" }) };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("renders only the fixed SDK diagnostic label in the failed task row", async () => {
  const f = fixture();
  const error = Object.assign(new BrowserDownloadError("DELIVERY_FAILED", false), { diagnostic: "DOWNLOAD_DISPOSITION_MISSING", message: "synthetic-private-upstream" });
  vi.mocked(f.deps.deliver).mockRejectedValue(error);
  render(<FileTransfersProvider controller={f.controller}><FileTransferTasks onInstances={() => {}} /></FileTransfersProvider>);
  await act(async () => { await f.controller.download(item, "compatible"); });
  expect(screen.getByText("下载失败")).toBeInTheDocument();
  expect(screen.getByText("浏览器下载未完成；NAS 未提供下载文件名")).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/synthetic-private|DOWNLOAD_DISPOSITION|never-render-input|nas-session|a{64}/);
});
it("downloads the actually selected file and continues when Files closes, then reopens tasks", async () => {
  const f = fixture();
  vi.spyOn(api, "read").mockResolvedValue({ items: [item], total: 1 });
  function Windows({ files, tasks }: {
    files: boolean;
    tasks: boolean;
  }) { return <FileTransfersProvider controller={f.controller}>{files && <NasModule id="files" connected onPlay={() => { }}/>}{tasks && <FileTransferTasks onInstances={() => { }}/>}</FileTransfersProvider>; }
  const view = render(<Windows files tasks={false}/>);
  expect(screen.getByRole("button", { name: "下载到本机" })).toBeDisabled();
  fireEvent.click(await screen.findByRole("button", { name: /实际资料.txt/ }));
  fireEvent.click(screen.getByRole("button", { name: "下载到本机" }));
  await waitFor(() => expect(f.deps.deliver).toHaveBeenCalledOnce());
  expect(f.deps.prepare).toHaveBeenCalledWith(item);
  view.rerender(<Windows files={false} tasks/>);
  act(() => f.options().onProgress?.({ received: 3, total: 8 }));
  expect(screen.getByText("实际资料.txt")).toBeInTheDocument();
  expect(screen.getByRole("progressbar")).toHaveAttribute("value", "3");
  expect(f.options().signal?.aborted).toBe(false);
  view.rerender(<Windows files={false} tasks={false}/>);
  act(() => f.finish());
  await waitFor(() => expect(f.controller.getSnapshot()[0].status).toBe("completed"));
  view.rerender(<Windows files={false} tasks/>);
  expect(screen.getByText("已交给浏览器")).toBeInTheDocument();
  expect(screen.getByText(/请在其中确认保存结果/)).toBeInTheDocument();
  expect(screen.queryByText(/文件已保存/)).not.toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/never-render-input|nas-session|a{64}/);
});
it("offers compatible H5 action with a visible size limit and missing-identity feedback", async () => {
  const f = fixture();
  vi.spyOn(api, "read").mockResolvedValue({ items: [{ ...item, path: undefined }], total: 1 });
  render(<FileTransfersProvider controller={f.controller}><NasModule id="files" connected onPlay={() => { }}/></FileTransfersProvider>);
  fireEvent.click(await screen.findByRole("button", { name: /实际资料.txt/ }));
  expect(screen.getByRole("button", { name: "下载到本机" })).toBeDisabled();
  expect(screen.getByText(/缺少可验证的下载身份/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "兼容下载（最多 64 MiB）" })).toBeDisabled();
  expect(f.deps.prepare).not.toHaveBeenCalled();
});
it("task view shows local NAS transfers without store login and opens independent shop jobs on demand", async () => {
  const f = fixture();
  api.storeSession = "";
  const store = vi.spyOn(api, "store").mockResolvedValue([]);
  render(<FileTransfersProvider controller={f.controller}><FileTransferTasks onInstances={() => { }}/></FileTransfersProvider>);
  expect(screen.getByText("还没有本机下载任务")).toBeInTheDocument();
  expect(store).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "商店安装" }));
  expect(await screen.findByText(/请先登录商店管理员/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "本机下载" })).toBeInTheDocument();
});
it("explicit cancellation is readable and unknown total is not rendered as fabricated progress", async () => {
  const f = fixture();
  vi.mocked(f.deps.prepare).mockResolvedValue({ id: "a".repeat(64), sessionId: "nas-session", name: item.name });
  render(<FileTransfersProvider controller={f.controller}><FileTransferTasks onInstances={() => { }}/></FileTransfersProvider>);
  act(() => { void f.controller.download({ ...item, size: undefined }); });
  await waitFor(() => expect(f.deps.deliver).toHaveBeenCalledOnce());
  act(() => f.options().onProgress?.({ received: 3 }));
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  expect(screen.getByText("3 B · 大小未知")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "取消下载 实际资料.txt" }));
  await screen.findByText("已取消");
  expect(f.options().signal?.aborted).toBe(true);
});
it("default controller installs safe native events and uses only opaque reference commands", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.spyOn(api, "nasSession", "get").mockReturnValue("native-session");
  vi.spyOn(api, "prepareDownload").mockResolvedValue({ id: "a".repeat(64), sessionId: "native-session", name: item.name, size: 8 });
  let listener!: (event: {
    payload: unknown;
  }) => void;
  native.listen.mockImplementation(async (_name, callback) => { listener = callback; return native.unlisten; });
  const row = { id: "b".repeat(64), sessionId: "native-session", name: item.name, received: 0, status: "choosing" };
  native.invoke.mockImplementation(async (command) => command === "nas_download_start" ? row : command === "nas_download_tasks" ? [row] : undefined);
  const controller = createFileTransfersController();
  await controller.download(item);
  expect(native.listen).toHaveBeenCalledWith("nas-download-progress", expect.any(Function));
  expect(native.invoke).toHaveBeenCalledWith("nas_download_start", { reference: "a".repeat(64) });
  act(() => listener({ payload: { ...row, received: 3, status: "running", raw: "http://secret?token=bad" } }));
  expect(controller.getSnapshot()[0].received).toBe(3);
  expect(JSON.stringify(controller.getSnapshot())).not.toMatch(/secret|token|never-render-input/);
  await controller.refresh();
  expect(native.invoke).toHaveBeenCalledWith("nas_download_tasks", { sessionId: "native-session" });
  await controller.cancel(row.id);
  expect(native.invoke).toHaveBeenCalledWith("nas_download_cancel", { taskId: row.id });
  controller.dispose();
  expect(native.unlisten).toHaveBeenCalledOnce();
});
it("pagehide cancels browser work but returning to the same page allows a fresh explicit download", async () => {
  const f = fixture();
  render(<FileTransfersProvider controller={f.controller}><FileTransferTasks onInstances={() => { }}/></FileTransfersProvider>);
  act(() => { void f.controller.download(item); });
  await waitFor(() => expect(f.deps.deliver).toHaveBeenCalledOnce());
  fireEvent(window, new Event("pagehide"));
  expect(f.options().signal?.aborted).toBe(true);
  expect(screen.getByText("已取消")).toBeInTheDocument();
  act(() => { void f.controller.download(item); });
  await waitFor(() => expect(f.deps.prepare).toHaveBeenCalledTimes(2));
});
it("changing the file directory clears the old selected-file download action", async () => {
  const f = fixture();
  vi.spyOn(api, "read").mockImplementation(async (operation) => ({ items: operation === "files.roots" ? [{ id: "root", name: "我的目录", path: "/folder", kind: "directory" }] : [item], total: 1 }));
  render(<FileTransfersProvider controller={f.controller}><NasModule id="files" connected onPlay={() => { }}/></FileTransfersProvider>);
  fireEvent.click(await screen.findByRole("button", { name: /我的目录文件夹/ }));
  fireEvent.click(await screen.findByRole("button", { name: /实际资料.txt/ }));
  expect(screen.getByRole("button", { name: "下载到本机" })).not.toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "返回上一级" }));
  await screen.findByRole("button", { name: /我的目录文件夹/ });
  expect(screen.getByRole("button", { name: "下载到本机" })).toBeDisabled();
});
it("StrictMode replay preserves the owned controller while the app remains mounted", async () => {
  vi.spyOn(api, "nasSession", "get").mockReturnValue("nas-session");
  const prepare = vi.spyOn(api, "prepareDownload").mockRejectedValue(new Error("synthetic preparation failure"));
  let controller!: FileTransfersController;
  function Probe() { controller = useFileTransfers()!; return null; }
  render(<StrictMode><FileTransfersProvider><Probe /><FileTransferTasks onInstances={() => {}} /></FileTransfersProvider></StrictMode>);
  await act(async () => {});
  await act(async () => { await controller.download(item); });
  expect(prepare).toHaveBeenCalledOnce();
  expect(screen.getByText("下载失败")).toBeInTheDocument();
});
it("reports native task snapshot failure without claiming an empty task list or exposing raw errors", async () => {
  const f = fixture(); f.deps.native = () => true;
  vi.mocked(f.deps.listen).mockResolvedValue(() => {});
  vi.mocked(f.deps.nativeTasks).mockRejectedValue(new Error("http://private-nas?token=secret"));
  render(<FileTransfersProvider controller={f.controller}><FileTransferTasks onInstances={() => {}} /></FileTransfersProvider>);
  expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法读取本机下载任务");
  expect(screen.queryByText("还没有本机下载任务")).not.toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/private-nas|token=secret/);
});
it.each(["completed", "cancelled"] as const)("keeps native cancel pending until the authoritative %s event", async terminal => {
  const f = fixture(); f.deps.native = () => true;
  const row = { id: "b".repeat(64), sessionId: "nas-session", name: item.name, received: 0, total: 8, status: "choosing" as const };
  let event!: (value: FileTransfer) => void;
  vi.mocked(f.deps.listen).mockImplementation(async callback => { event = callback; return () => {}; });
  vi.mocked(f.deps.startNative).mockResolvedValue(row); vi.mocked(f.deps.cancelNative).mockResolvedValue(); vi.mocked(f.deps.nativeTasks).mockResolvedValue([]);
  render(<FileTransfersProvider controller={f.controller}><FileTransferTasks onInstances={() => {}} /></FileTransfersProvider>);
  await act(async () => { await f.controller.download(item); });
  act(() => event({ ...row, status: "running", received: 3 }));
  fireEvent.click(screen.getByRole("button", { name: "取消下载 实际资料.txt" }));
  await waitFor(() => expect(f.deps.cancelNative).toHaveBeenCalledOnce());
  expect(screen.getByText("正在取消")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "取消下载 实际资料.txt" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "重新下载 实际资料.txt" })).not.toBeInTheDocument();
  expect(screen.queryByText("已取消")).not.toBeInTheDocument();
  act(() => event({ ...row, status: terminal, received: terminal === "completed" ? 8 : 3, ...(terminal === "cancelled" ? { retainedPartial: true } : {}) }));
  expect(screen.getByText(terminal === "completed" ? "已保存" : "已取消")).toBeInTheDocument();
  expect(screen.queryByText("正在取消")).not.toBeInTheDocument();
  if (terminal === "completed") expect(screen.queryByRole("button", { name: "重新下载 实际资料.txt" })).not.toBeInTheDocument();
  else expect(screen.getByText(/新建的不完整文件已保留/)).toBeInTheDocument();
});
it("asks for native save-dialog dismissal while cancellation is pending, then settles on its cancellation callback", async () => {
  const f = fixture(); f.deps.native = () => true;
  const row = { id: "c".repeat(64), sessionId: "nas-session", name: item.name, received: 0, status: "choosing" as const };
  let event!: (value: FileTransfer) => void;
  vi.mocked(f.deps.listen).mockImplementation(async callback => { event = callback; return () => {}; });
  vi.mocked(f.deps.startNative).mockResolvedValue(row); vi.mocked(f.deps.cancelNative).mockResolvedValue(); vi.mocked(f.deps.nativeTasks).mockResolvedValue([]);
  render(<FileTransfersProvider controller={f.controller}><FileTransferTasks onInstances={() => {}} /></FileTransfersProvider>);
  await act(async () => { await f.controller.download(item); });
  fireEvent.click(screen.getByRole("button", { name: "取消下载 实际资料.txt" }));
  expect(await screen.findByText(/请关闭保存对话框/)).toBeInTheDocument(); expect(screen.getByText("正在取消")).toBeInTheDocument();
  act(() => event({ ...row, status: "cancelled" }));
  expect(screen.getByText("已取消")).toBeInTheDocument(); expect(screen.queryByText(/请关闭保存对话框/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "重新下载 实际资料.txt" })).toBeInTheDocument();
});
