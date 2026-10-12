import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import Hls from "hls.js";
import { Player } from "./Player";
import { api } from "../api/client";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  api.logoutNas();
});

const video = { id: "/movies/demo.mkv", name: "演示影片.mkv", path: "/movies/demo.mkv", kind: "video" };
const selection = { items: [video], index: 0, kind: "video" as const };

function stubPlay(response: unknown) {
  vi.spyOn(api, "read").mockResolvedValue(response as never);
  // safeMediaUrl 归 SDK 管；这里聚焦"从响应的哪个字段取地址"
  vi.spyOn(api.nas, "safeMediaUrl").mockImplementation((value: unknown) =>
    typeof value === "string" ? value : undefined,
  );
}

const song = { id: "/music/demo.mp3", name: "演示歌曲.mp3", path: "/music/demo.mp3", kind: "music" };
const renderPlayer = (
  { kind }: { kind?: "video" | "music" } = {},
) =>
  render(
    <Player
      selection={
        kind === "music"
          ? { items: [song], index: 0, kind: "music" as const }
          : selection
      }
      onChange={() => {}}
      onClose={() => {}}
    />,
  );

describe("player media source", () => {
  it("uses data.uri, which is where the NAS puts the play address", async () => {
    // 官方前端 getVideoPlayUrlV2 读的就是 data.uri；之前只读 stream/url，导致窗口里放不出画面
    stubPlay({ items: [], values: { uri: "/play/abc123/demo.mkv/index.m3u8" } });
    const { container } = renderPlayer();
    await waitFor(() =>
      expect(container.querySelector("video")?.getAttribute("src")).toBe("/play/abc123/demo.mkv/index.m3u8"),
    );
  });

  it("still accepts the older stream/url shapes", async () => {
    stubPlay({ items: [], values: { url: "/transcode/play?file_path=x" } });
    const { container } = renderPlayer();
    await waitFor(() =>
      expect(container.querySelector("video")?.getAttribute("src")).toBe("/transcode/play?file_path=x"),
    );
  });

  it("reports honestly when the device returns no usable address", async () => {
    stubPlay({ items: [], values: {} });
    renderPlayer();
    expect(await screen.findByText("设备未返回可用的鉴权播放地址，无法开始播放。")).toBeInTheDocument();
  });

  /*
   * 倍速改成了"一个显示当前值的按钮，点一下换下一档"（对齐绿联的 1.0x）。
   * 以前是五个按钮一组；契约只要求 `aria-label="播放速度"`，所以这里按新形态断言：
   * 点一次 → 换到下一档并作用到 media 上。
   */
  it("cycles through playback speeds and applies the choice to the media element", async () => {
    stubPlay({ items: [], values: { uri: "/play/abc/index.m3u8" } });
    const { container } = renderPlayer();
    const button = await screen.findByRole("button", { name: "播放速度" });
    const media = container.querySelector("video") as HTMLVideoElement;
    expect(media.playbackRate).toBe(1);
    fireEvent.click(button);
    expect(media.playbackRate).toBeGreaterThan(1);
    expect(button.textContent).toContain("×");
  });

  it("retries once through the NAS and then reports failure instead of pretending", async () => {
    stubPlay({ items: [], values: { uri: "/play/abc/index.m3u8" } });
    const { container } = renderPlayer();
    const media = await waitFor(() => {
      const el = container.querySelector("video");
      expect(el).not.toBeNull();
      return el as HTMLVideoElement;
    });
    fireEvent.error(media);                       // 第一次失败 -> 让 NAS 重新判定转码
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(2));
    fireEvent.error(container.querySelector("video") as HTMLVideoElement);
    expect(await screen.findByText(/转码重试后仍不可用/)).toBeInTheDocument();
  });
});

describe("HLS handling (the NAS returns HLS, verified on the device)", () => {
  it("recognises the measured HLS shapes", async () => {
    const { isHlsSource } = await import("./Player");
    // 实测 /transcode/play 的 uri：/play/m3u8/strm/<hash>
    expect(isHlsSource("/play/m3u8/strm/CvDH84eeFm3XFdIy0KlqbQjKm3icGzJX")).toBe(true);
    expect(isHlsSource("/splay/m3u8/audio/abc")).toBe(true);
    expect(isHlsSource("http://nas/play/x/index.m3u8?token=1")).toBe(true);
    expect(isHlsSource("/transcode/play?file_path=x")).toBe(false);
    expect(isHlsSource(undefined)).toBe(false);
  });

  it("hands an HLS address to hls.js instead of src when the browser needs it", async () => {
    // Chrome 会对 HLS 的 MIME 回答 "maybe"（假阳性），所以选路只看 Hls.isSupported()
    vi.spyOn(Hls, "isSupported").mockReturnValue(true);
    stubPlay({ items: [], values: { uri: "/play/m3u8/strm/abc" } });
    const { container } = renderPlayer();
    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    // hls.js 现在是**按需加载**的，判断变成异步；等一拍再断言
    await waitFor(() => expect(container.querySelector("video")?.getAttribute("src")).toBeNull());
    // 仍然不能写 src，否则 Chrome 会先报一次解码错误
    expect(container.querySelector("video")?.getAttribute("src")).toBeNull();
  });

  it("documents the Chrome false positive that must not drive the choice", async () => {
    const { canPlayHlsNatively, isHlsSource } = await import("./Player");
    // 即便平台声称支持（canPlayType 返回 "maybe"），只要 hls.js 可用就必须用 hls.js
    vi.spyOn(Hls, "isSupported").mockReturnValue(true);
    expect(isHlsSource("/play/m3u8/strm/x")).toBe(true);
    expect(typeof canPlayHlsNatively()).toBe("boolean");
  });

  it("does not send a STRM redirector to hls.js (measured: it 302s to the real file)", async () => {
    vi.spyOn(Hls, "isSupported").mockReturnValue(true);
    // 实测 /transcode/play 对 .strm 返回 {strm: true, uri: "/play/m3u8/strm/<hash>"}，
    // 该地址会 302 到 .strm 里写的真实地址（通常是远端 mp4），不是 HLS 清单。
    stubPlay({ items: [], values: { strm: true, uri: "/play/m3u8/strm/CvDH84ee" } });
    const { container } = renderPlayer();
    await waitFor(() =>
      expect(container.querySelector("video")?.getAttribute("src")).toBe("/play/m3u8/strm/CvDH84ee"),
    );
  });

  it("keeps src for a progressive address", async () => {
    stubPlay({ items: [], values: { uri: "/transcode/play?file_path=x" } });
    const { container } = renderPlayer();
    await waitFor(() =>
      expect(container.querySelector("video")?.getAttribute("src")).toBe("/transcode/play?file_path=x"),
    );
  });
});

