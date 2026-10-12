import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api, type Item } from "../api/client";
import { ImagePreview } from "./ImagePreview";
import { NasModule } from "./NasModule";
import { OfficialNasError } from "../api/official-nas";
import { readFileSync } from "node:fs";

const first: Item = { id: "same-id", name: "First.jpg", path: "/photos/first.jpg", kind: "photo", size: 20 };
const second: Item = { ...first, name: "Second.jpg", path: "/photos/second.jpg" };
const nativeFirst = `nas-media://localhost/${"a".repeat(64)}`;
const nativeSecond = `nas-media://localhost/${"b".repeat(64)}`;
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });
function preview() {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  vi.spyOn(api, "nasSession", "get").mockReturnValue("synthetic-session");
  return vi.spyOn(api, "imagePreview").mockImplementation(async item => item.path === second.path ? nativeSecond : nativeFirst);
}

it("prepares the original when photos request original quality", async () => {
  const fallback = preview();
  const original = vi.spyOn(api, "imageOriginal").mockResolvedValue(nativeSecond);
  render(<ImagePreview item={first} preferOriginal />);
  expect(await screen.findByRole("img", { name: first.name })).toHaveAttribute("src", nativeSecond);
  expect(original).toHaveBeenCalledWith(first);
  expect(fallback).not.toHaveBeenCalled();
});

it("labels a decode failure as a preview fallback and retries the original on request", async () => {
  const fallback = preview();
  const original = vi.spyOn(api, "imageOriginal").mockResolvedValue(nativeSecond);
  render(<ImagePreview item={first} preferOriginal />);
  expect(await screen.findByRole("img")).toHaveAttribute("src", nativeSecond);
  fireEvent.error(screen.getByRole("img"));
  await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", nativeFirst));
  expect(screen.getByText("原图暂不可用，显示预览")).toBeInTheDocument();
  expect(fallback).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "重试原图" }));
  await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", nativeSecond));
  expect(original).toHaveBeenCalledTimes(2);
});

it("applies complete-image validation to originals before creating a browser Blob", async () => {
  const { create, reference } = browserPreview(new Response(new Uint8Array([255, 216, 255, 1]), { headers: { "Content-Type": "image/jpeg", "Content-Length": "4" } }));
  vi.spyOn(api, "imageOriginal").mockResolvedValue("http://nas.test/v2/file/download?path=%2Fphotos%2Ffirst.jpg");
  render(<ImagePreview item={first} preferOriginal />);
  await screen.findByRole("img");
  expect(create.mock.calls[0][0]).toHaveProperty("size", 4);
  expect(reference).not.toHaveBeenCalled();
});

