import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
  within,
} from "@testing-library/react";
import { Store } from "./Store";
import { StrictMode } from "react";
import { api } from "../api/client";
const storage = {
  path: "/synthetic",
  mountPoint: "/synthetic",
  source: "/dev/sda1",
  filesystem: "ext4",
  identity: "fixture",
  volumeType: "ssd",
  freeBytes: 1e10,
  totalBytes: 2e10,
  systemDisk: false,
  verifiedDataPool: true,
  installAllowed: true,
  mediaReadAllowed: true,
  reason: "fixture",
};
let requiresMedia = false;
let dockerSafe = true;
let requests: { path: string; body: any }[] = [];
let jobRows: any[] = [];
let instanceRows: any[] = [];
let retryPlanGate: Promise<void> | undefined;
let installGate: Promise<void> | undefined;
let installFailures = 0;
let logoutGate: Promise<void> | undefined;
let kumaFixture = false;
let retryPlanOverride: Record<string, unknown> = {};
beforeEach(() => {
  api.storeSession = "";
  requests = [];
  requiresMedia = false;
  dockerSafe = true;
  jobRows = [];
  instanceRows = [];
  retryPlanGate = undefined;
  installGate = undefined;
  installFailures = 0;
  logoutGate = undefined;
  kumaFixture = false;
  retryPlanOverride = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      const path = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path, body });
      if (path.endsWith("/retry-plan")) await retryPlanGate;
      if (path.endsWith("/logout")) await logoutGate;
      if (path.endsWith("/install")) {
        await installGate;
        if (installFailures-- > 0)
          throw new Error("Synthetic connection interrupted");
      }
      const payload = path.endsWith("/status")
        ? { configured: true, engineReady: true }
        : path.endsWith("/catalog")
          ? {
              items: [
                {
                  id: kumaFixture ? "uptime-kuma" : "synthetic-media",
                  name: kumaFixture ? "Uptime Kuma" : "Synthetic Media",
                  category: "影音",
                  description: "Synthetic fixture only",
                  version: "1",
                  image: "example/fixture:1",
                  installable: true,
                  defaultPort: 8096,
                  requiresMedia,
                },
              ],
            }
          : path.endsWith("/roots")
            ? {
                items: [
                  {
                    id: "storage",
                    name: "Fixture root",
                    path: "/synthetic",
                    roles: ["data", "mediaReadOnly"],
                    storage,
                  },
                  {
                    id: "music-library",
                    name: "Existing music",
                    path: "/media/music",
                    roles: ["mediaReadOnly"],
                    storage: {
                      ...storage,
                      path: "/media/music",
                      mountPoint: "/media",
                      identity: "different-media-disk",
                    },
                  },
                ],
              }
            : path.endsWith("/storage")
              ? {
                  items: [storage],
                  dockerStorage: storage,
                  dockerStorageSafe: dockerSafe,
                  message: "",
                }
              : path.endsWith("/retry-plan")
                ? {
                    id: "retry-plan-from-server",
                    appId: kumaFixture ? "uptime-kuma" : "synthetic-media",
                    instanceId: "instance-1",
                    containerName: "synthetic",
                    dataPath: "/synthetic/new-instance",
                    rootPath: "/synthetic",
                    storageIdentity: "fixture",
                    dockerStorageIdentity: "fixture",
                    image: kumaFixture
                      ? body?.imageSource === "ghcr"
                        ? "ghcr.io/louislam/uptime-kuma:2.5.6"
                        : "louislam/uptime-kuma:2.5.6"
                      : "original:image",
                    ...(kumaFixture && body?.imageSource === "ghcr"
                      ? { previousImage: "louislam/uptime-kuma:2.5.6" }
                      : {}),
                    hostPort: 8096,
                    expiresAt: "2030-02-01T00:00:00Z",
                    accessUrl: "http://synthetic-app.invalid:8096/",
                    mounts: [
                      { source: "/synthetic/new-instance", target: "/data" },
                    ],
                    retryOfPlanId: "original-plan",
                    retryOfJobId: "failed-job",
                    ...retryPlanOverride,
                  }
                : path.endsWith("/plans")
                  ? {
                      id: "plan-from-server",
                      appId: "synthetic-media",
                      dataPath: "/synthetic/new-instance",
                      image: "verified:image",
                      hostPort: 8096,
                      expiresAt: "2030-01-01T00:00:00Z",
                      accessUrl: "http://localhost:8096",
                      mounts: [],
                    }
                  : path.endsWith("/install")
                    ? {
                        id: "job-1",
                        instanceId: "instance-1",
                        status: "queued",
                      }
                    : path.endsWith("/jobs")
                      ? { items: jobRows }
                      : path.endsWith("/instances")
                        ? { items: instanceRows }
                        : { items: [] };
      return new Response(JSON.stringify({ ok: true, data: payload }));
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  api.storeSession = "";
  vi.useRealTimers();
});
function runtimeRefreshFixture() {
  api.storeSession = "runtime-refresh-session";
  return vi.spyOn(api, "store").mockImplementation(async (op, body: any) => {
    if (op === "v2/catalog") return { items: [{ id: "uptime-kuma", name: "Uptime Kuma", description: "监控", category: "monitoring",
      version: "2.5.6", availableVersions: ["2.5.6", "2.5.5"], latestVersion: "2.5.6", upgradeAllowed: true,
      checkedAt: "2026-10-12T00:00:00Z", sourceStatus: "ok", defaultPort: 3001, installable: true, requiresMedia: false }], categories: [] };
    if (op === "v2/settings") return { defaultRootId: "storage", theme: "light" };
    if (op === "roots") return { items: [{ id: "storage", name: "Fixture root", path: "/synthetic", roles: ["data"], storage }] };
    if (op === "storage") return { items: [storage], dockerStorageSafe: true };
    if (op === "v2/catalog/refresh") return { status: "queued" };
    if (op === "v2/plans") return { id: "runtime-plan", kind: body.kind, appId: body.appId, instanceId: "new-instance", targetVersion: body.targetVersion,
      dataPath: "/synthetic/new", hostPort: 3001, expiresAt: "2030-01-01T00:00:00Z", images: [], recipe: { name: "Uptime Kuma", services: [] } };
    return { items: [] };
  });
}
it("refreshes the mounted v2 catalog and instances through the store button while preserving installation input", async () => {
  const store = runtimeRefreshFixture();
  render(<Store initialTab="runtime" onInstances={() => {}} />);
  await screen.findByRole("button", { name: "查看 Uptime Kuma" });
  fireEvent.click(screen.getByRole("button", { name: "安装" }));
  const dialog = await screen.findByRole("dialog", { name: "安装 Uptime Kuma" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: /新实例目录名/ }), { target: { value: "kept-input" } });
  const catalogReads = store.mock.calls.filter(([op]) => op === "v2/catalog").length;
  const instanceReads = store.mock.calls.filter(([op]) => op === "v2/instances").length;
  fireEvent.click(screen.getByRole("button", { name: "刷新商店" }));
  await waitFor(() => expect(store.mock.calls.filter(([op]) => op === "v2/catalog")).toHaveLength(catalogReads + 1));
  expect(store.mock.calls.filter(([op]) => op === "v2/instances")).toHaveLength(instanceReads + 1);
  expect(screen.getByRole("dialog", { name: "安装 Uptime Kuma" })).toBe(dialog);
  expect(within(dialog).getByRole("textbox", { name: /新实例目录名/ })).toHaveValue("kept-input");
});
it("preserves the immutable runtime review and explicit confirmation when only store data is refreshed", async () => {
  runtimeRefreshFixture();
  render(<Store initialTab="runtime" onInstances={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "安装" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "生成安装计划" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "生成安装计划" }));
  const dialog = await screen.findByRole("dialog", { name: "确认操作计划" });
  fireEvent.click(within(dialog).getByRole("checkbox", { name: /已核对/ }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "刷新商店" })));
  expect(screen.getByRole("dialog", { name: "确认操作计划" })).toBe(dialog);
  expect(within(dialog).getByRole("checkbox", { name: /已核对/ })).toBeChecked();
  expect(within(dialog).getByText("runtime-plan")).toBeInTheDocument();
});
it("cancels the old catalog polling loop before a manual store data refresh", async () => {
  const store = runtimeRefreshFixture();
  render(<Store initialTab="runtime" onInstances={() => {}} />);
  await screen.findByRole("button", { name: "查看 Uptime Kuma" });
  vi.useFakeTimers();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "检查官方版本" })));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "刷新商店" })));
  expect(screen.getByRole("button", { name: "检查官方版本" })).toBeEnabled();
  const reads = store.mock.calls.filter(([op]) => op === "v2/catalog").length;
  await act(async () => vi.advanceTimersByTimeAsync(120000));
  expect(store.mock.calls.filter(([op]) => op === "v2/catalog")).toHaveLength(reads);
  expect(screen.queryByText(/版本检查完成|版本检查超时/)).not.toBeInTheDocument();
});
it("requires review of the actual immutable plan before install", async () => {
  api.storeSession = "synthetic-session";
  const done = vi.fn();
  render(<Store onInstances={done} />);
  fireEvent.click(await screen.findByRole("button", { name: "查看" }));
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "存储空间" })).toHaveValue(
      "storage",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));
  fireEvent.click(screen.getByRole("button", { name: "生成安装计划" }));
  expect(
    await screen.findByText("/synthetic/new-instance"),
  ).toBeInTheDocument();
  const install = screen.getByRole("button", { name: "确认并开始安装" });
  expect(install).toBeDisabled();
  expect(requests.filter((r) => r.path.endsWith("/install"))).toHaveLength(0);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(install);
  await waitFor(() =>
    expect(requests.filter((r) => r.path.endsWith("/install"))).toHaveLength(1),
  );
  const request = requests.find((r) => r.path.endsWith("/install"));
  expect(request?.body.planId).toBe("plan-from-server");
  expect(request?.body).not.toHaveProperty("dataPath");
});
it("opens installation wizard when randomUUID is absent over LAN HTTP", async () => {
  api.storeSession = "synthetic-session";
  const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  Object.defineProperty(crypto, "randomUUID", {
    value: undefined,
    configurable: true,
  });
  try {
    render(<Store onInstances={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "安装 Synthetic Media",
    );
  } finally {
    if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor);
    else delete (crypto as any).randomUUID;
  }
});
it("requires media selection before advancing a media-required installation", async () => {
  requiresMedia = true;
  api.storeSession = "synthetic";
  render(<Store onInstances={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "查看" }));
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));
  await screen.findByText("Docker 镜像存储位置");
  expect(screen.getByRole("button", { name: "下一步" })).toBeDisabled();
  fireEvent.change(
    screen.getByRole("combobox", { name: "媒体根目录（只读，必选）" }),
    { target: { value: "storage" } },
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "下一步" })).toBeEnabled(),
  );
});
it("never generates a plan when Docker image storage is unsafe", async () => {
  dockerSafe = false;
  api.storeSession = "synthetic";
  render(<Store onInstances={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "查看" }));
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));
  await screen.findByText(
    "镜像位置未通过检查，请核对检测原因及 Docker 数据位置。",
  );
  expect(screen.getByRole("button", { name: "下一步" })).toBeDisabled();
  expect(requests.some((r) => r.path.endsWith("/plans"))).toBe(false);
});
it("logs out on the server when the store account is closed", async () => {
  api.storeSession = "synthetic";
  render(<Store onInstances={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "管理员已登录" }));
  fireEvent.click(screen.getByRole("button", { name: "退出商店账号" }));
  await waitFor(() =>
    expect(requests.some((r) => r.path.endsWith("/logout"))).toBe(true),
  );
  expect(api.storeSession).toBe("");
});
it("keeps the SSD data root while submitting a separate registered music root", async () => {
  requiresMedia = true;
  api.storeSession = "synthetic";
  render(<Store onInstances={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "查看" }));
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "存储空间" })).toHaveValue(
      "storage",
    ),
  );
  fireEvent.change(
    screen.getByRole("combobox", { name: "媒体根目录（只读，必选）" }),
    { target: { value: "music-library" } },
  );
  const path = screen.getByRole("textbox", { name: /音乐库路径/ });
  fireEvent.change(path, { target: { value: "/elsewhere/music" } });
  expect(screen.getByRole("button", { name: "下一步" })).toBeDisabled();
  fireEvent.change(path, { target: { value: "/media/music/albums" } });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "下一步" })).toBeEnabled(),
  );
  expect(screen.getByRole("combobox", { name: "存储空间" })).toHaveValue(
    "storage",
  );
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));
  fireEvent.click(screen.getByRole("button", { name: "生成安装计划" }));
  await waitFor(() =>
    expect(requests.find((r) => r.path.endsWith("/plans"))?.body).toMatchObject(
      {
        rootId: "storage",
        mediaRootId: "music-library",
        mediaPath: "/media/music/albums",
      },
    ),
  );
});
const healthyInstance = () => ({
  id: "instance-1",
  appId: "synthetic-media",
  containerName: "synthetic",
  dataPath: "/synthetic/new-instance",
  hostPort: 8096,
  accessUrl: "http://synthetic-app.invalid:8096/",
  state: "running",
  health: "healthy",
  initialization: "pending",
  nativeIntegration: {
    status: "handoff",
    configUrl: "",
    reason: "Synthetic official registration requires manual configuration",
  },
});
async function submitTrackedInstallation() {
  api.storeSession = "synthetic-session";
  render(<Store onInstances={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "查看" }));
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "存储空间" })).toHaveValue(
      "storage",
    ),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "下一步" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));
  fireEvent.click(screen.getByRole("button", { name: "生成安装计划" }));
  await screen.findByText("/synthetic/new-instance");
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "确认并开始安装" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "安装 Synthetic Media" }),
    ).not.toBeInTheDocument(),
  );
}
async function refreshJob(status: string) {
  jobRows = [{ id: "job-1", instanceId: "instance-1", status, stage: status }];
  fireEvent.click(screen.getByRole("button", { name: "刷新商店" }));
  await screen.findByText(taskStatusLabel(status), {
    selector: ".job-list .tag",
  });
}
it("prompts once after this installation completes and becomes healthy without automatically opening a tab", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  await submitTrackedInstallation();
  expect(
    screen.queryByRole("dialog", { name: "Synthetic Media 已就绪" }),
  ).not.toBeInTheDocument();
  instanceRows = [healthyInstance()];
  await refreshJob("completed");
  expect(
    await screen.findByRole("dialog", { name: "Synthetic Media 已就绪" }),
  ).toBeInTheDocument();
  const link = screen.getByRole("link", { name: "打开应用初始化" });
  expect(link).toHaveAttribute("href", "http://synthetic-app.invalid:8096/");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(open).not.toHaveBeenCalled();
  expect(
    screen.getByText(
      "Synthetic official registration requires manual configuration",
    ),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "稍后配置" }));
  await refreshJob("completed");
  expect(
    screen.queryByRole("dialog", { name: "Synthetic Media 已就绪" }),
  ).not.toBeInTheDocument();
});
it.each([
  ["stopped", "healthy"],
  ["running", "starting"],
])(
  "waits for both running and healthy when state is %s and health is %s",
  async (state, health) => {
    await submitTrackedInstallation();
    instanceRows = [{ ...healthyInstance(), state, health }];
    await refreshJob("completed");
    expect(
      screen.queryByRole("dialog", { name: "Synthetic Media 已就绪" }),
    ).not.toBeInTheDocument();
    instanceRows = [healthyInstance()];
    await refreshJob("completed");
    expect(
      await screen.findByRole("dialog", { name: "Synthetic Media 已就绪" }),
    ).toBeInTheDocument();
  },
);
it.each(["failed", "needs_attention"])(
  "does not resurrect the initialization prompt after a tracked task becomes %s",
  async (status) => {
    await submitTrackedInstallation();
    instanceRows = [healthyInstance()];
    await refreshJob(status);
    expect(
      screen.queryByRole("dialog", { name: "Synthetic Media 已就绪" }),
    ).not.toBeInTheDocument();
    await refreshJob("completed");
    expect(
      screen.queryByRole("dialog", { name: "Synthetic Media 已就绪" }),
    ).not.toBeInTheDocument();
  },
);
it("never prompts for an unrelated previously completed task", async () => {
  api.storeSession = "synthetic-session";
  jobRows = [
    {
      id: "job-1",
      instanceId: "instance-1",
      status: "completed",
      stage: "completed",
    },
  ];
  instanceRows = [healthyInstance()];
  render(<Store initialTab="jobs" onInstances={() => {}} />);
  await screen.findByText("已完成", { selector: ".job-list .tag" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("drops the tracked follow-up when the store session changes", async () => {
  await submitTrackedInstallation();
  act(() => {
    api.storeSession = "another-session";
  });
  instanceRows = [healthyInstance()];
  await refreshJob("completed");
  expect(
    screen.queryByRole("dialog", { name: "Synthetic Media 已就绪" }),
  ).not.toBeInTheDocument();
});
it("drops the tracked follow-up when the service-address event is received", async () => {
  await submitTrackedInstallation();
  act(() => {
    window.dispatchEvent(new Event("space-store-address"));
  });
  instanceRows = [healthyInstance()];
  await refreshJob("completed");
  expect(
    screen.queryByRole("dialog", { name: "Synthetic Media 已就绪" }),
  ).not.toBeInTheDocument();
});
it("does not associate another instance or another job with this installation", async () => {
  await submitTrackedInstallation();
  instanceRows = [{ ...healthyInstance(), id: "another-instance" }];
  await refreshJob("completed");
  expect(
    screen.queryByRole("dialog", { name: "Synthetic Media 已就绪" }),
  ).not.toBeInTheDocument();
  instanceRows = [healthyInstance()];
  jobRows = [
    {
      id: "another-job",
      instanceId: "instance-1",
      status: "completed",
      stage: "completed",
    },
  ];
  fireEvent.click(screen.getByRole("button", { name: "刷新商店" }));
  await screen.findByText("已完成", { selector: ".job-list .tag" });
  expect(
    screen.queryByRole("dialog", { name: "Synthetic Media 已就绪" }),
  ).not.toBeInTheDocument();
});
it("suppresses initialization when the completed instance access URL contains credentials", async () => {
  await submitTrackedInstallation();
  instanceRows = [
    {
      ...healthyInstance(),
      accessUrl: "http://name:secret@synthetic-app.invalid/",
    },
  ];
  await refreshJob("completed");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "未返回可用的应用访问地址",
  );
  expect(
    screen.queryByRole("dialog", { name: "Synthetic Media 已就绪" }),
  ).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain("name:secret");
});

function taskStatusLabel(status: string) {
  return (
    (
      {
        queued: "排队中",
        running: "执行中",
        completed: "已完成",
        failed: "失败",
        needs_attention: "需处理",
      } as Record<string, string>
    )[status] || status
  );
}
async function openFailedInstance(state = "failed", strict = false) {
  api.storeSession = "synthetic-session";
  instanceRows = [{ ...healthyInstance(), state, health: "unknown" }];
  if (!jobRows.length)
    jobRows = [
      {
        id: "failed-job",
        instanceId: "instance-1",
        status: state,
        stage: "pull",
      },
    ];
  const shop = <Store initialTab="installed" onInstances={() => {}} />;
  render(strict ? <StrictMode>{shop}</StrictMode> : shop);
  return screen.findByRole("button", { name: "生成重试计划" });
}
it.each(["failed", "needs_attention"])(
  "reviews retained scope before retrying a %s installation and tracks its existing instance",
  async (state) => {
    fireEvent.click(await openFailedInstance(state));
    const dialog = await screen.findByRole("dialog", {
      name: "重试 Synthetic Media",
    });
    expect(
      within(dialog).getByText("/synthetic/new-instance"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("original:image")).toBeInTheDocument();
    expect(within(dialog).getByText("8096")).toBeInTheDocument();
    expect(within(dialog).getByText("synthetic")).toBeInTheDocument();
    const generate = requests.filter((r) => r.path.endsWith("/retry-plan"));
    expect(generate).toHaveLength(1);
    expect(generate[0].path).toContain("/instances/instance-1/retry-plan");
    expect(generate[0].body).toEqual({});
    const install = within(dialog).getByRole("button", {
      name: "确认并开始安装",
    });
    expect(install).toBeDisabled();
    expect(requests.some((r) => r.path.endsWith("/install"))).toBe(false);
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(install);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(requests.find((r) => r.path.endsWith("/install"))?.body).toEqual({
      planId: "retry-plan-from-server",
      requestId: expect.any(String),
    });
    instanceRows = [healthyInstance()];
    await refreshJob("completed");
    expect(
      await screen.findByRole("dialog", { name: "Synthetic Media 已就绪" }),
    ).toBeInTheDocument();
  },
);
it.each(["queued", "running"])(
  "does not generate a retry plan when the instance already has a %s task",
  async (status) => {
    jobRows = [
      { id: "active-job", instanceId: "instance-1", status, stage: "pull" },
    ];
    api.storeSession = "synthetic-session";
    instanceRows = [{ ...healthyInstance(), state: "failed" }];
    render(<Store initialTab="installed" onInstances={() => {}} />);
    await screen.findByRole("heading", { name: "Synthetic Media" });
    expect(
      screen.queryByRole("button", { name: "生成重试计划" }),
    ).not.toBeInTheDocument();
    expect(requests.some((r) => r.path.endsWith("/retry-plan"))).toBe(false);
  },
);
it("blocks confirmation when an active task appears after reviewing the retry plan", async () => {
  fireEvent.click(await openFailedInstance());
  const dialog = await screen.findByRole("dialog", {
    name: "重试 Synthetic Media",
  });
  fireEvent.click(within(dialog).getByRole("checkbox"));
  jobRows = [
    {
      id: "active-job",
      instanceId: "instance-1",
      status: "running",
      stage: "pull",
    },
  ];
  fireEvent.click(screen.getByRole("button", { name: "刷新商店" }));
  await within(dialog).findByText(
    "此实例已有活动安装任务，请等待任务结束后再重试。",
  );
  expect(
    within(dialog).getByRole("button", { name: "确认并开始安装" }),
  ).toBeDisabled();
  expect(requests.some((r) => r.path.endsWith("/install"))).toBe(false);
});
it("submits a reviewed retry once while the install request is pending", async () => {
  let resolve!: () => void;
  installGate = new Promise<void>((done) => {
    resolve = done;
  });
  fireEvent.click(await openFailedInstance());
  const dialog = await screen.findByRole("dialog", {
    name: "重试 Synthetic Media",
  });
  fireEvent.click(within(dialog).getByRole("checkbox"));
  const install = within(dialog).getByRole("button", {
    name: "确认并开始安装",
  });
  fireEvent.click(install);
  fireEvent.click(install);
  await waitFor(() =>
    expect(requests.filter((r) => r.path.endsWith("/install"))).toHaveLength(1),
  );
  await act(async () => resolve());
});
it.each(["session", "address"])(
  "discards a reviewed retry when the store %s changes",
  async (scope) => {
    fireEvent.click(await openFailedInstance());
    const dialog = await screen.findByRole("dialog", {
      name: "重试 Synthetic Media",
    });
    fireEvent.click(within(dialog).getByRole("checkbox"));
    act(() => {
      if (scope === "session") api.storeSession = "another-session";
      else window.dispatchEvent(new Event("space-store-address"));
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(requests.some((r) => r.path.endsWith("/install"))).toBe(false);
  },
);
it.each(["session", "address"])(
  "discards a retry plan that returns after the store %s changes",
  async (scope) => {
    let resolve!: () => void;
    retryPlanGate = new Promise<void>((done) => {
      resolve = done;
    });
    fireEvent.click(await openFailedInstance());
    await waitFor(() =>
      expect(requests.some((r) => r.path.endsWith("/retry-plan"))).toBe(true),
    );
    act(() => {
      if (scope === "session") api.storeSession = "another-session";
      else window.dispatchEvent(new Event("space-store-address"));
    });
    await act(async () => {
      resolve();
      await retryPlanGate;
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(requests.some((r) => r.path.endsWith("/install"))).toBe(false);
  },
);
it("shows application names and Chinese task status and stage while keeping IDs in details", async () => {
  api.storeSession = "synthetic-session";
  instanceRows = [healthyInstance()];
  jobRows = [
    {
      id: "opaque-job-1",
      instanceId: "instance-1",
      status: "failed",
      stage: "pull",
      error: "registry timeout",
    },
  ];
  render(<Store initialTab="jobs" onInstances={() => {}} />);
  await screen.findByText("拉取镜像 · 失败");
  const task = screen
    .getByText("Synthetic Media", { selector: ".job-list strong" })
    .closest("article")!;
  expect(
    within(task).getByText("失败", { selector: ".tag" }),
  ).toBeInTheDocument();
  expect(within(task).getByRole("alert")).toHaveTextContent("registry timeout");
  expect(
    within(task).getByText("opaque-job-1").closest("details"),
  ).not.toBeNull();
  expect(
    within(task).getByText("instance-1").closest("details"),
  ).not.toBeNull();
});

it("submits a reviewed retry under the production StrictMode mount lifecycle", async () => {
  fireEvent.click(await openFailedInstance("failed", true));
  const dialog = await screen.findByRole("dialog", {
    name: "重试 Synthetic Media",
  });
  fireEvent.click(within(dialog).getByRole("checkbox"));
  fireEvent.click(
    within(dialog).getByRole("button", { name: "确认并开始安装" }),
  );
  await waitFor(() =>
    expect(requests.filter((r) => r.path.endsWith("/install"))).toHaveLength(1),
  );
});
it("keeps a retry submission request ID stable after an ambiguous transport failure", async () => {
  installFailures = 1;
  fireEvent.click(await openFailedInstance());
  const dialog = await screen.findByRole("dialog", {
    name: "重试 Synthetic Media",
  });
  fireEvent.click(within(dialog).getByRole("checkbox"));
  fireEvent.click(
    within(dialog).getByRole("button", { name: "确认并开始安装" }),
  );
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "无法连接独立商店服务，请检查服务地址与网络",
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "确认并开始安装" }),
  );
  await waitFor(() =>
    expect(requests.filter((r) => r.path.endsWith("/install"))).toHaveLength(2),
  );
  const attempts = requests.filter((r) => r.path.endsWith("/install"));
  expect(attempts[0].body).toEqual(attempts[1].body);
});
it("does not replace an already reviewed retry plan through the instance controls", async () => {
  fireEvent.click(await openFailedInstance());
  const dialog = await screen.findByRole("dialog", {
    name: "重试 Synthetic Media",
  });
  fireEvent.click(within(dialog).getByRole("checkbox"));
  const generate = screen.getByRole("button", { name: "生成重试计划" });
  expect(generate).toBeDisabled();
  fireEvent.click(generate);
  expect(requests.filter((r) => r.path.endsWith("/retry-plan"))).toHaveLength(
    1,
  );
});

it.each([
  ["failed", "running"],
  ["needs_attention", "exited"],
])(
  "offers retry from the latest %s task when the retained container is %s",
  async (status, state) => {
    jobRows = [
      {
        id: "unrelated-newest",
        instanceId: "other-instance",
        status: "completed",
        stage: "completed",
      },
      { id: "failed-job", instanceId: "instance-1", status, stage: "health" },
    ];
    const retry = await openFailedInstance(state);
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    expect(
      await screen.findByRole("dialog", { name: "重试 Synthetic Media" }),
    ).toBeInTheDocument();
  },
);
it.each(["completed", "queued", "running"])(
  "hides retry when the latest task is %s despite an older failure and failed instance state",
  async (status) => {
    api.storeSession = "synthetic-session";
    instanceRows = [{ ...healthyInstance(), state: "failed" }];
    jobRows = [
      { id: "latest-job", instanceId: "instance-1", status, stage: "health" },
      {
        id: "old-failed-job",
        instanceId: "instance-1",
        status: "failed",
        stage: "pull",
      },
    ];
    render(<Store initialTab="installed" onInstances={() => {}} />);
    await screen.findByRole("heading", { name: "Synthetic Media" });
    expect(
      screen.queryByRole("button", { name: "生成重试计划" }),
    ).not.toBeInTheDocument();
    expect(requests.some((r) => r.path.endsWith("/retry-plan"))).toBe(false);
  },
);
it.each([
  ["exited", "已停止"],
  ["missing", "容器缺失"],
  ["ownership_mismatch", "容器归属不一致"],
  ["path_identity_mismatch", "数据目录身份不一致"],
  ["unexpected-state", "未知"],
])("shows the Docker/backend instance state %s as %s", async (state, label) => {
  api.storeSession = "synthetic-session";
  instanceRows = [{ ...healthyInstance(), state }];
  render(<Store initialTab="installed" onInstances={() => {}} />);
  expect(
    await screen.findByText(`运行：${label} · 健康：健康`),
  ).toBeInTheDocument();
});

it.each(["resolves", "rejects"])(
  "preserves a replacement session and its instance projection when an old logout %s",
  async (outcome) => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    logoutGate = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    api.storeSession = "old-session";
    instanceRows = [healthyInstance()];
    const projection = vi.fn();
    render(<Store initialTab="installed" onInstances={projection} />);
    await screen.findByRole("heading", { name: "Synthetic Media" });
    fireEvent.click(screen.getByRole("button", { name: "管理员已登录" }));
    fireEvent.click(screen.getByRole("button", { name: "退出商店账号" }));
    await waitFor(() =>
      expect(requests.some((r) => r.path.endsWith("/logout"))).toBe(true),
    );
    const replacementInstance = {
      ...healthyInstance(),
      id: "replacement-instance",
    };
    instanceRows = [replacementInstance];
    act(() => {
      api.storeSession = "replacement-session";
    });
    await waitFor(() =>
      expect(projection).toHaveBeenLastCalledWith([replacementInstance]),
    );
    projection.mockClear();
    await act(async () => {
      if (outcome === "resolves") resolve();
      else reject(new Error("Synthetic old logout failure"));
    });
    expect(api.storeSession).toBe("replacement-session");
    expect(
      screen.getByRole("button", { name: "管理员已登录" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Synthetic Media" }),
    ).toBeInTheDocument();
    expect(projection).not.toHaveBeenCalledWith([]);
    expect(screen.queryByText(/本地已退出/)).not.toBeInTheDocument();
  },
);
it.each(["jobs", "installed"] as const)("shows independent store authentication in %s without asking for a NAS account", async initialTab => {
  render(<Store initialTab={initialTab} onInstances={() => {}} />);
  expect((await screen.findAllByText("请先登录商店管理员")).length).toBeGreaterThan(0);
  expect(screen.queryByText("连接 NAS，打开你的空间")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "管理员登录" })).toBeInTheDocument();
});

async function openKumaRetry(overrides: Record<string, unknown> = {}) {
  kumaFixture = true;
  api.storeSession = "synthetic-session";
  instanceRows = [{
    ...healthyInstance(),
    appId: "uptime-kuma",
    image: "louislam/uptime-kuma:2.5.6",
    containerId: "",
    state: "failed",
    health: "unknown",
    ...overrides,
  }];
  jobRows = [{ id: "failed-job", instanceId: "instance-1", status: "failed", stage: "pull" }];
  render(<Store initialTab="installed" onInstances={() => {}} />);
  return screen.findByRole("button", { name: "生成重试计划" });
}

it("keeps the supported source retry on the original image by default", async () => {
  const generate = await openKumaRetry();
  expect(screen.getByRole("combobox", { name: "重试镜像来源" })).toHaveValue("");
  fireEvent.click(generate);
  const dialog = await screen.findByRole("dialog", { name: "重试 Uptime Kuma" });
  expect(within(dialog).getByText("louislam/uptime-kuma:2.5.6")).toBeInTheDocument();
  expect(within(dialog).queryByText("原镜像")).not.toBeInTheDocument();
  expect(requests.find(r => r.path.endsWith("/retry-plan"))?.body).toEqual({});
  expect(requests.some(r => r.path.endsWith("/install"))).toBe(false);
});

it("reviews the explicit same-version source change before installing the retained instance", async () => {
  const generate = await openKumaRetry();
  fireEvent.change(screen.getByRole("combobox", { name: "重试镜像来源" }), { target: { value: "ghcr" } });
  expect(requests.some(r => r.path.endsWith("/retry-plan"))).toBe(false);
  fireEvent.click(generate);
  const dialog = await screen.findByRole("dialog", { name: "重试 Uptime Kuma" });
  expect(requests.find(r => r.path.endsWith("/retry-plan"))?.body).toEqual({ imageSource: "ghcr" });
  for (const text of ["原镜像", "重试镜像", "louislam/uptime-kuma:2.5.6", "ghcr.io/louislam/uptime-kuma:2.5.6", "instance-1", "synthetic", "/synthetic/new-instance", "8096", "http://synthetic-app.invalid:8096/"]) {
    expect(within(dialog).getByText(text)).toBeInTheDocument();
  }
  const install = within(dialog).getByRole("button", { name: "确认并开始安装" });
  expect(install).toBeDisabled();
  expect(requests.some(r => r.path.endsWith("/install"))).toBe(false);
  fireEvent.click(within(dialog).getByRole("checkbox"));
  fireEvent.click(install);
  await waitFor(() => expect(requests.filter(r => r.path.endsWith("/install"))).toHaveLength(1));
  expect(requests.find(r => r.path.endsWith("/install"))?.body).toEqual({ planId: "retry-plan-from-server", requestId: expect.any(String) });
});

it.each([
  { image: "louislam/uptime-kuma:2.4.0" },
  { image: "louislam/uptime-kuma:latest" },
  { image: "ghcr.io/louislam/uptime-kuma:2.5.6" },
  { image: undefined },
  { appId: "other-app" },
  { containerId: "recorded-container" },
])("does not offer a source migration for unsupported instance %j", async (overrides) => {
  await openKumaRetry(overrides);
  expect(screen.queryByRole("combobox", { name: "重试镜像来源" })).not.toBeInTheDocument();
  expect(requests.some(r => r.path.endsWith("/retry-plan") || r.path.endsWith("/install"))).toBe(false);
});

it.each([
  { image: "louislam/uptime-kuma:2.5.6", previousImage: undefined },
  { image: "ghcr.io/louislam/uptime-kuma:2.6.0" },
  { previousImage: "louislam/uptime-kuma:2.4.0" },
])("rejects a server plan that ignores or changes the selected source %j", async (overrides) => {
  retryPlanOverride = overrides;
  const generate = await openKumaRetry();
  fireEvent.change(screen.getByRole("combobox", { name: "重试镜像来源" }), { target: { value: "ghcr" } });
  fireEvent.click(generate);
  expect(await screen.findByRole("alert")).toHaveTextContent("重试计划未匹配所选镜像来源");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(requests.filter(r => r.path.endsWith("/retry-plan"))).toHaveLength(1);
  expect(requests.some(r => r.path.endsWith("/install"))).toBe(false);
});

it.each(["session", "address"])("resets the explicit retry source when the store %s changes", async (scope) => {
  await openKumaRetry();
  fireEvent.change(screen.getByRole("combobox", { name: "重试镜像来源" }), { target: { value: "ghcr" } });
  act(() => {
    if (scope === "session") api.storeSession = "replacement-session";
    else window.dispatchEvent(new Event("space-store-address"));
  });
  expect(await screen.findByRole("combobox", { name: "重试镜像来源" })).toHaveValue("");
  expect(requests.some(r => r.path.endsWith("/retry-plan") || r.path.endsWith("/install"))).toBe(false);
});

it.each(["session", "address"])("discards an explicit source plan returned after the store %s changes", async (scope) => {
  let resolve!: () => void;
  retryPlanGate = new Promise<void>(done => { resolve = done; });
  const generate = await openKumaRetry();
  fireEvent.change(screen.getByRole("combobox", { name: "重试镜像来源" }), { target: { value: "ghcr" } });
  fireEvent.click(generate);
  await waitFor(() => expect(requests.filter(r => r.path.endsWith("/retry-plan"))).toHaveLength(1));
  act(() => {
    if (scope === "session") api.storeSession = "replacement-session";
    else window.dispatchEvent(new Event("space-store-address"));
  });
  await act(async () => { resolve(); await retryPlanGate; });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(requests.some(r => r.path.endsWith("/install"))).toBe(false);
});

it("resets source choice and confirmation when a source plan is closed", async () => {
  const generate = await openKumaRetry();
  fireEvent.change(screen.getByRole("combobox", { name: "重试镜像来源" }), { target: { value: "ghcr" } });
  fireEvent.click(generate);
  const dialog = await screen.findByRole("dialog", { name: "重试 Uptime Kuma" });
  fireEvent.click(within(dialog).getByRole("checkbox"));
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
  expect(screen.getByRole("combobox", { name: "重试镜像来源" })).toHaveValue("");
  fireEvent.click(generate);
  const next = await screen.findByRole("dialog", { name: "重试 Uptime Kuma" });
  expect(within(next).getByRole("checkbox")).not.toBeChecked();
  expect(within(next).getByRole("button", { name: "确认并开始安装" })).toBeDisabled();
  expect(requests.filter(r => r.path.endsWith("/retry-plan"))[1].body).toEqual({});
});

it("blocks a reviewed source retry if the latest terminal task changes", async () => {
  const generate = await openKumaRetry();
  fireEvent.change(screen.getByRole("combobox", { name: "重试镜像来源" }), { target: { value: "ghcr" } });
  fireEvent.click(generate);
  const dialog = await screen.findByRole("dialog", { name: "重试 Uptime Kuma" });
  fireEvent.click(within(dialog).getByRole("checkbox"));
  jobRows = [{ id: "newer-failed-job", instanceId: "instance-1", status: "failed", stage: "pull" }];
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "刷新商店" })));
  expect(within(dialog).getByRole("button", { name: "确认并开始安装" })).toBeDisabled();
  expect(requests.some(r => r.path.endsWith("/install"))).toBe(false);
});

