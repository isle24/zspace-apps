import { afterEach, expect, it, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";
import { NasModule } from "./NasModule";
import { api, type Collection } from "../api/client";
import { Pagination } from './Pagination';
it('uses the supplied aggregate page range while preserving the real item total', () => {
  render(<Pagination page={5} total={121} totalPages={5} count={20} onPage={() => {}} />);
  expect(screen.getByText(/第 5 页 \/ 5 页.*121/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
});
const page = (number: number, kind = "file"): Collection => ({
  items: [
    {
      id: `page-${number}`,
      name: `Page ${number}`,
      kind,
      path: `/page-${number}`,
    },
  ],
  total: 21,
});
/** 左栏「分类」也会渲染同名媒体库，这里只取内容区的卡片，保持原先的交互断言。 */
async function contentCard(name: RegExp) {
  const all = await screen.findAllByRole("button", { name });
  return all.find((el) => el.closest(".media-grid")) ?? all[0];
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("shows the full official album collection without offering a repeated server page", async () => {
  const read = vi.spyOn(api, "read").mockImplementation(async (operation) => operation === "photos.albums"
    ? { items: Array.from({ length: 21 }, (_, i) => ({ id: `album-${i + 1}`, name: `Album ${i + 1}`, kind: "album",metadata:{type:10} })), total: 21 }
    : { items: [], total: 0 });
  render(<NasModule id="photos" connected onPlay={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "我的相册" }));
  await screen.findByText("Album 21");
  expect(screen.queryByRole("navigation", { name: "列表分页" })).not.toBeInTheDocument();
  expect(read).toHaveBeenLastCalledWith("photos.albums", {});
});
it("loads the next recent-files page from NAS and resets on directory navigation", async () => {
  const read = vi
    .spyOn(api, "read")
    .mockImplementation(async (operation, params = {}) =>
      operation === "files.roots"
        ? { items: [], total: 0 }
        : page(Number(params.page || 1), "directory"),
    );
  render(<NasModule id="files" connected onPlay={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "最近访问" }));
  await screen.findByText("Page 1");
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByText("Page 2");
  expect(read).toHaveBeenCalledWith("files.recent", { page: 2, pageSize: 20 });
  fireEvent.click(screen.getByRole("button", { name: /Page 2/ }));
  await waitFor(() =>
    expect(read).toHaveBeenLastCalledWith("files.list", {
      path: "/page-2",
      page: 1,
      pageSize: 20,
    }),
  );
});
it.each([
  ["photos", "photos.timeline"],
  ["video", "video.list"],
  ["music", "music.songs"],
  ["downloads", "downloads.list"],
])(
  "paginates %s using server total and real page requests",
  async (id, operation) => {
    const read = vi
      .spyOn(api, "read")
      .mockImplementation(async (_operation, params = {}) =>
        ({...page(Number(params.page || 1)),total:id==="photos"?61:21}),
      );
    render(<NasModule id={id} connected onPlay={() => {}} />);
    if (id === "video")
      fireEvent.click(screen.getByRole("button", { name: "全部影片" }));
    if(id==="photos")await screen.findByRole("button",{name:"查看 Page 1"});else await screen.findByText("Page 1");
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    if(id==="photos")await screen.findByRole("button",{name:"查看 Page 2"});else await screen.findByText("Page 2");
    expect(read).toHaveBeenLastCalledWith(
      operation,
      expect.objectContaining({ page: 2, pageSize: id==="photos"?60:20 }),
    );
    expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
    expect(screen.getByText(id==="photos"?/共 61 项/:/共 21 项/)).toBeInTheDocument();
  },
);
it("drops a late old download page after switching the task filter", async () => {
  let complete: (data: Collection) => void = () => {};
  const read = vi
    .spyOn(api, "read")
    .mockImplementation(async (_operation, params = {}) => {
      if (params.type === "loading" && params.page === 2)
        return new Promise((resolve) => {
          complete = resolve;
        });
      return {
        ...page(1),
        items: [{ id: String(params.type), name: String(params.type) }],
      };
    });
  render(<NasModule id="downloads" connected onPlay={() => {}} />);
  await screen.findByText("loading");
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await waitFor(() =>
    expect(read).toHaveBeenCalledWith("downloads.list", {
      type: "loading",
      page: 2,
      pageSize: 20,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "已完成" }));
  await screen.findByText("complete");
  await act(async () => {
    complete(page(2));
  });
  expect(screen.queryByText("Page 2")).not.toBeInTheDocument();
  expect(read).toHaveBeenLastCalledWith("downloads.list", {
    type: "complete",
    page: 1,
    pageSize: 20,
  });
});
it("returns to page one for a new video library and keeps library discovery unpaged", async () => {
  const read = vi
    .spyOn(api, "read")
    .mockImplementation(async (operation, params = {}) =>
      operation === "video.libraries"
        ? {
            items: [
              { id: "one", name: "Library One", kind: "library" },
              { id: "two", name: "Library Two", kind: "library" },
            ],
            total: 2,
          }
        : page(Number(params.page || 1), "video"),
    );
  render(<NasModule id="video" connected onPlay={() => {}} />);
  fireEvent.click(await contentCard(/Library One/));
  await screen.findByText("Page 1");
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByText("Page 2");
  fireEvent.click(screen.getByRole("button", { name: "返回媒体库" }));
  fireEvent.click(await contentCard(/Library Two/));
  await waitFor(() =>
    expect(read).toHaveBeenLastCalledWith("video.list", {
      classification_id: "two",
      page: 1,
      pageSize: 20,
    }),
  );
  expect(
    read.mock.calls
      .filter(([operation]) => operation === "video.libraries")
      .every(([, params]) => Object.keys(params || {}).length === 0),
  ).toBe(true);
});
it("previous page triggers a fresh NAS read rather than slicing cached results", async () => {
  const read = vi
    .spyOn(api, "read")
    .mockImplementation(async (_operation, params = {}) =>
      page(Number(params.page || 1), "music"),
    );
  render(<NasModule id="music" connected onPlay={() => {}} />);
  await screen.findByText("Page 1");
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByText("Page 2");
  fireEvent.click(screen.getByRole("button", { name: "上一页" }));
  await screen.findByText("Page 1");
  expect(read.mock.calls.map(([, params]) => params?.page)).toEqual([1, 2, 1]);
});
