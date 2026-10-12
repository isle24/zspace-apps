import { afterEach, describe, expect, it, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
  within,
} from "@testing-library/react";
import App from "./App";
import { resetRuntimeConfigCache } from "./api/same-origin";
import { deliverBrowserDownload, type BrowserDownloadOptions, type BrowserDownloadResult } from "./api/browser-download";
vi.mock("./api/browser-download", async (original) => ({ ...await original<typeof import("./api/browser-download")>(), deliverBrowserDownload: vi.fn() }));
import { api } from "./api/client";
import { officialFixture, officialJson } from "./api/direct-test-fixture";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  api.logoutNas();
  api.storeSession = "";
});
/**
 * 应用启动时会读取一次静态部署配置（runtime-config.json），这不是 NAS/商店请求。
 * 断言"没有对外请求"时把它排除掉，保持原意。
 */
const externalCalls = (fetcher: ReturnType<typeof vi.fn>) =>
  fetcher.mock.calls.filter((call) => {
    const target = String(call[0]);
    return !target.endsWith("runtime-config.json");
  });

it("preview opens and closes a file window without a NAS mutation", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "先体验桌面" }));
  fireEvent.click(screen.getByRole("button", { name: "文件管理" }));
  expect(
    await screen.findByRole("region", { name: "文件管理窗口" }),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByText("连接 NAS，打开你的空间")).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("button", { name: "关闭文件管理" }));
  expect(
    screen.queryByRole("region", { name: "文件管理窗口" }),
  ).not.toBeInTheDocument();
  expect(externalCalls(fetcher)).toHaveLength(0);
});
it("shows a failed official connection without entering a fake desktop", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new TypeError("network unavailable")),
  );
  render(<App />);
  fireEvent.change(await screen.findByLabelText("设备地址"), {
    target: { value: "http://synthetic.invalid:5055" },
  });
  fireEvent.change(screen.getByLabelText("账号"), {
    target: { value: "fixture" },
  });
  fireEvent.change(screen.getByLabelText("密码"), {
    target: { value: "synthetic-only" },
  });
  fireEvent.click(screen.getByRole("button", { name: "登录" }));
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "文件管理" }),
  ).not.toBeInTheDocument();
});
it("returns to login when the official NAS session expires", async () => {
  vi.stubGlobal(
    "fetch",
    officialFixture(() => officialJson({ code: "N001208", msg: "expired" })),
  );
  render(<App />);
  fireEvent.change(await screen.findByLabelText("设备地址"), {
    target: { value: "http://synthetic.invalid:5055" },
  });
  fireEvent.change(screen.getByLabelText("账号"), {
    target: { value: "fixture" },
  });
  fireEvent.change(screen.getByLabelText("密码"), {
    target: { value: "synthetic-only" },
  });
  fireEvent.click(screen.getByRole("button", { name: "登录" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("NAS 登录已失效");
  expect(api.nasSession).toBe("");
});
it("tests official public-key connectivity without logging in or calling a shop service", async () => {
  const fetcher = vi.fn(officialFixture());
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  fireEvent.change(await screen.findByLabelText("设备地址"), {
    target: { value: "http://synthetic.invalid:5055" },
  });
  fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "官方 API 可达，尚未登录",
  );
  const calls = externalCalls(fetcher);
  expect(calls).toHaveLength(1);
  expect(new URL(String(calls[0][0])).pathname).toBe("/key/pub");
  expect(api.nasSession).toBe("");
});
it("does not submit login while an official public-key probe is in progress", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );
  render(<App />);
  fireEvent.change(await screen.findByLabelText("设备地址"), {
    target: { value: "http://synthetic.invalid:5055" },
  });
  fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
  expect(screen.getByRole("button", { name: "登录" })).toBeDisabled();
});

async function loginDesktop() {
  vi.stubGlobal("fetch", officialFixture());
  render(<App />);
  fireEvent.change(await screen.findByLabelText("设备地址"), { target: { value: "http://synthetic.invalid:5055" } });
  fireEvent.change(screen.getByLabelText("账号"), { target: { value: "fixture" } });
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: "synthetic-only" } });
  fireEvent.click(screen.getByRole("button", { name: "登录" }));
  await screen.findByRole("button", { name: "文件管理" });
}

it("does not render legacy localStorage remote tiles in the disconnected desktop", async () => {
  localStorage.setItem("space-desktop:shortcuts:v1", JSON.stringify([{ id: "legacy", name: "过期的本机入口", url: "https://old.test", onDesktop: true }]));
  try {
    vi.stubGlobal("fetch", vi.fn());
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "先体验桌面" }));
    expect(screen.queryByText("过期的本机入口")).not.toBeInTheDocument();
  } finally { localStorage.removeItem("space-desktop:shortcuts:v1"); }
});

