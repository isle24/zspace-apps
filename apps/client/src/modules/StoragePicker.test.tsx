import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StoragePicker, type StorageCandidate } from "./StoragePicker";
import { api } from "../api/client";
const ssd: StorageCandidate = {
  path: "/ssd",
  mountPoint: "/ssd",
  source: "/dev/sda1",
  filesystem: "ext4",
  identity: "disk-a",
  volumeType: "ssd",
  freeBytes: 400e9,
  totalBytes: 500e9,
  systemDisk: false,
  verifiedDataPool: true,
  installAllowed: true,
  reason: "已验证数据盘",
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  api.storeSession = "";
});
it("blocks system disks and unsafe Docker storage while showing real disk details", async () => {
  api.storeSession = "synthetic";
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              items: [
                {
                  ...ssd,
                  path: "/system",
                  systemDisk: true,
                  installAllowed: false,
                  reason: "系统盘禁止使用",
                },
                ssd,
              ],
              dockerStorage: {
                ...ssd,
                path: "/var/lib/docker",
                systemDisk: true,
                installAllowed: false,
              },
              dockerStorageSafe: false,
              message: "Docker 位于系统盘",
            },
          }),
        ),
      ),
  );
  const safety = vi.fn();
  render(
    <StoragePicker
      roots={[]}
      rootId=""
      onSelect={() => {}}
      onRegistered={() => {}}
      onSafety={safety}
    />,
  );
  expect(
    await screen.findByRole("button", { name: /系统盘禁止使用/ }),
  ).toBeDisabled();
  expect(screen.getAllByText(/dev\/sda1/).length).toBeGreaterThan(0);
  expect(screen.getByText("Docker 位于系统盘")).toBeInTheDocument();
  expect(safety).toHaveBeenLastCalledWith(false);
});
it("registers only the exact user supplied existing dedicated directory", async () => {
  api.storeSession = "synthetic";
  const fetcher = vi.fn(
    async (input: string, init: RequestInit) =>
      new Response(
        JSON.stringify({
          ok: true,
          data: String(input).endsWith("/storage")
            ? {
                items: [ssd],
                dockerStorage: ssd,
                dockerStorageSafe: true,
                message: "",
              }
            : {
                id: "root-new",
                name: "SSD应用",
                path: "/ssd/space-apps",
                roles: ["data"],
                storage: ssd,
              },
        }),
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  const selected = vi.fn();
  render(
    <StoragePicker
      roots={[]}
      rootId=""
      onSelect={selected}
      onRegistered={() => {}}
      onSafety={() => {}}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: /SSD ·/ }));
  fireEvent.change(
    screen.getByRole("textbox", { name: /已有专用目录的绝对路径/ }),
    { target: { value: "/ssd/space-apps" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "登记已有目录" }));
  await waitFor(() => expect(selected).toHaveBeenCalledWith("root-new"));
  const call = fetcher.mock.calls.find((c) => String(c[0]).endsWith("/roots"));
  expect(JSON.parse(String(call?.[1].body)).path).toBe("/ssd/space-apps");
});
