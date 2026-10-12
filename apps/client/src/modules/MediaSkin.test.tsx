/*
 * 媒体窗口换肤结构守卫（任务 3：相册 / 影视中心 / 音乐）
 *
 * 目的：换肤只允许改观感，不允许改契约。这里锁定媒体窗口对外可依赖的部分：
 * - 既有 className（media-module / media-hero / toolbar / tabs / media-grid /
 *   song-list / media-card / media-art / media-caption / play-overlay / photo-viewer）
 * - 既有 aria-label（返回媒体库 / 刷新媒体 / 影片详情）与 role（dialog / status）
 * - 既有中文文案（三个 Tab、空状态、查看器按钮等）
 * - 交互：分页、返回媒体库、打开照片查看器、进入影片详情
 */
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api, type Collection, type Item } from "../api/client";
import { NasModule } from "./NasModule";

const item = (id: string, kind = "photo"): Item => ({
  id,
  name: `媒体 ${id}`,
  kind,
  path: `/media/${id}`,
  metadata: { artist: `歌手 ${id}` },
});
const noop = () => {};

/** 左栏「分类」也会渲染同名媒体库，这里只取内容区的卡片，保持原先的交互断言。 */
async function contentCard(name: RegExp) {
  const all = await screen.findAllByRole("button", { name });
  return all.find((el) => el.closest(".media-grid")) ?? all[0];
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockRead(items: Item[] = [], total = items.length) {
  return vi
    .spyOn(api, "read")
    .mockImplementation(async (): Promise<Collection> => ({ items, total }));
}

it.each([
 ["photos",".photos-workspace",["图库","我的相册","宝宝相册","共享相册"],"刷新相册","搜索当前相册内容"],
 ["music",".qq-music",["全部歌曲","专辑","歌单"],"刷新音乐","搜索当前音乐内容"],
] as const)("%s 提供参考布局中的实际功能入口",async(id,selector,tabs,refresh,search)=>{mockRead();const {container}=render(<NasModule id={id} connected onPlay={noop}/>);await screen.findByRole("button",{name:tabs[0]});expect(container.querySelector(selector)).not.toBeNull();for(const tab of tabs)expect(screen.getByRole("button",{name:tab})).toBeInTheDocument();expect(screen.getByRole("button",{name:refresh})).toBeInTheDocument();expect(screen.getByLabelText(search)).toBeInTheDocument()});
it("影视保留既有媒体库导航和工具栏",async()=>{mockRead();const {container}=render(<NasModule id="video" connected onPlay={noop}/>);expect(container.querySelector(".media-module.video .toolbar")).not.toBeNull();expect(screen.getByRole("button",{name:"全部影片"})).toBeInTheDocument()});

it("未连接时给出可操作的居中空状态（文案 + 蓝色主按钮）", async () => {
  mockRead();
  const { container } = render(<NasModule id="photos" connected={false} onPlay={noop} />);
  expect(await screen.findByText("连接 NAS，打开你的空间")).toBeInTheDocument();
  expect(screen.getByText("当前未连接设备。登录后即可读取真实内容。")).toBeInTheDocument();
  const stage = container.querySelector(".photos-main");
  expect(stage?.querySelector(".state-panel")).not.toBeNull();
  expect(screen.getByRole("button", { name: "刷新相册" })).toBeInTheDocument();
});

it("相册返回的是媒体卡片网格，且照片不出现播放遮罩", async () => {
  mockRead([item("a"), item("b")]);
  const { container } = render(<NasModule id="photos" connected onPlay={noop} />);
  await screen.findByRole("button",{name:"查看 媒体 a"});
  const grid=container.querySelector(".photo-mosaic");expect(grid?.querySelectorAll(".photo-tile")).toHaveLength(2);expect(grid?.querySelector(".play-overlay")).toBeNull();
});

it("影视用海报比例卡片并保留播放遮罩，切到全部影片后进入影片详情", async () => {
  mockRead([item("v1", "video")]);
  const { container } = render(<NasModule id="video" connected onPlay={noop} />);
  const card = await screen.findByRole("button", { name: /媒体 v1/ });
  expect(card.querySelector(".play-overlay")).not.toBeNull();
  expect(card.querySelector(".media-art")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "全部影片" }));
  fireEvent.click(await screen.findByRole("button", { name: /媒体 v1/ }));
  const details = await screen.findByLabelText("影片详情");
  expect(details).toHaveClass("video-details");
  expect(screen.getByRole("button", { name: /返回影片列表/ })).toBeInTheDocument();
  expect(container.querySelector(".play-overlay")).toBeNull();
});

it("音乐歌曲 Tab 使用歌曲列表行并保留播放图标", async () => {
  mockRead([item("m1", "song")]);
  const { container } = render(<NasModule id="music" connected onPlay={noop} />);
  await screen.findByText("媒体 m1");
  const list=container.querySelector(".music-song-table");expect(list?.querySelectorAll("button.music-song-row")).toHaveLength(1);expect(list?.querySelector(".music-artwork")).not.toBeNull();expect(screen.getByRole("button",{name:"播放 媒体 m1"})).toBeInTheDocument();
});

it("进入媒体库后可用「返回媒体库」回到上一级（aria-label 不变）", async () => {
  const read = vi
    .spyOn(api, "read")
    .mockImplementation(async (operation): Promise<Collection> =>
      operation === "video.libraries"
        ? { items: [{ id: "lib", name: "媒体库 A", kind: "library" }], total: 1 }
        : { items: [item("v2", "video")], total: 1 },
    );
  render(<NasModule id="video" connected onPlay={noop} />);
  fireEvent.click(await contentCard(/媒体库 A/));
  await screen.findByText("媒体 v2");
  expect(read).toHaveBeenLastCalledWith("video.list", { classification_id: "lib", page: 1, pageSize: 20 });
  fireEvent.click(screen.getByRole("button", { name: "返回媒体库" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "返回媒体库" })).not.toBeInTheDocument(),
  );
});

it("点击照片打开查看器：role=dialog、aria-label 为文件名、可返回相册", async () => {
  mockRead([item("p1")]);
  render(<NasModule id="photos" connected onPlay={noop} />);
  fireEvent.click(await screen.findByRole("button", { name: /媒体 p1/ }));
  const dialog = screen.getByRole("dialog", { name: "媒体 p1" });
  expect(dialog.querySelector(".photo-viewer-bar")).not.toBeNull();
  expect(dialog.querySelector("h3")?.textContent).toBe("媒体 p1");
  fireEvent.click(screen.getByRole("button", { name: "返回相册" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
