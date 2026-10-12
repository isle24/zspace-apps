import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NasModule } from "./NasModule";
import { Files, dedupeByPath } from "./Files";
import { api, type Collection, type Item } from "../api/client";
import { FileTransfersProvider, FileTransferTasks } from "./FileTransfers";
import { FileTransfersController, type TransferDependencies } from "./file-transfers";
import type { BrowserDownloadOptions, BrowserDownloadResult } from "../api/browser-download";
import { DataValues } from "./common";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { OfficialNasError } from "../api/official-nas";
import type { DirectoryCreation } from "../api/client";
import { installMissingDialogMethods } from "./directory-dialog-test";
import { readFileSync } from "node:fs";

installMissingDialogMethods();

const directory: Item = { id: "storage", name: "家庭资料", path: "/actual/storage 家庭", kind: "directory" };
const file: Item = { id: "returned-id", name: "中文资料.png", path: "E.actual-returned-file", kind: "file", size: 8, metadata: { name: "中文资料.png", encrypted_path: "E.actual-returned-file", from: "search" } };
const collection = (items: Item[], total = items.length): Collection => ({ items, total });
function files() { return <NasModule id="files" connected onPlay={() => {}} />; }
function search(name: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "搜索文件名称" }), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
}
function normalReads() {
  return vi.spyOn(api, "read").mockImplementation(async (operation, params = {}) => {
    if (operation === "files.roots") return collection([directory]);
    if (operation === "files.info") return { items: [], values: { name: file.name, path: file.path, size: file.size, is_dir: false } };
    if (operation === "files.search") return collection([{ ...file, name: `${params.name}第${params.page}页.png` }], 42);
    return collection([{ id: "browse", name: "目录内文件.txt", kind: "file", path: "/returned/browse.txt" }], 21);
  });
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("retains a real row clicked at its first DOM commit through passive effects and passes its Item to a download that outlives Files", async () => {
  const immediate: Item = { id: "immediate", name: "即时选择.txt", path: "/returned/immediate.txt", kind: "file", size: 8, metadata: { name: "即时选择.txt", is_dir: 0 } };
  let complete!: (value: Collection) => void, started!: () => void;
  const listStarted = new Promise<void>(resolve => { started = resolve; });
  vi.spyOn(api, "read").mockImplementation(async operation => {
    if (operation === "files.roots") return collection([directory]);
    if (operation === "files.list") return new Promise<Collection>(resolve => { complete = resolve; started(); });
    return { items: [], values: { name: immediate.name, path: immediate.path } };
  });
  let options!: BrowserDownloadOptions, finish!: (value: BrowserDownloadResult) => void;
  const deps: TransferDependencies = { session: () => "synthetic-session", native: () => false, prepare: vi.fn(async () => ({ id: "a".repeat(64), sessionId: "synthetic-session", name: immediate.name, size: immediate.size })), fetch: vi.fn(), deliver: vi.fn(value => { options = value; return new Promise<BrowserDownloadResult>(resolve => { finish = resolve; }); }), listen: vi.fn(), startNative: vi.fn(), cancelNative: vi.fn(), nativeTasks: vi.fn() };
  const controller = new FileTransfersController(deps);
  function Windows({ showFiles }: { showFiles: boolean }) { return <FileTransfersProvider controller={controller}>{showFiles ? files() : <FileTransferTasks onInstances={() => {}} />}</FileTransfersProvider>; }
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let clicked!: () => void;
  const firstCommitClick = new Promise<void>(resolve => { clicked = resolve; });
  let opened = false, selected = false;
  const observer = new MutationObserver(() => {
    const rows = Array.from(host.querySelectorAll<HTMLButtonElement>(".file-row"));
    const folder = rows.find(row => row.textContent?.includes(directory.name));
    if (!opened && folder) { opened = true; folder.click(); }
    const row = rows.find(value => value.textContent?.includes(immediate.name));
    if (!selected && row) { selected = true; row.click(); clicked(); }
  });
  // Keep the actual commit/click outside act: act would flush the pending effect
  // before the MutationObserver gets its chance, concealing the ordering defect.
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
  observer.observe(host, { childList: true, subtree: true });
  try {
    flushSync(() => root.render(<Windows showFiles />));
    await listStarted;
    complete(collection([immediate]));
    await firstCommitClick;
    observer.disconnect();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => {});
    expect(within(host).getByRole("button", { name: "收起详情" })).toBeInTheDocument();
    expect(within(host).getByRole("button", { name: "下载到本机" })).toBeEnabled();
    await act(async () => { within(host).getByRole("button", { name: "下载到本机" }).click(); });
    expect(deps.prepare).toHaveBeenCalledWith(immediate);
    expect(deps.deliver).toHaveBeenCalledOnce();
    await act(async () => { root.render(<Windows showFiles={false} />); });
    expect(options.signal?.aborted).toBe(false);
    act(() => options.onProgress?.({ received: 4, total: 8 }));
    expect(within(host).getByRole("progressbar")).toHaveAttribute("value", "4");
    await act(async () => { finish({ received: 8, total: 8, method: "blob", outcome: "handed-to-browser", diskCompletion: "unknown" }); });
    expect(within(host).getByText("已交给浏览器")).toBeInTheDocument();
  } finally {
    observer.disconnect();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => root.unmount());
    host.remove();
  }
});