it("resets an unreviewed source selection when the latest failed job changes", async () => {
  await openKumaRetry();
  fireEvent.change(screen.getByRole("combobox", { name: "重试镜像来源" }), { target: { value: "ghcr" } });
  jobRows = [{ id: "newer-failed-job", instanceId: "instance-1", status: "failed", stage: "pull" }];
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "刷新商店" })));
  expect(screen.getByRole("combobox", { name: "重试镜像来源" })).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "生成重试计划" }));
  await waitFor(() => expect(requests.filter(r => r.path.endsWith("/retry-plan"))).toHaveLength(1));
  expect(requests.find(r => r.path.endsWith("/retry-plan"))?.body).toEqual({});
});

it.each(["session", "address"])("discards reviewed explicit source retry when the store %s changes", async (scope) => {
  const generate = await openKumaRetry();
  fireEvent.change(screen.getByRole("combobox", { name: "重试镜像来源" }), { target: { value: "ghcr" } });
  fireEvent.click(generate);
  const dialog = await screen.findByRole("dialog", { name: "重试 Uptime Kuma" });
  fireEvent.click(within(dialog).getByRole("checkbox"));
  act(() => {
    if (scope === "session") api.storeSession = "replacement-session";
    else window.dispatchEvent(new Event("space-store-address"));
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(await screen.findByRole("combobox", { name: "重试镜像来源" })).toHaveValue("");
  expect(requests.some(r => r.path.endsWith("/install"))).toBe(false);
});

it.each([
  { image: "louislam/uptime-kuma:2.4.0" },
  { containerId: "recorded-container" },
])("does not silently fall back after selected source eligibility changes %j", async (overrides) => {
  await openKumaRetry();
  fireEvent.change(screen.getByRole("combobox", { name: "重试镜像来源" }), { target: { value: "ghcr" } });
  instanceRows = [{ ...instanceRows[0], ...overrides }];
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "刷新商店" })));
  expect(screen.queryByRole("combobox", { name: "重试镜像来源" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "生成重试计划" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("当前实例不支持所选镜像来源");
  expect(requests.some(r => r.path.endsWith("/retry-plan") || r.path.endsWith("/install"))).toBe(false);
});

it.each([
  { image: "louislam/uptime-kuma:2.4.0" },
  { containerId: "recorded-container" },
])("blocks a reviewed source retry after instance eligibility changes %j", async (overrides) => {
  const generate = await openKumaRetry();
  fireEvent.change(screen.getByRole("combobox", { name: "重试镜像来源" }), { target: { value: "ghcr" } });
  fireEvent.click(generate);
  const dialog = await screen.findByRole("dialog", { name: "重试 Uptime Kuma" });
  fireEvent.click(within(dialog).getByRole("checkbox"));
  instanceRows = [{ ...instanceRows[0], ...overrides }];
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "刷新商店" })));
  expect(within(dialog).getByRole("button", { name: "确认并开始安装" })).toBeDisabled();
  expect(requests.some(r => r.path.endsWith("/install"))).toBe(false);
});
