import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api, type Collection, type Item } from "../api/client";
import { Files } from "./Files";

const pools: Item[] = [
  { id: "main", name: "家庭存储", path: "/main/my/data", kind: "directory", metadata: { mounted: true } },
  { id: "backup", name: "家庭存储备份", path: "/main/my/data-backup", kind: "directory" },
  { id: "fast", name: "高速存储", path: "/fast/my/data", kind: "directory" },
];
const child: Item = { id: "child", name: "工作资料", path: pools[0].path + "/work", kind: "directory" };
const file: Item = { id: "report", name: "报告.txt", path: child.path + "/report.txt", kind: "file" };
const list = (items: Item[], total = items.length): Collection => ({ items, total });
const sidebar = () => within(screen.getByRole("navigation", { name: "文件位置" }));
const poolButton = (item = pools[0]) => sidebar().getByRole("button", { name: `打开存储池：${item.name}` });
function reads() {
  return vi.spyOn(api, "read").mockImplementation(async (operation, params = {}) => {
    if (operation === "files.roots") return list(pools);
    if (operation === "files.list" && params.path === pools[0].path) return list([child]);
    if (operation === "files.info") return { items: [], values: { name: file.name } };
    return list([file], 42);
  });
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// This multi-step UI flow exceeded 5s on the loaded Intel macOS CI runner.
it("keeps three returned pools visible through nested folders, indexed search and recent access, reusing the overview read", async () => {
  const read = reads(); render(<Files connected />);
  await screen.findByRole("button", { name: "打开存储池：家庭存储" });
  expect(sidebar().getByRole("group", { name: "存储池" })).toBeInTheDocument();
  expect(read.mock.calls.filter(([op]) => op === "files.roots")).toEqual([["files.roots", {}]]);
  fireEvent.click(poolButton());
  fireEvent.click(await screen.findByRole("button", { name: /工作资料文件夹/ }));
  await screen.findByRole("button", { name: /报告.txt文件/ });
  expect(poolButton()).toHaveAttribute("aria-current", "page");
  fireEvent.change(screen.getByRole("textbox", { name: "搜索文件名称" }), { target: { value: "报告" } });
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  await waitFor(() => expect(read).toHaveBeenLastCalledWith("files.search", { name: "报告", path: child.path, page: 1, pageSize: 20 }));
  pools.forEach(pool => expect(poolButton(pool)).toBeInTheDocument());
  fireEvent.click(sidebar().getByRole("button", { name: "最近访问" }));
  await waitFor(() => expect(read).toHaveBeenLastCalledWith("files.recent", { page: 1, pageSize: 20 }));
  pools.forEach(pool => expect(poolButton(pool)).not.toHaveAttribute("aria-current"));
  fireEvent.click(sidebar().getByRole("button", { name: "我的文件" }));
  await screen.findByRole("button", { name: /家庭存储文件夹/ });
  expect(read.mock.calls.filter(([op]) => op === "files.roots")).toHaveLength(1);
}, 15_000);

it("switches to the exact returned same-prefix pool path and resets search, page, selection and breadcrumbs", async () => {
  const read = reads(); const view = render(<Files connected />);
  await screen.findByRole("button", { name: "打开存储池：家庭存储" });
  fireEvent.click(poolButton());
  await screen.findByRole("button", { name: /工作资料文件夹/ });
  fireEvent.change(screen.getByRole("textbox", { name: "搜索文件名称" }), { target: { value: "报告" } });
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  await screen.findByRole("button", { name: /报告.txt文件/ });
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await waitFor(() => expect(read).toHaveBeenLastCalledWith("files.search", { name: "报告", path: pools[0].path, page: 2, pageSize: 20 }));
  fireEvent.click(await screen.findByRole("button", { name: /报告.txt文件/ }));
  await screen.findByRole("button", { name: "收起详情" });
  fireEvent.click(poolButton(pools[1]));
  await waitFor(() => expect(read).toHaveBeenLastCalledWith("files.list", { path: pools[1].path, page: 1, pageSize: 20 }));
  expect(poolButton(pools[0])).not.toHaveAttribute("aria-current");
  expect(poolButton(pools[1])).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("textbox", { name: "搜索文件名称" })).toHaveValue("");
  expect(screen.queryByRole("button", { name: "收起详情" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "清除搜索" })).not.toBeInTheDocument();
  expect(Array.from(view.container.querySelectorAll(".crumb button")).map(node => node.textContent)).toEqual([pools[1].name]);
});