it("deduplicates repeated activation of the actual current directory before pending readback, then preserves child and back navigation", async () => {
  const child: Item = { id: "actual-child", name: "子文件夹", path: directory.path + "/actual-child", kind: "directory" };
  let complete!: (value: Collection) => void, started!: () => void, repeated!: () => void;
  const listStarted = new Promise<void>(resolve => { started = resolve; });
  const repeatedClick = new Promise<void>(resolve => { repeated = resolve; });
  const read = vi.spyOn(api, "read").mockImplementation(async (operation, params = {}) => {
    if (operation === "files.roots") return collection([directory]);
    if (params.path === child.path) return collection([{ ...file, name: "子目录内文件.txt" }]);
    return new Promise<Collection>(resolve => { complete = resolve; started(); });
  });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let opened = false, clickedAgain = false;
  const observer = new MutationObserver(() => {
    const row = Array.from(host.querySelectorAll<HTMLButtonElement>(".file-row")).find(value => value.textContent?.includes(directory.name));
    if (!opened && row) { opened = true; row.click(); return; }
    // Pool locations stay available after navigation commits, allowing another
    // activation while directory readback is pending.
    const location = host.querySelector<HTMLButtonElement>('[aria-label="打开存储池：家庭资料"]');
    if (!clickedAgain && location && host.querySelector(".crumb")) { clickedAgain = true; location.click(); repeated(); }
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
  observer.observe(host, { childList: true, subtree: true });
  try {
    flushSync(() => root.render(files()));
    await repeatedClick;
    await listStarted;
    observer.disconnect();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => {});
    const trail = () => Array.from(host.querySelectorAll(".crumb button")).map(button => button.textContent);
    expect(trail()).toEqual([directory.name]);
    expect(read.mock.calls.filter(([operation]) => operation === "files.list")).toEqual([["files.list", { path: directory.path, page: 1, pageSize: 20 }]]);
    await act(async () => { complete(collection([child])); });
    fireEvent.click(await within(host).findByRole("button", { name: /子文件夹文件夹/ }));
    await within(host).findByText("子目录内文件.txt");
    expect(trail()).toEqual([directory.name, child.name]);
    expect(read).toHaveBeenLastCalledWith("files.list", { path: child.path, page: 1, pageSize: 20 });
    fireEvent.click(within(host).getByRole("button", { name: "返回上一级" }));
    await waitFor(() => expect(read).toHaveBeenLastCalledWith("files.list", { path: directory.path, page: 1, pageSize: 20 }));
    await act(async () => { complete(collection([child])); });
    expect(trail()).toEqual([directory.name]);
    fireEvent.click(within(host).getByRole("button", { name: "返回上一级" }));
    await within(host).findByRole("button", { name: /家庭资料文件夹/ });
    expect(trail()).toEqual([]);
    expect(read.mock.calls.filter(([operation]) => operation === "files.roots")).toHaveLength(1);
  } finally {
    observer.disconnect();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => root.unmount());
    host.remove();
  }
});


it("deduplicates the same actual path even when a returned directory row has a different id", async () => {
  const alias = { ...directory, id: "another-returned-id", name: "当前目录返回项" };
  const read = vi.spyOn(api, "read").mockImplementation(async operation => operation === "files.roots" ? collection([directory]) : collection([alias]));
  const view = render(files());
  fireEvent.click(await screen.findByRole("button", { name: /家庭资料文件夹/ }));
  fireEvent.click(await screen.findByRole("button", { name: /当前目录返回项文件夹/ }));
  expect(Array.from(view.container.querySelectorAll(".crumb button")).map(button => button.textContent)).toEqual([directory.name]);
  expect(read.mock.calls.filter(([operation]) => operation === "files.list")).toHaveLength(1);
  expect(read).toHaveBeenLastCalledWith("files.list", { path: directory.path, page: 1, pageSize: 20 });
});

it("renders normalized search names as escaped text and passes the selected plain file to the existing download action", async () => {
  const plain: Item = { id: "/actual/authoritative.txt", path: "/actual/authoritative.txt", name: "<img src=x>报告.txt", kind: "file", size: 17, metadata: { path: "/actual/authoritative.txt", name: "<img src=x>报告.txt", is_dir: false } };
  vi.spyOn(api, "nasSession", "get").mockReturnValue("synthetic-session");
  const read = vi.spyOn(api, "read").mockImplementation(async operation => operation === "files.roots" ? collection([directory]) : operation === "files.info" ? { items: [], values: { name: plain.name, path: plain.path } } : collection([plain]));
  const deps: TransferDependencies = { session: () => "synthetic-session", native: () => false, prepare: vi.fn(async () => ({ id: "b".repeat(64), name: plain.name, size: plain.size, sessionId: "synthetic-session" })), fetch: vi.fn(), deliver: vi.fn(async (): Promise<BrowserDownloadResult> => ({ received: 17, total: 17, method: "blob", outcome: "handed-to-browser", diskCompletion: "unknown" })), listen: vi.fn(), startNative: vi.fn(), cancelNative: vi.fn(), nativeTasks: vi.fn() };
  const view = render(<FileTransfersProvider controller={new FileTransfersController(deps)}>{files()}</FileTransfersProvider>);
  await screen.findByRole("button", { name: /家庭资料文件夹/ });
  search("报告");
  fireEvent.click(await screen.findByRole("button", { name: /<img src=x>报告.txt/ }));
  await waitFor(() => expect(read).toHaveBeenLastCalledWith("files.info", { path: plain.path }));
  expect(view.container.querySelector("img[src=x]")).toBeNull();
  expect(screen.getByRole("heading", { name: plain.name })).toHaveTextContent(plain.name);
  const download = screen.getByRole("button", { name: "下载到本机" });
  expect(download).toBeEnabled();
  fireEvent.click(download);
  await waitFor(() => expect(deps.deliver).toHaveBeenCalledOnce());
  expect(deps.prepare).toHaveBeenCalledWith(plain);
});


