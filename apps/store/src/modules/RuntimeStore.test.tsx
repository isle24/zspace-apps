import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";
import { api } from "../api/client";
import { RuntimeStore } from "./RuntimeStore";
import type { RuntimeInstance } from "./runtime-types";
const instance = {
  id: "i",
  appId: "immich",
  name: "照片",
  version: "3.3.0",
  activeGenerationId: "g",
  state: "running",
  health: "healthy",
  initialization: "pending",
  accessUrl: "http://nas:2283",
  dataPath: "/data/old",
  hostPort: 2283,
  updateAvailable: true,
};
const plan = {
  id: "p",
  kind: "update",
  appId: "immich",
  instanceId: "i",
  targetVersion: "3.3.1",
  sourceGenerationId: "g",
  dataPath: "/data/new",
  snapshotId: "s",
  hostPort: 2283,
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  images: [
    {
      serviceId: "server",
      publisher: "immich-app",
      digest: "sha256:proof",
      reference: "official@sha256:proof",
      platform: "linux/amd64",
      deliverySource: "ghcr",
    },
  ],
  recipe: {
    services: [
      { id: "server", dependsOn: ["database"] },
      { id: "database", dependsOn: [] },
    ],
  },
};
const reviewedCatalog = { items: [{ id: "immich", name: "Immich", description: "照片", category: "photos", version: "3.3.1",
  latestVersion: "3.3.1", availableVersions: ["3.3.1", "3.3.0"], upgradeAllowed: true }], categories: [] };
const upstreamCatalog = [{ ...reviewedCatalog.items[0], latestVersion: "3.4.0", upgradeAllowed: false }];
beforeEach(() => {
  api.storeSession = "test";
  vi.spyOn(api, "streamStore").mockImplementation(
    async (_op, _callback, signal) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve()),
      ),
  );
  vi.spyOn(api, "store").mockImplementation(
    async (op) =>
      ({
        "v2/catalog": {
          items: [
            {
              id: "immich",
              name: "Immich",
              description: "照片管理",
              version: "3.3.1",
              latestVersion: "3.3.1",
              availableVersions: ["3.3.1", "3.3.0"],
              upgradeAllowed: true,
              installable: true,
              category: "photos",
              platforms: ["linux/amd64"],
              services: plan.recipe.services,
            },
          ],
          categories: [],
        },
        "v2/instances": { items: [instance] },
        "v2/jobs": { items: [] },
        "v2/snapshots": { items: [] },
        "v2/desktop": { items: [instance] },
        "v2/settings": {
          theme: "system",
          updateCheckEnabled: true,
          updateCheckHours: 6,
        },
        "v2/plans": plan,
        "v2/execute": { id: "job", instanceId: "i" },
      })[op] || {},
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  api.storeSession = "";
});