it("renders only desktop-visible remote entries returned by the current NAS", async () => {
  const entries = vi.spyOn(api, "remoteEntries").mockResolvedValue([
    { id: "remote-1", name: "实际远程入口", address: "http://nas.test:8080", url: "http://nas.test:8080", proxy: false, desktopVisible: true },
    { id: "remote-2", name: "未放到桌面的入口", address: "http://nas.test:9000", url: "http://nas.test:9000", proxy: false, desktopVisible: false },
    { id: "remote-3", name: "缺少可用地址", address: "invalid", proxy: false, desktopVisible: true },
  ]);
  await loginDesktop();
  expect(await screen.findByRole("link", { name: "实际远程入口" })).toHaveAttribute("href", "http://nas.test:8080");
  expect(screen.queryByText("未放到桌面的入口")).not.toBeInTheDocument();
  expect(screen.queryByText("缺少可用地址")).not.toBeInTheDocument();
  expect(entries).toHaveBeenCalledOnce();
});
it("shows one fixed NAS expiry sentence and clears NAS authority without reflecting event details", async () => {
  await loginDesktop();
  const logout = vi.spyOn(api, "logoutNas");
  await act(async () => { window.dispatchEvent(new CustomEvent("space-session-expired", { detail: { scope: "nas", message: "NAS 登录已失效，请重新登录。http://private?token=secret" } })); });
  expect(await screen.findByRole("alert")).toHaveTextContent(/^NAS 登录已失效，请重新登录。$/);
  expect(logout).toHaveBeenCalledOnce();
  expect(api.nasSession).toBe("");
  expect(document.body.textContent).not.toMatch(/private|token=secret/);
});
it("opens the same local task view from status and desktop without store authorization", async () => {
  vi.stubGlobal("fetch", vi.fn()); render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "先体验桌面" }));
  fireEvent.click(screen.getByRole("button", { name: "打开任务中心" }));
  expect(await screen.findByText("还没有本机下载任务")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "关闭任务中心" }));
  fireEvent.click(screen.getByRole("button", { name: "任务中心" }));
  expect(screen.getByText("还没有本机下载任务")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "商店安装" })).toBeInTheDocument();
});
it("revokes NAS downloads while preserving an independently logged-in shop", async () => {
  const file = { id: "file", name: "实际文件.txt", path: "/file.txt", kind: "file" };
  vi.spyOn(api, "read").mockResolvedValue({ items: [file], total: 1 });
  vi.spyOn(api, "prepareDownload").mockImplementation(async () => ({ id: "a".repeat(64), name: file.name, sessionId: api.nasSession }));
  let delivery!: BrowserDownloadOptions, finish!: (result: BrowserDownloadResult) => void;
  vi.mocked(deliverBrowserDownload).mockImplementation(options => { delivery = options; return new Promise(resolve => { finish = resolve; }); });
  const storeLogout = vi.spyOn(api, "logoutStore");
  await loginDesktop();
  fireEvent.click(screen.getByRole("button", { name: "文件管理" }));
  fireEvent.click(await screen.findByRole("button", { name: /实际文件.txt/ }));
  fireEvent.click(screen.getByRole("button", { name: "下载到本机" }));
  await waitFor(() => expect(deliverBrowserDownload).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "关闭文件管理" }));
  expect(delivery.signal?.aborted).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "打开任务中心" }));
  expect(within(screen.getByRole("region", { name: "任务中心窗口" })).getByText("实际文件.txt")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "打开账号面板" }));
  api.storeSession = "independent-password-session";
  fireEvent.click(screen.getByRole("button", { name: "退出并切换设备" }));
  expect(storeLogout).not.toHaveBeenCalled(); expect(api.nasSession).toBe(""); expect(delivery.signal?.aborted).toBe(true);
  expect(api.storeSession).toBe("independent-password-session");
  await act(async () => { finish({ received: 8, method: "blob", outcome: "handed-to-browser", diskCompletion: "unknown" }); });
  expect(await screen.findByRole("button", { name: "登录" })).toBeInTheDocument();
});

it("returns focus to the desktop entry after its running Dock entry is removed", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "先体验桌面" }));
  const desktopEntry = screen.getByRole("button", { name: "文件管理" });
  desktopEntry.focus();
  fireEvent.click(desktopEntry);
  expect(await screen.findByRole("region", { name: "文件管理窗口" })).toBeInTheDocument();
  const railEntry = screen.getByRole("button", { name: "打开文件管理" });
  railEntry.focus();
  fireEvent.click(screen.getByRole("button", { name: "关闭文件管理" }));
  await waitFor(() => expect(document.activeElement).toBe(desktopEntry));
});

it("puts focus in the launchpad search and hands it back on Escape", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "先体验桌面" }));
  const launcher = screen.getByRole("button", { name: "显示全部应用" });
  launcher.focus();
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  const search = await screen.findByRole("textbox", { name: "搜索应用名称" });
  await waitFor(() => expect(document.activeElement).toBe(search));
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(launcher));
});