it("submits indexed name search only explicitly, uses server pages at root, and keeps an active query while typing", async () => {
  const read = normalReads();
  render(files());
  await screen.findByRole("button", { name: /家庭资料文件夹/ });
  expect(screen.queryByRole("option", { name: "当前文件夹" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "搜索文件名称" }), { target: { value: " 中文 " } });
  expect(read.mock.calls.filter(([operation]) => operation === "files.search")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  await screen.findByText("中文第1页.png");
  expect(read).toHaveBeenLastCalledWith("files.search", { name: "中文", page: 1, pageSize: 20 });
  expect(screen.getByText(/全部可访问文件.*中文/)).toBeInTheDocument();
  expect(screen.getByText(/仅搜索.*索引.*外接设备.*回收站.*快照/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /中文第1页.png/ }));
  await waitFor(() => expect(read).toHaveBeenLastCalledWith("files.info", { path: file.path }));
  const calls = read.mock.calls.length;
  fireEvent.change(screen.getByRole("textbox", { name: "搜索文件名称" }), { target: { value: "新草稿" } });
  expect(read).toHaveBeenCalledTimes(calls);
  expect(screen.getByRole("button", { name: "收起详情" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByText("中文第2页.png");
  expect(read).toHaveBeenLastCalledWith("files.search", { name: "中文", page: 2, pageSize: 20 });
  expect(screen.queryByRole("button", { name: "收起详情" })).not.toBeInTheDocument();
  expect(screen.getByText(/第 2 页 \/ 3 页.*共 42 项/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  await screen.findByText("新草稿第1页.png");
  expect(read).toHaveBeenLastCalledWith("files.search", { name: "新草稿", page: 1, pageSize: 20 });
});

it("invalidates an old selection when refreshing the collection even if the returned file identity stays the same", async () => {
  const textFile: Item = { id: "same-identity", name: "刷新资料.txt", path: "/returned/same.txt", kind: "file" };
  let finishRefresh!: (value: Collection) => void;
  let reads = 0;
  vi.spyOn(api, "read").mockImplementation(async operation => {
    if (operation === "files.info") return { items: [], values: { name: textFile.name } };
    if (++reads === 1) return collection([textFile]);
    return new Promise<Collection>(resolve => { finishRefresh = resolve; });
  });
  render(files());
  fireEvent.click(await screen.findByRole("button", { name: /刷新资料.txt/ }));
  await screen.findByRole("button", { name: "收起详情" });
  fireEvent.click(screen.getByRole("button", { name: "刷新文件" }));
  expect(screen.queryByRole("button", { name: "收起详情" })).not.toBeInTheDocument();
  await act(async () => { finishRefresh(collection([textFile])); });
  expect(screen.getByRole("button", { name: /刷新资料.txt/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "收起详情" })).not.toBeInTheDocument();
});

it("searches an actual directory or all accessible indexed files and clears back to that directory page one", async () => {
  const read = normalReads(); render(files());
  fireEvent.click(await screen.findByRole("button", { name: /家庭资料文件夹/ }));
  await screen.findByText("目录内文件.txt");
  search("报告");
  await screen.findByText("报告第1页.png");
  expect(read).toHaveBeenLastCalledWith("files.search", { name: "报告", path: directory.path, page: 1, pageSize: 20 });
  fireEvent.click(screen.getByRole("button", { name: "下一页" })); await screen.findByText("报告第2页.png");
  fireEvent.click(screen.getByRole("button", { name: /报告第2页.png/ }));
  await screen.findByRole("button", { name: "收起详情" });
  fireEvent.change(screen.getByRole("combobox", { name: "搜索范围" }), { target: { value: "all" } });
  await screen.findByText("报告第1页.png");
  expect(read).toHaveBeenLastCalledWith("files.search", { name: "报告", page: 1, pageSize: 20 });
  expect(screen.queryByRole("button", { name: "收起详情" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));
  await screen.findByText("目录内文件.txt");
  expect(read).toHaveBeenLastCalledWith("files.list", { path: directory.path, page: 1, pageSize: 20 });
  expect(screen.getByRole("heading", { name: directory.name })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "搜索文件名称" })).toHaveValue("");
});

it("opens a folder result using its returned opaque path, exits search and resets pagination", async () => {
  const result = { id: "opaque-folder-id", name: "展示名称不能拼接", kind: "directory", path: "E.returned-folder" };
  const read = vi.spyOn(api, "read").mockImplementation(async (operation) => operation === "files.search" ? collection([result], 42) : operation === "files.roots" ? collection([directory]) : collection([file]));
  render(files()); await screen.findByRole("button", { name: /家庭资料文件夹/ }); search("目录");
  fireEvent.click(await screen.findByRole("button", { name: /展示名称不能拼接/ }));
  await waitFor(() => expect(read).toHaveBeenLastCalledWith("files.list", { path: result.path, page: 1, pageSize: 20 }));
  expect(screen.queryByRole("button", { name: "清除搜索" })).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "搜索文件名称" })).toHaveValue("");
});

it.each(["current", "all"])("replaces the old navigation trail with the actual %s search folder result, while ordinary browsing appends known children", async scope => {
  const child: Item = { id: "child", name: "报告目录", path: "/actual/storage 家庭/returned-child", kind: "directory" };
  const read = vi.spyOn(api, "read").mockImplementation(async (operation, params = {}) => {
    if (operation === "files.roots") return collection([directory]);
    if (operation === "files.search") return collection([child], 42);
    if (operation === "files.list" && params.path === directory.path) return collection([child]);
    return collection([{ ...file, name: "目录内文件.txt" }]);
  });
  const view = render(files());
  fireEvent.click(await screen.findByRole("button", { name: /家庭资料文件夹/ }));
  fireEvent.click(await screen.findByRole("button", { name: /报告目录/ }));
  await screen.findByText("目录内文件.txt");
  const trail = () => Array.from(view.container.querySelectorAll(".crumb button")).map(button => button.textContent);
  expect(trail()).toEqual([directory.name, child.name]);
  if (scope === "all") fireEvent.change(screen.getByRole("combobox", { name: "搜索范围" }), { target: { value: "all" } });
  search("报告目录");
  await screen.findByRole("button", { name: /报告目录文件夹/ });
  expect(read).toHaveBeenLastCalledWith("files.search", { name: "报告目录", ...(scope === "current" ? { path: child.path } : {}), page: 1, pageSize: 20 });
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await waitFor(() => expect(read).toHaveBeenLastCalledWith("files.search", { name: "报告目录", ...(scope === "current" ? { path: child.path } : {}), page: 2, pageSize: 20 }));
  fireEvent.click(await screen.findByRole("button", { name: /报告目录文件夹/ }));
  await screen.findByText("目录内文件.txt");
  expect(read).toHaveBeenLastCalledWith("files.list", { path: child.path, page: 1, pageSize: 20 });
  expect(trail()).toEqual([child.name]);
  expect(screen.queryByRole("button", { name: "清除搜索" })).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "搜索文件名称" })).toHaveValue("");
  expect(within(view.container.querySelector(".toolbar") as HTMLElement).getAllByRole("button", { name: child.name })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "返回上一级" }));
  await screen.findByRole("button", { name: /家庭资料文件夹/ });
  expect(read.mock.calls.filter(([operation]) => operation === "files.roots")).toHaveLength(1);
  expect(trail()).toEqual([]);
});

