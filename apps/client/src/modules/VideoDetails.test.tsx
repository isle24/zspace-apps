import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api, type Collection, type Item } from "../api/client";
import { VideoDetails } from "./VideoDetails";
import { NasModule } from "./NasModule";
import { Player } from "./Player";

const collection: Item = { id: "collection-1", name: "Selected collection", path: "/collection/1", metadata: { collection_id: 12, classification_id: 3 } };
const episode: Item = { id: "video-1-a", name: "Episode one.mkv", path: "/media/season-1/episode-1.mkv", kind: "video", size: 1024, metadata: { video_id: 1, version: "4K", episode: 1 } };
const props = { collection, connected: true, onClose: () => {}, onPlay: vi.fn() };
/** 左栏「分类」也会渲染同名媒体库，这里只取内容区的卡片，保持原先的交互断言。 */
async function contentCard(name: RegExp) {
  const all = await screen.findAllByRole("button", { name });
  return all.find((el) => el.closest(".media-grid")) ?? all[0];
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function detailRead(files: Item[] = [episode]) {
  return vi.spyOn(api, "read").mockImplementation(async (operation) =>
    operation === "video.info" ? { items: [], values: { title: "NAS title", storyline: "Returned storyline" } } : { items: files });
}

it("loads official collection metadata and passes the actual episode path and version in its queue", async () => {
  const read = detailRead([episode, { ...episode, id: "video-1-b", path: "/media/episode-1-1080.mkv", metadata: { video_id: 1, version: "1080p" } }]);
  const onPlay = vi.fn();
  render(<VideoDetails {...props} onPlay={onPlay} />);
  await screen.findByText("NAS title");
  expect(screen.getByText("Returned storyline")).toBeInTheDocument();
  expect(read).toHaveBeenCalledWith("video.info", { collection_id: "12", classification_id: "3" });
  expect(read).toHaveBeenCalledWith("video.files", { collection_id: "12", classification_id: "3" });
  fireEvent.click(screen.getByRole("button", { name: /Episode one.mkv.*4K/ }));
  expect(onPlay).toHaveBeenCalledWith({ items: [episode, expect.objectContaining({ path: "/media/episode-1-1080.mkv" })], index: 0, kind: "video" });
  expect(read.mock.calls.some(([operation]) => operation === "video.play")).toBe(false);
});

it("browses returned directories with file_path and excludes them from the playback queue", async () => {
  const directory: Item = { id: "season-1", name: "Season One", kind: "directory", path: "/media/season-1" };
  const read = vi.spyOn(api, "read").mockImplementation(async (operation, params) => operation === "video.info"
    ? { items: [], values: { title: "NAS title" } }
    : { items: params?.file_path ? [episode] : [directory] });
  const onPlay = vi.fn();
  render(<VideoDetails {...props} onPlay={onPlay} />);
  fireEvent.click(await screen.findByRole("button", { name: /Season One/ }));
  await screen.findByText("Episode one.mkv");
  expect(read).toHaveBeenLastCalledWith("video.files", { collection_id: "12", classification_id: "3", file_path: "/media/season-1" });
  expect(onPlay).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Episode one.mkv/ }));
  expect(onPlay).toHaveBeenCalledWith({ items: [episode], index: 0, kind: "video" });
  fireEvent.click(screen.getByRole("button", { name: "返回上一级目录" }));
  await screen.findByRole("button", { name: /Season One/ });
});

