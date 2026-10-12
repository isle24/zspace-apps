import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../api/client";
import { DockerAppInstall } from "./DockerAppInstall";
import { OfficialStore } from "./OfficialStore";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("selects a NAS disk and folder before submitting the verified installation fields", async () => {
  vi.spyOn(api, "prepareDockerApp").mockResolvedValue({ appName: "OpenWebUI", version: 101, roots: [{ id: "nvme1", name: "SSD", path: "/nvme1/my/data" }, { id: "sata1", name: "HDD", path: "/sata1/my/data" }], portMin: 50000, portMax: 65535 });
  vi.spyOn(api, "read").mockResolvedValue({ items: [{ id: "/sata1/my/data/openwebui", name: "openwebui", path: "/sata1/my/data/openwebui", kind: "directory" }], total: 1 });
  const install = vi.spyOn(api, "installDockerApp").mockResolvedValue({ installed: true, status: "running" });
  render(<DockerAppInstall appName="OpenWebUI" finished={() => {}} />);
  fireEvent.change(await screen.findByRole("combobox", { name: "应用数据磁盘" }), { target: { value: "sata1" } });
  fireEvent.click(await screen.findByRole("button", { name: "打开文件夹 openwebui" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "应用访问端口" }), { target: { value: "58080" } });
  fireEvent.click(screen.getByRole("button", { name: "查看安装计划" })); expect(install).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: "Docker应用安装计划" })).toHaveTextContent("HDD · /sata1/my/data/openwebui");
  fireEvent.click(screen.getByRole("button", { name: "确认安装" }));
  await waitFor(() => expect(install).toHaveBeenCalledWith({ appName: "OpenWebUI", version: 101, dataPath: "/sata1/my/data/openwebui", port: 58080, autoStart: true }));
  expect(await screen.findByText(/安装状态已确认/)).toBeInTheDocument();
});
it("offers the integrated vendor installer only for the verified template", async () => {
  vi.spyOn(api, "read").mockImplementation(async op => ({ items: op === "apps.docker" ? [
    { id: "OpenWebUI", name: "OpenWebUI", metadata: { app_name: "OpenWebUI", is_docker: 1, installed: 0 } },
    { id: "unverified_vendor", name: "unverified_vendor", metadata: { app_name: "unverified_vendor", is_docker: 1, installed: 0 } },
  ] : [] }));
  render(<OfficialStore />); fireEvent.click(await screen.findByRole("button", { name: "查看OpenWebUI详情" }));
  expect(screen.getByRole("button", { name: "安装应用" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "关闭应用详情" })); fireEvent.click(screen.getByRole("button", { name: "查看unverified_vendor详情" }));
  expect(screen.queryByRole("button", { name: "安装应用" })).not.toBeInTheDocument(); expect(screen.getByText(/初始化模板尚未核对/)).toBeInTheDocument();
});

it("chooses configuration and media directories independently for Jellyfin",async()=>{
 vi.spyOn(api,"prepareDockerApp").mockResolvedValue({appName:"Jellyfin",version:101,roots:[{id:"sata1",name:"HDD",path:"/sata1/my/data"}],portMin:50000,portMax:65535,primaryLabel:"应用配置",autoStartDefault:false,fields:[{key:"docker_jellyfin_media",label:"影音媒体",type:"directory"}]});
 vi.spyOn(api,"read").mockResolvedValue({items:[{id:"config",name:"config",path:"/sata1/my/data/config",kind:"directory"},{id:"media",name:"media",path:"/sata1/my/data/media",kind:"directory"}],total:2});
 const install=vi.spyOn(api,"installDockerApp").mockResolvedValue({installed:true,status:"running"});render(<DockerAppInstall appName="Jellyfin" finished={()=>{}}/>);
 fireEvent.change(await screen.findByRole("combobox",{name:"应用配置磁盘"}),{target:{value:"sata1"}});fireEvent.click(await screen.findByRole("button",{name:"打开文件夹 config"}));
 fireEvent.change(screen.getByRole("combobox",{name:"影音媒体磁盘"}),{target:{value:"sata1"}});
 await waitFor(()=>expect(screen.getAllByRole("button",{name:"打开文件夹 media"})).toHaveLength(2));fireEvent.click(screen.getAllByRole("button",{name:"打开文件夹 media"})[1]);
 fireEvent.change(screen.getByRole("spinbutton",{name:"应用访问端口"}),{target:{value:"58080"}});fireEvent.click(screen.getByRole("button",{name:"查看安装计划"}));fireEvent.click(screen.getByRole("button",{name:"确认安装"}));
 await waitFor(()=>expect(install).toHaveBeenCalledWith({appName:"Jellyfin",version:101,dataPath:"/sata1/my/data/config",port:58080,autoStart:false,settings:{docker_jellyfin_media:"/sata1/my/data/media"}}));
});
it("keeps application passwords out of the readable installation plan",async()=>{
 vi.spyOn(api,"prepareDockerApp").mockResolvedValue({appName:"openlist",version:101,roots:[{id:"sata1",name:"HDD",path:"/sata1/my/data"}],portMin:50000,portMax:65535,fields:[{key:"docker_openlist_password",label:"管理员密码",type:"password",minLength:1}]});
 vi.spyOn(api,"read").mockResolvedValue({items:[{id:"config",name:"config",path:"/sata1/my/data/config",kind:"directory"}],total:1});render(<DockerAppInstall appName="openlist" finished={()=>{}}/>);
 fireEvent.change(await screen.findByRole("combobox",{name:"应用数据磁盘"}),{target:{value:"sata1"}});fireEvent.click(await screen.findByRole("button",{name:"打开文件夹 config"}));fireEvent.change(screen.getByRole("spinbutton",{name:"应用访问端口"}),{target:{value:"58080"}});fireEvent.change(screen.getByLabelText("管理员密码"),{target:{value:"Synthetic-Private-Value"}});fireEvent.click(screen.getByRole("button",{name:"查看安装计划"}));
 const review=screen.getByRole("region",{name:"Docker应用安装计划"});expect(review).toHaveTextContent("管理员密码：已填写");expect(review).not.toHaveTextContent("Synthetic-Private-Value");
});