describe("music playback uses fnOS's docked pill", () => {
  it("formats the elapsed time for the bar", async () => {
    const { clock } = await import("./Player");
    expect(clock(0)).toBe("0:00");
    expect(clock(59)).toBe("0:59");
    expect(clock(211)).toBe("3:31");
    expect(clock(3725)).toBe("1:02:05");
    expect(clock(Number.NaN)).toBe("0:00");
  });

  it("offers a play/pause control and a seekable progress bar instead of native controls", async () => {
    stubPlay({ items: [], values: { uri: "/splay/song-1" } });
    const { container } = renderPlayer({ kind: "music" });
    await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
    // 音乐走自绘运输条（原生 controls 在胶囊里放不下）
    expect(container.querySelector("audio")?.hasAttribute("controls")).toBe(false);
    expect(screen.getByRole("button", { name: "播放" })).toBeTruthy();
    expect(screen.getByLabelText("播放进度")).toBeTruthy();
  });
});

describe("music queue panel", () => {
  it("lists the queue with the current track marked and switches on click", async () => {
    const a = { id: "s1", name: "第一首", path: "/m/1.mp3", kind: "music", metadata: { artist: "甲" } };
    const b = { id: "s2", name: "第二首", path: "/m/2.mp3", kind: "music", metadata: { artist: "乙" } };
    stubPlay({ items: [], values: { uri: "/splay/x" } });
    const changes: number[] = [];
    render(
      <Player
        selection={{ items: [a, b], index: 0, kind: "music" }}
        onChange={(next) => changes.push(next.index)}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "播放队列" }));
    const panel = await screen.findByRole("region", { name: "播放队列" });
    expect(within(panel).getByText("第一首")).toBeTruthy();
    expect(within(panel).getByText("正在播放")).toBeTruthy();
    expect(within(panel).getByText("1 / 2")).toBeTruthy();
    fireEvent.click(within(panel).getByText("第二首"));
    expect(changes).toEqual([1]);
  });
});

describe("panels survive a track change", () => {
  it("keeps the queue open and moves the marker when the next track is chosen", async () => {
    const a = { id: "s1", name: "第一首", path: "/m/1.mp3", kind: "music" };
    const b = { id: "s2", name: "第二首", path: "/m/2.mp3", kind: "music" };
    stubPlay({ items: [], values: { uri: "/splay/x" } });
    const selection = { items: [a, b], index: 0, kind: "music" as const };
    const { rerender } = render(
      <Player selection={selection} onChange={() => {}} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "播放队列" }));
    expect(await screen.findByRole("region", { name: "播放队列" })).toBeTruthy();
    // 换歌会让 PlayerContent 按 key 重挂载；面板状态在外层，所以必须还开着
    rerender(<Player selection={{ ...selection, index: 1 }} onChange={() => {}} onClose={() => {}} />);
    const panel = await screen.findByRole("region", { name: "播放队列" });
    expect(within(panel).getByText("2 / 2")).toBeTruthy();
    expect(within(panel).getAllByText("正在播放")).toHaveLength(1);
  });
});

describe("undecodable music files", () => {
  it("names the codec problem instead of a generic failure, and offers to skip", async () => {
    const a = { id: "s1", name: "伪装成 mp3 的 wma.mp3", path: "/m/1.mp3", kind: "music" };
    const b = { id: "s2", name: "第二首", path: "/m/2.mp3", kind: "music" };
    stubPlay({ items: [], values: { uri: "/splay/ZE" } });
    const changes: number[] = [];
    const { container } = render(
      <Player
        selection={{ items: [a, b], index: 0, kind: "music" }}
        onChange={(next) => changes.push(next.index)}
        onClose={() => {}}
      />,
    );
    const el = await waitFor(() => {
      const node = container.querySelector("audio") as HTMLAudioElement;
      expect(node).not.toBeNull();
      return node;
    });
    // 浏览器报 MEDIA_ERR_SRC_NOT_SUPPORTED（4）：转码重试一次后仍失败
    fireEvent.error(el);                       // 第一次失败 -> 让 NAS 重新判定转码
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(2));
    // 重试会让 React 换掉 audio 节点，所以要在当前节点上模拟"浏览器解不了这个编码"
    const fresh = container.querySelector("audio") as HTMLAudioElement;
    Object.defineProperty(fresh, "error", { configurable: true, value: { code: 4, message: "unsupported" } });
    fireEvent.error(fresh);                    // 第二次 -> 报明确原因
    // 文案由 Status 呈现（role=status），断言文案本身
    const message = await screen.findByText(/音频编码/);
    expect(message.textContent).toContain("WMA");
    fireEvent.click(screen.getByRole("button", { name: "跳过这一首" }));
    expect(changes).toEqual([1]);
  });
});
