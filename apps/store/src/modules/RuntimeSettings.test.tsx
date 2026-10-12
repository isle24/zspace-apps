import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { RuntimeSettings } from "./RuntimeSettings";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  api.storeSession = "";
  delete document.documentElement.dataset.theme;
});
function mockStore(impl: (op: string, body?: any) => Promise<any>) {
  return vi.spyOn(api, "store").mockImplementation((op, body) =>
    op === "v2/maintenance" ? Promise.resolve({ state: "ready" }) : impl(op, body),
  );
}
const settings = {
  theme: "light",
  updateCheckEnabled: true,
  updateCheckHours: 6,
};
it("shows actual source, deployment engine, host facts and unsafe storage without inferring readiness", async () => {
  api.storeSession = "test";
  mockStore(async (op) =>
    op === "v2/settings"
      ? settings
      : {
          storeId: "store-a",
          engineMode: "sshbind",
          version: "v2",
          runtimeSupported: true,
          retention: "all generations, snapshots and failed resources retained",
          source: {
            policy: "固定官方 GHCR 配方",
            publishers: ["immich-app", "jellyfin"],
          },
          facts: {
            platform: "linux/amd64",
            dockerRoot: "/ssd/docker",
            dockerVersion: "27.3.1",
            composeVersion: "2.29.7",
            cpus: 4,
            memoryBytes: 8 * 1073741824,
          },
          storage: {
            dockerStorageSafe: false,
            dockerStorage: { path: "/system/docker", identity: "systemdisk" },
            message: "系统盘禁止安装",
          },
        },
  );
  render(<RuntimeSettings />);
  expect(await screen.findByText("固定官方 GHCR 配方")).toBeInTheDocument();
  expect(screen.getByText("SSH 远程设备")).toBeInTheDocument();
  expect(screen.getByText("linux/amd64")).toBeInTheDocument();
  expect(screen.getByText("/ssd/docker")).toBeInTheDocument();
  expect(screen.getByText("系统盘禁止安装")).toBeInTheDocument();
  expect(screen.getByText("未通过安装存储检查")).toBeInTheDocument();
  expect(screen.getByText(/部署与应用健康仍需分别验收/)).toBeInTheDocument();
  expect(screen.queryByText("部署已完成")).not.toBeInTheDocument();
});
it("keeps diagnostic read failures visible and retries the real endpoint", async () => {
  api.storeSession = "test";
  const read = mockStore(async (op) => {
    if (op === "v2/diagnostics") throw new Error("诊断读取失败");
    return settings;
  });
  render(<RuntimeSettings />);
  expect(await screen.findByRole("alert")).toHaveTextContent("诊断读取失败");
  fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
  await waitFor(() =>
    expect(
      read.mock.calls.filter(([op]) => op === "v2/diagnostics"),
    ).toHaveLength(2),
  );
});
it("shows host fact failure independently of returned deployment metadata", async () => {
  api.storeSession = "test";
  mockStore(async (op) =>
    op === "v2/settings"
      ? settings
      : {
          storeId: "store-b",
          engineMode: "disabled",
          version: "v2",
          runtimeSupported: false,
          factsError: "引擎未启用",
          source: { policy: "固定官方来源", publishers: [] },
          storage: {
            dockerStorageSafe: false,
            dockerStorage: null,
            message: "存储尚未验证",
          },
        },
  );
  render(<RuntimeSettings />);
  expect(await screen.findByText("引擎未启用")).toBeInTheDocument();
  expect(screen.getByText("未启用")).toBeInTheDocument();
  expect(screen.getByText("存储尚未验证")).toBeInTheDocument();
  expect(screen.queryByText("部署已完成")).not.toBeInTheDocument();
});
const dataRoots = [
  {
    id: "r1",
    name: "应用数据盘",
    path: "/ssd/apps",
    roles: ["data"],
    storage: { installAllowed: true, systemDisk: false },
  },
  {
    id: "bad",
    name: "系统盘",
    path: "/system",
    roles: ["data"],
    storage: { installAllowed: false, systemDisk: true },
  },
  {
    id: "media",
    name: "媒体盘",
    path: "/media",
    roles: ["mediaReadOnly"],
    storage: { installAllowed: true, systemDisk: false },
  },
];
it("persists a human selected safe registered root and explicitly clears it with manual choice", async () => {
  api.storeSession = "test";
  const read = mockStore(async (op, body: any) =>
      op === "roots"
        ? { items: dataRoots }
        : op === "v2/settings"
          ? body || { ...settings, defaultRootId: "" }
          : {},
    );
  render(<RuntimeSettings />);
  const select = await screen.findByLabelText("默认应用数据位置");
  await screen.findByRole("option", { name: "应用数据盘 · /ssd/apps" });
  expect(
    screen.queryByRole("option", { name: /系统盘/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("option", { name: /媒体盘/ }),
  ).not.toBeInTheDocument();
  fireEvent.change(select, { target: { value: "r1" } });
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() =>
    expect(read).toHaveBeenCalledWith("v2/settings", {
      ...settings,
      defaultRootId: "r1",
    }),
  );
  await screen.findByText("设置已保存");
  fireEvent.change(select, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() =>
    expect(read).toHaveBeenCalledWith("v2/settings", {
      ...settings,
      defaultRootId: "",
    }),
  );
});
it("presents a removed saved root as manual instead of ready", async () => {
  api.storeSession = "test";
  mockStore(async (op) =>
    op === "roots"
      ? { items: dataRoots }
      : op === "v2/settings"
        ? { ...settings, defaultRootId: "removed" }
        : {},
  );
  render(<RuntimeSettings />);
  await screen.findByRole("option", { name: "应用数据盘 · /ssd/apps" });
  await waitFor(() =>
    expect(screen.getByLabelText("默认应用数据位置")).toHaveValue(""),
  );
});
it.each(["session", "address"])(
  "discards settings returning after %s changes",
  async (mode) => {
    api.storeSession = "test";
    let release!: (value: any) => void;
    mockStore(async (op) =>
      op === "v2/settings"
        ? new Promise((done) => (release = done))
        : op === "roots"
          ? { items: dataRoots }
          : {},
    );
    render(<RuntimeSettings />);
    await waitFor(() => expect(release).toBeDefined());
    if (mode === "session") api.storeSession = "replacement";
    else await api.setStoreAddress("https://settings-changed.example");
    release({ ...settings, defaultRootId: "r1" });
    await screen.findByText(/商店服务或会话已改变/);
    expect(screen.queryByLabelText("默认应用数据位置")).not.toBeInTheDocument();
    if (mode === "address") await api.setStoreAddress("");
  },
);
it.each(["session", "address"])(
  "does not report old preference save successful after %s changes",
  async (mode) => {
    api.storeSession = "test";
    let release!: (value: any) => void;
    mockStore(async (op, body: any) =>
      op === "v2/settings"
        ? body
          ? new Promise((done) => (release = done))
          : { ...settings, defaultRootId: "" }
        : op === "roots"
          ? { items: dataRoots }
          : {},
    );
    render(<RuntimeSettings />);
    await screen.findByRole("option", { name: "应用数据盘 · /ssd/apps" });
    fireEvent.change(screen.getByLabelText("默认应用数据位置"), {
      target: { value: "r1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(release).toBeDefined());
    if (mode === "session") api.storeSession = "replacement";
    else await api.setStoreAddress("https://save-changed.example");
    release({ ...settings, defaultRootId: "r1" });
    await new Promise((done) => setTimeout(done, 0));
    expect(screen.queryByText("设置已保存")).not.toBeInTheDocument();
    if (mode === "address") await api.setStoreAddress("");
  },
);
it("preserves saved default root when roots fail while saving unrelated theme", async () => {
  api.storeSession = "test";
  const read = mockStore(async (op, body: any) => {
    if (op === "roots") throw new Error("目录暂时不可读取");
    if (op === "v2/settings") return body || { ...settings, defaultRootId: "r1" };
    return {};
  });
  render(<RuntimeSettings />);
  const root = await screen.findByLabelText("默认应用数据位置");
  await waitFor(() => expect(root).toBeDisabled());
  expect(root).toHaveValue("r1");
  fireEvent.change(screen.getByLabelText("外观"), { target: { value: "dark" } });
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() => expect(read).toHaveBeenCalledWith("v2/settings", { ...settings, theme: "dark" }));
  await screen.findByText("设置已保存");
});
