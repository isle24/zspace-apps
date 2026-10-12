import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../api/client";
import { DownloadsWindow } from "./DownloadsWindow";
import { RemoteWindow } from "./RemoteWindow";
import { OfficialStore } from "./OfficialStore";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("offers advertised download engines and confirms the selected switch", async () => {
  vi.spyOn(api, "read").mockResolvedValue({ items: [] });
  vi.spyOn(api, "downloadDirectory").mockResolvedValue("");
  const state = { current: 1 as const, status: 0, engines: [{ type: 1 as const, name: "Transmission", version: "4" }, { type: 2 as const, name: "qBittorrent", version: "5" }] };
  vi.spyOn(api, "downloadEngineState").mockResolvedValue(state);
  const switchEngine = vi.spyOn(api, "switchDownloadEngine").mockResolvedValue({ ...state, current: 2, status: 5 });
  render(<DownloadsWindow connected />);
  fireEvent.change(await screen.findByRole("combobox", { name: "下载引擎" }), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "切换引擎" }));
  expect(switchEngine).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认切换" }));
  await waitFor(() => expect(switchEngine).toHaveBeenCalledWith(2));
  expect(await screen.findByText(/切换已完成/)).toBeInTheDocument();
});
it("reads official remote entries without mounting local shortcut creation", async () => {
  const entries = vi.spyOn(api, "remoteEntries").mockResolvedValue([{ id: "0", name: "Official Jellyfin", address: "127.0.0.1:8096", url: "http://nas.test:8096/", proxy: true, desktopVisible: true }]);
  vi.spyOn(api, "read").mockResolvedValue({ items: [] });
  render(<RemoteWindow connected />);
  expect(await screen.findByText("Official Jellyfin")).toBeInTheDocument();
  expect(entries).toHaveBeenCalled(); expect(screen.queryByRole("button", { name: "新建" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "打开 Official Jellyfin" })).toBeInTheDocument();
});
it("shows removable applications and submits uninstall retaining their data", async () => {
  vi.spyOn(api, "read").mockImplementation(async op => ({ items: op === "apps.native" ? [{ id: "backup", name: "backup", metadata: { app_name: "backup", installed: 1, removable: 1, toggleable: 1, status: "running", local_info: { i18n: [{ lang: "zh_cn", name: "备份" }] } } }] : [] }));
  const uninstall = vi.spyOn(api, "uninstallApp").mockResolvedValue({ installed: false, status: "stop" });
  render(<OfficialStore />);
  fireEvent.click(await screen.findByRole("button", { name: "查看备份详情" }));
  fireEvent.click(screen.getByRole("button", { name: "卸载应用" }));
  expect(screen.getByText(/保留应用数据/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "确认卸载" }));
  await waitFor(() => expect(uninstall).toHaveBeenCalledWith({ appName: "backup", docker: false }));
});
