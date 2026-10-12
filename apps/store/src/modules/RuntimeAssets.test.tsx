import { StrictMode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { RuntimeDesktop, RuntimeSnapshots, RuntimeLogs } from "./RuntimeAssets";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  api.storeSession = "";
});
const ownInstance = { id: "i", appId: "immich", name: "图库", activeGenerationId: "g", version: "3.3.1", state: "running",
  health: "healthy", initialization: "completed", accessUrl: "http://nas:2283", dataPath: "/ssd/g", hostPort: 2283 };
const ownGeneration = { id: "g", instanceId: "i", appId: "immich", recipe: { services: [
  { id: "database", entry: false }, { id: "immich-server", entry: true }, { id: "immich-machine-learning", entry: false },
] } };
it("selects logs only from the current owned generation's declared services", async () => {
  api.storeSession = "current";
  const store = vi.spyOn(api, "store").mockImplementation(async op =>
    op === "v2/generations" ? { items: [ownGeneration, { ...ownGeneration, id: "foreign", instanceId: "other", recipe: { services: [{ id: "foreign-service" }] } }] }
      : { text: op.endsWith("service=database") ? "database-log" : "entry-log" });
  render(<RuntimeLogs instance={ownInstance} />);
  fireEvent.click(screen.getByRole("button", { name: "查看日志" }));
  const selector = await screen.findByRole("combobox", { name: "日志服务" });
  expect(selector).toHaveValue("immich-server");
  expect(screen.queryByRole("option", { name: "foreign-service" })).not.toBeInTheDocument();
  expect(await screen.findByText("entry-log")).toBeInTheDocument();
  fireEvent.change(selector, { target: { value: "database" } });
  expect(await screen.findByText("database-log")).toBeInTheDocument();
  expect(store).toHaveBeenCalledWith("v2/instances/i/logs?service=database");
  const count = store.mock.calls.length;
  fireEvent.change(selector, { target: { value: "arbitrary-container" } });
  await Promise.resolve();
  expect(store.mock.calls).toHaveLength(count);
});
it("does not guess a log service when the active generation has not been returned", async () => {
  api.storeSession = "current";
  const store = vi.spyOn(api, "store").mockResolvedValue({ items: [{ ...ownGeneration, id: "retained" }] });
  render(<RuntimeLogs instance={ownInstance} />);
  fireEvent.click(screen.getByRole("button", { name: "查看日志" }));
  expect(await screen.findByText(/当前代次.*未返回/)).toBeInTheDocument();
  expect(store.mock.calls.some(([op]) => op.includes("/logs"))).toBe(false);
});
it("hides a delayed service log after the store session changes", async () => {
  api.storeSession = "current";
  let resolve!: (data: unknown) => void;
  vi.spyOn(api, "store").mockImplementation(async op => op === "v2/generations" ? { items: [ownGeneration] }
    : new Promise(done => { resolve = done; }));
  render(<RuntimeLogs instance={ownInstance} />);
  fireEvent.click(screen.getByRole("button", { name: "查看日志" }));
  await waitFor(() => expect(resolve).toBeDefined());
  api.storeSession = "replacement";
  resolve({ text: "old-private-log" });
  await waitFor(() => expect(screen.getByText(/商店服务或会话已改变/)).toBeInTheDocument());
  expect(screen.queryByText("old-private-log")).not.toBeInTheDocument();
});
it.each([
  ["unknown", "待核验"],
  ["", "待核验"],
  ["future-state", "待核验"],
  ["required", "待完成"],
  ["pending", "待完成"],
  ["completed", "已完成"],
  ["not_required", "无需配置"],
])("desktop reports %s initialization as %s independently of health", async (initialization, label) => {
  api.storeSession = "current";
  vi.spyOn(api, "store").mockResolvedValue({
    items: [{ id: "i", appId: "uptime-kuma", name: "监控", initialization,
      health: "healthy", accessUrl: "http://nas:3001" }],
  });
  render(<RuntimeDesktop />);
  expect(await screen.findByText("首次配置：" + label)).toBeInTheDocument();
  expect(screen.getByText("健康检查：healthy")).toBeInTheDocument();
});
it("downloads the authenticated binary and clears busy after StrictMode effect replay", async () => {
  api.storeSession = "current";
  vi.spyOn(api, "store").mockResolvedValue({
    items: [
      {
        id: "s",
        instanceId: "i",
        appId: "immich",
        version: "3.3.1",
        sha256:
          "229cc317ac5ffab2a6b7c3142731fc59e9cc5dab5303dd5fe7444933ab36ab45",
        sizeBytes: 15,
        createdAt: "now",
        path: "/private/s",
      },
    ],
  });
  const fetcher = vi.fn(
    async () =>
      new Response("private archive", {
        headers: {
          "Content-Type": "application/x-tar",
          "Content-Length": "15",
        },
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const create = vi.fn(() => "blob:private-download");
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = vi.fn();
    },
  );
  const clicked = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  render(
    <StrictMode>
      <RuntimeSnapshots busy={false} onPlan={() => {}} />
    </StrictMode>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "下载私有快照" }));
  await waitFor(() => expect(clicked).toHaveBeenCalledOnce());
  expect(create).toHaveBeenCalledWith(expect.any(Blob));
  expect(fetcher).toHaveBeenCalledWith(
    expect.stringContaining("/v2/snapshots/s/download"),
    expect.objectContaining({ headers: { "X-Store-Session": "current" } }),
  );
  expect(screen.getByRole("button", { name: "下载私有快照" })).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "下载中…" }),
  ).not.toBeInTheDocument();
});
it.each([
  { name: "truncated", bytes: "partial", error: "大小不一致" },
  { name: "corrupted", bytes: "corrupt archive", error: "校验不一致" },
])(
  "never offers a usable download for $name 200 response",
  async ({ bytes, error }) => {
    api.storeSession = "current";
    vi.spyOn(api, "store").mockResolvedValue({
      items: [
        {
          id: "s",
          instanceId: "i",
          appId: "immich",
          version: "3.3.1",
          sha256:
            "229cc317ac5ffab2a6b7c3142731fc59e9cc5dab5303dd5fe7444933ab36ab45",
          sizeBytes: 15,
          createdAt: "now",
          path: "/private/s",
        },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes)),
    );
    const created = vi.fn(() => "blob:private-download");
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = created;
        static revokeObjectURL = vi.fn();
      },
    );
    const clicked = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    render(<RuntimeSnapshots busy={false} onPlan={() => {}} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "下载私有快照" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(error);
    expect(created).not.toHaveBeenCalled();
    expect(clicked).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "下载私有快照" })).toBeEnabled();
  },
);
