import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { RuntimeInstall } from "./RuntimeInstall";
const disk = {
  path: "/ssd",
  installAllowed: true,
  mediaReadAllowed: true,
  systemDisk: false,
  freeBytes: 1e9,
  totalBytes: 2e9,
};
const roots = [
  {
    id: "data",
    name: "应用盘",
    path: "/ssd/apps",
    roles: ["data"],
    storage: disk,
  },
  {
    id: "media",
    name: "媒体盘",
    path: "/media",
    roles: ["mediaReadOnly"],
    storage: disk,
  },
];
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  api.storeSession = "";
});
it("uses a server-listed media directory inside a verified root for its immutable plan", async () => {
  api.storeSession = "test";
  vi.spyOn(api, "store").mockImplementation(async (op) =>
    op === "roots"
      ? { items: roots }
      : op === "v2/settings"
        ? { defaultRootId: "data" }
        : op === "storage"
          ? { items: [], dockerStorageSafe: true }
          : op === "v2/roots/media/directories"
            ? { items: ["/media/albums", "/outside"] }
            : { items: [] },
  );
  const onPlan = vi.fn();
  render(
    <RuntimeInstall
      app={{
        id: "navidrome",
        name: "Navidrome",
        description: "音乐",
        category: "music",
        version: "0.64.2",
        defaultPort: 4533,
        installable: true,
        requiresMedia: true,
      }}
      busy={false}
      onPlan={onPlan}
      onClose={() => {}}
    />,
  );
  fireEvent.change(await screen.findByLabelText("媒体根目录（只读，必选）"), {
    target: { value: "media" },
  });
  const selection = await screen.findByLabelText("选择媒体子目录");
  await screen.findByRole("option", { name: "/media/albums" });
  expect(
    screen.queryByRole("option", { name: "/outside" }),
  ).not.toBeInTheDocument();
  fireEvent.change(selection, { target: { value: "/media/albums" } });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "生成安装计划" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "生成安装计划" }));
  expect(onPlan).toHaveBeenCalledWith(
    expect.objectContaining({
      rootId: "data",
      mediaRootId: "media",
      mediaPath: "/media/albums",
    }),
  );
});
const app = {
  id: "uptime-kuma",
  name: "Kuma",
  description: "监控",
  category: "tools",
  version: "2.5.6",
  defaultPort: 3001,
  installable: true,
  requiresMedia: false,
};
const safeRoots = [
  roots[0],
  { ...roots[0], id: "second", name: "第二应用盘", path: "/ssd/second" },
];
function mountInstall() {
  return render(
    <RuntimeInstall
      app={app}
      busy={false}
      onPlan={() => {}}
      onClose={() => {}}
    />,
  );
}
function mountPortInstall(syncthing = true) {
  api.storeSession = "test";
  vi.spyOn(api, "store").mockImplementation(async op =>
    op === "roots" ? { items: roots }
      : op === "v2/settings" ? { defaultRootId: "data" }
        : op === "storage" ? { items: [], dockerStorageSafe: true }
          : { items: [] },
  );
  const onPlan = vi.fn();
  render(<RuntimeInstall app={syncthing ? { ...app, id: "syncthing", defaultPort: 8384 } : app}
    busy={false} onPlan={onPlan} onClose={() => {}} />);
  return onPlan;
}
it("submits all three explicit Syncthing ports to its reviewed installation plan", async () => {
  const onPlan = mountPortInstall();
  await waitFor(() => expect(screen.getByRole("button", { name: "生成安装计划" })).toBeEnabled());
  fireEvent.change(screen.getByRole("spinbutton", { name: /同步端口/ }), { target: { value: "32000" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: /发现端口/ }), { target: { value: "32001" } });
  fireEvent.click(screen.getByRole("button", { name: "生成安装计划" }));
  expect(onPlan).toHaveBeenCalledWith(expect.objectContaining({ hostPort: 8384, peerPort: 32000, discoveryPort: 32001 }));
});
it.each([
  ["应用访问端口", "8384.5"], ["同步端口（TCP/UDP）", "32000.5"],
  ["发现端口（UDP）", "1023"], ["同步端口（TCP/UDP）", "65536"],
  ["同步端口（TCP/UDP）", "8384"], ["发现端口（UDP）", "22000"],
])("blocks invalid or colliding Syncthing port %s=%s", async (label, value) => {
  const onPlan = mountPortInstall();
  await waitFor(() => expect(screen.getByRole("button", { name: "生成安装计划" })).toBeEnabled());
  fireEvent.change(screen.getByRole("spinbutton", { name: label }), { target: { value } });
  expect(screen.getByRole("button", { name: "生成安装计划" })).toBeDisabled();
  expect(screen.getByText(/端口须为 1024.*65535.*整数.*互不重复/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "生成安装计划" }));
  expect(onPlan).not.toHaveBeenCalled();
});
it("keeps other applications free of Syncthing ports and rejects fractional access ports", async () => {
  const onPlan = mountPortInstall(false);
  await waitFor(() => expect(screen.getByRole("button", { name: "生成安装计划" })).toBeEnabled());
  expect(screen.queryByRole("spinbutton", { name: /同步端口/ })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("spinbutton", { name: "应用访问端口" }), { target: { value: "3001.5" } });
  expect(screen.getByRole("button", { name: "生成安装计划" })).toBeDisabled();
  fireEvent.change(screen.getByRole("spinbutton", { name: "应用访问端口" }), { target: { value: "3001" } });
  fireEvent.click(screen.getByRole("button", { name: "生成安装计划" }));
  const request = onPlan.mock.calls[0][0];
  expect(request).not.toHaveProperty("peerPort");
  expect(request).not.toHaveProperty("discoveryPort");
});
it.each(["removed", "unsafe"])(
  "keeps manual choice for %s defaults instead of selecting the first root",
  async (defaultRootId) => {
    api.storeSession = "test";
    vi.spyOn(api, "store").mockImplementation(async (op) =>
      op === "roots"
        ? {
            items: [
              ...safeRoots,
              {
                ...roots[0],
                id: "unsafe",
                storage: { ...disk, installAllowed: false },
              },
            ],
          }
        : op === "v2/settings"
          ? { defaultRootId }
          : op === "storage"
            ? { items: [], dockerStorageSafe: true }
            : { items: [] },
    );
    mountInstall();
    await screen.findByRole("option", { name: /第二应用盘/ });
    await waitFor(() =>
      expect(screen.getByLabelText("存储空间")).toHaveValue(""),
    );
    expect(screen.getByRole("button", { name: "生成安装计划" })).toBeDisabled();
  },
);
it("prefills only a still registered safe data default", async () => {
  api.storeSession = "test";
  vi.spyOn(api, "store").mockImplementation(async (op) =>
    op === "roots"
      ? { items: safeRoots }
      : op === "v2/settings"
        ? { defaultRootId: "second" }
        : op === "storage"
          ? { items: [], dockerStorageSafe: true }
          : { items: [] },
  );
  mountInstall();
  await waitFor(() =>
    expect(screen.getByLabelText("存储空间")).toHaveValue("second"),
  );
});
it("does not override a user choice when saved preference arrives later", async () => {
  api.storeSession = "test";
  let release!: (value: any) => void;
  vi.spyOn(api, "store").mockImplementation(async (op) =>
    op === "roots"
      ? { items: safeRoots }
      : op === "v2/settings"
        ? new Promise((done) => (release = done))
        : op === "storage"
          ? { items: [], dockerStorageSafe: true }
          : { items: [] },
  );
  mountInstall();
  await screen.findByRole("option", { name: /第二应用盘/ });
  fireEvent.change(screen.getByLabelText("存储空间"), {
    target: { value: "data" },
  });
  release({ defaultRootId: "second" });
  await waitFor(() =>
    expect(screen.getByLabelText("存储空间")).toHaveValue("data"),
  );
});
it.each(["session", "address"])(
  "discards a preference returning after %s scope change",
  async (mode) => {
    api.storeSession = "test";
    let release!: (value: any) => void;
    vi.spyOn(api, "store").mockImplementation(async (op) =>
      op === "roots"
        ? { items: safeRoots }
        : op === "v2/settings"
          ? new Promise((done) => (release = done))
          : op === "storage"
            ? { items: [], dockerStorageSafe: true }
            : { items: [] },
    );
    mountInstall();
    await screen.findByRole("option", { name: /第二应用盘/ });
    if (mode === "session") api.storeSession = "replacement";
    else await api.setStoreAddress("https://changed.example");
    release({ defaultRootId: "second" });
    await waitFor(() =>
      expect(screen.getByLabelText("存储空间")).toHaveValue(""),
    );
    if (mode === "address") await api.setStoreAddress("");
  },
);
it("selects the first verified directory on a fresh shop without saved preferences", async () => {
  api.storeSession="test";
  vi.spyOn(api,"store").mockImplementation(async op => op==="roots"?{items:safeRoots}:op==="v2/settings"?{defaultRootId:""}:op==="storage"?{items:[],dockerStorageSafe:true}:{items:[]});
  mountInstall();
  await waitFor(()=>expect(screen.getByRole("button",{name:"生成安装计划"})).toBeEnabled());
  expect(screen.getByLabelText("存储空间")).toHaveValue("data");
});