it("allows late roots to populate while recent content is active without replacing that content", async () => {
  let finish!: (value: Collection) => void;
  vi.spyOn(api, "read").mockImplementation(async op => op === "files.roots" ? new Promise(resolve => { finish = resolve; }) : list([file]));
  render(<Files connected />);
  expect(sidebar().getByRole("status")).toHaveTextContent("正在读取存储池");
  fireEvent.click(sidebar().getByRole("button", { name: "最近访问" }));
  await screen.findByRole("button", { name: /报告.txt文件/ });
  await act(async () => finish(list(pools)));
  expect(poolButton()).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "最近访问" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /报告.txt文件/ })).toBeInTheDocument();
});

it("refreshes roots independently and removes a vanished selected pool without retaining its directory or details", async () => {
  const read = reads(); render(<Files connected />);
  await screen.findByRole("button", { name: "打开存储池：家庭存储" });
  fireEvent.click(poolButton()); fireEvent.click(await screen.findByRole("button", { name: /工作资料文件夹/ }));
  fireEvent.click(await screen.findByRole("button", { name: /报告.txt文件/ }));
  await screen.findByRole("button", { name: "收起详情" });
  read.mockImplementation(async op => op === "files.roots" ? list([pools[2]]) : list([file]));
  fireEvent.click(sidebar().getByRole("button", { name: "刷新存储池" }));
  await waitFor(() => expect(sidebar().queryByRole("button", { name: "打开存储池：家庭存储" })).not.toBeInTheDocument());
  expect(poolButton(pools[2])).toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: "我的文件" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "收起详情" })).not.toBeInTheDocument();
  expect(read.mock.calls.filter(([op]) => op === "files.roots")).toHaveLength(2);
});

it("discards pending roots from old sessions and clears pools and reads on disconnect", async () => {
  let session = "old-session", finish!: (value: Collection) => void;
  vi.spyOn(api, "nasSession", "get").mockImplementation(() => session);
  const read = vi.spyOn(api, "read").mockImplementation(async op => op === "files.roots" && session === "old-session" ? new Promise(resolve => { finish = resolve; }) : list([pools[2]]));
  const view = render(<Files connected />);
  session = "new-session"; view.rerender(<Files connected />);
  await screen.findByRole("button", { name: "打开存储池：高速存储" });
  await act(async () => finish(list([pools[0]])));
  expect(sidebar().queryByRole("button", { name: "打开存储池：家庭存储" })).not.toBeInTheDocument();
  const count = read.mock.calls.length;
  view.rerender(<Files connected={false} />);
  expect(sidebar().getByText("连接 NAS 后显示存储池")).toBeInTheDocument();
  expect(sidebar().queryByRole("button", { name: /打开存储池/ })).not.toBeInTheDocument();
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(count);
});

it("offers genuine error retry and an empty pool state instead of inventing locations", async () => {
  const read = vi.spyOn(api, "read").mockRejectedValue(new Error("读取失败"));
  render(<Files connected />);
  await waitFor(() => expect(sidebar().getByRole("alert")).toHaveTextContent("读取失败"));
  read.mockResolvedValue(list([]));
  fireEvent.click(sidebar().getByRole("button", { name: "刷新存储池" }));
  expect(await sidebar().findByText("暂无可访问的存储池")).toBeInTheDocument();
  expect(sidebar().queryByRole("button", { name: /打开存储池/ })).not.toBeInTheDocument();
  expect(read).toHaveBeenCalledTimes(2);
});