it("resubmits the same query as a fresh server read and shows a failed search without sample results", async () => {
  const read = normalReads(); render(files()); await screen.findByRole("button", { name: /家庭资料文件夹/ });
  search("重试"); await screen.findByText("重试第1页.png");
  const searches = () => read.mock.calls.filter(([operation]) => operation === "files.search");
  expect(searches()).toHaveLength(1);
  read.mockImplementation(async operation => {
    if (operation === "files.search") throw new Error("暂时无法搜索，请重试");
    return collection([directory]);
  });
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法搜索，请重试");
  expect(searches()).toHaveLength(2);
  expect(screen.queryByText("重试第1页.png")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));
  await screen.findByRole("button", { name: /家庭资料文件夹/ });
  expect(read.mock.calls.filter(([operation]) => operation === "files.roots")).toHaveLength(1);
});

it.each(["query", "clear", "directory", "scope", "session"])("rejects late search results after %s changes", async change => {
  let complete!: (value: Collection) => void;
  let session = "session-one";
  vi.spyOn(api, "nasSession", "get").mockImplementation(() => session);
  const read = vi.spyOn(api, "read").mockImplementation(async (operation, params = {}) => {
    if (operation === "files.search" && params.name === "旧查询" && (change !== "scope" || params.path)) return new Promise(resolve => { complete = resolve; });
    if (operation === "files.roots") return collection([directory]);
    if (operation === "files.search") return collection([{ ...file, name: "新搜索结果.txt" }]);
    return collection([{ ...file, name: "当前目录结果.txt" }]);
  });
  const view = render(files());
  fireEvent.click(await screen.findByRole("button", { name: /家庭资料文件夹/ }));
  await screen.findByText("当前目录结果.txt");
  search("旧查询");
  await waitFor(() => expect(complete).toBeTypeOf("function"));
  if (change === "query") search("新查询");
  if (change === "clear") fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));
  if (change === "directory") fireEvent.click(screen.getByRole("button", { name: "返回上一级" }));
  if (change === "scope") fireEvent.change(screen.getByRole("combobox", { name: "搜索范围" }), { target: { value: "all" } });
  if (change === "session") { session = "session-two"; view.rerender(files()); }
  if (change === "directory" || change === "session") await screen.findByRole("button", { name: /家庭资料文件夹/ });
  else await screen.findByText(change === "query" || change === "scope" ? "新搜索结果.txt" : "当前目录结果.txt");
  await act(async () => { complete(collection([{ ...file, name: "过期结果不得出现.txt" }])); });
  expect(screen.queryByText("过期结果不得出现.txt")).not.toBeInTheDocument();
  if (change === "session") {
    expect(read).toHaveBeenLastCalledWith("files.roots", {});
    expect(screen.getByRole("textbox", { name: "搜索文件名称" })).toHaveValue("");
    expect(screen.queryByRole("button", { name: "清除搜索" })).not.toBeInTheDocument();
  }
});

