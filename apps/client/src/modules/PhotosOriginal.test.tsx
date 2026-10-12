import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api, type Item } from "../api/client";
import { PhotosWindow } from "./PhotosWindow";

const photo: Item = { id: "photo-3", name: "原始照片.jpg", kind: "photo", path: "/photos/original.jpg", thumbnail: "https://nas.test/transcode/thumb?dest_fmt=small", metadata: { cdate: 20261012 } };
const originalUrl = "nas-media://localhost/original-photo";
function fixture() {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  vi.spyOn(api, "nasSession", "get").mockReturnValue("photo-session");
  vi.spyOn(api.nas, "session").mockReturnValue({ sessionId: "photo-session", baseUrl: "http://192.168.3.56:5055", user: {} });
  vi.spyOn(api.nas, "safeMediaUrl").mockImplementation(value => typeof value === "string" ? value : undefined);
  vi.spyOn(api, "read").mockImplementation(async operation => ({ items: operation === "photos.timeline" ? [photo] : [] }));
  vi.spyOn(api, "imagePreview").mockResolvedValue("nas-media://localhost/large-preview");
  return vi.spyOn(api, "imageOriginal").mockResolvedValue(originalUrl);
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });

it("defaults to originals on a local connection for both the gallery and viewer", async () => {
  const original = fixture();
  const { container } = render(<PhotosWindow connected />);
  const tile = await screen.findByRole("button", { name: `查看 ${photo.name}` });
  expect(screen.getByRole("button", { name: "原图" })).toHaveAttribute("aria-pressed", "true");
  await waitFor(() => expect(container.querySelector(".photo-tile img")).toHaveAttribute("src", originalUrl));
  fireEvent.click(tile);
  expect(await screen.findByRole("img", { name: photo.name })).toHaveAttribute("src", originalUrl);
  expect(original).toHaveBeenCalledWith(photo);
  expect(api.imagePreview).not.toHaveBeenCalled();
});

it("labels a failed original before falling back to the thumbnail", async () => {
  fixture();
  const { container } = render(<PhotosWindow connected />);
  await screen.findByRole("button", { name: `查看 ${photo.name}` });
  await waitFor(() => expect(container.querySelector(".photo-tile img")).toHaveAttribute("src", originalUrl));
  fireEvent.error(container.querySelector(".photo-tile img")!);
  expect(container.querySelector(".photo-tile img")).toHaveAttribute("src", photo.thumbnail);
  expect(screen.getByText("原图暂不可用，显示预览")).toBeInTheDocument();
});

it("does not attach a late original after switching the gallery to previews", async () => {
  let finish!: (value: string) => void;
  fixture().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { container } = render(<PhotosWindow connected />);
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("button", { name: "预览" }));
  await act(async () => finish(originalUrl));
  expect(container.querySelector(".photo-tile img")).toHaveAttribute("src", photo.thumbnail);
  expect(screen.getByRole("button", { name: "预览" })).toHaveAttribute("aria-pressed", "true");
});
