import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

/**
 * hls.js 按需加载的两条路径。
 *
 * 放在单独文件里：`vi.mock("hls.js")` 是**提升**到文件顶部的，
 * 而 `vi.resetModules()` + 动态 import 会连带把 `api` 换成新实例，
 * 导致前面文件里对 `api.read` 的 spy 失效（第一版就是这么失败的）。
 */
const hls = vi.hoisted(() => {
  const state = { fail: false, ctor: vi.fn(), loadSource: vi.fn(), attachMedia: vi.fn(), destroy: vi.fn(), on: vi.fn() };
  return state;
});

vi.mock("hls.js", () => {
  if (hls.fail) throw new Error("chunk 加载失败");
  const instance = { loadSource: hls.loadSource, attachMedia: hls.attachMedia, destroy: hls.destroy, on: hls.on };
  const ctor = function (this: unknown) { hls.ctor(); return instance; } as unknown as { isSupported: () => boolean; Events: { ERROR: string } };
  ctor.isSupported = () => true;
  ctor.Events = { ERROR: "hlsError" };
  return { default: ctor };
});

const { Player } = await import("./Player");
const { api } = await import("../api/client");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  api.logoutNas();
  hls.fail = false;
});

const video = { id: "/movies/demo.mkv", name: "演示影片.mkv", path: "/movies/demo.mkv", kind: "video" };
const selection = { items: [video], index: 0, kind: "video" as const };

function stubPlay(response: unknown) {
  vi.spyOn(api, "read").mockResolvedValue(response as never);
  vi.spyOn(api.nas, "safeMediaUrl").mockImplementation((value: unknown) =>
    typeof value === "string" ? value : undefined,
  );
}

describe("hls.js 按需加载", () => {
  it("HLS 地址走到 hls.js，且不给 video 写 src", async () => {
    stubPlay({ items: [], values: { uri: "/play/m3u8/stream/index.m3u8" } });
    const { container } = render(<Player selection={selection} onChange={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(hls.ctor).toHaveBeenCalled());
    // 交给 hls.js 之后不能再写 src，否则 Chrome 会先报一次解码错误
    expect(container.querySelector("video")?.getAttribute("src")).toBeNull();
    expect(hls.attachMedia).toHaveBeenCalled();
    expect(hls.loadSource).toHaveBeenCalledWith("/play/m3u8/stream/index.m3u8");
  });

  it("hls.js 加载失败时回落原生 src，而不是黑屏", async () => {
    hls.fail = true;
    stubPlay({ items: [], values: { uri: "/play/m3u8/stream/index.m3u8" } });
    const { container } = render(<Player selection={selection} onChange={() => {}} onClose={() => {}} />);
    await waitFor(() =>
      expect(container.querySelector("video")?.getAttribute("src")).toBe("/play/m3u8/stream/index.m3u8"),
    );
  });
});