it("rejects malformed sidebar paths while retaining legitimate returned labels and exposes the mobile locations control", async () => {
  vi.spyOn(api, "read").mockResolvedValue(list([...pools, { id: "unsafe", name: "路径待核实", path: "/main/../secret", kind: "directory" }, { id: "missing", name: "缺少路径", kind: "directory" }, { id: "opaque", name: "加密位置", path: "E.opaque", kind: "directory" }]));
  render(<Files connected />);
  await screen.findByRole("button", { name: "打开存储池：家庭存储" });
  expect(sidebar().getAllByRole("button", { name: /打开存储池/ })).toHaveLength(3);
  const control = screen.getByRole("button", { name: "文件位置" });
  expect(control).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(control);
  expect(control).toHaveAttribute("aria-expanded", "true");
  fireEvent.keyDown(screen.getByRole("navigation", { name: "文件位置" }), { key: "Escape" });
  expect(control).toHaveAttribute("aria-expanded", "false");
  expect(control).toHaveFocus();
  fireEvent.click(control);
  poolButton().focus();
  fireEvent.click(poolButton());
  expect(control).toHaveAttribute("aria-expanded", "false");
  expect(control).toHaveFocus();
});

it("rejects a roots completion if the live account changes before the parent renders", async () => {
  let session = "original", finish!: (value: Collection) => void;
  vi.spyOn(api, "nasSession", "get").mockImplementation(() => session);
  const read = vi.spyOn(api, "read").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<Files connected />);
  session = "replacement";
  await act(async () => finish(list(pools)));
  expect(sidebar().queryByRole("button", { name: /打开存储池/ })).not.toBeInTheDocument();
  expect(read).toHaveBeenCalledTimes(1);
});

it("refreshes returned names without leaving a still-accessible directory or rereading its content", async () => {
  const read = reads(); render(<Files connected />);
  await screen.findByRole("button", { name: "打开存储池：家庭存储" });
  fireEvent.click(poolButton()); await screen.findByRole("button", { name: /工作资料文件夹/ });
  const calls = read.mock.calls.filter(([op]) => op === "files.list").length;
  read.mockImplementation(async op => op === "files.roots" ? list([{ ...pools[0], name: "家庭池新名称" }]) : list([file]));
  fireEvent.click(sidebar().getByRole("button", { name: "刷新存储池" }));
  expect(await sidebar().findByRole("button", { name: "打开存储池：家庭池新名称" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("button", { name: /工作资料文件夹/ })).toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: "家庭池新名称" })).toBeInTheDocument();
  expect(read.mock.calls.filter(([op]) => op === "files.list")).toHaveLength(calls);
});

it("distinguishes pools with identical returned names using their actual paths in accessible labels", async () => {
  vi.spyOn(api, "read").mockResolvedValue(list([pools[0], { ...pools[2], name: pools[0].name }]));
  render(<Files connected />);
  expect(await sidebar().findByRole("button", { name: `打开存储池：家庭存储（${pools[0].path}）` })).toBeInTheDocument();
  expect(sidebar().getByRole("button", { name: `打开存储池：家庭存储（${pools[2].path}）` })).toBeInTheDocument();
});

it("rejects stale file details if the live account changes before the parent renders", async () => {
  let session = "details-original", finish!: (value: Collection) => void;
  vi.spyOn(api, "nasSession", "get").mockImplementation(() => session);
  const read = vi.spyOn(api, "read").mockImplementation(async op => op === "files.roots" ? list(pools) : op === "files.info" ? new Promise(resolve => { finish = resolve; }) : list([file]));
  render(<Files connected />);
  await screen.findByRole("button", { name: "打开存储池：家庭存储" });
  fireEvent.click(poolButton());
  fireEvent.click(await screen.findByRole("button", { name: /报告.txt文件/ }));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  session = "details-replacement";
  await act(async () => finish({ items: [], values: { name: "旧账号详情不得出现" } }));
  expect(screen.queryByText("旧账号详情不得出现")).not.toBeInTheDocument();
  expect(read.mock.calls.filter(([op]) => op === "files.info")).toHaveLength(1);
});
