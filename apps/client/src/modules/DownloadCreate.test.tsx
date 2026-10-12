import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DownloadCreate } from "./DownloadCreate";
import { api } from "../api/client";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  api.logoutNas();
});

const openDialog = () => {
  render(<DownloadCreate connected dir="/downloads" onDirChange={() => {}} onDone={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "添加下载" }));
};

/** jsdom 不是安全上下文，也没有 clipboard API：要用剪切板的用例必须显式声明能力。 */
function secureClipboard(double?: () => Promise<string>) {
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.assign(navigator, {
    clipboard: { readText: vi.fn(double ?? (async () => "https://clip.example/file.zip")) },
  });
}

describe("add download task", () => {
  it("submits one link per line and reports the count", async () => {
    vi.spyOn(api, "downloadProtocols").mockResolvedValue(["http", "https", "magnet"]);
    const add = vi.spyOn(api, "addDownloadLink").mockResolvedValue(undefined);
    const done = vi.fn();
    render(<DownloadCreate connected dir="/downloads" onDirChange={() => {}} onDone={done} />);
    fireEvent.click(screen.getByRole("button", { name: "添加下载" }));
    fireEvent.change(screen.getByLabelText("下载链接"), {
      target: { value: "https://example.com/a.iso\nmagnet:?xt=urn:btih:abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: /开始下载/ }));
    await waitFor(() => expect(add).toHaveBeenCalledTimes(2));
    expect(add).toHaveBeenCalledWith("https://example.com/a.iso", "/downloads");
    expect(add).toHaveBeenCalledWith("magnet:?xt=urn:btih:abc", "/downloads");
    expect(await screen.findByText("已提交 2 个任务")).toBeInTheDocument();
    expect(done).toHaveBeenCalled();
  });

  it("warns about lines that are not supported links and skips them", async () => {
    // 设备给的协议列表是权威的：这里声明 https，所以 https 链接算合法、"这不是链接" 不算
    vi.spyOn(api, "downloadProtocols").mockResolvedValue(["https", "magnet"]);
    const add = vi.spyOn(api, "addDownloadLink").mockResolvedValue(undefined);
    openDialog();
    fireEvent.change(screen.getByLabelText("下载链接"), {
      target: { value: "https://ok.example/f\n这不是链接" },
    });
    expect(await screen.findByText(/1 行不是受支持的链接格式/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /开始下载/ }));
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    expect(add).toHaveBeenCalledWith("https://ok.example/f", "/downloads");
  });

  it("surfaces the duplicate-task code instead of claiming success", async () => {
    vi.spyOn(api, "downloadProtocols").mockResolvedValue(["https"]);
    vi.spyOn(api, "addDownloadLink").mockRejectedValue(Object.assign(new Error("已有相同任务"), { code: "1000" }));
    openDialog();
    fireEvent.change(screen.getByLabelText("下载链接"), { target: { value: "https://dup.example/x" } });
    fireEvent.click(screen.getByRole("button", { name: /开始下载/ }));
    expect(await screen.findByText(/成功 0 个，失败 1 个/)).toBeInTheDocument();
  });

  it("fills the field from the clipboard when the user asks", async () => {
    vi.spyOn(api, "downloadProtocols").mockResolvedValue(["https"]);
    secureClipboard();
    openDialog();
    fireEvent.click(screen.getByRole("button", { name: /读取剪切板/ }));
    await waitFor(() =>
      expect((screen.getByLabelText("下载链接") as HTMLTextAreaElement).value).toBe("https://clip.example/file.zip"),
    );
  });

  it("tells the user when the browser refuses clipboard access", async () => {
    vi.spyOn(api, "downloadProtocols").mockResolvedValue(["https"]);
    secureClipboard(async () => {
      throw new Error("denied");
    });
    openDialog();
    fireEvent.click(screen.getByRole("button", { name: /读取剪切板/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/不允许读取剪切板/);
  });
});

describe("clipboard capability", () => {
  it("reports unavailable with a reason when the page is not a secure context", async () => {
    const { clipboardSupport } = await import("./DownloadCreate");
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    const result = clipboardSupport();
    expect(result.available).toBe(false);
    expect(result.reason).toContain("HTTPS");
    expect(result.reason).toContain("⌘V");
  });

  it("reports available on a secure context with the clipboard API", async () => {
    const { clipboardSupport } = await import("./DownloadCreate");
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    vi.stubGlobal("navigator", Object.assign(navigator, { clipboard: { readText: async () => "" } }));
    expect(clipboardSupport().available).toBe(true);
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
  });

  it("treats a missing clipboard API as unavailable even on a secure context", async () => {
    const { clipboardSupport } = await import("./DownloadCreate");
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    vi.stubGlobal("navigator", Object.assign(navigator, { clipboard: undefined }));
    expect(clipboardSupport().available).toBe(false);
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
  });
});