it("shows pending source and decode states, then a loaded image", async () => {
  const read = preview();
  render(<ImagePreview item={first} />);
  expect(screen.getByRole("status")).toHaveTextContent("正在加载图片");
  const image = await screen.findByRole("img", { name: first.name });
  expect(read).toHaveBeenCalledWith(first);
  expect(image).toHaveAttribute("src", nativeFirst);
  expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
  expect(screen.getByRole("status")).toBeInTheDocument();
  fireEvent.load(image);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("shows failed decoding, removes the source and retries with a fresh reference", async () => {
  const read = preview().mockResolvedValueOnce(nativeFirst).mockResolvedValueOnce("/safe/retry.jpg");
  render(<ImagePreview item={first} />);
  fireEvent.error(await screen.findByRole("img"));
  expect(screen.getByRole("alert")).toHaveTextContent("图片加载失败");
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重试图片" }));
  const retried = await screen.findByRole("img");
  expect(retried).toHaveAttribute("src", "/safe/retry.jpg");
  fireEvent.load(retried);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(read).toHaveBeenCalledTimes(2);
});

it("shows registration failures and allows retry", async () => {
  const read = preview().mockRejectedValueOnce(new OfficialNasError("此媒体暂不能在原生界面安全读取", "MEDIA_REGISTER_FAILED", 501));
  render(<ImagePreview item={first} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("此媒体暂不能在原生界面安全读取");
  fireEvent.click(screen.getByRole("button", { name: "重试图片" }));
  fireEvent.load(await screen.findByRole("img"));
  expect(read).toHaveBeenCalledTimes(2);
});

it.each([
  { ...first, path: undefined },
  { ...first, name: "Movie.mp4", path: "/photos/movie.mp4" },
  { ...first, kind: "directory" },
])("shows unsupported or missing image identity without requesting a preview", async item => {
  const read = preview();
  render(<ImagePreview item={item} />);
  expect(screen.getByText("此项目缺少图片路径或暂不支持预览")).toBeInTheDocument();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(read).not.toHaveBeenCalled();
});

it("resets immediately when files share one ID but have different actual paths", async () => {
  preview();
  const view = render(<ImagePreview item={first} />);
  fireEvent.load(await screen.findByRole("img"));
  view.rerender(<ImagePreview item={second} />);
  expect(screen.queryByRole("img", { name: first.name })).not.toBeInTheDocument();
  const image = await screen.findByRole("img", { name: second.name });
  expect(image).toHaveAttribute("src", nativeSecond);
  expect(screen.getByRole("status")).toBeInTheDocument();
});

it("ignores late preview responses after a path change", async () => {
  let finish!: (value: string) => void;
  preview().mockImplementation(async item => item.path === first.path
    ? new Promise<string>(resolve => { finish = resolve; }) : nativeSecond);
  const view = render(<ImagePreview item={first} />);
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  view.rerender(<ImagePreview item={second} />);
  await screen.findByRole("img", { name: second.name });
  await act(async () => finish("/safe/late-first.jpg"));
  expect(screen.getByRole("img")).toHaveAttribute("src", nativeSecond);
});

it("does not attach a late source after the NAS session changes", async () => {
  let finish!: (value: string) => void;
  preview().mockImplementation(() => new Promise<string>(resolve => { finish = resolve; }));
  const session = vi.spyOn(api, "nasSession", "get").mockReturnValue("old-session");
  const view = render(<ImagePreview item={first} />);
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  session.mockReturnValue("new-session");
  await act(async () => finish("/safe/old-session.jpg"));
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  session.mockReturnValue("");
  view.rerender(<ImagePreview item={first} />);
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});

it("discards an already decoded image when the session changes", async () => {
  preview();
  const session = vi.spyOn(api, "nasSession", "get").mockReturnValue("old-session");
  const view = render(<ImagePreview item={first} />);
  fireEvent.load(await screen.findByRole("img"));
  session.mockReturnValue("");
  view.rerender(<ImagePreview item={first} />);
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(screen.getByText("请先连接 NAS")).toBeInTheDocument();
});

it.each(["files", "photos"])("opens the shared large preview from %s", async id => {
  const readPreview = preview();
  vi.spyOn(api, "read").mockImplementation(async operation => ({ items: operation === "files.info" ? [] : [first] }));
  render(<NasModule id={id} connected onPlay={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: /First.jpg/ }));
  const image = await screen.findByRole("img", { name: first.name });
  expect(readPreview).toHaveBeenCalledWith(first);
  expect(image).toHaveAttribute("src", nativeFirst);
  if (id === "photos") expect(screen.getByRole("dialog")).toBeInTheDocument();
});

it("refreshes file details for different paths with the same ID", async () => {
  preview();
  const read = vi.spyOn(api, "read").mockImplementation(async operation => ({ items: operation === "files.info" ? [] : [first] }));
  render(<NasModule id="files" connected onPlay={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: /First.jpg/ }));
  await waitFor(() => expect(read).toHaveBeenCalledWith("files.info", { path: first.path }));
  read.mockImplementation(async operation => ({ items: operation === "files.info" ? [] : [second] }));
  fireEvent.click(screen.getByRole("button", { name: "刷新文件" }));
  fireEvent.click(await screen.findByRole("button", { name: /Second.jpg/ }));
  await waitFor(() => expect(read).toHaveBeenCalledWith("files.info", { path: second.path }));
});


function browserPreview(response: Response = new Response(new Uint8Array([255, 216, 255, 1]), { headers: { "Content-Type": "image/jpeg" } })) {
  const reference = preview().mockResolvedValue("http://nas.test:5055/transcode/thumb?token=synthetic-secret");
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  const create = vi.fn((_blob: Blob) => "blob:http://localhost/synthetic-image");
  const revoke = vi.fn();
  vi.stubGlobal("URL", class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
  const fetch = vi.spyOn(api.nas, "fetchMedia").mockResolvedValue(response);
  return { reference, create, revoke, fetch };
}

it("uses guarded browser fetch and only a Blob image source, revoking it on cleanup", async () => {
  const { create, revoke, fetch } = browserPreview();
  const view = render(<ImagePreview item={first} />);
  const image = await screen.findByRole("img");
  expect(fetch).toHaveBeenCalledWith("http://nas.test:5055/transcode/thumb?token=synthetic-secret", { signal: expect.any(AbortSignal) });
  expect(image).toHaveAttribute("src", "blob:http://localhost/synthetic-image");
  expect(create).toHaveBeenCalledWith(expect.any(Blob));
  expect(screen.getByRole("img").outerHTML).not.toContain("synthetic-secret");
  view.unmount();
  expect(revoke).toHaveBeenCalledWith("blob:http://localhost/synthetic-image");
});

it("native images keep the opaque reference and do not use the browser fetch pipeline", async () => {
  preview();
  const fetch = vi.spyOn(api.nas, "fetchMedia");
  render(<ImagePreview item={first} />);
  expect(await screen.findByRole("img")).toHaveAttribute("src", nativeFirst);
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  ["image/jpeg", "<html>login synthetic-secret</html>"],
  ["image/png", '{"token":"synthetic-secret"}'],
  ["image/jpeg", "<svg xmlns='http://www.w3.org/2000/svg'></svg>"],
  ["image/svg+xml", "<svg/>"],
  ["text/html", "<html/>"],
])("rejects descriptors disguised as images (%s)", async (mime, content) => {
  const { create } = browserPreview(new Response(content, { headers: { "Content-Type": mime } }));
  render(<ImagePreview item={first} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("图片加载失败");
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(create).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("synthetic-secret");
});

it("cancels oversized image bodies even when the declared size is absent", async () => {
  const cancel = vi.fn();
  const { create } = browserPreview(new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(64 * 1024 * 1024 + 1)); }, cancel,
  }), { headers: { "Content-Type": "image/jpeg" } }));
  render(<ImagePreview item={first} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("图片加载失败");
  expect(create).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalled();
});

