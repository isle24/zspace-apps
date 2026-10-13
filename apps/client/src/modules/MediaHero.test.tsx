import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api, type Item } from "../api/client";
import { MediaWindow } from "./MediaWindow";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const library: Item = { id: "library-7", name: "家庭影院", kind: "library", metadata: { collection_count: 1 } };
const film: Item = {
  id: "collection-9", name: "星际旅途", kind: "video",
  thumbnail: "https://nas.test/zvideo_static/portrait_cover.jpg",
  metadata: { classification_id: library.id, collection_id: "collection-9", release_year: 2024, genres: "冒险 / 科幻", storyline: "一段真实的影片简介。" },
};
const panorama = "https://nas.test/zvideo_static/landscape_backdrop.jpg";
function fixture(item: Item, backdrop?: string, files: Item[] = []) {
  vi.spyOn(api.nas, "safeMediaUrl").mockImplementation(value => typeof value === "string" && value.startsWith("https://nas.test/") ? value : undefined);
  return vi.spyOn(api, "read").mockImplementation(async operation =>
    operation === "video.libraries" ? { items: [library], total: 1 } :
    operation === "video.list" ? { items: [item], total: 1 } :
    operation === "video.info" ? { items: [], values: { backdrop } } :
    operation === "video.files" ? { items: files } : { items: [] });
}

it("resolves the collection's real video files before the home play action starts a player", async () => {
  const file: Item = { id: "file-5", name: "第 1 集.mkv", kind: "video", path: "/movies/real/episode1.mkv" };
  const read = fixture({ ...film, backdrop: panorama }, undefined, [file]);
  const play = vi.fn();
  render(<MediaWindow id="video" connected onPlay={play} />);
  await screen.findByRole("region", { name: "首页推荐影片" });
  fireEvent.click(screen.getByRole("button", { name: "播放" }));
  await waitFor(() => expect(play).toHaveBeenCalledWith({ items: [file], index: 0, kind: "video" }));
  expect(read).toHaveBeenCalledWith("video.files", { collection_id: film.id, classification_id: library.id });
});

it("accepts playback from the first visible hero without cancelling the same collection request", async () => {
  const file: Item = { id: "file-immediate", name: "实际影片.mkv", kind: "video", path: "/movies/real/movie.mkv" };
  const read = fixture({ ...film, backdrop: panorama });
  const baseline = read.getMockImplementation()!;
  let finish!: (data: { items: Item[] }) => void;
  read.mockImplementation((operation, ...args) => operation === "video.files"
    ? new Promise(resolve => { finish = resolve; }) : baseline(operation, ...args));
  const play = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  let clicked = false;
  const observer = new MutationObserver(() => {
    const button = host.querySelector<HTMLButtonElement>(".hero-play");
    if (button && !clicked) { clicked = true; fireEvent.click(button); }
  });
  observer.observe(host, { childList: true, subtree: true });
  try {
    render(<MediaWindow id="video" connected onPlay={play} />, { container: host });
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    await act(async () => finish({ items: [file] }));
    expect(play).toHaveBeenCalledWith({ items: [file], index: 0, kind: "video" });
  } finally { observer.disconnect(); host.remove(); }
});

it("uses the returned widescreen backdrop across the home hero without a portrait poster", async () => {
  const read = fixture({ ...film, backdrop: panorama });
  const { container } = render(<MediaWindow id="video" connected onPlay={() => {}} />);
  const hero = await screen.findByRole("region", { name: "首页推荐影片" });
  expect(hero.closest(".media-module")?.querySelector(".video-window-art")).toHaveAttribute("src", panorama);
  expect(hero.querySelector(".hero-backdrop")).toBeNull();
  expect(hero.querySelector(".hero-poster")).toBeNull();
  expect(hero).toHaveTextContent("星际旅途");
  expect(hero).not.toHaveStyle({ backgroundImage: `url(${film.thumbnail})` });
  expect(read.mock.calls.filter(([operation]) => operation === "video.info")).toHaveLength(0);
  expect(container.querySelector(".video-hero")).not.toBeNull();
});