it("filters the launchpad grid by the search box", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "先体验桌面" }));
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  const search = await screen.findByRole("textbox", { name: "搜索应用名称" });
  fireEvent.change(search, { target: { value: "相册" } });
  const dialog = screen.getByRole("dialog", { name: "全部应用" });
  expect(within(dialog).getByRole("button", { name: /相册/ })).toBeInTheDocument();
  expect(within(dialog).queryByRole("button", { name: /Docker/ })).not.toBeInTheDocument();
});

describe("登录页的设备地址", () => {
  // loadRuntimeConfig 的 promise 是模块级缓存，跨用例会串味，必须重置
  afterEach(() => resetRuntimeConfigCache());

  /** 部署期配置给出 NAS 地址时，登录页不该再让用户填一遍 */
  it("已知地址时隐藏地址栏，并且可以手动展开", async () => {
    resetRuntimeConfigCache();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("runtime-config.json")) {
        return { ok: true, json: async () => ({ nasOrigin: "http://192.168.3.56:5055" }) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    vi.stubGlobal("fetch", fetcher);
    render(<App />);

    // 配置到达之前先不显示输入框，配置到达之后也不该出现
    await waitFor(() => expect(screen.queryByLabelText("设备地址")).toBeNull());
    expect(screen.getByLabelText("账号")).toBeInTheDocument();
    // 副标题显示已知地址（不带协议）
    await waitFor(() => expect(screen.getByText("192.168.3.56:5055")).toBeInTheDocument());

    // 仍然留了改地址的入口
    fireEvent.click(screen.getByRole("button", { name: "更改设备地址" }));
    const field = await screen.findByLabelText("设备地址");
    expect((field as HTMLInputElement).value).toBe("http://192.168.3.56:5055");
    fireEvent.click(screen.getByRole("button", { name: "收起设备地址" }));
    await waitFor(() => expect(screen.queryByLabelText("设备地址")).toBeNull());
  });

  it("没有任何地址来源时仍然让用户填", async () => {
    resetRuntimeConfigCache();
    const fetcher = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response);
    vi.stubGlobal("fetch", fetcher);
    render(<App />);
    expect(await screen.findByLabelText("设备地址")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "更改设备地址" })).toBeNull();
  });
});

describe("窗口快捷键", () => {
  /**
   * 桌面客户端的通用习惯：⌘W 关最前窗口、⌘M 最小化最前窗口。
   * 浏览器里 ⌘W 归浏览器管（preventDefault 拦不住），到原生客户端才真正生效。
   */
  it("⌘W 关闭最前窗口", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "先体验桌面" }));
    fireEvent.click(screen.getByRole("button", { name: "文件管理" }));
    expect(await screen.findByRole("region", { name: "文件管理窗口" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "w", metaKey: true });
    await waitFor(() => expect(screen.queryByRole("region", { name: "文件管理窗口" })).toBeNull());
  });

  it("⌘M 最小化最前窗口，全部最小化后快捷键不再误伤", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "先体验桌面" }));
    fireEvent.click(screen.getByRole("button", { name: "文件管理" }));
    fireEvent.click(screen.getByRole("button", { name: "相册" }));
    expect(await screen.findByRole("region", { name: "相册窗口" })).toBeInTheDocument();

    // 最前的是相册，⌘M 应该只收起它
    fireEvent.keyDown(window, { key: "m", metaKey: true });
    await waitFor(() => expect(screen.getByRole("region", { name: "相册窗口" })).toHaveClass("window-hidden"));
    expect(screen.getByRole("region", { name: "文件管理窗口" })).not.toHaveClass("window-hidden");

    // 再按一次：这时最前的是文件管理
    fireEvent.keyDown(window, { key: "m", metaKey: true });
    await waitFor(() => expect(screen.getByRole("region", { name: "文件管理窗口" })).toHaveClass("window-hidden"));

    // 全都最小化之后，⌘W 不该关掉任何东西（没有"最前窗口"）
    const before = screen.getAllByRole("region").length;
    fireEvent.keyDown(window, { key: "w", metaKey: true });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(screen.getAllByRole("region").length).toBe(before);
  });
});

describe("置灰控件要说明原因", () => {
  /**
   * 「保持登录」在网页版是**故意置灰**的（网页没有原生钥匙串，不保存凭据），
   * 只有桌面客户端能勾。但灰着不说话最容易被当成 bug —— 实测在浏览器里
   * 键盘用户根本跳不到它（disabled 元素不参与 Tab），界面上也没有任何解释。
   * 所以把原因写出来，并用例钉住。
   */
  it("网页版：保持登录置灰并说明", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response));
    render(<App />);
    const box = (await screen.findByLabelText(/保持登录/)) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(screen.getByText("网页版不保存凭据")).toBeInTheDocument();
    expect(box.getAttribute("title")).toContain("桌面客户端可勾选");
  });
});