it("rejects declared oversize before reading the body", async () => {
  const { create } = browserPreview(new Response(new Uint8Array([255, 216, 255]), { headers: { "Content-Type": "image/jpeg", "Content-Length": String(64 * 1024 * 1024 + 1) } }));
  render(<ImagePreview item={first} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("图片加载失败");
  expect(create).not.toHaveBeenCalled();
});

it("hides raw request errors from the image failure state", async () => {
  browserPreview().fetch.mockRejectedValue(new Error("synthetic-secret in network stack"));
  render(<ImagePreview item={first} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("图片加载失败");
  expect(document.body.textContent).not.toContain("synthetic-secret");
});

it("aborts browser image reads and drops late bodies when switching paths", async () => {
  let finish!: (value: Response) => void;
  const { create, fetch } = browserPreview();
  fetch.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  const view = render(<ImagePreview item={first} />);
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  const signal = fetch.mock.calls[0][1]!.signal!;
  view.rerender(<ImagePreview item={second} />);
  expect(signal.aborted).toBe(true);
  await screen.findByRole("img", { name: second.name });
  await act(async () => finish(new Response(new Uint8Array([255, 216, 255]))));
  expect(create).toHaveBeenCalledTimes(1);
});

it("allows only the explicit Blob image scheme addition in native CSP", () => {
  const config = JSON.parse(readFileSync(`${process.cwd()}/src-tauri/tauri.conf.json`, "utf8"));
  const directive = config.app.security.csp.split(";").find((value: string) => value.trim().startsWith("img-src"));
  expect(directive.split(/\s+/)).toContain("blob:");
  expect(directive).not.toContain("*");
});


it("refreshes and revokes the old browser preview when only updated_at changes", async () => {
  const { create, revoke, reference, fetch } = browserPreview();
  create.mockReturnValueOnce("blob:http://localhost/old-image").mockReturnValueOnce("blob:http://localhost/new-image");
  fetch.mockImplementation(async () => new Response(new Uint8Array([255, 216, 255, 1]), { headers: { "Content-Type": "image/jpeg" } }));
  const original = { ...first, metadata: { updated_at: 1 } };
  const updated = { ...first, metadata: { updated_at: 2 } };
  const view = render(<ImagePreview item={original} />);
  fireEvent.load(await screen.findByRole("img"));
  expect(screen.getByRole("img")).toHaveAttribute("src", "blob:http://localhost/old-image");
  view.rerender(<ImagePreview item={updated} />);
  await waitFor(() => expect(reference).toHaveBeenCalledTimes(2));
  expect(reference).toHaveBeenLastCalledWith(updated);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(await screen.findByRole("img")).toHaveAttribute("src", "blob:http://localhost/new-image");
  expect(revoke).toHaveBeenCalledWith("blob:http://localhost/old-image");
});

it("shows a session change instead of leaving a failed browser read pending", async () => {
  let reject!: (error: Error) => void;
  const { fetch } = browserPreview();
  const session = vi.spyOn(api, "nasSession", "get").mockReturnValue("old-session");
  fetch.mockImplementationOnce(() => new Promise<Response>((_resolve, fail) => { reject = fail; }));
  render(<ImagePreview item={first} />);
  await waitFor(() => expect(reject).toBeTypeOf("function"));
  session.mockReturnValue("");
  await act(async () => reject(new OfficialNasError("NAS 登录已失效，请重新登录", "SESSION_EXPIRED", 401)));
  expect(screen.getByRole("alert")).toHaveTextContent("NAS 会话已改变");
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});


it("reads a complete browser image over 8 MiB within the image-specific 64 MiB bound", async () => {
  const bytes = new Uint8Array(9 * 1024 * 1024);
  bytes.set([255, 216, 255]);
  const { create } = browserPreview(new Response(bytes, { headers: { "Content-Type": "image/jpeg", "Content-Length": String(bytes.length) } }));
  render(<ImagePreview item={first} />);
  await screen.findByRole("img");
  expect(create.mock.calls[0][0]).toHaveProperty("size", bytes.length);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});


it("uses Gateway media transport so image authentication failure reaches the App event handler", async () => {
  browserPreview().fetch.mockRejectedValue(new OfficialNasError("NAS 登录已失效，请重新登录", "SESSION_EXPIRED", 401));
  const gateway = vi.spyOn(api, "fetchMedia");
  const listener = vi.fn();
  window.addEventListener("space-session-expired", listener);
  try {
    render(<ImagePreview item={first} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("NAS 登录已失效");
    expect(gateway).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail.scope).toBe("nas");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  } finally { window.removeEventListener("space-session-expired", listener); }
});

it("accepts a validated complete browser 206 image response", async () => {
  browserPreview(new Response(new Uint8Array([255, 216, 255, 1]), { status: 206, headers: { "Content-Type": "image/jpeg", "Content-Range": "bytes 0-3/4", "Content-Length": "4" } }));
  render(<ImagePreview item={first} />);
  await screen.findByRole("img");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it.each<Record<string, string>>([
  { "Content-Length": "6" },
  { "Content-Range": "bytes 0-3/10", "Content-Length": "4" },
])("rejects an incomplete browser image even if its response status is 200", async headers => {
  const { create } = browserPreview(new Response(new Uint8Array([255, 216, 255, 1]), { headers: { ...headers, "Content-Type": "image/jpeg" } }));
  render(<ImagePreview item={first} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("图片加载失败");
  expect(create).not.toHaveBeenCalled();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});