it("keeps recent access as labelled local page filtering and requests a real recent page two", async () => {
  const read = vi.spyOn(api, "read").mockImplementation(async (operation, params = {}) => operation === "files.roots" ? collection([directory]) : collection([{ ...file, name: `最近匹配第${params.page}页.txt` }, { ...file, id: "other", name: "其他文件.txt" }], 42));
  render(files()); fireEvent.click(screen.getByRole("button", { name: "最近访问" }));
  await screen.findByText("最近匹配第1页.txt");
  const calls = read.mock.calls.length;
  fireEvent.change(screen.getByRole("textbox", { name: "筛选本页名称" }), { target: { value: "匹配" } });
  expect(screen.queryByText("其他文件.txt")).not.toBeInTheDocument();
  expect(read).toHaveBeenCalledTimes(calls);
  expect(screen.getByText(/仅筛选最近访问的当前页/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "搜索" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByText("最近匹配第2页.txt");
  expect(read).toHaveBeenLastCalledWith("files.recent", { page: 2, pageSize: 20 });
  expect(read.mock.calls.some(([operation]) => operation === "files.search")).toBe(false);
});

it("passes the actual selected search Item to preview and global download, which survives closing Files", async () => {
  vi.spyOn(api, "nasSession", "get").mockReturnValue("synthetic-session");
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.spyOn(api, "read").mockImplementation(async operation => operation === "files.roots" ? collection([directory]) : operation === "files.info" ? { items: [], values: { name: file.name } } : collection([file]));
  const preview = vi.spyOn(api, "imagePreview").mockResolvedValue("nas-media://opaque-image");
  let options!: BrowserDownloadOptions, finish!: (result: BrowserDownloadResult) => void;
  const deps: TransferDependencies = { session: () => "synthetic-session", native: () => false, prepare: vi.fn(async () => ({ id: "a".repeat(64), sessionId: "synthetic-session", name: file.name, size: 8 })), fetch: vi.fn(), deliver: vi.fn(value => { options = value; return new Promise<BrowserDownloadResult>(resolve => { finish = resolve; }); }), listen: vi.fn(), startNative: vi.fn(), cancelNative: vi.fn(), nativeTasks: vi.fn() };
  const controller = new FileTransfersController(deps);
  function Windows({ showFiles }: { showFiles: boolean }) { return <FileTransfersProvider controller={controller}>{showFiles ? files() : <FileTransferTasks onInstances={() => {}} />}</FileTransfersProvider>; }
  const view = render(<Windows showFiles />); await screen.findByRole("button", { name: /家庭资料文件夹/ });
  search("中文"); fireEvent.click(await screen.findByRole("button", { name: /中文资料.png/ }));
  const image = await screen.findByRole("img", { name: file.name });
  expect(image).toHaveAttribute("src", "nas-media://opaque-image");
  expect(preview).toHaveBeenCalledWith(file);
  fireEvent.load(image);
  fireEvent.click(screen.getByRole("button", { name: "下载到本机" }));
  await waitFor(() => expect(deps.deliver).toHaveBeenCalledOnce());
  expect(deps.prepare).toHaveBeenCalledWith(file);
  view.rerender(<Windows showFiles={false} />);
  expect(options.signal?.aborted).toBe(false);
  act(() => options.onProgress?.({ received: 4, total: 8 }));
  expect(screen.getByRole("progressbar")).toHaveAttribute("value", "4");
  await act(async () => { finish({ received: 8, total: 8, method: "blob", outcome: "handed-to-browser", diskCompletion: "unknown" }); });
  expect(await screen.findByText("已交给浏览器")).toBeInTheDocument();
});

it("presents known file information in its own context without changing device labels or rendering unknown metadata", async () => {
  vi.spyOn(api, "read").mockImplementation(async operation => operation === "files.info" ? { items: [], values: { name: "资料.txt", path: "E.actual", size: 2048, is_dir: 0, file_count: 2, unknown_debug: { raw: "internal-detail" } } } : collection([{ ...file, name: "资料.txt" }]));
  render(<>{files()}<DataValues data={{ name: "设备甲", version: "1.0" }} /></>);
  fireEvent.click(await screen.findByRole("button", { name: /资料.txt/ }));
  await screen.findByText("文件名称");
  expect(screen.getByText("文件路径")).toBeInTheDocument();
  expect(screen.getByText("文件大小")).toBeInTheDocument();
  expect(screen.getByText("2.0 KB")).toBeInTheDocument();
  expect(screen.getByText("文件数量")).toBeInTheDocument();
  expect(screen.getByText("设备名称")).toBeInTheDocument();
  expect(screen.getByText("系统版本")).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/unknown_debug|internal-detail|\bfile\b|is_dir/);
});

async function openDirectoryCreate(parent: Item = directory) {
  vi.spyOn(api, "nasSession", "get").mockReturnValue("directory-session");
  const read = vi.spyOn(api, "read").mockImplementation(async operation => operation === "files.roots" ? collection([parent]) : collection([]));
  const view = render(files());
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(parent.name + (parent.kind === "root" ? "存储空间" : "文件夹")) }));
  await waitFor(() => expect(read).toHaveBeenLastCalledWith("files.list", { path: parent.path, page: 1, pageSize: 20 }));
  return { view, read };
}
function submitDirectory(name = " 中文 资料 ") {
  fireEvent.click(screen.getByRole("button", { name: "新建文件夹" }));
  fireEvent.change(screen.getByRole("textbox", { name: "文件夹名称" }), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "确认新建" }));
}
const readyDirectory = (sessionId = "directory-session"): DirectoryCreation => ({
  sessionId, outcome: "directory-ready", item: { id: "/verified/child", name: " 中文 资料 ", path: `${directory.path}/ 中文 资料 `, kind: "directory", metadata: { is_dir: true } },
});

it("offers disabled creation with honest feedback in virtual roots, recent access and disconnected views", async () => {
  const create = vi.spyOn(api, "createDirectory");
  normalReads();
  const view = render(files());
  expect(screen.getByRole("button", { name: "新建文件夹" })).toBeDisabled();
  expect(screen.getByText("请先打开一个普通文件夹后再新建。" )).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "最近访问" }));
  expect(screen.getByRole("button", { name: "新建文件夹" })).toBeDisabled();
  expect(screen.getByText("最近访问不能作为新建位置，请先打开一个普通文件夹。" )).toBeInTheDocument();
  view.rerender(<NasModule id="files" connected={false} onPlay={() => {}} />);
  expect(screen.getByText("请先连接 NAS 后再新建。" )).toBeInTheDocument();
  expect(create).not.toHaveBeenCalled();
});