const checkedApps = ["uptime-kuma", "navidrome", "jellyfin", "immich", "syncthing"].map(id => ({
  id, name: id, description: "受控应用", category: "apps", version: "2.1.6", latestVersion: "2.1.6",
  availableVersions: ["2.1.6", "2.1.5"], upgradeAllowed: true, sourceStatus: "ok",
  checkedAt: "2026-10-12T00:00:00Z", installable: true,
}));
function versionAPI(items: unknown[], instanceItems: RuntimeInstance[] = [instance]) {
  const original = vi.mocked(api.store).getMockImplementation()!;
  vi.mocked(api.store).mockImplementation(async (op, ...args) =>
    op === "v2/catalog" ? { items, categories: [] }
      : op === "v2/instances" ? { items: instanceItems }
        : original(op, ...args),
  );
}
it("waits for every queued source check to change its own server baseline, including source errors", async () => {
  let completed = 0;
  versionAPI(checkedApps);
  const original = vi.mocked(api.store).getMockImplementation()!;
  vi.mocked(api.store).mockImplementation(async (op, ...args) =>
    op === "v2/catalog/refresh" ? { status: "queued" }
      : op === "v2/catalog" ? { items: checkedApps.map((app, index) => ({ ...app,
        ...(index < completed ? { checkedAt: "2026-10-12T00:01:00Z", sourceStatus: index === 4 ? "error" : "ok",
          sourceError: index === 4 ? "来源暂时不可用" : "" } : {}),
      })), categories: [] } : original(op, ...args),
  );
  render(<RuntimeStore />);
  await screen.findByRole("button", { name: "查看 syncthing" });
  vi.useFakeTimers();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "检查官方版本" })));
  expect(screen.getByText(/版本检查中/)).toBeInTheDocument();
  completed = 4;
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(screen.getByRole("button", { name: "检查中…" })).toBeDisabled();
  expect(screen.queryByText(/版本检查完成/)).not.toBeInTheDocument();
  completed = 5;
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(screen.getByText(/版本检查完成.*1.*来源失败/)).toBeInTheDocument();
  expect(screen.getByText("来源暂时不可用")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "检查官方版本" })).toBeEnabled();
});
it("does not overlap catalog polling and ends a stalled request at the bounded timeout", async () => {
  versionAPI(checkedApps);
  const original = vi.mocked(api.store).getMockImplementation()!;
  let reads = 0, resolve!: (value: unknown) => void;
  vi.mocked(api.store).mockImplementation(async (op, ...args) => {
    if (op === "v2/catalog/refresh") return { status: "queued" };
    if (op === "v2/catalog" && ++reads > 1) return new Promise(done => { resolve = done; });
    return original(op, ...args);
  });
  render(<RuntimeStore />);
  await screen.findByRole("button", { name: "查看 syncthing" });
  vi.useFakeTimers();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "检查官方版本" })));
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(reads).toBe(2);
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(screen.getByText(/版本检查超时/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "检查官方版本" })).toBeEnabled();
  await act(async () => resolve({ items: checkedApps.map(app => ({ ...app, checkedAt: "late" })), categories: [] }));
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(reads).toBe(2);
  expect(screen.queryByText(/版本检查完成/)).not.toBeInTheDocument();
});
it.each(["session", "address", "unmount"])("stops queued checks when %s changes", async change => {
  versionAPI(checkedApps);
  const original = vi.mocked(api.store).getMockImplementation()!;
  vi.mocked(api.store).mockImplementation(async (op, ...args) => op === "v2/catalog/refresh" ? { status: "queued" } : original(op, ...args));
  const view = render(<RuntimeStore />);
  await screen.findByRole("button", { name: "查看 syncthing" });
  vi.useFakeTimers();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "检查官方版本" })));
  await act(async () => {
    if (change === "session") api.storeSession = "replacement";
    else if (change === "address") await api.setStoreAddress("http://poll-replacement:19091");
    else view.unmount();
  });
  const calls = vi.mocked(api.store).mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(120000));
  expect(vi.mocked(api.store).mock.calls).toHaveLength(calls);
  expect(screen.queryByText(/版本检查完成/)).not.toBeInTheDocument();
});
it("reports refresh request failure instead of completion", async () => {
  versionAPI(checkedApps);
  const original = vi.mocked(api.store).getMockImplementation()!;
  vi.mocked(api.store).mockImplementation(async (op, ...args) => {
    if (op === "v2/catalog/refresh") throw new Error("版本检查无法排队");
    return original(op, ...args);
  });
  render(<RuntimeStore />);
  await screen.findByRole("button", { name: "查看 syncthing" });
  fireEvent.click(screen.getByRole("button", { name: "检查官方版本" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("版本检查无法排队");
  expect(screen.queryByText(/版本检查完成/)).not.toBeInTheDocument();
});
it("lets the existing API clear a 401 session and closes all queued polling", async () => {
  vi.mocked(api.store).mockRestore();
  let reads = 0;
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const op = String(url).split("/api/store/")[1];
    if (op === "v2/catalog" && ++reads > 1)
      return new Response(JSON.stringify({ ok: false, error: { message: "会话失效", code: "store_auth_required" } }), { status: 401 });
    return new Response(JSON.stringify({ ok: true, data: op === "v2/catalog" ? { items: checkedApps, categories: [] }
      : op === "v2/catalog/refresh" ? { status: "queued" } : { items: [] } }));
  });
  vi.stubGlobal("fetch", fetcher);
  render(<RuntimeStore />);
  await screen.findByRole("button", { name: "查看 syncthing" });
  vi.useFakeTimers();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "检查官方版本" })));
  expect(api.storeSession).toBe("");
  expect(screen.getByText("请先登录商店管理员")).toBeInTheDocument();
  const calls = fetcher.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(120000));
  expect(fetcher.mock.calls).toHaveLength(calls);
});
it("shows installed, reviewed and unreviewed upstream versions while targeting only the reviewed upgrade", async () => {
  versionAPI([{ ...checkedApps[3], id: "immich", name: "Immich", version: "3.3.1", latestVersion: "3.4.0",
    availableVersions: ["3.3.1", "3.3.0"], upgradeAllowed: false, sourceStatus: "error", sourceError: "官方版本源暂时不可用。" }]);
  render(<RuntimeStore />);
  fireEvent.click(screen.getByRole("button", { name: "更新" }));
  await screen.findByText(/已安装版本：3.3.0/);
  expect(screen.getByText(/最新已审查版本：3.3.1/)).toBeInTheDocument();
  expect(screen.getByText(/上游发现版本：3.4.0/)).toBeInTheDocument();
  expect(screen.getByText(/待审查/)).toBeInTheDocument();
  expect(screen.getByText("官方版本源暂时不可用。")).toBeInTheDocument();
  expect(screen.getByText(/2026-10-12T00:00:00Z/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "生成更新计划" }));
  await screen.findByRole("dialog", { name: "确认操作计划" });
  expect(api.store).toHaveBeenCalledWith("v2/plans", { kind: "update", instanceId: "i", targetVersion: "3.3.1" });
});
it.each(["already-reviewed", "unknown-catalog"])("blocks single and batch upgrades for %s without guessing an reviewed target", async variant => {
  versionAPI(variant === "unknown-catalog" ? [] : [{ ...checkedApps[3], id: "immich", version: "3.3.1", latestVersion: "3.4.0",
    availableVersions: ["3.3.1", "3.3.0"], upgradeAllowed: false }], [{ ...instance, version: "3.3.1" }]);
  render(<RuntimeStore />);
  fireEvent.click(screen.getByRole("button", { name: "更新" }));
  const update = await screen.findByRole("button", { name: "生成更新计划" });
  expect(update).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "选择 照片" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "全选可更新应用" }));
  expect(screen.getByRole("button", { name: "生成批量更新计划（0）" })).toBeDisabled();
  expect(vi.mocked(api.store).mock.calls.some(([op]) => op === "v2/plans")).toBe(false);
});
it.each(["unknown", "", "future-state"])(
  "keeps healthy applications with %s initialization explicitly unverified",
  async (initialization) => {
    const original = vi.mocked(api.store).getMockImplementation()!;
    vi.mocked(api.store).mockImplementation(async (op, ...args) =>
      op === "v2/instances"
        ? { items: [{ ...instance, initialization }] }
        : original(op, ...args),
    );
    render(<RuntimeStore />);
    fireEvent.click(screen.getByRole("button", { name: "我的应用" }));
    expect(await screen.findByText(/首次配置：待核验/)).toBeInTheDocument();
    expect(screen.queryByText(/首次配置：待完成/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开应用 / 首次配置" })).toHaveAttribute("href", instance.accessUrl + "/");
  },
);
it("requires immutable review before update execution and shows provenance/copy scope", async () => {
  render(<RuntimeStore />);
  fireEvent.click(screen.getByRole("button", { name: "更新" }));
  fireEvent.click(await screen.findByRole("button", { name: "生成更新计划" }));
  expect(await screen.findByText("sha256:proof")).toBeInTheDocument();
  expect(screen.getByText("/data/new")).toBeInTheDocument();
  const execute = screen.getByRole("button", { name: "确认执行" });
  expect(execute).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: /已核对/ }));
  fireEvent.click(execute);
  await waitFor(() =>
    expect(api.store).toHaveBeenCalledWith(
      "v2/execute",
      expect.objectContaining({ planId: "p", requestId: expect.any(String) }),
    ),
  );
});
it("shows dependency and architecture details without claiming initialization complete", async () => {
  render(<RuntimeStore />);
  fireEvent.click(await screen.findByRole("button", { name: "查看 Immich" }));
  expect(await screen.findByText(/linux\/amd64/)).toBeInTheDocument();
  expect(screen.getByText(/server · 依赖：database/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "关闭详情" }));
  fireEvent.click(screen.getByRole("button", { name: "应用桌面" }));
  expect(await screen.findByText(/首次配置：待完成/)).toBeInTheDocument();
});
it("renders real streamed job stages", async () => {
  let callback!: (value: unknown) => void;
  vi.mocked(api.streamStore).mockImplementation(async (_op, cb, signal) => {
    callback = cb;
    return new Promise((resolve) =>
      signal.addEventListener("abort", () => resolve()),
    );
  });
  render(<RuntimeStore />);
  fireEvent.click(screen.getByRole("button", { name: "任务中心" }));
  await waitFor(() => expect(callback).toBeDefined());
  callback({
    items: [
      {
        id: "j",
        appId: "immich",
        instanceId: "i",
        status: "running",
        stage: "snapshot",
        stages: [{ name: "snapshot", status: "running" }],
      },
    ],
  });
  expect(await screen.findByText("创建私有快照")).toBeInTheDocument();
});
it("rejects returned plan for a different instance", async () => {
  vi.mocked(api.store).mockImplementation(async (op) =>
    op === "v2/instances"
      ? { items: [instance] }
      : op === "v2/catalog" ? reviewedCatalog : op === "v2/plans"
        ? { ...plan, instanceId: "other" }
        : { items: [] },
  );
  render(<RuntimeStore />);
  fireEvent.click(screen.getByRole("button", { name: "更新" }));
  fireEvent.click(await screen.findByRole("button", { name: "生成更新计划" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("不一致");
  expect(
    screen.queryByRole("button", { name: "确认执行" }),
  ).not.toBeInTheDocument();
});
it("reviews every selected update plan before one atomic batch submission", async () => {
  vi.mocked(api.store).mockImplementation(async (op, body: any) =>
    op === "v2/instances"
      ? { items: [instance, { ...instance, id: "i2", name: "第二个照片实例" }] }
      : op === "v2/catalog" ? reviewedCatalog : op === "v2/plans"
        ? {
            ...plan,
            id: body.instanceId === "i" ? "p" : "p2",
            instanceId: body.instanceId,
          }
        : op === "v2/batches"
          ? { items: [{ id: "j" }, { id: "j2" }] }
          : { items: [] },
  );
  render(<RuntimeStore />);
  fireEvent.click(screen.getByRole("button", { name: "更新" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "全选可更新应用" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "生成批量更新计划（2）" }),
  );
  expect(await screen.findByText("批量操作确认")).toBeInTheDocument();
  expect(screen.getByText("p2")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: /已核对/ }));
  fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
  await waitFor(() =>
    expect(api.store).toHaveBeenCalledWith("v2/batches", {
      planIds: ["p", "p2"],
      requestId: expect.any(String),
    }),
  );
  expect(
    vi.mocked(api.store).mock.calls.filter(([op]) => op === "v2/execute"),
  ).toHaveLength(0);
});
it("archive and reactivation generate plans rather than mutate immediately", async () => {
  vi.mocked(api.store).mockImplementation(async (op, body: any) =>
    op === "v2/instances"
      ? {
          items: [
            instance,
            { ...instance, id: "archive", name: "归档实例", archived: true },
          ],
        }
      : op === "v2/plans"
        ? { ...plan, kind: body.kind, instanceId: body.instanceId }
        : { items: [] },
  );
  render(<RuntimeStore />);
  fireEvent.click(screen.getByRole("button", { name: "我的应用" }));
  fireEvent.click(await screen.findByRole("button", { name: "生成归档计划" }));
  expect(
    await screen.findByRole("dialog", { name: "确认操作计划" }),
  ).toBeInTheDocument();
  expect(
    vi.mocked(api.store).mock.calls.filter(([op]) => op === "v2/execute"),
  ).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "关闭计划" }));
  fireEvent.click(screen.getByRole("button", { name: "生成重新启用计划" }));
  await waitFor(() =>
    expect(api.store).toHaveBeenCalledWith("v2/plans", {
      kind: "reactivate",
      instanceId: "archive",
    }),
  );
});
it("restore uses a listed private snapshot without accepting typed snapshot IDs", async () => {
  vi.mocked(api.store).mockImplementation(async (op, body: any) =>
    op === "v2/snapshots"
      ? {
          items: [
            {
              id: "snap",
              instanceId: "i",
              appId: "immich",
              version: "3.3.0",
              sha256: "proof",
              sizeBytes: 2048,
              createdAt: "today",
              path: "/private/snap",
            },
          ],
        }
      : op === "v2/plans"
        ? { ...plan, kind: body.kind, sourceSnapshotId: body.snapshotId }
        : { items: [] },
  );
  render(<RuntimeStore />);
  fireEvent.click(screen.getByRole("button", { name: "备份与恢复" }));
  fireEvent.click(await screen.findByRole("button", { name: "生成恢复计划" }));
  await waitFor(() =>
    expect(api.store).toHaveBeenCalledWith("v2/plans", {
      kind: "restore",
      instanceId: "i",
      snapshotId: "snap",
    }),
  );
  expect(await screen.findByText("snap")).toBeInTheDocument();
});
it("discards delayed plans after replacing the session", async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(api.store).mockImplementation(async (op) =>
    op === "v2/instances"
      ? { items: [instance] }
      : op === "v2/catalog" ? reviewedCatalog : op === "v2/plans"
        ? new Promise((done) => (resolve = done))
        : { items: [] },
  );
  render(<RuntimeStore />);
  fireEvent.click(screen.getByRole("button", { name: "更新" }));
  fireEvent.click(await screen.findByRole("button", { name: "生成更新计划" }));
  await waitFor(() => expect(resolve).toBeDefined());
  api.storeSession = "replacement";
  resolve(plan);
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});
it("exposes failed resource reads and retries without pretending an empty successful list", async () => {
  vi.mocked(api.store).mockImplementation(async (op) => {
    if (op === "v2/catalog") throw new Error("目录源不可达");
    return { items: [] };
  });
  render(<RuntimeStore />);
  expect(await screen.findByRole("alert")).toHaveTextContent("目录源不可达");
  expect(screen.queryByText("这里还没有内容")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
  await waitFor(() =>
    expect(
      vi.mocked(api.store).mock.calls.filter(([op]) => op === "v2/catalog")
        .length,
    ).toBe(2),
  );
});
it("reviews stop and start without archiving or replacing the stable instance", async () => {
  vi.mocked(api.store).mockImplementation(async (op, body: any) =>
    op === "v2/instances"
      ? {
          items: [
            instance,
            {
              ...instance,
              id: "paused",
              name: "暂停实例",
              state: "stopped",
              archived: false,
            },
          ],
        }
      : op === "v2/plans"
        ? { ...plan, kind: body.kind, instanceId: body.instanceId }
        : { items: [] },
  );
  render(<RuntimeStore />);
  fireEvent.click(screen.getByRole("button", { name: "我的应用" }));
  fireEvent.click(await screen.findByRole("button", { name: "生成停止计划" }));
  await waitFor(() =>
    expect(api.store).toHaveBeenCalledWith("v2/plans", {
      kind: "stop",
      instanceId: "i",
    }),
  );
  expect(
    await screen.findByRole("dialog", { name: "确认操作计划" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "关闭计划" }));
  fireEvent.click(screen.getByRole("button", { name: "生成启动计划" }));
  await waitFor(() =>
    expect(api.store).toHaveBeenCalledWith("v2/plans", {
      kind: "start",
      instanceId: "paused",
    }),
  );
  expect(
    vi.mocked(api.store).mock.calls.filter(([op]) => op === "v2/execute"),
  ).toHaveLength(0);
});
it("applies the saved theme on protected screen mount before visiting settings", async () => {
  delete document.documentElement.dataset.theme;
  vi.mocked(api.store).mockImplementation(async (op) =>
    op === "v2/settings"
      ? { theme: "dark", updateCheckEnabled: true, updateCheckHours: 6 }
      : { items: [] },
  );
  render(<RuntimeStore />);
  await waitFor(() =>
    expect(document.documentElement.dataset.theme).toBe("dark"),
  );
  delete document.documentElement.dataset.theme;
});
it("renders reviewed licensing, exact minimum memory, user mode and read-only mount roles", async () => {
  vi.mocked(api.store).mockImplementation(async (op) =>
    op === "v2/catalog"
      ? {
          items: [
            {
              id: "immich",
              name: "Immich",
              description: "照片",
              version: "3.3.1",
              license: "AGPL-3.0",
              minimumMemoryBytes: 6 * 1073741824,
              platforms: ["linux/amd64"],
              services: [
                {
                  id: "server",
                  userMode: "image-default",
                  dependsOn: ["database"],
                  volumes: [
                    { name: "uploads", target: "/data", role: "data" },
                    {
                      name: "library",
                      target: "/media",
                      role: "media-readonly",
                    },
                  ],
                },
                {
                  id: "database",
                  userMode: "image-default",
                  volumes: [
                    {
                      name: "database",
                      target: "/var/lib/postgresql/data",
                      role: "data",
                    },
                  ],
                },
              ],
            },
          ],
          categories: [],
        }
      : { items: [] },
  );
  render(<RuntimeStore />);
  fireEvent.click(await screen.findByRole("button", { name: "查看 Immich" }));
  expect(screen.getByText("AGPL-3.0")).toBeInTheDocument();
  expect(screen.getByText("6 GiB")).toBeInTheDocument();
  expect(screen.getAllByText(/应用默认账号/)).toHaveLength(2);
  expect(
    screen.getByText(/library · \/media · 现有媒体，只读/),
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      /database · \/var\/lib\/postgresql\/data · 独立应用数据，可写/,
    ),
  ).toBeInTheDocument();
});
it("filters actual server category IDs using their returned Chinese category names", async () => {
  vi.mocked(api.store).mockImplementation(async (op) =>
    op === "v2/catalog"
      ? {
          items: [
            {
              id: "jellyfin",
              name: "Jellyfin",
              description: "影片",
              category: "media",
              version: "10.11.0",
              installable: true,
            },
            {
              id: "syncthing",
              name: "Syncthing",
              description: "同步",
              category: "files",
              version: "2.1.6",
              installable: true,
            },
          ],
          categories: [
            { id: "media", name: "影音" },
            { id: "files", name: "文件" },
          ],
        }
      : { items: [] },
  );
  render(<RuntimeStore />);
  fireEvent.click(await screen.findByRole("button", { name: "影音" }));
  expect(
    screen.getByRole("button", { name: "查看 Jellyfin" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "查看 Syncthing" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "文件" }));
  expect(
    screen.getByRole("button", { name: "查看 Syncthing" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "查看 Jellyfin" }),
  ).not.toBeInTheDocument();
});