it("reads the actual film detail backdrop when its list entry has no backdrop", async () => {
  const read = fixture(film, panorama);
  render(<MediaWindow id="video" connected onPlay={() => {}} />);
  const hero = await screen.findByRole("region", { name: "首页推荐影片" });
  await waitFor(() => expect(hero.closest(".media-module")?.querySelector(".video-window-art")).toHaveAttribute("src", panorama));
  expect(read).toHaveBeenCalledWith("video.info", { collection_id: film.id, classification_id: library.id });
});

it("keeps a neutral hero when no actual backdrop is available and hides the home hero in a library", async () => {
  fixture(film);
  render(<MediaWindow id="video" connected onPlay={() => {}} />);
  const hero = await screen.findByRole("region", { name: "首页推荐影片" });
  expect(hero.querySelector("img")).toBeNull();
  expect(hero).toHaveTextContent("设备未提供横版背景图");
  const libraryButton = (await screen.findAllByRole("button", { name: /家庭影院/ })).find(button => button.closest(".media-grid"))!;
  fireEvent.click(libraryButton);
  await waitFor(() => expect(screen.queryByRole("region", { name: "首页推荐影片" })).not.toBeInTheDocument());
});

it("does not stretch a failed or portrait-shaped backdrop into a panorama", async () => {
  fixture({ ...film, backdrop: panorama });
  render(<MediaWindow id="video" connected onPlay={() => {}} />);
  const hero = await screen.findByRole("region", { name: "首页推荐影片" });
  const image = hero.closest(".media-module")!.querySelector(".video-window-art")!;
  Object.defineProperties(image, { naturalWidth: { value: 500 }, naturalHeight: { value: 750 } });
  fireEvent.load(image);
  expect(hero.closest(".media-module")?.querySelector(".video-window-art")).toBeNull();
  expect(hero).toHaveTextContent("横版背景图暂不可用");
});


it("shares a decorative full-window backdrop between the rail and content and removes it inside a library", async () => {
  fixture({ ...film, backdrop: panorama });
  const { container } = render(<MediaWindow id="video" connected onPlay={() => {}} />);
  await screen.findByRole("region", { name: "首页推荐影片" });
  const surface=container.querySelector(".media-module.video")!;
  const backdrop=surface.querySelector(".video-window-backdrop")!;
  expect(backdrop?.parentElement).toBe(surface);
  expect(backdrop).toHaveAttribute("aria-hidden","true");
  expect(surface).toHaveClass("video-immersive-home");
  expect(surface.querySelector(".app-rail")?.parentElement).toBe(surface);
  expect(surface.querySelector(".app-content")?.parentElement).toBe(surface);
  expect(backdrop.querySelector(".video-window-shade")).not.toBeNull();
  fireEvent.click(surface.querySelector(".rail-list button")!);
  await waitFor(()=>expect(surface).not.toHaveClass("video-immersive-home"));
  expect(surface.querySelector(".video-window-backdrop")).toBeNull();
});

it("loads credential-bearing artwork through the existing media API and only places its blob reference in the window", async () => {
  const protectedSource=panorama+"?token=private-backdrop-token";
  fixture({ ...film, backdrop: protectedSource });
  const fetch=vi.spyOn(api,"fetchMedia").mockResolvedValue(new Response(new Uint8Array([137,80,78,71]),{headers:{'Content-Type':'image/png'}}));
  const revoke=vi.fn(),create=vi.fn(()=>"blob:video-backdrop-fixture");
  vi.stubGlobal("URL",class extends URL {static createObjectURL=create;static revokeObjectURL=revoke});
  const {container,unmount}=render(<MediaWindow id="video" connected onPlay={()=>{}}/>);
  await waitFor(()=>expect(container.querySelector(".video-window-art")).toHaveAttribute("src","blob:video-backdrop-fixture"));
  expect(fetch).toHaveBeenCalledWith(protectedSource,expect.objectContaining({signal:expect.any(AbortSignal)}));
  expect(container.innerHTML).not.toContain("private-backdrop-token");
  unmount();expect(revoke).toHaveBeenCalledWith("blob:video-backdrop-fixture");
});