it.each([
  { ...directory, path: "E.encrypted-parent" },
  { ...directory, metadata: { encrypted_path: "E.encrypted-parent" } },
  { ...directory, path: "/ordinary/../unsupported" },
])("disables creation for encrypted or unsupported actual parent %j", async parent => {
  await openDirectoryCreate(parent);
  expect(screen.getByRole("button", { name: "新建文件夹" })).toBeDisabled();
  expect(screen.getByText("此位置不支持新建，请打开一个普通文件夹。" )).toBeInTheDocument();
});

it.each(["directory", "root"])("uses actual %s parent and unchanged name, prevents duplicate dispatch and refreshes verified readiness", async kind => {
  let complete!: (value: DirectoryCreation) => void;
  const create = vi.spyOn(api, "createDirectory").mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const parent = { ...directory, kind, ...(kind === "root" ? { path: "/" } : {}) };
  const { read } = await openDirectoryCreate(parent);
  fireEvent.click(screen.getByRole("button", { name: "新建文件夹" }));
  const dialog = screen.getByRole("dialog", { name: "新建文件夹" });
  expect(within(dialog).getByText(parent.name)).toBeInTheDocument();
  expect(within(dialog).getByText(parent.path!)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "确认新建" })).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox", { name: "文件夹名称" }), { target: { value: " 中文 资料 " } });
  fireEvent.submit(dialog.querySelector("form")!);
  fireEvent.submit(dialog.querySelector("form")!);
  expect(create).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledWith(parent, " 中文 资料 ", { signal: expect.any(AbortSignal) });
  expect(screen.getByRole("button", { name: "处理中…" })).toBeDisabled();
  expect(screen.getByRole("textbox", { name: "文件夹名称" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "新建文件夹" })).toBeDisabled();
  const listCalls = read.mock.calls.length;
  await act(async () => { complete(readyDirectory()); });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByText("文件夹已就绪" )).toBeInTheDocument();
  await waitFor(() => expect(read).toHaveBeenCalledTimes(listCalls + 1));
  expect(read).toHaveBeenLastCalledWith("files.list", { path: parent.path, page: 1, pageSize: 20 });
});

it.each([
  [new OfficialNasError("untrusted-token-from-error", "DIRECTORY_CONFLICT", 409), "同名文件夹已存在，请刷新查看。"],
  [new OfficialNasError("untrusted-token-from-error", "DIRECTORY_UNVERIFIED", 502, true), "请求已中断，文件夹可能已创建，请先刷新查看。"],
  [new Error("untrusted-token-from-error"), "文件夹请求未完成，请检查连接后重试。"],
  [new OfficialNasError("untrusted-token-from-error", "INVALID_DIRECTORY_NAME", 400), "请输入有效的文件夹名称（最多 255 字节）。"],
])("shows safe static failure feedback without automatic writes for %j", async (error, feedback) => {
  const create = vi.spyOn(api, "createDirectory").mockRejectedValue(error);
  const { read } = await openDirectoryCreate();
  const calls = read.mock.calls.length;
  submitDirectory();
  expect(await screen.findByRole("alert")).toHaveTextContent(feedback as string);
  expect(document.body.textContent).not.toContain("untrusted-token-from-error");
  expect(screen.queryByText("文件夹已就绪")).not.toBeInTheDocument();
  expect(create).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledTimes(calls);
  if (error instanceof OfficialNasError && error.mayHaveCreated) {
    expect(screen.queryByRole("button", { name: "确认新建" })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "刷新查看" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(calls + 1));
    expect(create).toHaveBeenCalledOnce();
  }
  if (error instanceof OfficialNasError && error.code === "DIRECTORY_CONFLICT") {
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "刷新查看" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(calls + 1));
    expect(create).toHaveBeenCalledOnce();
  }
});

it.each(["cancel", "escape"])("aborts a pending request on %s and ignores even a later successful completion", async cancel => {
  let complete!: (value: DirectoryCreation) => void;
  const create = vi.spyOn(api, "createDirectory").mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const { read } = await openDirectoryCreate();
  submitDirectory();
  const signal = create.mock.calls[0][2]?.signal;
  if (cancel === "cancel") fireEvent.click(screen.getByRole("button", { name: "取消" }));
  else fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(signal?.aborted).toBe(true);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByText("请求已中断，文件夹可能已创建，请先刷新查看。" )).toBeInTheDocument();
  const calls = read.mock.calls.length;
  await act(async () => { complete(readyDirectory()); });
  expect(read).toHaveBeenCalledTimes(calls);
  expect(screen.queryByText("文件夹已就绪")).not.toBeInTheDocument();
});

it.each(["parent", "session", "disconnect", "unmount"])("aborts and rejects stale completion after %s changes", async change => {
  let complete!: (value: DirectoryCreation) => void;
  const create = vi.spyOn(api, "createDirectory").mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const { view, read } = await openDirectoryCreate();
  submitDirectory();
  const signal = create.mock.calls[0][2]?.signal;
  if (change === "parent") fireEvent.click(screen.getByRole("button", { name: "返回上一级" }));
  if (change === "session") { vi.spyOn(api, "nasSession", "get").mockReturnValue("replacement-session"); view.rerender(files()); }
  if (change === "disconnect") view.rerender(<NasModule id="files" connected={false} onPlay={() => {}} />);
  if (change === "unmount") view.unmount();
  expect(signal?.aborted).toBe(true);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  const calls = read.mock.calls.length;
  await act(async () => { complete(readyDirectory()); });
  expect(read).toHaveBeenCalledTimes(calls);
  expect(screen.queryByText("文件夹已就绪")).not.toBeInTheDocument();
});

