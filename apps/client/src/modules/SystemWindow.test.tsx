import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { api } from "../api/client";
import { SystemWindow } from "./SystemWindow";
afterEach(()=>{cleanup();vi.restoreAllMocks()});
it("routes panel modules to actual views without a raw JSON fallback",async()=>{
 vi.spyOn(api,"read").mockResolvedValue({items:[],values:{file:{show_hidden:0}}});render(<SystemWindow id="system" connected />);
 fireEvent.click(screen.getByRole("button",{name:"文件与存储偏好"}));expect(await screen.findByRole("checkbox",{name:"显示隐藏文件"})).toBeInTheDocument();
 fireEvent.click(screen.getByRole("button",{name:"设备应用"}));expect(await screen.findByRole("button",{name:"发现应用"})).toBeInTheDocument();expect(document.querySelector("pre")).toBeNull();
});
