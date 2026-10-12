import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../api/client";
import { OfficialStore } from "./OfficialStore";
const info = { i18n: [{ lang: "zh_cn", name: "FTP备份", intro: "自动备份文件", tags: [{ key: "backup", name: "备份" }] }], icons: [{ spec: "PC:240x240", url: "/AppStore/ui/icon.png" }], version: { version: "V3.2.100" } };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("official store acceptance", () => {
  it("shows Chinese names and descriptions once and filters by category and installed state", async () => {
    const read = vi.spyOn(api, "read").mockImplementation(async operation => ({ items: operation === "apps.native" ? [
      { id: "FTPBackUp", name: "FTPBackUp", metadata: { app_name: "FTPBackUp", installed: 1, status: "running", local_info: info } },
    ] : [ { id: "komga", name: "komga", metadata: { app_name: "komga", installed: 0, is_docker: 1, latest_version: { i18n: [{ lang: "zh_cn", name: "漫画阅读", intro: "阅读漫画", tags: [{ key: "reading", name: "阅读" }] }] } } } ] }));
    render(<OfficialStore />);
    expect(await screen.findByText("FTP备份")).toBeInTheDocument();
    expect(screen.getAllByText("FTP备份")).toHaveLength(1);
    expect(screen.getByText("自动备份文件")).toBeInTheDocument();
    expect(read.mock.calls.map(c => c[0])).toEqual(["apps.native", "apps.docker"]);
    fireEvent.click(screen.getByRole("button", { name: "已安装" }));
    expect(screen.queryByText("漫画阅读")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "发现应用" }));
    fireEvent.click(screen.getByRole("button", { name: "阅读" }));
    expect(screen.getByText("漫画阅读")).toBeInTheDocument();
    expect(screen.queryByText("FTP备份")).not.toBeInTheDocument();
  });
  it("opens a readable detail view", async () => {
    vi.spyOn(api, "read").mockResolvedValue({ items: [{ id: "FTPBackUp", name: "FTPBackUp", metadata: { local_info: info, installed: 1, app_name: "FTPBackUp", toggleable: 1, status: "running" } }] });
    render(<OfficialStore />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "查看FTP备份详情" }).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole("button", { name: "查看FTP备份详情" })[0]);
    expect(screen.getByRole("dialog", { name: "FTP备份详情" })).toHaveTextContent("V3.2.100");
    expect(screen.getByRole("button", { name: "停止应用" })).toBeInTheDocument();
  });
});
it("keeps detail and result visible while refreshing after an action", async()=>{
 let reads=0;vi.spyOn(api,"read").mockImplementation(async operation=>{
  if(++reads>2)return new Promise(()=>{});
  return {items:operation==="apps.native"?[{id:"FTPBackUp",name:"FTPBackUp",metadata:{local_info:info,installed:1,app_name:"FTPBackUp",toggleable:1,status:"running"}}]:[]};
 });vi.spyOn(api,"controlApp").mockResolvedValue();render(<OfficialStore/>);
 fireEvent.click(await screen.findByRole("button",{name:"查看FTP备份详情"}));fireEvent.click(screen.getByRole("button",{name:"停止应用"}));fireEvent.click(screen.getByRole("button",{name:"确认操作"}));
 expect(await screen.findByText("设备状态已确认，正在更新应用列表。")).toBeInTheDocument();expect(screen.getByRole("dialog",{name:"FTP备份详情"})).toBeInTheDocument();
});
