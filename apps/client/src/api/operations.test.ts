import { describe, expect, it } from "vitest";
import { aggregateVideoList, fileRequest, mediaRequest, playRequest } from "./operations";
it("file navigation uses only the verified path parameter", () => {
  expect(
    fileRequest("files.list", {
      id: "opaque",
      name: "Folder",
      path: "/synthetic/folder",
    }),
  ).toEqual({ operation: "files.list", params: { path: "/synthetic/folder" } });
});
it("library navigation maps to the verified NAS classification parameter", () => {
  expect(
    mediaRequest("video", "libraries", { id: "42", name: "Library" }),
  ).toEqual({ operation: "video.list", params: { classification_id: "42" } });
});
it("album navigation uses the album feeds route rather than timeline", () => {
  expect(mediaRequest("photos", "albums", { id: "a", name: "Album" })).toEqual({
    operation: "photos.feeds",
    params: { album_id: "a" },
  });
});
it("music playback sends the verified transcode file path", () => {
  // music.play 的允许参数名是 file_path：传 path 会被 SDK 判为不支持参数，音乐就放不出来
  expect(
    playRequest("music", { id: "song", name: "Song", path: "/s.mp3" }),
  ).toEqual({ operation: "music.play", params: { file_path: "/s.mp3" } });
});
it("video playback requires a selected file instead of a collection-only identifier", () => {
  expect(() => playRequest("video", { id: "collection-7", name: "Series" })).toThrow("文件");
  expect(playRequest("video", { id: "episode-1", name: "Episode 1", path: "/media/s01e01.mkv" })).toEqual({
    operation: "video.play", params: { file_path: "/media/s01e01.mkv" },
  });
});
it("opening a recent directory uses file listing, never recent with a path", () => {
  expect(
    fileRequest("files.recent", {
      id: "folder",
      name: "Folder",
      path: "/folder",
    }),
  ).toEqual({ operation: "files.list", params: { path: "/folder" } });
});
it("album songs use verified album filtering", () => {
  expect(
    mediaRequest("music", "albums", { id: "42", name: "Album", kind: "album" }),
  ).toEqual({
    operation: "music.songs",
    params: { filter_type: "album", filter_value: "42" },
  });
});
it("playlist songs use the verified playlist route adapter", () => {
  expect(
    mediaRequest("music", "playlists", {
      id: "42",
      name: "List",
      kind: "playlist",
    }),
  ).toEqual({ operation: "music.songs", params: { playlist_id: "42" } });
});

describe("部分媒体库读取失败", () => {
  /**
   * 官方接口强制按 classification_id 取，「全部影片」是逐库合并。
   * 某个库读不出来时不能让整页失败，但**必须记下来** ——
   * 否则用户只会看到"片子变少了"，不知道原因。
   */
  it("保留其它库的内容，并列出失败的库名", async () => {
    const read = async (operation: string, params: Record<string, unknown>) => {
      if (operation === "video.libraries") {
        return { items: [
          { id: "a", name: "电影" },
          { id: "b", name: "电视剧" },
        ] as never };
      }
      if (params.classification_id === "b") throw new Error("设备返回 500");
      return { items: [{ id: "1", name: "片子", kind: "file", path: "/x" }] as never, total: 1 };
    };
    const result = await aggregateVideoList(read, 1, 20);
    expect(result.items).toHaveLength(1);
    expect(result.libraries).toBe(2);
    expect(result.failedLibraries).toEqual(["电视剧"]);
    // 总数只统计成功的那部分，不能把失败库算成 0 还装作完整
    expect(result.total).toBe(1);
  });

  it("全部成功时不产生失败列表", async () => {
    const read = async (operation: string) => {
      if (operation === "video.libraries") return { items: [{ id: "a", name: "电影" }] as never };
      return { items: [{ id: "1", name: "片子", kind: "file", path: "/x" }] as never, total: 7 };
    };
    const result = await aggregateVideoList(read, 1, 20);
    expect(result.failedLibraries).toEqual([]);
    expect(result.total).toBe(7);
  });
});
