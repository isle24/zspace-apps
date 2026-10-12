import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DeviceTasks } from "./DeviceTasks";
import { api } from "../api/client";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  api.logoutNas();
});

/** /task/list 的真实字段形状（官方渲染分支里读到的键名）。 */
const tasks = {
  items: [
    { id: "d1", name: "下载：ubuntu.iso", size: 1024,
      metadata: { task_id: "d1", file_name: "ubuntu.iso", name: "ubuntu.iso", type_name: "下载",
        status: "loading", total_size: 1024, download_size: 512, progress: 50, created_time: 1791720000 } },
    { id: "s1", name: "同步到云盘", metadata: { task_id: "s1", name: "同步到云盘", type: "sync",
      status: "success", next_sync_time: 1791806400 } },
  ],
  values: {},
};

describe("device tasks tab", () => {
  it("renders mixed task types with status, progress and sizes", async () => {
    vi.spyOn(api, "read").mockResolvedValue(tasks as never);
    render(<DeviceTasks />);
    expect(await screen.findByText("ubuntu.iso")).toBeInTheDocument();
    expect(screen.getByText(/下载 · 进行中/)).toBeInTheDocument();
    expect(screen.getByText("512 B / 1.0 KB")).toBeInTheDocument();
    expect(screen.getByText("同步到云盘")).toBeInTheDocument();
    expect(screen.getByText(/sync · 已完成/)).toBeInTheDocument();
  });

  it("does not invent status text when the device omits it", async () => {
    vi.spyOn(api, "read").mockResolvedValue({ items: [{ id: "x", name: "未知任务", metadata: {} }], values: {} } as never);
    render(<DeviceTasks />);
    expect(await screen.findByText("未知任务")).toBeInTheDocument();
    expect(screen.getByText("设备未返回更多信息")).toBeInTheDocument();
  });

  it("shows the empty state when there are no tasks", async () => {
    vi.spyOn(api, "read").mockResolvedValue({ items: [], values: {} } as never);
    render(<DeviceTasks />);
    expect(await screen.findByText("这里还没有内容")).toBeInTheDocument();
  });
});