const failedJob = { id: "failed-job", planId: "failed-plan", kind: "update", appId: "immich", instanceId: "i", status: "failed", stage: "failed" };
const retryPlan = { ...plan, id: "retry-plan", retryOfJobId: "failed-job", retryOfPlanId: "failed-plan" };
function retryAPI(result: unknown = retryPlan, job = failedJob) {
  vi.mocked(api.store).mockImplementation(async op => {
    if (op === "v2/jobs") return { items: [job] };
    if (op === "v2/jobs/failed-job/retry-plan") return result;
    if (op === "v2/execute") return { id: "new-job" };
    if (op === "v2/instances") return { items: [instance] };
    return { items: [] };
  });
}
it("reviews a new retry plan with old job/plan provenance before fresh explicit execution", async () => {
  retryAPI();
  render(<RuntimeStore />);
  fireEvent.click(screen.getByRole("button", { name: "任务中心" }));
  fireEvent.click(await screen.findByRole("button", { name: "生成重试计划" }));
  await screen.findByRole("dialog", { name: "确认操作计划" });
  expect(api.store).toHaveBeenCalledWith("v2/jobs/failed-job/retry-plan", {});
  expect(screen.getByText("失败任务")).toBeInTheDocument();
  expect(screen.getByText("失败计划")).toBeInTheDocument();
  expect(screen.getByText("failed-plan")).toBeInTheDocument();
  expect(screen.getByText(/失败任务的数据、容器和记录均保留/)).toBeInTheDocument();
  expect(vi.mocked(api.store).mock.calls.filter(([op]) => op === "v2/execute")).toHaveLength(0);
  const execute = screen.getByRole("button", { name: "确认执行" });
  expect(execute).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: /已核对/ }));
  fireEvent.click(execute);
  fireEvent.click(execute);
  await waitFor(() => expect(api.store).toHaveBeenCalledWith("v2/execute", { planId: "retry-plan", requestId: expect.any(String) }));
  expect(vi.mocked(api.store).mock.calls.filter(([op]) => op === "v2/execute")).toHaveLength(1);
});
it("reviews failed installation using a new instance and retained historical resources", async () => {
  retryAPI({ ...retryPlan, kind: "install", instanceId: "new-instance", dataPath: "/data/fresh-retry" }, { ...failedJob, kind: "install" });
  render(<RuntimeStore />);
  fireEvent.click(screen.getByRole("button", { name: "任务中心" }));
  fireEvent.click(await screen.findByRole("button", { name: "生成重试计划" }));
  expect(await screen.findByText("/data/fresh-retry")).toBeInTheDocument();
  expect(screen.getByText("new-instance")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();
});
it.each([
  { retryOfJobId: "foreign-job" }, { retryOfPlanId: "foreign-plan" },
  { appId: "jellyfin" }, { instanceId: "other" }, { kind: "backup" },
  { id: "failed-plan" }, { id: "" }, { retryOfJobId: undefined },
])("rejects retry response with mismatched binding %j", async mismatch => {
  retryAPI({ ...retryPlan, ...mismatch });
  render(<RuntimeStore />);
  fireEvent.click(screen.getByRole("button", { name: "任务中心" }));
  fireEvent.click(await screen.findByRole("button", { name: "生成重试计划" }));
  expect(await screen.findByRole("alert", { name: "" })).toHaveTextContent(/不一致/);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("rejects install retry reusing the failed instance", async () => {
  retryAPI({ ...retryPlan, kind: "install" }, { ...failedJob, kind: "install" });
  render(<RuntimeStore />);
  fireEvent.click(screen.getByRole("button", { name: "任务中心" }));
  fireEvent.click(await screen.findByRole("button", { name: "生成重试计划" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/不一致/);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it.each(["session", "address"])("discards delayed retry after replacing %s", async changed => {
  let resolve!: (value: unknown) => void;
  retryAPI(new Promise(done => { resolve = done; }));
  render(<RuntimeStore />);
  fireEvent.click(screen.getByRole("button", { name: "任务中心" }));
  fireEvent.click(await screen.findByRole("button", { name: "生成重试计划" }));
  await waitFor(() => expect(api.store).toHaveBeenCalledWith("v2/jobs/failed-job/retry-plan", {}));
  if (changed === "session") api.storeSession = "replacement";
  else await api.setStoreAddress("http://replacement-store:19091");
  resolve(retryPlan);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});
it("keeps retry failures visible and permits regenerating the plan", async () => {
  retryAPI();
  const base = vi.mocked(api.store).getMockImplementation()!;
  let attempts = 0;
  vi.mocked(api.store).mockImplementation(async (op, ...args) => {
    if (op.endsWith("/retry-plan") && attempts++ === 0) throw new Error("retry_source_changed：请检查当前代次");
    return base(op, ...args);
  });
  render(<RuntimeStore />);
  fireEvent.click(screen.getByRole("button", { name: "任务中心" }));
  fireEvent.click(await screen.findByRole("button", { name: "生成重试计划" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("retry_source_changed");
  fireEvent.click(screen.getByRole("button", { name: "生成重试计划" }));
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
});
it("attention inspection opens current instances instead of generating a retry", async () => {
  retryAPI(retryPlan, { ...failedJob, status: "needs_attention" });
  render(<RuntimeStore />);
  fireEvent.click(screen.getByRole("button", { name: "任务中心" }));
  fireEvent.click(await screen.findByRole("button", { name: "检查当前应用代次" }));
  expect(await screen.findByRole("heading", { name: "我的应用" })).toBeInTheDocument();
  expect(vi.mocked(api.store).mock.calls.some(([op]) => op.endsWith("/retry-plan"))).toBe(false);
});
it.each(["start", "stop", "restart", "update", "backup", "restore", "archive", "reactivate"])("routes failed %s through a new review preserving source provenance", async kind => {
  retryAPI({ ...retryPlan, kind, sourceSnapshotId: kind === "restore" ? "original-snapshot" : undefined }, { ...failedJob, kind });
  render(<RuntimeStore />);
  fireEvent.click(screen.getByRole("button", { name: "任务中心" }));
  fireEvent.click(await screen.findByRole("button", { name: "生成重试计划" }));
  await screen.findByRole("dialog", { name: "确认操作计划" });
  expect(screen.getByText("原代次").nextElementSibling).toHaveTextContent("g");
  expect(screen.getByText("失败计划").nextElementSibling).toHaveTextContent("failed-plan");
  if (kind === "restore") expect(screen.getByText("恢复来源").nextElementSibling).toHaveTextContent("original-snapshot");
  expect(vi.mocked(api.store).mock.calls.filter(([op]) => op === "v2/execute")).toHaveLength(0);
});
it("prevents duplicate retry generation while loading and leaves task history readable", async () => {
  let resolve!: (value: unknown) => void;
  retryAPI(new Promise(done => { resolve = done; }));
  render(<RuntimeStore />);
  fireEvent.click(screen.getByRole("button", { name: "任务中心" }));
  const retry = await screen.findByRole("button", { name: "生成重试计划" });
  fireEvent.click(retry);
  fireEvent.click(retry);
  expect(screen.getByRole("button", { name: "生成计划中…" })).toBeDisabled();
  expect(screen.getByRole("heading", { name: "immich · 失败" })).toBeInTheDocument();
  expect(vi.mocked(api.store).mock.calls.filter(([op]) => op.endsWith("/retry-plan"))).toHaveLength(1);
  resolve(retryPlan);
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
});
const ownedGeneration = {
  id: "g", instanceId: "i", appId: "immich", version: "3.3.0", recipeRevision: "r1", state: "running",
  rootPath: "/ssd/apps", dataPath: "/ssd/g", hostPort: 2283, peerPort: 0, discoveryPort: 0,
  recipe: { services: [{ id: "server", entry: true, containerPort: 2283, userMode: "image-default",
    volumes: [{ name: "uploads", target: "/data", role: "data" }], environment: { SECRET: "hidden-value" } }] },
  containers: [{ serviceId: "server", id: "container-id", name: "owned-server", image: "sha256:actual", state: "running" }],
  images: [{ serviceId: "server", reference: "official@sha256:proof", digest: "sha256:proof", platform: "linux/amd64", publisher: "immich-app", deliverySource: "ghcr" }],
};
it("reads and displays owned current and retained generations, declared mounts, containers and immutable images", async () => {
  const original = vi.mocked(api.store).getMockImplementation()!;
  vi.mocked(api.store).mockImplementation(async (op, ...args) => op === "v2/generations"
    ? { items: [ownedGeneration, { ...ownedGeneration, id: "old-g", dataPath: "/ssd/old-g", state: "stopped" },
      { ...ownedGeneration, id: "foreign-g", instanceId: "foreign", dataPath: "/private/foreign" }] }
    : original(op, ...args));
  render(<RuntimeStore />);
  fireEvent.click(screen.getByRole("button", { name: "我的应用" }));
  fireEvent.click(await screen.findByRole("button", { name: "查看代次详情" }));
  expect(await screen.findByRole("heading", { name: "当前代次 g" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "保留代次 old-g" })).toBeInTheDocument();
  expect(screen.getAllByText(/应用访问端口：2283/)).toHaveLength(2);
  expect(screen.getAllByText(/\/ssd\/g\/uploads.*\/data.*可写/)).toHaveLength(1);
  expect(screen.getAllByText(/owned-server/)).toHaveLength(2);
  expect(screen.getAllByText(/official@sha256:proof/)).toHaveLength(2);
  expect(screen.getByText(/暂无实时 CPU.*内存用量/)).toBeInTheDocument();
  expect(screen.queryByText(/foreign-g|\/private\/foreign|hidden-value/)).not.toBeInTheDocument();
});
it.each(["empty", "error"])("shows generations %s without inventing runtime facts", async variant => {
  const original = vi.mocked(api.store).getMockImplementation()!;
  vi.mocked(api.store).mockImplementation(async (op, ...args) => {
    if (op === "v2/generations") {
      if (variant === "error") throw new Error("代次读取失败");
      return { items: [] };
    }
    return original(op, ...args);
  });
  render(<RuntimeStore />);
  fireEvent.click(screen.getByRole("button", { name: "我的应用" }));
  fireEvent.click(await screen.findByRole("button", { name: "查看代次详情" }));
  if (variant === "empty") expect(await screen.findByText(/尚无本实例的运行代次资料/)).toBeInTheDocument();
  else expect(await screen.findByRole("alert")).toHaveTextContent("代次读取失败");
});
it("explicitly identifies legacy instances as having no v2 generations", async () => {
  const original = vi.mocked(api.store).getMockImplementation()!;
  vi.mocked(api.store).mockImplementation(async (op, ...args) => op === "v2/instances" ? { items: [{ ...instance, legacy: true }] } : original(op, ...args));
  render(<RuntimeStore />);
  fireEvent.click(screen.getByRole("button", { name: "我的应用" }));
  expect(await screen.findByText(/旧版部署.*没有运行代次资料/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "查看代次详情" })).not.toBeInTheDocument();
  expect(vi.mocked(api.store).mock.calls.some(([op]) => op === "v2/generations")).toBe(false);
});
it("keeps a distinct reviewed upgrade available after the upstream version has been ignored", async () => {
  versionAPI(upstreamCatalog, [{ ...instance, ignoredVersion: "3.4.0", updateAvailable: false }]);
  render(<RuntimeStore />);
  fireEvent.click(screen.getByRole("button", { name: "我的应用" }));
  await screen.findByText(/已安装版本：3.3.0/);
  expect(screen.getByRole("button", { name: "生成更新计划" })).toBeEnabled();
  expect(screen.getByText(/已忽略上游版本：3.4.0/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "生成更新计划" }));
  await screen.findByRole("dialog", { name: "确认操作计划" });
  expect(api.store).toHaveBeenCalledWith("v2/plans", { kind: "update", instanceId: "i", targetVersion: "3.3.1" });
});
it("selects the explicit reviewed upgrade for batches even when backend upstream updateAvailable is false", async () => {
  versionAPI(upstreamCatalog, [{ ...instance, ignoredVersion: "3.4.0", updateAvailable: false },
    { ...instance, id: "already-current", version: "3.3.1", ignoredVersion: "3.4.0", updateAvailable: false },
    { ...instance, id: "reviewed-ignored", name: "忽略已审查目标的实例", ignoredVersion: "3.3.1", updateAvailable: true }]);
  render(<RuntimeStore />);
  fireEvent.click(screen.getByRole("button", { name: "更新" }));
  await screen.findByRole("checkbox", { name: "选择 照片" });
  fireEvent.click(screen.getByRole("button", { name: "全选可更新应用" }));
  const submit = screen.getByRole("button", { name: "生成批量更新计划（1）" });
  expect(submit).toBeEnabled();
  fireEvent.click(submit);
  await screen.findByRole("dialog", { name: "确认操作计划" });
  expect(vi.mocked(api.store).mock.calls.filter(([op]) => op === "v2/plans")).toEqual([
    ["v2/plans", { kind: "update", instanceId: "i", targetVersion: "3.3.1" }],
  ]);
});
it.each(["reviewed-latest", "unreviewed-latest"])("respects the ignored reviewed target separately from %s", async scenario => {
  versionAPI(scenario === "reviewed-latest" ? reviewedCatalog.items : upstreamCatalog,
    [{ ...instance, ignoredVersion: "3.3.1", updateAvailable: scenario === "unreviewed-latest" }]);
  render(<RuntimeStore />);
  fireEvent.click(screen.getByRole("button", { name: "我的应用" }));
  await screen.findByText(/已安装版本：3.3.0/);
  const update = screen.queryByRole("button", { name: "生成更新计划" });
  if (update) expect(update).toBeDisabled();
  expect(screen.getByText(/已忽略已审查目标：3.3.1/)).toBeInTheDocument();
  expect(vi.mocked(api.store).mock.calls.some(([op]) => op === "v2/plans")).toBe(false);
});
it("reads back an upstream ignore without losing the reviewed upgrade or mixing the version labels", async () => {
  versionAPI(upstreamCatalog);
  const original = vi.mocked(api.store).getMockImplementation()!;
  let ignored = false;
  vi.mocked(api.store).mockImplementation(async (op, ...args) => {
    if (op === "v2/instances/i/ignore-update") { ignored = true; return {}; }
    if (op === "v2/instances") return { items: [{ ...instance, updateAvailable: !ignored, ignoredVersion: ignored ? "3.4.0" : "" }] };
    return original(op, ...args);
  });
  render(<RuntimeStore />);
  fireEvent.click(screen.getByRole("button", { name: "我的应用" }));
  fireEvent.click(await screen.findByRole("button", { name: /忽略.*版本/ }));
  await waitFor(() => expect(api.store).toHaveBeenCalledWith("v2/instances/i/ignore-update", { version: "3.4.0" }));
  expect(await screen.findByRole("button", { name: "生成更新计划" })).toBeEnabled();
  expect(await screen.findByText(/已忽略上游版本：3.4.0/)).toBeInTheDocument();
  expect(screen.getByText(/可更新到已审查版本 3.3.1/)).toBeInTheDocument();
});
it('discovers public references without login and keeps pending applications non-installable',async()=>{
 const {readPublicCatalog}=await import('../api/public-catalog');
 const {cloud}=await import('../api/cloud-catalog');
 vi.spyOn(cloud,'user','get').mockReturnValue(undefined);
 vi.mocked(readPublicCatalog).mockResolvedValue({items:[{id:'native-reference',name:'原生参考',description:'公开资料',category:'tools',icon:'',version:'1.0',image:'',containerPort:0,dataTargets:[],environment:[],published:true,releaseNumber:0,catalogOnly:true,compatibilityNote:'安装支持待适配'},{id:'new-published',name:'新发布应用',description:'可安装目录',category:'tools',icon:'',version:'1.0',image:'docker.io/example/app@sha256:'+'a'.repeat(64),containerPort:8080,dataTargets:[],environment:[],published:true,releaseNumber:1,manifestDigest:'a'.repeat(64)}]});
 render(<RuntimeStore/>);
 expect(await screen.findByText('原生参考')).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'原生参考安装支持待适配'})).toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'安装 新发布应用'}));
 expect(await screen.findByRole('form',{name:'商店账号'})).toBeInTheDocument();
 expect(api.store).not.toHaveBeenCalledWith('v2/cloud/install-plan',expect.anything());
 vi.mocked(readPublicCatalog).mockResolvedValue({items:[]});
});
