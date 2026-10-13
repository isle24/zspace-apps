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

it("keeps the launchpad open while searching and provides an explicit close action", async () => {
 vi.stubGlobal("fetch",vi.fn());render(<App/>);fireEvent.click(await screen.findByRole("button",{name:"先体验桌面"}));
 const trigger=screen.getByRole("button",{name:"显示全部应用"});trigger.focus();fireEvent.click(trigger);
 const search=await screen.findByRole("textbox",{name:"搜索应用名称"});fireEvent.click(search);fireEvent.change(search,{target:{value:"Docker"}});
 const dialog=screen.getByRole("dialog",{name:"全部应用"});expect(within(dialog).getByRole("button",{name:"Docker"})).toBeInTheDocument();
 fireEvent.click(within(dialog).getByRole("button",{name:"关闭全部应用"}));expect(screen.queryByRole("dialog",{name:"全部应用"})).not.toBeInTheDocument();
});
it("keeps keyboard navigation within the launchpad until Escape closes it", async () => {
 vi.stubGlobal("fetch",vi.fn());render(<App/>);fireEvent.click(await screen.findByRole("button",{name:"先体验桌面"}));fireEvent.click(screen.getByRole("button",{name:"显示全部应用"}));
 const dialog=await screen.findByRole("dialog",{name:"全部应用"});const search=within(dialog).getByRole("textbox",{name:"搜索应用名称"});const buttons=within(dialog).getAllByRole("button");const last=buttons[buttons.length-1];
 last.focus();fireEvent.keyDown(last,{key:"Tab"});expect(document.activeElement).toBe(search);
 search.focus();fireEvent.keyDown(search,{key:"Tab",shiftKey:true});expect(document.activeElement).toBe(last);
 fireEvent.keyDown(window,{key:"Escape"});expect(screen.queryByRole("dialog",{name:"全部应用"})).not.toBeInTheDocument();
});