it.each([
  { id: "", name: "Missing collection", metadata: { classification_id: 3 } },
  { id: "12", name: "Missing classification" },
])("rejects missing collection or classification identifiers visibly without reading NAS: $name", async (missing) => {
  const read = detailRead();
  render(<VideoDetails {...props} collection={missing} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("影片或媒体库标识");
  expect(read).not.toHaveBeenCalled();
});

it("accepts an explicit zero classification identifier and the collection ID fallback", async () => {
  const read = detailRead();
  render(<VideoDetails {...props} collection={{ id: "fallback", name: "Zero", metadata: { classification_id: 0 } }} />);
  await screen.findByText("NAS title");
  expect(read).toHaveBeenCalledWith("video.files", { collection_id: "fallback", classification_id: "0" });
});

it("keeps missing file paths unplayable and displays server errors and empty results", async () => {
  const read = detailRead([{ id: "unavailable", name: "Missing path", kind: "video" }]);
  const view = render(<VideoDetails {...props} />);
  expect(await screen.findByRole("button", { name: /Missing path/ })).toBeDisabled();
  expect(screen.getByText("设备未返回文件路径，暂不能打开或播放")).toBeInTheDocument();
  read.mockImplementation(async () => { throw new Error("NAS denied this collection"); });
  view.rerender(<VideoDetails {...props} collection={{ ...collection, id: "another", metadata: { collection_id: 99, classification_id: 3 } }} />);
  expect((await screen.findAllByRole("alert"))[0]).toHaveTextContent("NAS denied this collection");
  read.mockResolvedValue({ items: [] });
  view.rerender(<VideoDetails {...props} collection={{ ...collection, metadata: { collection_id: 100, classification_id: 3 } }} />);
  await screen.findByText("这里还没有内容");
});

it("discards late responses when the collection changes", async () => {
  let finish: (value: Collection) => void = () => {};
  const read = vi.spyOn(api, "read").mockImplementation(async (operation, params) => {
    if (params?.collection_id === "12") return new Promise<Collection>((resolve) => { if (operation === "video.files") finish = resolve; });
    return operation === "video.info" ? { items: [], values: { title: "Current title" } } : { items: [{ ...episode, name: "Current episode" }] };
  });
  const view = render(<VideoDetails {...props} />);
  await waitFor(() => expect(read).toHaveBeenCalledWith("video.files", expect.anything()));
  view.rerender(<VideoDetails {...props} collection={{ ...collection, metadata: { collection_id: 22, classification_id: 3 } }} />);
  await screen.findByText("Current episode");
  await act(async () => finish({ items: [{ ...episode, name: "Stale episode" }] }));
  expect(screen.queryByText("Stale episode")).not.toBeInTheDocument();
});

it("loads collection info once while browsing and resets the directory for a new collection", async () => {
  const directory: Item = { id: "folder", name: "Nested directory", kind: "directory", path: "/media/nested" };
  const read = vi.spyOn(api, "read").mockImplementation(async (operation, params) => operation === "video.info" ? { items: [], values: { title: "NAS title" } } : { items: params?.file_path ? [episode] : [directory] });
  const view = render(<VideoDetails {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: /Nested directory/ }));
  await screen.findByText("Episode one.mkv");
  expect(read.mock.calls.filter(([operation]) => operation === "video.info")).toHaveLength(1);
  view.rerender(<VideoDetails {...props} collection={{ ...collection, metadata: { collection_id: 22, classification_id: 3 } }} />);
  await screen.findByRole("button", { name: /Nested directory/ });
  expect(read).toHaveBeenLastCalledWith("video.files", { collection_id: "22", classification_id: "3" });
  expect(screen.queryByText("Episode one.mkv")).not.toBeInTheDocument();
});

it("discards a late file result after the authenticated NAS session changes", async () => {
  let finish: (value: Collection) => void = () => {};
  const session = vi.spyOn(api, "nasSession", "get").mockReturnValue("synthetic-old");
  const read = vi.spyOn(api, "read").mockImplementation(async (operation) => operation === "video.info" ? { items: [] } : new Promise<Collection>((resolve) => { finish = resolve; }));
  const view = render(<VideoDetails {...props} />);
  await waitFor(() => expect(read).toHaveBeenCalledWith("video.files", expect.anything()));
  const oldFinish = finish;
  session.mockReturnValue("synthetic-new");
  read.mockResolvedValue({ items: [] });
  view.rerender(<VideoDetails {...props} />);
  await screen.findByText("这里还没有内容");
  await act(async () => oldFinish({ items: [episode] }));
  expect(screen.queryByText("Episode one.mkv")).not.toBeInTheDocument();
});

