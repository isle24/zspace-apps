import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../api/client";
import { NasModule } from "./NasModule";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * 下载中心的批量操作只有这两个是**实测验证过**的：
 * 2026-10-12 在真机上用空体调用 /downloader/start/all 与 /downloader/stop/all，均返回 200。
 * 单任务 start/stop/del 的参数名（id/gid/hash/ids 全试过）无法确定，所以界面里没有这些按钮。
 */
describe("download window bulk actions", () => {
  it("sends the two verified operations and reports the result", async () => {
    const read = vi.spyOn(api, "read").mockResolvedValue({ items: [], total: 0 } as never);
    render(<NasModule id="downloads" connected onPlay={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /全部开始/ }));
    await waitFor(() => expect(read).toHaveBeenCalledWith("downloads.startAll"));
    expect(await screen.findByText(/已请求全部开始/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /全部暂停/ }));
    await waitFor(() => expect(read).toHaveBeenCalledWith("downloads.stopAll"));
  });

  it("shows the device error instead of pretending the action worked", async () => {
    vi.spyOn(api, "read").mockImplementation(async (operation: string) => {
      if (operation === "downloads.stopAll") throw new Error("设备拒绝了这次请求");
      return { items: [], total: 0 } as never;
    });
    render(<NasModule id="downloads" connected onPlay={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /全部暂停/ }));
    expect(await screen.findByText(/设备拒绝了这次请求/)).toBeTruthy();
  });
});
