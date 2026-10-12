import { describe, expect, it } from "vitest";
import { containerState, createdText, imageLabel } from "./DockerView";

describe("docker container state", () => {
  it("maps Docker's own words to Chinese labels and a tone", () => {
    expect(containerState("running")).toEqual({ label: "运行中", tone: "up" });
    expect(containerState("exited")).toEqual({ label: "已停止", tone: "down" });
    expect(containerState("paused")).toEqual({ label: "已暂停", tone: "idle" });
    expect(containerState("restarting")).toEqual({ label: "重启中", tone: "idle" });
  });

  it("passes an unknown state through instead of inventing one", () => {
    expect(containerState("weird")).toEqual({ label: "weird", tone: "idle" });
    expect(containerState(undefined)).toEqual({ label: "未知", tone: "idle" });
  });
});

describe("docker image labels", () => {
  it("splits repository and tag", () => {
    expect(imageLabel({ id: "sha256:abc", tags: ["nginx:1.27"], size: 1, created: 0 }))
      .toEqual({ name: "nginx", tag: "1.27" });
    expect(imageLabel({ id: "sha256:abc", tags: ["ghcr.io/a/b:latest"], size: 1, created: 0 }))
      .toEqual({ name: "ghcr.io/a/b", tag: "latest" });
  });

  it("explains untagged images instead of presenting a digest as a name", () => {
    expect(imageLabel({ id: "sha256:0123456789abcdef", tags: [], size: 1, created: 0 }))
      .toEqual({ name: "未命名镜像", tag: "无仓库标签" });
    expect(imageLabel({ id: "sha256:0123456789abcdef", tags: ["<none>:<none>"], size: 1, created: 0 }))
      .toEqual({ name: "未命名镜像", tag: "无仓库标签" });
  });
});

describe("created timestamps", () => {
  it("shows a date for a real value and a dash otherwise", () => {
    expect(createdText(undefined)).toBe("—");
    expect(createdText(0)).toBe("—");
    expect(createdText(Number.NaN)).toBe("—");
    expect(createdText(1750000000)).toMatch(/2025/);
  });
});

import { afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { api } from "../api/client";
import { DockerView } from "./DockerView";
afterEach(()=>{cleanup();vi.restoreAllMocks()});
it("confirms lifecycle actions and reads the resulting list",async()=>{
 const id="a".repeat(64);let state="running";
 const request=vi.spyOn(api,"docker").mockImplementation(async(endpoint,body)=>{
  if(endpoint==="capabilities")return {manage:true,available:true} as never;
  if(endpoint==="control"){expect(body).toEqual({id,action:"stop"});state="exited";return {id,state} as never}
  return {containers:[{id,name:"review-fixture",image:"alpine:3",state,status:state,ports:[],created:1}]} as never;
 });
 render(<DockerView connected />);fireEvent.click(await screen.findByRole("button",{name:"停止review-fixture"}));
 expect(request.mock.calls.some(c=>c[0]==="control")).toBe(false);
 fireEvent.click(screen.getByRole("button",{name:"确认停止"}));expect(await screen.findByText("操作完成，设备状态已确认。")).toBeInTheDocument();expect(await screen.findByRole("button",{name:"启动review-fixture"})).toBeInTheDocument();
});
it("shows log read failures without inventing empty log content",async()=>{
 vi.spyOn(api,"docker").mockImplementation(async endpoint=>{
  if(endpoint==="capabilities")return {manage:true,available:true} as never;
  if(endpoint.startsWith("logs/"))throw new Error("读取日志失败");
  return {containers:[{id:"a".repeat(64),name:"review-fixture",image:"alpine",state:"running",status:"",ports:[],created:1}]} as never;
 });
 render(<DockerView connected />);fireEvent.click(await screen.findByRole("button",{name:"查看review-fixture日志"}));expect(await screen.findByText("读取日志失败")).toBeInTheDocument();expect(screen.queryByText("设备没有返回日志")).not.toBeInTheDocument();
});

it("names untagged images using their verified publisher title",()=>{expect(imageLabel({id:"sha256:abc",tags:[],size:1,created:0,displayName:"Reader Server"})).toEqual({name:"Reader Server",tag:"无仓库标签"})});

it("shows a saved official project without suggesting that nonexistent containers are running",async()=>{
 vi.spyOn(api,"docker").mockImplementation(async endpoint=>endpoint==="capabilities"?{manage:true,available:true} as never:endpoint==="compose"?{projects:[{name:"saved-review",state:"saved",official:true,directory:"/sata1/my/data/projects",running:0,total:0,services:[]}]} as never:{containers:[]} as never);
 render(<DockerView connected/>);fireEvent.click(screen.getByRole("button",{name:"Compose 项目"}));expect(await screen.findByText("saved-review")).toBeVisible();expect(screen.getByText("已保存，尚未创建容器")).toBeVisible();expect(screen.getByText("/sata1/my/data/projects")).toBeVisible();expect(screen.getByRole("button",{name:"查看项目容器"})).toBeDisabled();
});
