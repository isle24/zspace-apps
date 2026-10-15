import type { Item } from "./client";
export type ReadRequest = {
  operation: string;
  params: Record<string, unknown>;
};
export function fileRequest(
  operation: string,
  item?: Pick<Item, "id" | "name" | "path">,
): ReadRequest {
  if (item && !item.path)
    throw new Error("设备未返回文件路径，暂不能打开该项目");
  return {
    operation: item && operation === "files.recent" ? "files.list" : operation,
    params: item ? { path: item.path } : {},
  };
}
export function mediaRequest(
  module: string,
  tab: string,
  parent?: Item,
): ReadRequest {
  if (!parent) return { operation: `${module}.${tab}`, params: {} };
  if (module === "photos")
    return { operation: "photos.feeds", params: { album_id: parent.id } };
  if (module === "video")
    return {
      operation: "video.list",
      params: { classification_id: parent.id },
    };
  return {
    operation: "music.songs",
    params:
      tab === "playlists"
        ? { playlist_id: parent.id }
        : { filter_type: "album", filter_value: parent.id },
  };
}
export function playRequest(kind: "video" | "music", item: Item): ReadRequest {
  if (!item.path?.trim())
    throw new Error(kind === "music" ? "设备未返回音乐文件路径，暂不能播放" : "设备未返回视频文件路径，暂不能播放");
  return kind === "music"
    // music.play 的允许参数名是 file_path（与 video.play 一致）；传 path 会被 SDK 直接判为
    // 不支持的参数并抛错，之前音乐点开就是"没有播放地址"
    ? { operation: "music.play", params: { file_path: item.path } }
    : {
        operation: "video.play",
        params: { file_path: item.path },
      };
}

/**
 * 「全部影片」是客户端自己的聚合视图 —— 官方侧栏只有真实媒体库，没有"全部"这一项。
 * 而 `/zvideo/video/v2/list` 必须带 `classification_id`（实测不带会返回 N001212 参数有误），
 * 所以这里按媒体库逐个取一页再合并，并把所属媒体库写回条目的 metadata，
 * 保证后续进入详情/播放时仍然知道它属于哪个库。
 */
export type VideoLibraryPage = {
  items: Item[];
  total?: number;
  totalPages?: number;
  libraries: number;
  /** 读取失败的媒体库名（不会让整页失败，但要在界面上说清楚） */
  failedLibraries?: string[];
};

export async function aggregateVideoList(
  read: (operation: string, params: Record<string, unknown>) => Promise<{ items?: Item[]; total?: number }>,
  page: number,
  pageSize: number,
  maxLibraries = 8,
): Promise<VideoLibraryPage> {
  const libraries = await read("video.libraries", {});
  const ids = (libraries.items ?? [])
    .map((entry) => ({ id: entry.id, name: entry.name }))
    .filter((entry) => typeof entry.id === "string" && entry.id.trim())
    .slice(0, maxLibraries);
  if (!ids.length) return { items: [], total: 0, libraries: 0 };
  const pages = await Promise.all(
    ids.map(async (library) => {
      try {
        const result = await read("video.list", {
          classification_id: library.id,
          page,
          pageSize,
        });
        return {
          total: result.total,
          items: (result.items ?? []).map((item) => ({
            ...item,
            metadata: { ...(item.metadata ?? {}), classification_id: library.id, classification_name: library.name },
          })),
        };
      } catch {
        // 单个库里没有可读内容时不该让整个"全部影片"失败；
        // 但要**记下来**：否则用户只会看到"片子变少了"，却不知道是某个库读失败。
        return { total: undefined, items: [] as Item[], failed: library.name };
      }
    }),
  );
  const total = pages.some((entry) => entry.total !== undefined)
    ? pages.reduce((sum, entry) => sum + (entry.total ?? 0), 0)
    : undefined;
  const failed = pages.map((entry) => entry.failed).filter((name): name is string => !!name);
  // Each aggregate page contains one page from every library. Its range is
  // governed by the longest library, not the sum divided by one page size.
  const totalPages = !failed.length && pages.every(entry => typeof entry.total === 'number' && Number.isFinite(entry.total) && entry.total >= 0)
    ? Math.max(1, ...pages.map(entry => Math.ceil(entry.total! / pageSize)))
    : undefined;
  return {
    items: pages.flatMap((entry) => entry.items),
    total,
    totalPages,
    libraries: ids.length,
    failedLibraries: failed,
  };
}
