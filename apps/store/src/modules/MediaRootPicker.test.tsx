import { expect, it, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { MediaRootPicker, mediaPathAllowed } from "./MediaRootPicker";
import { api } from "../api/client";
const root = {
  id: "music-root",
  name: "Music",
  path: "/media/music",
  roles: ["mediaReadOnly"],
  storage: {
    path: "/media/music",
    mountPoint: "/media",
    source: "/dev/sdb1",
    filesystem: "ext4",
    identity: "media-disk",
    volumeType: "hdd" as const,
    freeBytes: 1e10,
    totalBytes: 2e10,
    systemDisk: false,
    verifiedDataPool: true,
    installAllowed: true,
    mediaReadAllowed: true,
    reason: "verified",
  },
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  api.storeSession = "";
});
it("accepts media only inside the separately registered root", () => {
  expect(mediaPathAllowed(root, "/media/music")).toBe(true);
  expect(mediaPathAllowed(root, "/media/music/albums")).toBe(true);
  expect(mediaPathAllowed(root, "/media/music-other")).toBe(false);
  expect(mediaPathAllowed(root, "/media/music/../../etc")).toBe(false);
  expect(mediaPathAllowed(undefined, "/media/music")).toBe(false);
});
it("registers an existing music root without changing the application data root", async () => {
  api.storeSession = "synthetic";
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ ok: true, data: root })));
  vi.stubGlobal("fetch", fetcher);
  const selected = vi.fn();
  render(
    <MediaRootPicker
      roots={[]}
      rootId=""
      mediaPath=""
      onChange={selected}
      onRegistered={() => {}}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "已有音乐库根目录" }), {
    target: { value: "/media/music" },
  });
  fireEvent.click(screen.getByRole("button", { name: "登记媒体根目录" }));
  await waitFor(() =>
    expect(selected).toHaveBeenCalledWith("music-root", "/media/music"),
  );
  expect(JSON.parse(fetcher.mock.calls[0][1].body).path).toBe("/media/music");
});

it("allows a verified read-only media root without write installation permission", () => {
  expect(
    mediaPathAllowed(
      {
        ...root,
        storage: {
          ...root.storage,
          installAllowed: false,
          mediaReadAllowed: true,
        },
      },
      "/media/music",
    ),
  ).toBe(true);
});