it("ignores ready results from a different session or a live account replacement before rerender", async () => {
  let complete!: (value: DirectoryCreation) => void;
  const create = vi.spyOn(api, "createDirectory").mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const { read } = await openDirectoryCreate();
  submitDirectory();
  const calls = read.mock.calls.length;
  vi.spyOn(api, "nasSession", "get").mockReturnValue("replacement-before-render");
  await act(async () => { complete(readyDirectory("replacement-before-render")); });
  expect(read).toHaveBeenCalledTimes(calls);
  expect(screen.queryByText("文件夹已就绪")).not.toBeInTheDocument();
  expect(create).toHaveBeenCalledOnce();
});

it("keeps an active search and current scope when refreshing readiness in the actual parent", async () => {
  vi.spyOn(api, "nasSession", "get").mockReturnValue("directory-session");
  const read = normalReads();
  const create = vi.spyOn(api, "createDirectory").mockResolvedValue(readyDirectory());
  render(files());
  fireEvent.click(await screen.findByRole("button", { name: /家庭资料文件夹/ }));
  await screen.findByText("目录内文件.txt");
  search("报告");
  await screen.findByText("报告第1页.png");
  const searches = read.mock.calls.filter(([operation]) => operation === "files.search").length;
  submitDirectory();
  await screen.findByText("文件夹已就绪");
  await waitFor(() => expect(read.mock.calls.filter(([operation]) => operation === "files.search")).toHaveLength(searches + 1));
  expect(create).toHaveBeenCalledWith(directory, " 中文 资料 ", { signal: expect.any(AbortSignal) });
  expect(read).toHaveBeenLastCalledWith("files.search", { name: "报告", path: directory.path, page: 1, pageSize: 20 });
  expect(screen.getByText(/当前文件夹：家庭资料.*搜索“报告”/)).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "搜索文件名称" })).toHaveValue("报告");
});

it("keeps a new pending submission intact when the cancelled earlier action rejects", async () => {
  let rejectOld!: (value: unknown) => void, finishNew!: (value: DirectoryCreation) => void;
  const create = vi.spyOn(api, "createDirectory")
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
  await openDirectoryCreate();
  submitDirectory("旧请求");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  submitDirectory("用户另行请求");
  await act(async () => { rejectOld(new OfficialNasError("raw-old", "DIRECTORY_UNVERIFIED", 502, true)); });
  expect(screen.getByRole("textbox", { name: "文件夹名称" })).toHaveValue("用户另行请求");
  expect(screen.getByRole("button", { name: "处理中…" })).toBeDisabled();
  expect(create.mock.calls[1][2]?.signal?.aborted).toBe(false);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await act(async () => { finishNew(readyDirectory()); });
  expect(screen.getByText("文件夹已就绪")).toBeInTheDocument();
  expect(create).toHaveBeenCalledTimes(2);
});

it("cancels an unsubmitted modal without dispatching a mutation or claiming a possible creation", async () => {
  const create = vi.spyOn(api, "createDirectory");
  await openDirectoryCreate();
  fireEvent.click(screen.getByRole("button", { name: "新建文件夹" }));
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(create).not.toHaveBeenCalled();
  expect(screen.queryByText(/文件夹可能已创建/)).not.toBeInTheDocument();
});

it("rejects a mismatching result session while the current session is unchanged", async () => {
  const create = vi.spyOn(api, "createDirectory").mockResolvedValue(readyDirectory("old-session"));
  const { read } = await openDirectoryCreate();
  const calls = read.mock.calls.length;
  submitDirectory();
  expect(await screen.findByRole("alert")).toHaveTextContent("文件夹可能已创建，请先刷新查看");
  expect(read).toHaveBeenCalledTimes(calls);
  expect(screen.queryByText("文件夹已就绪")).not.toBeInTheDocument();
  expect(create).toHaveBeenCalledOnce();
});

it("retains the possible-creation warning after dismissing an ambiguous failure", async () => {
  vi.spyOn(api, "createDirectory").mockRejectedValue(new OfficialNasError("hidden", "DIRECTORY_UNVERIFIED", 502, true));
  await openDirectoryCreate();
  submitDirectory();
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByText("请求已中断，文件夹可能已创建，请先刷新查看。" )).toBeInTheDocument();
});

it("keeps the real navigation and search controls inside the fnOS toolbar with the honest scope notes still visible", async () => {
  normalReads();
  const view = render(files());
  await screen.findByRole("button", { name: /家庭资料文件夹/ });
  const toolbar = view.container.querySelector(".toolbar") as HTMLElement;
  expect(toolbar).not.toBeNull();
  // 返回/刷新仍是真实语义的图标按钮，只是换成 fnOS 的描边方块样式。
  expect(within(toolbar).getByRole("button", { name: "返回上一级" })).toHaveClass("files-tool-button");
  expect(within(toolbar).getByRole("button", { name: "刷新文件" })).toHaveClass("files-tool-button");
  expect(within(toolbar).getByRole("button", { name: "我的文件" })).toBeInTheDocument();
  const form = within(toolbar).getByRole("form", { name: "文件名称搜索" });
  expect(within(form).getByRole("textbox", { name: "搜索文件名称" })).toBeInTheDocument();
  expect(within(form).getByRole("combobox", { name: "搜索范围" })).toBeInTheDocument();
  expect(within(form).getByRole("button", { name: "搜索" })).toBeInTheDocument();
  // 索引范围说明仍是可见的真实约束，不被皮肤隐藏。
  expect(screen.getByText(/仅搜索.*索引.*外接设备.*回收站.*快照/)).toBeInTheDocument();
  // 最近访问没有文件搜索表单，只保留“仅筛选当前页”的说明。
  fireEvent.click(screen.getByRole("button", { name: "最近访问" }));
  expect(within(toolbar).queryByRole("form", { name: "文件名称搜索" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "搜索" })).not.toBeInTheDocument();
  expect(screen.getByText(/仅筛选最近访问的当前页/)).toBeInTheDocument();
});

