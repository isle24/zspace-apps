import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import App from "./App";
import { api } from "./api/client";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  api.logoutNas();
});

it("keeps a minimized application in the Dock and removes it when its window closes", async () => {
  vi.stubGlobal("fetch", vi.fn());
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "先体验桌面" }));
  const dock = within(screen.getByRole("navigation", { name: "应用 Dock" }));
  expect(dock.queryByRole("button", { name: "打开文件管理" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "文件管理" }));
  const entry = dock.getByRole("button", { name: "打开文件管理" });
  expect(entry).toHaveClass("running");
  fireEvent.click(screen.getByRole("button", { name: "最小化文件管理" }));
  expect(entry).toBeInTheDocument();
  fireEvent.click(entry);
  fireEvent.click(screen.getByRole("button", { name: "关闭文件管理" }));
  expect(dock.queryByRole("button", { name: "打开文件管理" })).not.toBeInTheDocument();
});

it("adds applications outside the old fixed Dock list and removes only the closed one", async () => {
  vi.stubGlobal("fetch", vi.fn());
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "先体验桌面" }));
  const dock = within(screen.getByRole("navigation", { name: "应用 Dock" }));
  fireEvent.click(screen.getByRole("button", { name: "下载中心" }));
  fireEvent.click(screen.getByRole("button", { name: "文件管理" }));
  expect(dock.getByRole("button", { name: "打开下载中心" })).toHaveClass("running");
  fireEvent.click(screen.getByRole("button", { name: "关闭文件管理" }));
  expect(dock.queryByRole("button", { name: "打开文件管理" })).not.toBeInTheDocument();
  expect(dock.getByRole("button", { name: "打开下载中心" })).toHaveClass("running");
});
