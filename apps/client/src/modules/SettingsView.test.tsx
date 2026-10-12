import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { api } from "../api/client";
import { SettingsView } from "./SystemNetwork";
afterEach(()=>{cleanup();vi.restoreAllMocks()});
it("uses a settings form and confirms the device value after saving", async()=>{
 let hidden=0;vi.spyOn(api,"read").mockImplementation(async()=>({items:[],values:{file:{show_hidden:hidden,hash_check:0,hash_check_option:"simple"},fs_evt_monitor:1,disk_stats_sec:3600}}));
 const save=vi.spyOn(api,"saveSetting").mockImplementation(async(key,value)=>{expect(key).toBe("show_hidden");hidden=Number(value)});
 render(<SettingsView connected />);const toggle=await screen.findByRole("checkbox",{name:"显示隐藏文件"});fireEvent.click(toggle);
 fireEvent.click(screen.getByRole("button",{name:"保存设置"}));expect(await screen.findByText("设置已保存，并已从设备确认。")).toBeInTheDocument();expect(save).toHaveBeenCalledOnce();expect(screen.getByRole("checkbox",{name:"显示隐藏文件"})).toBeChecked();
});
it("retains edited values after a failed save",async()=>{
 vi.spyOn(api,"read").mockResolvedValue({items:[],values:{file:{show_hidden:0}}});vi.spyOn(api,"saveSetting").mockRejectedValue(new Error("网络中断"));
 render(<SettingsView connected />);fireEvent.click(await screen.findByRole("checkbox",{name:"显示隐藏文件"}));fireEvent.click(screen.getByRole("button",{name:"保存设置"}));expect(await screen.findByText("网络中断")).toBeInTheDocument();expect(screen.getByRole("checkbox",{name:"显示隐藏文件"})).toBeChecked();
});