it("keeps the Files skin on fnOS tokens only, with no hardcoded colors and no system dark-mode query", () => {
  const css = readFileSync(`${process.cwd()}/src/styles/fnos-files.css`, "utf8");
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // 皮肤只用 --fn-* 令牌着色：规则里不得出现字面色值。
  expect(rules.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g) || []).toEqual([]);
  // 浅色是唯一默认外观；深色只由 fnos-theme.css 的显式属性提供。
  expect(rules).not.toMatch(/prefers-color-scheme/);
  // 不重复定义 fnos-controls.css 的共用控件皮肤，只加 .files-module 作用域规则。
  for (const shared of [".primary", ".secondary", ".icon-button", ".toolbar", ".search", ".state-panel", ".pagination", ".tabs", ".card"]) {
    expect(rules).not.toMatch(new RegExp(`^\\${shared}\\s*[,{]`, "m"));
  }
  // --fn-bg-0 是页面底（#F3F3F3），不能当白色内容面用。
  expect(rules).not.toMatch(/background:\s*var\(--fn-bg-0\)/);
  // 皮肤必须在外壳之后加载，才能覆盖 styles.css 里既有的 Files 规则。
  const main = readFileSync(`${process.cwd()}/src/main.tsx`, "utf8");
  const skin = main.indexOf('"./styles/fnos-files.css"');
  expect(skin).toBeGreaterThan(main.indexOf('"./styles/fnos-shell.css"'));
});

describe("same-path rows", () => {
  it("renders a folder once even if the device returns it twice", async () => {
    // 新建文件夹后立刻刷新时，极空间偶发把同一路径返回两行
    const folder = { id: "f1", name: "新建文件夹", path: "/public/新建文件夹", kind: "directory" };
    vi.spyOn(api, "read").mockResolvedValue({
      items: [folder, { ...folder, id: "f2" }],
      total: 2,
    } as Collection);
    const { container } = render(<Files connected />);
    await waitFor(() => expect(container.querySelectorAll(".file-row").length).toBeGreaterThan(0));
    // 只看列表里的行名（"新建文件夹"这个字样在按钮/弹窗里也会出现）
    const rows = [...container.querySelectorAll(".file-row .file-name")].filter((node) =>
      node.textContent?.includes("新建文件夹"),
    );
    expect(rows).toHaveLength(1);
    expect(container.querySelectorAll(".file-row")).toHaveLength(1);
  });

  it("keeps genuinely different files that only share a name", () => {
    const a = { id: "a", name: "同名.txt", path: "/x/同名.txt", kind: "file" };
    const b = { id: "b", name: "同名.txt", path: "/y/同名.txt", kind: "file" };
    expect(dedupeByPath([a, b])).toHaveLength(2);
    expect(dedupeByPath([a, { ...a }])).toHaveLength(1);
    expect(dedupeByPath([]).length).toBe(0);
  });
});

describe("multi-select", () => {
  const rows = [
    { id: "a", name: "甲.txt", path: "/x/甲.txt", kind: "file", size: 1024 },
    { id: "b", name: "乙.txt", path: "/x/乙.txt", kind: "file", size: 2048 },
    { id: "c", name: "丙.txt", path: "/x/丙.txt", kind: "file", size: 4096 },
  ];

  it("selects with modifier keys, sums the size, and clears with Escape", async () => {
    vi.spyOn(api, "read").mockResolvedValue({ items: rows, total: rows.length } as Collection);
    const { container } = render(<Files connected />);
    await waitFor(() => expect(container.querySelectorAll(".file-row").length).toBe(3));
    const find = () =>
      [...container.querySelectorAll<HTMLButtonElement>(".file-row")].find((row) =>
        row.textContent?.includes("乙.txt"),
      )!;
    const first = () => container.querySelectorAll<HTMLButtonElement>(".file-row")[0];

    // ⌘/Ctrl 点选：不打开预览，只选中
    fireEvent.click(find(), { metaKey: true });
    expect(container.querySelector(".file-selection-bar")?.textContent).toContain("已选 1 项");
    expect(container.querySelector(".file-selection-bar")?.textContent).toContain("2.0 KB");   // formatBytes 的写法
    // Shift 连选：从锚点到当前
    fireEvent.click(first(), {});
    expect(container.querySelector(".file-selection-bar")).toBeNull();
    fireEvent.click(container.querySelectorAll<HTMLButtonElement>(".file-row")[2], { metaKey: true });
    fireEvent.click(first(), { shiftKey: true });
    expect(container.querySelector(".file-selection-bar")?.textContent).toContain("已选 3 项");
    expect(container.querySelectorAll(".file-row.picked").length).toBe(3);
    // Esc 清空
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(container.querySelector(".file-selection-bar")).toBeNull());
    expect(container.querySelectorAll(".file-row.picked").length).toBe(0);
  });

  it("does not offer a batch download for folders", async () => {
    const folder = { id: "f", name: "子目录", path: "/x/子目录", kind: "directory" };
    vi.spyOn(api, "read").mockResolvedValue({ items: [folder], total: 1 } as Collection);
    const { container } = render(<Files connected />);
    await waitFor(() => expect(container.querySelectorAll(".file-row").length).toBe(1));
    fireEvent.click(container.querySelector<HTMLButtonElement>(".file-row")!, { metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: /下载所选/ }));
    await waitFor(() =>
      expect(container.querySelector(".file-selection-bar")?.textContent).toContain("文件夹需要逐个打开"),
    );
  });
});