it("keeps library navigation and opens a film collection without playing it", async () => {
  const read = vi.spyOn(api, "read").mockImplementation(async (operation) => operation === "video.libraries"
    ? { items: [{ id: "3", name: "My library", kind: "library" }] }
    : operation === "video.list" ? { items: [{ ...collection, metadata: { collection_id: 12 } }] }
    : operation === "video.info" ? { items: [], values: { title: "NAS title" } } : { items: [episode] });
  const onPlay = vi.fn();
  render(<NasModule id="video" connected onPlay={onPlay} />);
  fireEvent.click(await contentCard(/My library/));
  expect(read).toHaveBeenLastCalledWith("video.list", { classification_id: "3", page: 1, pageSize: 20 });
  fireEvent.click(await screen.findByRole("button", { name: /Selected collection/ }));
  await screen.findByRole("region", { name: "影片详情" });
  await screen.findByText("NAS title");
  expect(onPlay).not.toHaveBeenCalled();
  expect(read.mock.calls.some(([operation]) => operation === "video.play")).toBe(false);
});

it("refreshes playback for two versions sharing an ID but having different file paths", async () => {
  const read = vi.spyOn(api, "read").mockResolvedValue({ items: [], values: {} });
  const items = [episode, { ...episode, path: "/media/alternate.mkv" }];
  const view = render(<Player selection={{ items, index: 0, kind: "video" }} onChange={() => {}} onClose={() => {}} />);
  await waitFor(() => expect(read).toHaveBeenCalledWith("video.play", { file_path: episode.path }));
  expect(screen.getByRole("button", { name: "上一集" })).toBeDisabled();
  view.rerender(<Player selection={{ items, index: 1, kind: "video" }} onChange={() => {}} onClose={() => {}} />);
  await waitFor(() => expect(read).toHaveBeenLastCalledWith("video.play", { file_path: "/media/alternate.mkv" }));
  expect(screen.getByRole("button", { name: "下一集" })).toBeDisabled();
});

it("rejects a collection-only Player selection visibly before requesting playback", async () => {
  const read = vi.spyOn(api, "read").mockResolvedValue({ items: [] });
  render(<Player selection={{ items: [{ id: "collection-only", name: "No file" }], index: 0, kind: "video" }} onChange={() => {}} onClose={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("视频文件路径");
  expect(read).not.toHaveBeenCalled();
});

it("removes the previous playable descriptor immediately while the next file loads", async () => {
  vi.spyOn(api.nas, "safeMediaUrl").mockImplementation((value) => typeof value === "string" && value.startsWith("mediaref:") ? value : undefined);
  let finish: (value: Collection) => void = () => {};
  const read = vi.spyOn(api, "read").mockResolvedValue({ items: [], values: { stream: "mediaref:old" } });
  const items = [episode, { ...episode, path: "/media/next.mkv" }];
  const view = render(<Player selection={{ items, index: 0, kind: "video" }} onChange={() => {}} onClose={() => {}} />);
  await waitFor(() => expect(view.container.querySelector("video")).toHaveAttribute("src", "mediaref:old"));
  read.mockImplementation(async () => new Promise<Collection>((resolve) => { finish = resolve; }));
  view.rerender(<Player selection={{ items, index: 1, kind: "video" }} onChange={() => {}} onClose={() => {}} />);
  expect(view.container.querySelector("video")).not.toBeInTheDocument();
  await act(async () => finish({ items: [], values: { stream: "mediaref:new" } }));
  await waitFor(() => expect(view.container.querySelector("video")).toHaveAttribute("src", "mediaref:new"));
});
