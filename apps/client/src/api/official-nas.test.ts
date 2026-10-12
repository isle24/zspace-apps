import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { JSEncrypt } from "jsencrypt";
import { OfficialNas, OfficialNasError } from "./official-nas";
const nativePlugin = vi.hoisted(() => ({ fetch: vi.fn() }));
const nativeCore = vi.hoisted(() => ({ invoke: vi.fn() }));
const nativeEvents = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => nativeEvents);
vi.mock("@tauri-apps/api/core", () => nativeCore);
vi.mock("@tauri-apps/plugin-http", () => nativePlugin);

const keys = [0, 1].map(() =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }),
);
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function fixture(
  read: (
    url: URL,
    init: RequestInit,
    form: URLSearchParams,
  ) => Response | Promise<Response> = (url) =>
    json({ code: 200, data: url.pathname === "/system/polling2"
      ? { pools: [] } : { list: [], total: 0 } }),
) {
  let index = -1;
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const form =
        init.method === "POST"
          ? new URLSearchParams(String(init.body))
          : url.searchParams;
      expect(url.origin).toBe("http://nas.test:5055");
      expect(init.credentials).toBe("omit");
      expect(init.redirect).toBe("error");
      if (url.pathname === "/key/pub") {
        index++;
        expect(form.get("signme")).toBe("1");
        return json({
          code: 200,
          data: {
            key: keys[index % 2].publicKey,
            sign: "synthetic-challenge",
            nasid: "n1",
          },
        });
      }
      if (url.pathname === "/auth/login") {
        const rsa = new JSEncrypt();
        rsa.setPrivateKey(keys[index % 2].privateKey);
        expect(rsa.decrypt(form.get("username")!)).toBe("synthetic-user");
        expect(rsa.decrypt(form.get("password")!)).toBe("synthetic-password");
        for (const k of ["plat", "version", "device", "device_id", "_l"])
          expect(form.get(k)).toBeTruthy();
        return json({
          code: "S000200",
          data: {
            token: "synthetic-nas+token",
            nasid: "n1",
            username: "synthetic-user",
            nickname: "Synthetic",
          },
        });
      }
      expect(form.get("token")).toBe("synthetic-nas+token");
      return read(url, init, form);
    },
  );
  return { nas: new OfficialNas(fetcher as typeof fetch), fetcher };
}
const login = (nas: OfficialNas) =>
  nas.login("http://nas.test:5055", "synthetic-user", "synthetic-password");
beforeEach(() => {
  vi.unstubAllEnvs();
  localStorage.clear();
  nativePlugin.fetch.mockReset();
  nativeEvents.listen.mockReset();
  nativeEvents.listen.mockResolvedValue(() => {});
  let id = 0;
  nativeCore.invoke.mockReset();
  nativeCore.invoke.mockImplementation((command: string) =>
    Promise.resolve(
      command === "nas_media_register"
        ? `nas-media://localhost/${(++id).toString(16).padStart(64, "0")}`
        : undefined,
    ),
  );
});

describe("Official NAS direct adapter", () => {
  it("exposes only a canonical official error code for runtime diagnosis, never server secrets", async () => {
    const { nas } = fixture(() => json({ success: false, code: "N001316", message: "synthetic-nas+token synthetic-password" }));
    await login(nas);
    await expect(nas.read("files.info", { path: "/synthetic/missing.jpg" })).rejects.toMatchObject({
      code: "NAS_BUSINESS_ERROR", message: "NAS 未能完成此请求（N001316）",
    });
    const other = fixture(() => json({ success: false, code: "synthetic-private-code", message: "synthetic-password" }));
    await login(other.nas);
    await expect(other.nas.read("files.info", { path: "/synthetic/missing.jpg" })).rejects.toMatchObject({
      code: "NAS_BUSINESS_ERROR", message: "NAS 未能完成此请求",
    });
  });
  it.each(["video.info", "video.files"])("rejects %s without actual collection and classification identities before reaching the NAS", async (operation) => {
    const { nas, fetcher } = fixture();
    await login(nas);
    const count = fetcher.mock.calls.length;
    for (const params of [
      {},
      { collection_id: "collection-7" },
      { classification_id: "library-2" },
      ...["", "   ", null, undefined, true, false, NaN, Infinity, {}, []].flatMap((id) => [
        { collection_id: id, classification_id: "library-2" },
        { collection_id: "collection-7", classification_id: id },
      ]),
    ]) {
      await expect(nas.read(operation, params)).rejects.toMatchObject({ code: "INVALID_PARAMS" });
      expect(fetcher.mock.calls.length).toBe(count);
    }
  });
  it.each(["video.info", "video.files"])("preserves provided numeric zero identities for %s", async (operation) => {
    const { nas } = fixture((_url, _init, form) => {
      expect(form.get("collection_id")).toBe("0");
      expect(form.get("classification_id")).toBe("0");
      return json({ success: true, data: operation === "video.files"
        ? { video_list: [{ file_path: "/media/zero.mkv", file_name: "Zero" }] }
        : { collection_id: 0, title: "Zero" } });
    });
    await login(nas);
    const result = await nas.read(operation, { collection_id: 0, classification_id: 0 });
    if (operation === "video.files")
      expect(result.items[0].metadata).toMatchObject({ collection_id: 0, classification_id: 0 });
  });
  it.each([
    { unexpected_schema: "changed" },
    [],
    null,
    { video_list: {} },
    { file_list: [] },
    { file_list: { list: null } },
    { video_list: [], file_list: { list: "changed" } },
  ].map(data => [data]))("rejects an unsupported video file-list response shape: %j", async (data) => {
    const { nas } = fixture(() => json({ success: true, data }));
    await login(nas);
    await expect(nas.read("video.files", { collection_id: "collection-7", classification_id: "library-2" }))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE", status: 502 });
  });
  it.each([
    { video_list: [] },
    { file_list: { list: [] } },
    { video_list: [], file_list: { list: [] } },
  ])("accepts verified empty video file lists: %j", async (data) => {
    const { nas } = fixture(() => json({ success: true, data }));
    await login(nas);
    const result = await nas.read("video.files", { collection_id: "collection-7", classification_id: "library-2" });
    expect(result.items).toEqual([]);
  });
  it("deduplicates overlapping video/file representations while retaining actual versions and episodes", async () => {
    const original = { video_id: "episode-1", version_id: "original", file_id: "file-1", file_name: "Episode 1", file_path: "/media/s01e01.mkv", ep: "S01E01" };
    const compact = { ...original, version_id: "compact", file_name: "Episode 1 compact" };
    const nextEpisode = { ...original, video_id: "episode-2", file_name: "Episode 2", ep: "S01E02" };
    const { nas } = fixture(() => json({ success: true, data: {
      video_list: [original, compact, nextEpisode],
      file_list: { list: [{ ...original, title: "Overlapping representation" }, compact, nextEpisode,
        { file_id: "extras", file_name: "Extras", file_path: "/media/extras", is_dir: 1 }] },
    } }));
    await login(nas);
    const result = await nas.read("video.files", { collection_id: "collection-7", classification_id: "library-2" });
    expect(result.items.map(item => item.name)).toEqual(["Episode 1", "Episode 1 compact", "Episode 2", "Extras"]);
    expect(new Set(result.items.map(item => item.id)).size).toBe(4);
    expect(result.items[1].metadata).toMatchObject({ video_id: "episode-1", version_id: "compact" });
    expect(result.items[2].metadata).toMatchObject({ video_id: "episode-2", ep: "S01E02" });
  });
  it.each([
    { file_name: "Plain file representation", path: "/media/episode.mkv", extra: "file metadata" },
    { file_id: "file-1", file_name: "Plain file representation", extra: "file metadata" },
  ])("merges a compatible partial file representation with actual video identity: %j", async (partial) => {
    const complete = { video_id: "episode-1", version_id: "original", file_id: "file-1", file_name: "Episode 1", file_path: "/media/episode.mkv", ep: "S01E01" };
    const { nas } = fixture(() => json({ success: true, data: {
      video_list: [complete], file_list: { list: [partial] },
    } }));
    await login(nas);
    const result = await nas.read("video.files", { collection_id: "collection-7", classification_id: "library-2" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ name: "Episode 1", path: "/media/episode.mkv",
      metadata: { video_id: "episode-1", version_id: "original", file_id: "file-1", ep: "S01E01", extra: "file metadata" } });
  });
  it("retains the more complete video identity when it is returned in the file list", async () => {
    const { nas } = fixture(() => json({ success: true, data: {
      video_list: [{ file_name: "Plain file representation", file_path: "/media/episode.mkv" }],
      file_list: { list: [{ video_id: "episode-1", version_id: "original", file_id: "file-1", file_name: "Episode 1", file_path: "/media/episode.mkv" }] },
    } }));
    await login(nas);
    const result = await nas.read("video.files", { collection_id: "collection-7", classification_id: "library-2" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ name: "Episode 1", metadata: { video_id: "episode-1", version_id: "original", file_id: "file-1" } });
  });
  it.each([
    { version_id: "compact" },
    { video_id: "episode-2" },
    { file_id: "file-2" },
    { is_dir: 1 },
  ])("keeps explicitly different identities or kinds at the same video path: %j", async (difference) => {
    const original = { video_id: "episode-1", version_id: "original", file_id: "file-1", file_name: "Episode 1", file_path: "/media/episode.mkv" };
    const distinct = { ...original, ...difference, file_name: "Distinct returned item" };
    const { nas } = fixture(() => json({ success: true, data: { video_list: [original], file_list: { list: [distinct] } } }));
    await login(nas);
    const result = await nas.read("video.files", { collection_id: "collection-7", classification_id: "library-2" });
    expect(result.items.map(item => item.name)).toEqual(["Episode 1", "Distinct returned item"]);
    expect(new Set(result.items.map(item => item.id)).size).toBe(2);
  });
  it("does not infer overlapping video identity from a shared display name", async () => {
    const { nas } = fixture(() => json({ success: true, data: {
      video_list: [{ file_name: "Episode", file_path: "/media/a.mkv" }],
      file_list: { list: [{ file_name: "Episode", file_path: "/media/b.mkv" }] },
    } }));
    await login(nas);
    const result = await nas.read("video.files", { collection_id: "collection-7", classification_id: "library-2" });
    expect(result.items.map(item => item.path)).toEqual(["/media/a.mkv", "/media/b.mkv"]);
  });
  it("reads current collection details and actual episode/version files", async () => {
    const { nas } = fixture((url, _init, form) => {
      expect(form.get("collection_id")).toBe("collection-7");
      expect(form.get("classification_id")).toBe("library-2");
      if (url.pathname === "/zvideo/collection/info") {
        expect(form.get("get_type")).toBe("all");
        return json({ success: true, data: { collection_id: "collection-7", title: "Series", storyline: "A real returned synopsis" } });
      }
      expect(url.pathname).toBe("/zvideo/collection/video");
      return json({ success: true, data: { video_list: [
        { video_id: "episode-1", version_id: "original", title: "Series", file_name: "Episode 1", file_path: "/media/s01e01.mkv", file_size: 1024, ep: "S01E01" },
        { video_id: "episode-1", version_id: "compact", file_name: "Episode 1 compact", file_path: "/media/s01e01-compact.mp4", file_size: 512, ep: "S01E01" },
      ], file_list: { list: [{ file_name: "Extras", file_path: "/media/extras", is_dir: 1 }] } } });
    });
    await login(nas);
    const params = { collection_id: "collection-7", classification_id: "library-2" };
    const info = await nas.read("video.info", params);
    expect(info.values?.storyline).toBe("A real returned synopsis");
    const files = await nas.read("video.files", params);
    expect(files.items.map(i => i.name)).toEqual(["Episode 1", "Episode 1 compact", "Extras"]);
    expect(files.items[0]).toMatchObject({ path: "/media/s01e01.mkv", size: 1024, metadata: { collection_id: "collection-7", classification_id: "library-2", video_id: "episode-1", version_id: "original" } });
    expect(new Set(files.items.map(i => i.id)).size).toBe(3);
    expect(files.items[2].kind).toBe("directory");
  });
  it("requests the current official playback descriptor for the selected video file", async () => {
    const { nas } = fixture((url, init, form) => {
      expect(url.pathname).toBe("/transcode/play");
      expect(init.method).toBe("GET");
      expect(form.get("file_path")).toBe("/media/s01e01.mkv");
      expect(form.get("from")).toBe("zvideo");
      expect(form.get("play_env")).toBe("1");
      expect(form.has("video_codec")).toBe(true);
      expect(form.has("audio_codec")).toBe(true);
      expect(form.has("id")).toBe(false);
      return json({ success: true, data: { uri: "/play/selected.mp4" } });
    });
    await login(nas);
    const result = await nas.read("video.play", { file_path: "/media/s01e01.mkv" });
    expect(result.items[0].stream).toContain("/play/selected.mp4");
  });
  it("rejects video playback without a file before reaching the NAS", async () => {
    const { nas, fetcher } = fixture();
    await login(nas);
    const count = fetcher.mock.calls.length;
    await expect(nas.read("video.play", {})).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect(fetcher.mock.calls.length).toBe(count);
  });
  it("browses returned video directories with only verified file query parameters", async () => {
    const { nas, fetcher } = fixture((url, init, form) => {
      expect(url.pathname).toBe("/zvideo/collection/video");
      expect(init.method).toBe("POST");
      expect(form.get("collection_id")).toBe("collection-7");
      expect(form.get("classification_id")).toBe("library-2");
      expect(form.get("file_path")).toBe("/media/extras");
      return json({ success: true, data: { video_list: [], file_list: { list: [] } } });
    });
    await login(nas);
    await nas.read("video.files", { collection_id: "collection-7", classification_id: "library-2", file_path: "/media/extras" });
    const count = fetcher.mock.calls.length;
    await expect(nas.read("video.files", { collection_id: "collection-7", delete: true })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect(fetcher.mock.calls.length).toBe(count);
  });
  it("derives official playback codecs from runtime support without a fabricated fallback", async () => {
    const capability = vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockImplementation((type) =>
      ['video/mp4; codecs="avc1.42E01E"', 'video/webm; codecs="vp9"', 'video/mp4; codecs="hev1.1.6.L93.B0"', 'video/mp4; codecs="hvc1.1.6.L93.B0"'].includes(type) ? "probably" : "",
    );
    try {
      const { nas } = fixture((_url, _init, form) => {
        expect(form.get("video_codec")).toBe("h264,vp9,hevc");
        expect(form.get("audio_codec")).toBe("aac,mp4a,vorbis");
        return json({ success: true, data: { uri: "/play/selected.mp4" } });
      });
      await login(nas);
      await nas.read("video.play", { file_path: "/media/s01e01.mkv" });
      capability.mockReturnValue("");
      const unsupported = fixture((_url, _init, form) => {
        expect(form.get("video_codec")).toBe("");
        expect(form.get("audio_codec")).toBe("");
        return json({ success: true, data: { uri: "/play/selected.mp4" } });
      });
      await login(unsupported.nas);
      await unsupported.nas.read("video.play", { file_path: "/media/s01e01.mkv" });
    } finally {
      capability.mockRestore();
    }
  });
  it("removes nested package pwd secrets while retaining ordinary labels", async () => {
    const { nas } = fixture(() => json({ success: true, data: { list: [{
      id: "package-1", name: "Password manager", pwd_label: "Optional package setting", pwd: "synthetic-package-secret", package: { PWD: "synthetic-nested-secret", settings: [{ pwd: "synthetic-list-secret", name: "Archive label" }] },
    }] } }));
    await login(nas);
    const result = await nas.read("apps.list");
    expect(JSON.stringify(result)).not.toContain("synthetic-package-secret");
    expect(JSON.stringify(result)).not.toContain("synthetic-nested-secret");
    expect(JSON.stringify(result)).not.toContain("synthetic-list-secret");
    expect(result.items[0]).toMatchObject({ name: "Password manager", metadata: { pwd_label: "Optional package setting", package: { settings: [{ name: "Archive label" }] } } });
  });
  it("uses fresh NAS keys and encrypted normal login without public token/persistence", async () => {
    const { nas, fetcher } = fixture();
    const first = await login(nas);
    const second = await login(nas);
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(second.user.username).toBe("synthetic-user");
    expect(JSON.stringify([nas, first, second])).not.toContain(
      "synthetic-nas+token",
    );
    expect(
      fetcher.mock.calls.filter(
        ([u]) => new URL(String(u)).pathname === "/key/pub",
      ),
    ).toHaveLength(2);
    expect(JSON.stringify(localStorage)).not.toContain("synthetic-nas+token");
    expect(JSON.stringify(localStorage)).not.toContain("synthetic-password");
  });
  it("persists only one nonsecret installation identity across instances", async () => {
    const a = fixture(),
      b = fixture();
    await login(a.nas);
    await login(a.nas);
    await login(b.nas);
    const ids = [...a.fetcher.mock.calls, ...b.fetcher.mock.calls]
      .filter(([u]) => new URL(String(u)).pathname === "/key/pub")
      .map(([u]) => new URL(String(u)).searchParams.get("device_id"));
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(/^[a-f0-9]{32}$/);
  });
  it("rejects URL credentials, foreign media sources and unknown mutations", async () => {
    const { nas, fetcher } = fixture();
    await expect(
      nas.login("http://user:pass@nas.test:5055", "u", "p"),
    ).rejects.toMatchObject({ code: "INVALID_BASE_URL" });
    expect(fetcher).not.toHaveBeenCalled();
    await login(nas);
    await expect(nas.read("files.delete")).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
    });
    expect(nas.safeMediaUrl("http://evil.test/play/a")).toBeUndefined();
    expect(
      nas.safeMediaUrl("http://user:pass@nas.test:5055/play/a"),
    ).toBeUndefined();
    expect(nas.safeMediaUrl("/system/reboot")).toBeUndefined();
  });
  it("does not count HTTP200 business failure as success and clears expired state", async () => {
    const { nas } = fixture(() =>
      json({ code: "N001208", msg: "synthetic-nas+token" }),
    );
    await login(nas);
    await expect(nas.read("files.roots")).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
      status: 401,
    });
    expect(nas.session()).toBeNull();
  });
  it("maps files and recent pages to official zero-based start/num", async () => {
    const { nas } = fixture((_u, _i, f) => {
      expect(f.get("start")).toBe("12");
      expect(f.get("num")).toBe("12");
      expect(f.has("page")).toBe(false);
      return json({ code: 200, data: { list: [], total: 30 } });
    });
    await login(nas);
    for (const op of ["files.list", "files.recent"])
      expect((await nas.read(op, { page: 2, pageSize: 12 })).total).toBe(30);
  });
  it("reads only mounted personal roots from the official polling pools", async () => {
    const { nas, fetcher } = fixture(() => {
      return json({ code: 200, data: { pools: [
        { key: "pool-a", name: "家庭存储", mounted: true, path: "/private/server/path" },
        { key: "pool-b", mounted: 1 },
        { key: "pool-c", name: "离线存储", mounted: false },
        { key: "pool-d", name: "未挂载存储", mounted: 0 },
        { mounted: false },
      ] } });
    });
    await login(nas);
    const roots = await nas.read("files.roots");
    const [url, init] = fetcher.mock.calls[2];
    expect(`${init?.method} ${new URL(String(url)).pathname}`).toBe("POST /system/polling2");
    expect(roots.items).toMatchObject([
      { id: "pool-a", name: "家庭存储", kind: "directory", path: "/pool-a/my/data" },
      { id: "pool-b", name: "pool-b", kind: "directory", path: "/pool-b/my/data" },
    ]);
    expect(roots.total).toBe(2);
    expect(JSON.stringify(roots)).not.toContain("/private/server/path");
    expect(roots.items.every((item) => !item.stream && !item.thumbnail)).toBe(true);
    expect(fetcher.mock.calls).toHaveLength(3);
  });
  it("accepts a verified empty pool list as empty file roots", async () => {
    const { nas } = fixture(() => json({ code: 200, data: { pools: [] } }));
    await login(nas);
    expect(await nas.read("files.roots")).toMatchObject({ items: [], total: 0 });
  });
  it.each([
    {}, { list: [] }, { pools: null }, { pools: {} }, { pools: [null] },
    { pools: [{ key: "valid", mounted: "yes" }] },
    { pools: [{ key: "valid" }] },
    { pools: [{ key: 1, mounted: true }] },
    { pools: [{ key: "valid", name: {}, mounted: true }] },
    ...["", ".", "..", "../pool", "pool/other", "pool\\other", "%2e%2e", "pool?x", "pool#x", "pool\n"].map((key) =>
      ({ pools: [{ key, mounted: true }] })),
  ])("rejects unverified or unsafe file root pool shape %#", async (data) => {
    const { nas, fetcher } = fixture(() => json({ code: 200, data }));
    await login(nas);
    await expect(nas.read("files.roots")).rejects.toMatchObject({ code: "INVALID_RESPONSE", status: 502 });
    expect(fetcher.mock.calls).toHaveLength(3);
  });
  it("adds verified official personal recent-file defaults and preserves returned totals", async () => {
    const { nas, fetcher } = fixture(() =>
      json({ code: 200, data: { list: [], total: 3983 } }));
    await login(nas);
    expect((await nas.read("files.recent", { page: 2, pageSize: 20 })).total).toBe(3983);
    const [url, init] = fetcher.mock.calls[2];
    const form = new URLSearchParams(String(init?.body));
    expect(new URL(String(url)).pathname).toBe("/v2/recent/list");
    expect(form.get("scope")).toBe("1");
    expect(form.get("show_hidden")).toBe("0");
    expect(form.get("with_fields")).toBe("encrypted,encrypt_icon,duration,nshare,ori,ext,height,weight,type,is_sys,dw,labels");
    expect(form.get("start")).toBe("20");
    expect(form.get("num")).toBe("20");
  });
  it("allows explicit official recent public scope and field selection", async () => {
    const { nas } = fixture((_url, _init, form) => {
      expect(form.get("scope")).toBe("2");
      expect(form.get("show_hidden")).toBe("1");
      expect(form.get("with_fields")).toBe("ext,type");
      return json({ code: 200, data: { list: [], total: 0 } });
    });
    await login(nas);
    await nas.read("files.recent", { scope: 2, show_hidden: 1, with_fields: "ext,type" });
  });
  it("maps concrete official song fields and transcode uri playback", async () => {
    const { nas } = fixture((u, _i, f) => {
      if (u.pathname === "/transcode/audio/play") {
        expect(f.get("file_path")).toBe("/my/a.mp3");
        expect(f.get("app")).toBe("music");
        expect(f.get("dest_fmt")).toBe("HQ");
        return json({ code: 200, data: { uri: "/play/a.mp3" } });
      }
      return json({
        code: 200,
        data: {
          list: [
            {
              song_id: "s1",
              song_name: "a.mp3",
              song_path: "/my/a.mp3",
              song_cover: "/my/a.jpg",
              song_size: 1000,
            },
          ],
          count: 1,
        },
      });
    });
    await login(nas);
    const song = (await nas.read("music.songs")).items[0];
    expect(song.path).toBe("/my/a.mp3");
    expect(song.size).toBe(1000);
    expect(song.thumbnail).toContain("http://nas.test:5055/transcode/thumb");
    const play = (await nas.read("music.play", { path: song.path })).items[0];
    expect(play.stream).toContain("http://nas.test:5055/play/a.mp3");
  });
  it("keeps secret canonical fields and metadata out of read output", async () => {
    const { nas } = fixture(() =>
      json({
        code: 200,
        data: {
          list: [
            {
              id: "synthetic-nas%2Btoken",
              name: "synthetic-nas+token",
              path: "/my/synthetic-nas+token",
              size: { token: "secret" },
              private_key: "secret",
              password: "secret",
            },
          ],
          total: "synthetic-nas+token",
        },
      }),
    );
    await login(nas);
    const data = await nas.read("files.list");
    expect(JSON.stringify(data)).not.toContain("synthetic-nas");
    expect(JSON.stringify(data)).not.toContain("private_key");
    expect(data.total).toBe(0);
    expect(data.items[0].size).toBeUndefined();
  });
  it("clears local NAS state on logout without invented remote write route", async () => {
    const { nas, fetcher } = fixture();
    await login(nas);
    const count = fetcher.mock.calls.length;
    nas.logout();
    expect(nas.session()).toBeNull();
    expect(fetcher.mock.calls).toHaveLength(count);
    await expect(nas.read("apps.list")).rejects.toMatchObject({
      code: "NO_SESSION",
    });
  });
  it("uses verified download and library pagination and playlist record route", async () => {
    const { nas } = fixture((u, i, f) => {
      if (u.pathname === "/zvideo/video/v2/list") {
        expect(f.get("start")).toBe("13");
        expect(f.get("limit")).toBe("12");
      }
      if (u.pathname === "/downloader/list") {
        expect(f.get("start")).toBe("12");
        expect(f.get("size")).toBe("12");
        expect(f.get("type")).toBe("complete");
      }
      if (u.pathname === "/zmusic/api/v2/playlist/record/list") {
        expect(i.method).toBe("GET");
        expect(f.get("playlist_id")).toBe("p1");
      }
      return json({ code: 200, data: [] });
    });
    await login(nas);
    await nas.read("video.list", { page: 2, pageSize: 12 });
    await nas.read("downloads.list", {
      page: 2,
      pageSize: 12,
      type: "complete",
    });
    await nas.read("music.songs", { playlist_id: "p1" });
  });
  it("has typed explicit extra verification and malformed response errors", async () => {
    const { nas } = fixture(() => json({ code: "N001414", msg: "verify" }));
    await login(nas);
    await expect(nas.read("apps.list")).rejects.toBeInstanceOf(
      OfficialNasError,
    );
    await expect(nas.read("apps.list")).rejects.toMatchObject({
      code: "CHALLENGE_REQUIRED",
    });
  });
});

it("checks the official public-key connection without login or returning key material", async () => {
  const { nas, fetcher } = fixture();
  const result = await nas.checkConnection("http://nas.test:5055/");
  expect(result).toEqual({ baseUrl: "http://nas.test:5055", reachable: true });
  expect(nas.session()).toBeNull();
  expect(fetcher.mock.calls).toHaveLength(1);
  expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe("/key/pub");
  expect(JSON.stringify(result)).not.toContain("PUBLIC KEY");
});
it("blocks redirected media before returning a response to a player", async () => {
  const { nas } = fixture(() => json({}, 302));
  await login(nas);
  await expect(
    nas.fetchMedia("http://nas.test:5055/play/a"),
  ).rejects.toMatchObject({ code: "MEDIA_REDIRECT_BLOCKED" });
});

it("routes every confirmed operation directly to the official NAS", async () => {
  let expected = "";
  const { nas } = fixture((u, init, form) => {
    const routes = [expected];
    if (expected === "POST /AppStore/v1/list")
      routes.push("POST /zdocker/AppStore/v1/list");
    if (expected === "POST /storagepool/info2")
      routes.push("POST /system/polling2");
    expect(routes).toContain(`${init.method} ${u.pathname}`);
    if (u.pathname.startsWith("/v2/album/"))
      expect(form.get("app")).toBe("album");
    return json({ code: 200, data:
      u.pathname === "/system/polling2" ? { sp_ver: "v2", pools: [] }
        : u.pathname === "/storagepool/info2" ? { system: {} }
          : u.pathname === "/v2/album/home" ? { combine: { list: [] } }
            : u.pathname === "/zvideo/collection/video" ? { video_list: [], file_list: { list: [] } }
              : [] });
  });
  await login(nas);
  const routes: Record<string, string> = {
    "files.roots": "POST /system/polling2",
    "files.list": "POST /v2/file/list",
    "files.info": "POST /v2/file/info",
    "files.recent": "POST /v2/recent/list",
    "photos.albums": "POST /v2/album/home",
    "photos.timeline": "POST /v2/album/feed/list",
    "photos.feeds": "POST /v2/album/feed/list",
    "video.libraries": "POST /zvideo/classification/list",
    "video.list": "POST /zvideo/video/v2/list",
    "video.info": "POST /zvideo/collection/info",
    "video.files": "POST /zvideo/collection/video",
    "video.play": "GET /transcode/play",
    "music.songs": "POST /zmusic/api/v2/song/list",
    "music.albums": "GET /zmusic/api/v2/album/list",
    "music.playlists": "GET /zmusic/api/v2/playlist/list",
    "music.lyrics": "GET /zmusic/api/v2/song/info/lyrics",
    "music.play": "GET /transcode/audio/play",
    "downloads.list": "POST /downloader/list",
    // 实测本机固件 /system 为 404，官方前端对应接口是 /system/home
    "system.overview": "POST /system/home",
    "system.monitor": "POST /system/recent",
    "system.monitorDelay": "POST /system/delay",
    "system.storage": "POST /storagepool/info2",
    "system.network": "GET /network-settings/v1/interface/list",
    "system.settings": "POST /setting/load",
    "apps.list": "POST /AppStore/v1/list",
  };
  for (const [op, path] of Object.entries(routes)) {
    expected = path;
    await nas.read(op, op === "video.play" ? { file_path: "/media/selected.mkv" }
      : ["video.info", "video.files"].includes(op) ? { collection_id: "collection-7", classification_id: "library-2" } : {});
  }
});
it("retains official collection identities and shapes for navigation", async () => {
  let op = "";
  const rows: Record<string, unknown> = {
    "music.albums": { album_id: "a1", album: "record" },
    "music.playlists": { playlist_id: "p1", playlist_name: "mix" },
    "video.libraries": { id: "v1", name: "films" },
    "photos.albums": { album_id: "p1", name: "photos" },
    "files.roots": { key: "synthetic-pool", name: "personal", mounted: true },
  };
  const { nas } = fixture(() => json({ code: 200, data: op === "photos.albums"
    ? { combine: { list: [rows[op]] } } : op === "files.roots"
      ? { pools: [rows[op]] } : [rows[op]] }));
  await login(nas);
  const kinds: Record<string, string> = {
    "music.albums": "album",
    "music.playlists": "playlist",
    "video.libraries": "library",
    "photos.albums": "album",
    "files.roots": "directory",
  };
  for (op of Object.keys(rows)) {
    const item = (await nas.read(op)).items[0];
    expect(item.id).toBeTruthy();
    expect(item.name).toBeTruthy();
    expect(item.kind).toBe(kinds[op]);
  }
});
it("shows official classification names when browsing video libraries", async () => {
  const { nas } = fixture(() =>
    json({
      code: 200,
      data: [
        { id: 17, classification_name: "家庭电影", is_system: 0 },
        { id: 18, classification_name: "剧集", is_system: 0 },
      ],
    }),
  );
  await login(nas);
  expect((await nas.read("video.libraries")).items).toMatchObject([
    { id: "17", name: "家庭电影", kind: "library" },
    { id: "18", name: "剧集", kind: "library" },
  ]);
});
it("combines the official and Docker app lists with parallel read requests", async () => {
  let completeOfficial!: (response: Response) => void;
  const calls: string[] = [];
  const { nas } = fixture((url, init) => {
    calls.push(url.pathname);
    expect(init.method).toBe("POST");
    if (url.pathname === "/AppStore/v1/list")
      return new Promise<Response>((resolve) => (completeOfficial = resolve));
    expect(url.pathname).toBe("/zdocker/AppStore/v1/list");
    return json({
      code: 200,
      data: { list: [{ app_name: "navidrome", name: "Navidrome" }] },
    });
  });
  await login(nas);
  const pending = nas.read("apps.list");
  await Promise.resolve();
  expect(calls).toEqual(["/AppStore/v1/list", "/zdocker/AppStore/v1/list"]);
  completeOfficial(
    json({ code: 200, data: { list: [{ app_name: "album", name: "相册" }] } }),
  );
  const apps = await pending;
  expect(apps.items).toMatchObject([
    { id: "album", name: "相册", kind: "app" },
    { id: "navidrome", name: "Navidrome", kind: "app" },
  ]);
  expect(apps.total).toBe(2);
});
it("does not report a partial official app list after the Docker list session expires", async () => {
  const { nas } = fixture((url) =>
    url.pathname === "/AppStore/v1/list"
      ? json({ code: 200, data: { list: [{ app_name: "album", name: "相册" }] } })
      : json({ code: "N001207" }),
  );
  await login(nas);
  await expect(nas.read("apps.list")).rejects.toMatchObject({
    code: "SESSION_EXPIRED",
  });
  expect(nas.session()).toBeNull();
});
it("pages flat timeline photos using the official feed list instead of date aggregates", async () => {
  let request!: { path: string; form: URLSearchParams };
  const { nas } = fixture((url, _init, form) => {
    request = { path: url.pathname, form };
    return json({
      code: 200,
      data: {
        total: 41,
        list: [{ id: 26, name: "夏日.jpg", path: "/nvme2/my/data/夏日.jpg", size: 4096, cdate: "20260819" }],
      },
    });
  });
  await login(nas);
  const photos = await nas.read("photos.timeline", { page: 2, pageSize: 20 });
  expect(request.path).toBe("/v2/album/feed/list");
  expect(request.form.get("app")).toBe("album");
  expect(request.form.get("start")).toBe("20");
  expect(request.form.get("num")).toBe("20");
  expect(request.form.get("sort")).toBe("id");
  expect(request.form.get("order")).toBe("desc");
  expect(request.form.has("page")).toBe(false);
  expect(request.form.has("page_size")).toBe(false);
  expect(photos.total).toBe(41);
  expect(photos.items).toMatchObject([
    { id: "26", name: "夏日.jpg", path: "/nvme2/my/data/夏日.jpg", kind: "photo", size: 4096 },
  ]);
  expect(photos.items[0].thumbnail).toContain("/transcode/thumb?");
});
it("uses official start and num for album feeds and all-photo feeds", async () => {
  const requests: { path: string; form: URLSearchParams }[] = [];
  const { nas } = fixture((url, _init, form) => {
    requests.push({ path: url.pathname, form });
    return json({ code: 200, data: { total: 44, list: [] } });
  });
  await login(nas);
  await nas.read("photos.feeds", { album_id: "album-17", page: 3, pageSize: 20 });
  await nas.read("photos.feeds", { page: 3, pageSize: 20 });
  expect(requests.map(({ path }) => path)).toEqual(["/v2/album/album/feeds", "/v2/album/feed/list"]);
  expect(requests[0].form.get("album_id")).toBe("album-17");
  expect(requests[1].form.get("album_id")).toBeNull();
  for (const { form } of requests) {
    expect(form.get("start")).toBe("40");
    expect(form.get("num")).toBe("20");
    expect(form.get("sort")).toBe("id");
    expect(form.get("order")).toBe("desc");
    expect(form.has("page")).toBe(false);
    expect(form.has("page_size")).toBe(false);
  }
});
it("preserves an unknown total so a full page can continue pagination", async () => {
  const { nas } = fixture(() =>
    json({ code: 200, data: { list: Array.from({ length: 20 }, (_, id) => ({ id, name: `photo-${id}.jpg`, path: `/my/photo-${id}.jpg` })) } }),
  );
  await login(nas);
  const photos = await nas.read("photos.timeline", { page: 1, pageSize: 20 });
  expect(photos.items).toHaveLength(20);
  expect(photos.total).toBeUndefined();
});
it("reads the complete official album home combine list without invented server pagination", async () => {
  let request!: { path: string; form: URLSearchParams };
  const { nas } = fixture((url, _init, form) => {
    request = { path: url.pathname, form };
    return json({
      code: 200,
      data: {
        combine: {
          list: [
            { id: 39, name: "家庭时光", cover: "/nvme2/my/data/cover.jpg", fnum: 62, type: 50 },
            { id: 40, name: "旅行", cover: "", fnum: 17, type: 10 },
          ],
        },
      },
    });
  });
  await login(nas);
  const albums = await nas.read("photos.albums", { page: 2, pageSize: 20 });
  expect(request.path).toBe("/v2/album/home");
  expect(request.form.has("page")).toBe(false);
  expect(request.form.has("page_size")).toBe(false);
  expect(albums.total).toBe(2);
  expect(albums.items).toMatchObject([
    { id: "39", name: "家庭时光", kind: "album", metadata: { fnum: 62, type: 50 } },
    { id: "40", name: "旅行", kind: "album" },
  ]);
  expect(albums.items[0].thumbnail).toContain("/transcode/thumb?");
});
it("selects ZOS v3 storage through official polling and preserves pool and disk details", async () => {
  const calls: string[] = [];
  const { nas } = fixture((url) => {
    calls.push(url.pathname);
    return json({ code: 200, data: url.pathname === "/system/polling2"
      ? { sp_ver: "v3" }
      : { pool_list: [{ id: 7, name: "nvme11", protocol: "protnvme", pool_type: "single", status: "ok", total_size: 2048, disk_list: [{ sn: "synthetic-disk", dev_type: "NVME", pos: 1, total_size: 2048 }] }], free_list: [], esp_ver: "v2" } });
  });
  await login(nas);
  const storage = await nas.read("system.storage");
  expect(calls).toEqual(["/system/polling2", "/zspool/info"]);
  expect(storage.items).toMatchObject([{ id: "7", name: "nvme11", kind: "storage", size: 2048, metadata: { disk_list: [{ sn: "synthetic-disk", dev_type: "NVME", pos: 1, total_size: 2048 }] } }]);
  expect(storage.values).toMatchObject({ sp_ver: "v3", free_list: [], esp_ver: "v2" });
});
it.each(["v1", "v2"])("retains the official older storage shape for %s", async (version) => {
  const calls: string[] = [];
  const { nas } = fixture((url) => {
    calls.push(url.pathname);
    return json({ code: 200, data: url.pathname === "/system/polling2"
      ? { sp_ver: version }
      : { system: { sata_group: [{ disks: [{ serial_number: "synthetic-disk", position: 1 }] }], ssd_group: [] } } });
  });
  await login(nas);
  const storage = await nas.read("system.storage");
  expect(calls).toEqual(["/system/polling2", "/storagepool/info2"]);
  expect(storage.values).toMatchObject({ sp_ver: version, system: { sata_group: [{ disks: [{ serial_number: "synthetic-disk", position: 1 }] }] } });
});
it.each([undefined, "v4"])("does not guess a storage endpoint for unverified version %s", async (version) => {
  const { nas, fetcher } = fixture(() => json({ code: 200, data: { sp_ver: version } }));
  await login(nas);
  await expect(nas.read("system.storage")).rejects.toMatchObject({ code: "UNVERIFIED_STORAGE_VERSION", status: 501 });
  expect(fetcher.mock.calls.slice(2).map(([url]) => new URL(String(url)).pathname)).toEqual(["/system/polling2"]);
});
it("adapts official download sizes, progress and byte rates for the download view", async () => {
  const { nas } = fixture(() => json({
    code: 200,
    data: {
      total: 3,
      list: [
        { id: 1, name: "Linux.iso", totalSize: 4096, completeSize: 1024, rateDownload: 512, rateUpload: 128, status: 0, downloadDir: "/nvme2/my/data/下载" },
        { id: 2, totalSize: 2048, completeSize: 4096, rateDownload: 0, files: [{ name: "家庭录像.mp4" }], status: 2 },
        { id: 3, name: "正在获取内容", totalSize: 0, completeSize: 0, rateDownload: 0, status: 1 },
      ],
    },
  }));
  await login(nas);
  const tasks = await nas.read("downloads.list");
  expect(tasks.items).toMatchObject([
    { id: "1", name: "Linux.iso", size: 4096, path: "/nvme2/my/data/下载/Linux.iso", metadata: { progress: 25, speed: 512, rateUpload: 128, status: 0 } },
    { id: "2", name: "家庭录像.mp4", size: 2048, metadata: { progress: 100, speed: 0, status: 2 } },
    { id: "3", name: "正在获取内容", size: 0, metadata: { speed: 0, status: 1 } },
  ]);
  expect(tasks.items[2].metadata).not.toHaveProperty("progress");
  expect(tasks.total).toBe(3);
});
it("never forwards arbitrary token/action parameters to a read route", async () => {
  const { nas, fetcher } = fixture();
  await login(nas);
  const count = fetcher.mock.calls.length;
  for (const params of [
    { token: "attacker" },
    { action: "delete" },
    { page: 0 },
    { pageSize: 1000 },
  ])
    await expect(nas.read("files.list", params)).rejects.toMatchObject({
      code: "INVALID_PARAMS",
    });
  expect(fetcher.mock.calls).toHaveLength(count);
});
it("does not let an old expired response clear a newer NAS session", async () => {
  let finish: (response: Response) => void = () => {};
  const { nas } = fixture(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  await login(nas);
  const pending = nas.read("files.roots");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const fresh = await login(nas);
  finish(json({ code: "N001208" }));
  await expect(pending).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  expect(nas.sessionId).toBe(fresh.sessionId);
});
it("cancels login before sending credentials when logout occurs during public-key fetch", async () => {
  let finish: (response: Response) => void = () => {};
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const nas = new OfficialNas(fetcher as typeof fetch);
  const pending = login(nas);
  nas.logout();
  finish(json({ code: 200, data: { key: keys[0].publicKey } }));
  await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("sanitizes canonical paths synthesized from caller parameters", async () => {
  const { nas } = fixture(() =>
    json({ code: 200, data: { list: [{ name: "image.jpg" }] } }),
  );
  await login(nas);
  const item = (
    await nas.read("files.list", { path: "/my/synthetic-nas%2Btoken" })
  ).items[0];
  expect(item.path).toBe("");
  expect(item.stream).toBeUndefined();
  expect(item.thumbnail).toBeUndefined();
});

it("rejects inherited operation names and stale media authentication", async () => {
  const { nas, fetcher } = fixture();
  await login(nas);
  const count = fetcher.mock.calls.length;
  for (const operation of ["__proto__", "constructor", "toString"])
    await expect(nas.read(operation)).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
    });
  expect(fetcher.mock.calls).toHaveLength(count);
  expect(
    nas.safeMediaUrl("http://nas.test:5055/play/a?token=old-session-token"),
  ).toBeUndefined();
  expect(
    nas.safeMediaUrl("http://nas.test:5055/v2/file/downloads/delete"),
  ).toBeUndefined();
});
it("media requests expire only their own active official NAS session", async () => {
  const { nas } = fixture(() => json({ code: "N001208" }, 401));
  await login(nas);
  await expect(
    nas.fetchMedia("http://nas.test:5055/play/a"),
  ).rejects.toMatchObject({ code: "SESSION_EXPIRED", status: 401 });
  expect(nas.session()).toBeNull();
});

it("native official HTTP uses only its own normal-login Cookie and stable device ID", async () => {
  const original = fixture();
  const native = new OfficialNas(original.fetcher as typeof fetch, {
    transport: "native",
  });
  const cookieRead = vi.spyOn(Document.prototype, "cookie", "get");
  const cookieWrite = vi.spyOn(Document.prototype, "cookie", "set");
  try {
    await login(native);
    await native.read("files.roots");
    const calls = original.fetcher.mock.calls;
    for (const [input, init] of calls) {
      const url = new URL(String(input));
      const cookie = new Headers(init?.headers).get("Cookie");
      /*
       * Cookie 由 SDK 自己拼（不碰 document.cookie），且必须带齐五个身份 cookie：
       * 转码服务额外校验 device/version/plat，少一个就 T000001 参数错误。
       * 网页版早就写这五个，原生端原来只发 device_id + zenithtoken ——
       * 那意味着同一部影片在浏览器能播、在客户端播不了。
       */
      // 身份三元组（device/version/plat）在任何阶段都要有 —— 转码服务校验的就是它们
      expect(cookie).toMatch(/device_id=[a-f0-9]{32}/);
      expect(cookie).toContain("device=SpaceDesktop");
      expect(cookie).toContain("version=");
      expect(cookie).toContain("plat=web");
      const form =
        init?.method === "POST"
          ? new URLSearchParams(String(init.body))
          : url.searchParams;
      expect(cookie).toContain(`device_id=${form.get("device_id")}`);
      /*
       * token 只在**已登录**的请求上出现（key/pub、auth/login 这些还没有会话）。
       * 判据用请求里带不带 token 参数，比按路径列白名单更稳。
       */
      if (form.get("token")) {
        expect(cookie).toContain("token=synthetic-nas+token");
        // zenithtoken 是官方客户端的叫法，与 token 同值
        expect(cookie).toContain("zenithtoken=synthetic-nas+token");
      } else {
        expect(cookie).not.toContain("token=");
      }
    }
    expect(cookieRead).not.toHaveBeenCalled();
    expect(cookieWrite).not.toHaveBeenCalled();
    expect(JSON.stringify(localStorage)).not.toContain("synthetic-nas+token");
    native.logout();
    await expect(native.read("files.roots")).rejects.toMatchObject({
      code: "NO_SESSION",
    });
  } finally {
    cookieRead.mockRestore();
    cookieWrite.mockRestore();
  }
});
it("browser official HTTP never tries to set forbidden Cookie headers or document cookies", async () => {
  const { nas, fetcher } = fixture();
  const cookieRead = vi.spyOn(Document.prototype, "cookie", "get");
  const cookieWrite = vi.spyOn(Document.prototype, "cookie", "set");
  try {
    await login(nas);
    await nas.read("files.roots");
    for (const [, init] of fetcher.mock.calls)
      expect(new Headers(init?.headers).has("Cookie")).toBe(false);
    expect(cookieRead).not.toHaveBeenCalled();
    expect(cookieWrite).not.toHaveBeenCalled();
  } finally {
    cookieRead.mockRestore();
    cookieWrite.mockRestore();
  }
});
it("native media fetch carries only SDK-owned authentication on the selected NAS", async () => {
  const original = fixture((_url, init) => {
    expect(new Headers(init.headers).get("Cookie")).toContain(
      "zenithtoken=synthetic-nas+token",
    );
    return new Response(new Uint8Array([0, 0, 0, 24]), {
      headers: { "Content-Type": "video/mp4" },
    });
  });
  const nas = new OfficialNas(original.fetcher as typeof fetch, {
    transport: "native",
  });
  await login(nas);
  const response = await nas.fetchMedia("/play/binary");
  expect(response.status).toBe(200);
  const count = original.fetcher.mock.calls.length;
  await expect(
    nas.fetchMedia("http://evil.test/play/binary"),
  ).rejects.toMatchObject({ code: "INVALID_MEDIA_URL" });
  expect(original.fetcher.mock.calls).toHaveLength(count);
});

it("default Tauri SDK uses scoped official native HTTP with zero redirects", async () => {
  const old = Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__");
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  try {
    const original = fixture();
    nativePlugin.fetch.mockImplementation(original.fetcher);
    const nas = new OfficialNas();
    await login(nas);
    await nas.read("files.roots");
    expect(nativePlugin.fetch).toHaveBeenCalledTimes(3);
    for (const [input, init] of nativePlugin.fetch.mock.calls) {
      expect(new URL(String(input)).origin).toBe("http://nas.test:5055");
      expect(init).toMatchObject({
        maxRedirections: 0,
        connectTimeout: 15000,
        credentials: "omit",
      });
      expect(init.danger).toBeUndefined();
    }
    nativePlugin.fetch.mockClear();
    const injected = fixture();
    await login(injected.nas);
    expect(nativePlugin.fetch).not.toHaveBeenCalled();
    for (const [, init] of injected.fetcher.mock.calls)
      expect(new Headers(init?.headers).has("Cookie")).toBe(false);
  } finally {
    if (old) Object.defineProperty(window, "__TAURI_INTERNALS__", old);
    else Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  }
});

it("native rendering registers opaque session-bound media URIs without token DOM URLs", async () => {
  const original = fixture(() =>
    json({
      code: 200,
      data: {
        list: [{ id: "f1", name: "a.jpg", path: "/my/a.jpg" }],
        stream: "/play/root.mp4",
        url: "/play/alternate.mp4",
      },
    }),
  );
  const nas = new OfficialNas(original.fetcher as typeof fetch, {
    transport: "native",
  });
  const session = await login(nas);
  const data = await nas.read("files.list", { path: "/my" });
  for (const uri of [
    data.items[0].thumbnail,
    data.items[0].stream,
    data.values?.stream,
    data.values?.url,
  ]) {
    expect(uri).toMatch(/^nas-media:\/\/localhost\/[a-f0-9]{64}$/);
    expect(nas.safeMediaUrl(uri)).toBe(uri);
  }
  expect(JSON.stringify(data)).not.toContain("synthetic-nas");
  const registrations = nativeCore.invoke.mock.calls.filter(
    ([command]) => command === "nas_media_register",
  );
  expect(registrations.length).toBeGreaterThanOrEqual(2);
  for (const [, args] of registrations) {
    expect(args.baseUrl).toBe("http://nas.test:5055");
    expect(new URL(args.sourceUrl).origin).toBe(args.baseUrl);
    expect(args.cookie).toContain("zenithtoken=synthetic-nas+token");
    expect(args.sessionId).toBe(session.sessionId);
    expect(args.sourceUrl).not.toContain(":8050");
  }
  expect(
    nas.safeMediaUrl("nas-media://localhost/" + "f".repeat(64)),
  ).toBeUndefined();
  expect(
    nas.safeMediaUrl("http://nas-media.localhost/" + "f".repeat(64)),
  ).toBeUndefined();
  expect(nas.safeMediaUrl("http://nas.test:5055/play/a")).toBeUndefined();
  const old = data.items[0].stream;
  nas.logout();
  expect(nas.safeMediaUrl(old)).toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(nativeCore.invoke).toHaveBeenCalledWith("nas_media_clear", {
    sessionId: session.sessionId,
  });
});
it("native late media registration after logout is cleared and cannot revive a URI", async () => {
  let finish: (uri: string) => void = () => {};
  nativeCore.invoke.mockImplementation((command: string) =>
    command === "nas_media_register"
      ? new Promise<string>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(),
  );
  const original = fixture(() =>
    json({ code: 200, data: { uri: "/play/music.mp3" } }),
  );
  const nas = new OfficialNas(original.fetcher as typeof fetch, {
    transport: "native",
  });
  const session = await login(nas);
  const pending = nas.read("music.play");
  await new Promise((resolve) => setTimeout(resolve, 0));
  nas.logout();
  const uri = "nas-media://localhost/" + "a".repeat(64);
  finish(uri);
  await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  expect(nas.safeMediaUrl(uri)).toBeUndefined();
  expect(nativeCore.invoke).toHaveBeenCalledWith("nas_media_clear", {
    sessionId: session.sessionId,
  });
});
it("native session replacement and expiry invalidate earlier registered media", async () => {
  let expired = false;
  const original = fixture(() =>
    expired
      ? json({ code: "N001208" })
      : json({ code: 200, data: { uri: "/play/a.mp3" } }),
  );
  const nas = new OfficialNas(original.fetcher as typeof fetch, {
    transport: "native",
  });
  const a = await login(nas);
  const old = (await nas.read("music.play")).items[0].stream;
  const b = await login(nas);
  expect(nas.safeMediaUrl(old)).toBeUndefined();
  const current = (await nas.read("music.play")).items[0].stream;
  expired = true;
  await expect(nas.read("files.roots")).rejects.toMatchObject({
    code: "SESSION_EXPIRED",
  });
  expect(nas.safeMediaUrl(current)).toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(nativeCore.invoke).toHaveBeenCalledWith("nas_media_clear", {
    sessionId: a.sessionId,
  });
  expect(nativeCore.invoke).toHaveBeenCalledWith("nas_media_clear", {
    sessionId: b.sessionId,
  });
});

it("accepts only an actually registered Windows native URI, rejects a bad RPC return", async () => {
  const windows = "http://nas-media.localhost/" + "c".repeat(64);
  nativeCore.invoke.mockImplementation((command: string) =>
    Promise.resolve(command === "nas_media_register" ? windows : undefined),
  );
  const original = fixture(() =>
    json({ code: 200, data: { uri: "/play/a.mp3" } }),
  );
  const nas = new OfficialNas(original.fetcher as typeof fetch, {
    transport: "native",
  });
  await login(nas);
  const data = await nas.read("music.play");
  expect(data.items[0].stream).toBe(windows);
  expect(nas.safeMediaUrl(windows)).toBe(windows);
  expect(nas.safeMediaUrl(windows + "?token=forged")).toBeUndefined();
  nativeCore.invoke.mockImplementation((command: string) =>
    Promise.resolve(
      command === "nas_media_register" ? "http://evil.test/play/a" : undefined,
    ),
  );
  await expect(nas.read("music.play")).rejects.toMatchObject({
    code: "INVALID_MEDIA_REFERENCE",
  });
  expect(nas.safeMediaUrl("http://evil.test/play/a")).toBeUndefined();
});

it("browser DEV matching fixed target rewrites only original official paths and guarded media", async () => {
  vi.stubEnv("DEV", true);
  vi.stubEnv("VITE_NAS_DEV_TARGET", "http://nas.test:5055/");
  const original = fixture(() =>
    json({
      code: 200,
      data: {
        list: [{ id: "f1", name: "a.jpg", path: "/my/a.jpg" }],
        stream: "/play/root.mp4",
      },
    }),
  );
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const wire = new URL(String(input));
    expect(wire.origin).toBe(location.origin);
    expect(wire.pathname.startsWith("/__nas/")).toBe(true);
    expect(new Headers(init?.headers).has("Cookie")).toBe(false);
    return original.fetcher(
      "http://nas.test:5055" +
        wire.pathname.slice("/__nas".length) +
        wire.search,
      init,
    );
  });
  const nas = new OfficialNas(fetcher as typeof fetch);
  await login(nas);
  const data = await nas.read("files.list", {
    path: "/my",
    page: 2,
    pageSize: 12,
  });
  const sent = fetcher.mock.calls.map(([url]) => new URL(String(url)));
  expect(sent.map((u) => u.pathname)).toEqual([
    "/__nas/key/pub",
    "/__nas/auth/login",
    "/__nas/v2/file/list",
  ]);
  const params = new URLSearchParams(String(fetcher.mock.calls[2][1]?.body));
  expect(params.get("start")).toBe("12");
  expect(params.get("num")).toBe("12");
  for (const value of [
    data.items[0].thumbnail,
    data.items[0].stream,
    data.values?.stream,
  ]) {
    const url = new URL(String(value));
    expect(url.origin).toBe(location.origin);
    expect(url.pathname.startsWith("/__nas/")).toBe(true);
    expect(nas.safeMediaUrl(value)).toBe(value);
  }
  expect(
    nas.safeMediaUrl(location.origin + "/__nas/system/reboot"),
  ).toBeUndefined();
  expect(
    nas.safeMediaUrl(
      location.origin + "/__nas/play/forged?token=synthetic-nas%2Btoken",
    ),
  ).toBeUndefined();
  const previous = data.items[0].thumbnail;
  nas.logout();
  expect(nas.safeMediaUrl(previous)).toBeUndefined();
});
it("DEV proxy never rewrites a different selected NAS or production requests", async () => {
  for (const [dev, target] of [
    [true, "http://other.test:5055"],
    [false, "http://nas.test:5055"],
  ] as const) {
    vi.stubEnv("DEV", dev);
    vi.stubEnv("VITE_NAS_DEV_TARGET", target);
    const { nas, fetcher } = fixture();
    await login(nas);
    await nas.read("files.roots");
    for (const [url] of fetcher.mock.calls)
      expect(new URL(String(url)).origin).toBe("http://nas.test:5055");
  }
});
it("DEV proxy media fetch preserves Range and HTTP status with no JS Cookie", async () => {
  vi.stubEnv("DEV", true);
  vi.stubEnv("VITE_NAS_DEV_TARGET", "http://nas.test:5055");
  const original = fixture((_url, init) => {
    expect(new Headers(init.headers).get("Range")).toBe("bytes=12-19");
    return new Response(new Uint8Array([0, 1]), {
      status: 206,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Range": "bytes 12-13/30",
      },
    });
  });
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const wire = new URL(String(input));
    expect(wire.origin).toBe(location.origin);
    expect(new Headers(init?.headers).has("Cookie")).toBe(false);
    return original.fetcher(
      "http://nas.test:5055" +
        wire.pathname.slice("/__nas".length) +
        wire.search,
      init,
    );
  });
  const nas = new OfficialNas(fetcher as typeof fetch);
  await login(nas);
  const response = await nas.fetchMedia("/play/a.mp4", {
    range: "bytes=12-19",
  });
  expect(response.status).toBe(206);
  expect(response.headers.get("Content-Range")).toBe("bytes 12-13/30");
  expect(new URL(String(fetcher.mock.calls[2][0])).pathname).toBe(
    "/__nas/play/a.mp4",
  );
});

it("matching DEV target never changes native official HTTP or opaque renderer transport", async () => {
  vi.stubEnv("DEV", true);
  vi.stubEnv("VITE_NAS_DEV_TARGET", "http://nas.test:5055");
  const original = fixture(() =>
    json({ code: 200, data: { uri: "/play/a.mp3" } }),
  );
  const nas = new OfficialNas(original.fetcher as typeof fetch, {
    transport: "native",
  });
  await login(nas);
  const data = await nas.read("music.play");
  for (const [url] of original.fetcher.mock.calls)
    expect(new URL(String(url)).origin).toBe("http://nas.test:5055");
  expect(data.items[0].stream).toMatch(/^nas-media:/);
  for (const [command, args] of nativeCore.invoke.mock.calls)
    if (command === "nas_media_register")
      expect(new URL(args.sourceUrl).origin).toBe("http://nas.test:5055");
});


describe("official image preview references", () => {
  const image = { name: "夏日.jpg", path: "/my/夏日 & one.jpg", size: 4096, metadata: { updated_at: 1234 } };
  it("builds the official large preview with actual path, size and update marker", async () => {
    const { nas } = fixture();
    await login(nas);
    const url = new URL(await nas.imagePreview(image));
    expect(url.origin).toBe("http://nas.test:5055");
    expect(url.pathname).toBe("/transcode/thumb");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ file_path: image.path, s: "4096", up: "1234", dest_fmt: "large", request_purpose: "5" });
    expect(nas.safeMediaUrl(url.href)).toBe(url.href);
  });
  it("keeps unknown size and update absent and rejects unsupported or missing identities", async () => {
    const { nas } = fixture();
    await login(nas);
    const url = new URL(await nas.imagePreview({ name: "a.png", path: "/my/a.png" }));
    expect(url.searchParams.has("s")).toBe(false);
    expect(url.searchParams.has("up")).toBe(false);
    for (const item of [
      { name: "a.jpg" }, { name: "missing", path: " " },
      { name: "Folder.jpg", path: "/my/Folder.jpg", metadata: { is_dir: true } },
      { name: "movie.mp4", path: "/my/movie.mp4" },
      { name: "vector.svg", path: "/my/vector.svg" },
    ]) await expect(nas.imagePreview(item)).rejects.toMatchObject({ code: "INVALID_IMAGE" });
    nas.logout();
    await expect(nas.imagePreview(image)).rejects.toMatchObject({ code: "NO_SESSION" });
  });
  it("preserves returned update timestamps but omits invalid size/time values", async () => {
    const { nas } = fixture();
    await login(nas);
    const timestamp = "2026-10-11T08:00:00Z";
    const known = new URL(await nas.imagePreview({ ...image, metadata: { updated_at: timestamp } }));
    expect(known.searchParams.get("up")).toBe(timestamp);
    const invalid = new URL(await nas.imagePreview({ ...image, size: NaN, metadata: { updated_at: "unknown" } }));
    expect(invalid.searchParams.has("s")).toBe(false);
    expect(invalid.searchParams.has("up")).toBe(false);
  });
  it("uses exact encrypted image route and preserves only file/photo encrypted identities", async () => {
    const { nas } = fixture(() => json({ code: 200, data: { list: [
      { id: "encrypted", name: "secret.jpg", path: "E.synthetic-image", encrypted_path: "E.synthetic-image", from: "pub_album", size: 99, pwd: "private", nested: { pwd: "private" } },
    ] } }));
    await login(nas);
    for (const operation of ["files.list", "photos.timeline"]) {
      const item = (await nas.read(operation)).items[0];
      const url = new URL(await nas.imagePreview(item));
      expect(url.pathname).toBe("/transcode/decrypt/thumb");
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ encrypted_path: "E.synthetic-image", from: "pub_album", dest_fmt: "large" });
      expect(url.searchParams.has("file_path")).toBe(false);
      expect(JSON.stringify(item)).not.toContain("private");
      expect(item.stream).toBeUndefined();
      expect(new URL(item.thumbnail!).pathname).toBe("/transcode/decrypt/thumb");
    }
    const ordinary = new URL(await nas.imagePreview({ name: "secret.jpg", path: "E.synthetic-image" }));
    expect(ordinary.searchParams.get("from")).toBe("pub_album");
    const music = (await nas.read("music.songs")).items[0];
    expect(music.metadata).not.toHaveProperty("encrypted_path");
    expect(music.stream).toBeUndefined();
  });
  it("preserves an explicit encrypted photo identity without inventing a normal file path", async () => {
    const { nas } = fixture(() => json({ code: 200, data: { list: [
      { id: 1, name: "Encrypted.jpg", encrypted_path: "E.synthetic-image", from: "pub_album", size: 3 },
    ] } }));
    await login(nas);
    const item = (await nas.read("photos.timeline")).items[0];
    expect(item.path).toBeFalsy();
    expect(item.stream).toBeUndefined();
    expect(item.thumbnail).toBeTypeOf("string");
    expect(new URL(item.thumbnail!).pathname).toBe("/transcode/decrypt/thumb");
    expect(new URL(await nas.imagePreview(item)).searchParams.get("encrypted_path")).toBe("E.synthetic-image");
  });
  it("generates thumbnails with known row s/up but never uses a song size for a separate cover", async () => {
    const { nas } = fixture(() => json({ code: 200, data: { list: [
      { id: 1, name: "a.jpg", path: "/my/a.jpg", s: "20", updated_at: "30" },
      { id: 2, name: "Unknown.jpg", path: "/my/unknown.jpg" },
      { id: 3, name: "Provided.jpg", path: "/my/provided.jpg", thumbnail: "/transcode/thumb?file_path=%2Fmy%2Fprovided.jpg&s=7&up=8&dest_fmt=small&request_purpose=5" },
      { id: 4, title: "Missing.jpg" },
      { id: 5, name: "song", song_path: "/music/a.mp3", song_size: 5000, song_cover: "/music/cover.jpg" },
    ] } }));
    await login(nas);
    const items = (await nas.read("files.list", { path: "/my" })).items;
    expect(Object.fromEntries(new URL(items[0].thumbnail!).searchParams)).toMatchObject({ s: "20", up: "30" });
    expect(items[1].size).toBeUndefined();
    expect(new URL(items[1].thumbnail!).searchParams.has("s")).toBe(false);
    expect(Object.fromEntries(new URL(items[2].thumbnail!).searchParams)).toMatchObject({ s: "7", up: "8" });
    expect(items[3].path).toBeFalsy();
    expect(items[3].thumbnail).toBeUndefined();
    expect(new URL(items[4].thumbnail!).searchParams.has("s")).toBe(false);
    expect(new URL(items[4].thumbnail!).searchParams.has("up")).toBe(false);
  });
  it("does not resolve a browser preview reference after immediate session invalidation", async () => {
    const { nas } = fixture();
    await login(nas);
    const pending = nas.imagePreview(image);
    nas.logout();
    await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  });
  it("registers opaque native preview references and rejects failed or stale registration", async () => {
    const original = fixture();
    const nas = new OfficialNas(original.fetcher as typeof fetch, { transport: "native" });
    await login(nas);
    const reference = await nas.imagePreview(image);
    expect(reference).toMatch(/^nas-media:\/\/localhost\/[a-f0-9]{64}$/);
    const args = nativeCore.invoke.mock.calls.find(([command]) => command === "nas_media_register")![1];
    expect(new URL(args.sourceUrl).pathname).toBe("/transcode/thumb");
    expect(new URL(args.sourceUrl).searchParams.get("dest_fmt")).toBe("large");
    expect(args.baseUrl).toBe("http://nas.test:5055");
    expect(args.sessionId).toBe(nas.sessionId);
    nativeCore.invoke.mockImplementation(async () => { throw new Error("synthetic-secret"); });
    await expect(nas.imagePreview(image)).rejects.toMatchObject({ code: "MEDIA_REGISTER_FAILED" });
    let finish!: (value: string) => void;
    nativeCore.invoke.mockImplementation(command => command === "nas_media_register"
      ? new Promise<string>(resolve => { finish = resolve; }) : Promise.resolve());
    const pending = nas.imagePreview(image);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    nas.logout();
    finish(reference);
    await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(nas.safeMediaUrl(reference)).toBeUndefined();
  });
  it("rewrites only a matching DEV selected origin through the existing H5 transport", async () => {
    vi.stubEnv("DEV", true);
    vi.stubEnv("VITE_NAS_DEV_TARGET", "http://nas.test:5055");
    const original = fixture();
    const nas = new OfficialNas(((input, init) => {
      const wire = new URL(String(input));
      return original.fetcher("http://nas.test:5055" + wire.pathname.slice("/__nas".length) + wire.search, init);
    }) as typeof fetch);
    await login(nas);
    const url = new URL(await nas.imagePreview(image));
    expect(url.origin).toBe(location.origin);
    expect(url.pathname).toBe("/__nas/transcode/thumb");
    expect(nas.safeMediaUrl(url.href)).toBe(url.href);
    expect(nas.safeMediaUrl("http://foreign.invalid/transcode/decrypt/thumb")).toBeUndefined();
  });
});


it("installs the native auth-expiry listener before registering any image reference and fences old events", async () => {
  let expire!: (event: { payload: unknown }) => void;
  const onNativeSessionExpired = vi.fn();
  nativeEvents.listen.mockImplementation(async (_event, callback) => { expire = callback; return () => {}; });
  const original = fixture();
  const nas = new OfficialNas(original.fetcher as typeof fetch, { transport: "native", onNativeSessionExpired });
  await login(nas);
  const old = nas.sessionId;
  const reference = await nas.imagePreview({ name: "a.jpg", path: "/my/a.jpg" });
  expect(nativeEvents.listen).toHaveBeenCalledWith("nas-media-session-expired", expect.any(Function));
  const registerIndex = nativeCore.invoke.mock.calls.findIndex(([command]) => command === "nas_media_register");
  expect(nativeEvents.listen.mock.invocationCallOrder[0]).toBeLessThan(nativeCore.invoke.mock.invocationCallOrder[registerIndex]);
  await login(nas);
  const current = nas.sessionId;
  expire({ payload: old });
  expire({ payload: { sessionId: current, token: "synthetic-secret" } });
  expect(nas.sessionId).toBe(current);
  expect(onNativeSessionExpired).not.toHaveBeenCalled();
  expire({ payload: current });
  expect(nas.sessionId).toBe("");
  expect(nas.safeMediaUrl(reference)).toBeUndefined();
  expect(onNativeSessionExpired).toHaveBeenCalledExactlyOnceWith(current);
  expire({ payload: current });
  expect(onNativeSessionExpired).toHaveBeenCalledTimes(1);
});

describe("file download capabilities", () => {
  const file = { id: "file1", name: "display", path: "/my/data/report.json", kind: "file" };
  const info = { path: file.path, name: "report.json", size: 14, is_dir: false };
  it("uses authoritative file info and keeps the normal download URL private", async () => {
    const { nas } = fixture(url => url.pathname === "/v2/file/info" ? json({ code: 200, data: info }) : new Response('{"legal":true}', { headers: { "Content-Disposition": 'attachment; filename="report.json"', "Content-Type": "application/json" } }));
    await login(nas);
    const download = await nas.prepareDownload(file);
    expect(download).toEqual({ id: expect.stringMatching(/^[a-f0-9]{64}$/), name: "report.json", size: 14, sessionId: nas.sessionId });
    expect(JSON.stringify(download)).not.toMatch(/nas.test|token|Cookie|http/);
    expect(nas.safeMediaUrl(download.id)).toBeUndefined();
    const response = await nas.fetchDownload(download.id);
    expect(await response.text()).toBe('{"legal":true}');
  });
  it("registers the exact native normal download source after installing expiry handling", async () => {
    nativeCore.invoke.mockResolvedValue("a".repeat(64));
    const nas = new OfficialNas(fixture(() => json({ code: 200, data: info })).fetcher as typeof fetch, { transport: "native" });
    await login(nas);
    const descriptor = await nas.prepareDownload(file);
    expect(descriptor.id).toBe("a".repeat(64));
    const call = nativeCore.invoke.mock.calls.find(([command]) => command === "nas_download_register")!;
    expect(call).toBeDefined();
    const args = call[1];
    const source = new URL(args.sourceUrl);
    expect(source.pathname).toBe("/v2/file/download");
    expect(Object.fromEntries(["path", "webagent", "request_purpose", "show_hidden"].map(key => [key, source.searchParams.get(key)]))).toEqual({ path: file.path, webagent: "v2", request_purpose: "5", show_hidden: "0" });
    expect(args).toMatchObject({ name: "report.json", size: 14, sessionId: nas.sessionId });
    expect(nativeEvents.listen.mock.invocationCallOrder[0]).toBeLessThan(nativeCore.invoke.mock.invocationCallOrder[0]);
    await expect(nas.fetchDownload(descriptor.id)).rejects.toMatchObject({ code: "NATIVE_DOWNLOAD_ONLY" });
  });
  it("uses the verified encrypted identity without inventing encrypted info", async () => {
    const { nas, fetcher } = fixture(url => {
      expect(url.pathname).toBe("/v2/file/decrypt/download");
      expect(url.searchParams.get("encrypted_path")).toBe("E.synthetic");
      expect(url.searchParams.get("from")).toBe("pub_album");
      return new Response("<svg/>", { headers: { "Content-Disposition": 'attachment; filename="a.svg"' } });
    });
    await login(nas);
    const descriptor = await nas.prepareDownload({ id: "e", name: "a.svg", metadata: { name: "a.svg", encrypted_path: "E.synthetic", from: "pub_album", is_dir: false } });
    expect(descriptor).not.toHaveProperty("size");
    await nas.fetchDownload(descriptor.id);
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/key/pub", "/auth/login", "/v2/file/decrypt/download"]);
  });
  it("rejects directories and missing real identity without a request", async () => {
    const { nas, fetcher } = fixture();
    await login(nas);
    const count = fetcher.mock.calls.length;
    for (const item of [{ id: "d", name: "d", path: "/d", kind: "directory" }, { id: "x", name: "display" }])
      await expect(nas.prepareDownload(item)).rejects.toMatchObject({ code: "INVALID_DOWNLOAD" });
    expect(fetcher.mock.calls).toHaveLength(count);
  });
  it("fences delayed metadata, registration, and capabilities across logout/replacement", async () => {
    let finish!: (response: Response) => void;
    const { nas } = fixture(() => new Promise<Response>(resolve => { finish = resolve; }));
    await login(nas);
    const pending = nas.prepareDownload(file);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await login(nas);
    finish(json({ code: 200, data: info }));
    await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    const other = fixture(() => json({ code: 200, data: info }));
    await login(other.nas);
    const descriptor = await other.nas.prepareDownload(file);
    other.nas.logout();
    await expect(other.nas.fetchDownload(descriptor.id)).rejects.toMatchObject({ code: "INVALID_DOWNLOAD_REFERENCE" });
  });
});

describe("download response identity and session fencing", () => {
  const item = { id: "f", name: "title", path: "/my/a.json" };
  const info = { path: item.path, name: "a.json", is_dir: false, size: 3 };
  it.each([
    { label: "missing disposition", headers: {}, diagnostic: "DOWNLOAD_DISPOSITION_MISSING" },
    { label: "malformed disposition", headers: { "Content-Disposition": "inline; filename=a.json" }, diagnostic: "DOWNLOAD_DISPOSITION_INVALID" },
    { label: "different valid filename", headers: { "Content-Disposition": "attachment; filename=other.json" }, diagnostic: "DOWNLOAD_FILENAME_MISMATCH" },
    { label: "encoding", headers: { "Content-Encoding": "gzip" }, diagnostic: "DOWNLOAD_ENCODING" },
    { label: "invalid length", headers: { "Content-Length": "invalid" }, diagnostic: "DOWNLOAD_LENGTH_INVALID" },
    { label: "size mismatch", headers: { "Content-Length": "4" }, diagnostic: "DOWNLOAD_SIZE_MISMATCH" },
    { label: "unexpected range", headers: { "Content-Range": "bytes 0-2/3" }, diagnostic: "DOWNLOAD_RANGE_INVALID" },
    { label: "incomplete range", status: 206, headers: { "Content-Range": "bytes 1-2/3" }, diagnostic: "DOWNLOAD_RANGE_INVALID" },
    { label: "range size mismatch", status: 206, headers: { "Content-Range": "bytes 0-3/4" }, diagnostic: "DOWNLOAD_SIZE_MISMATCH" },
    { label: "HTTP failure", status: 500, headers: {}, diagnostic: "DOWNLOAD_HTTP" },
  ])("classifies $label using only a static diagnostic and preserves the error code", async testCase => {
    const headers = new Headers(testCase.label === "missing disposition" ? {} : { "Content-Disposition": "attachment; filename=a.json" });
    for (const [name, value] of Object.entries(testCase.headers)) if (value !== undefined) headers.set(name, value);
    const { nas } = fixture(url => url.pathname === "/v2/file/info" ? json({ code: 200, data: info }) : new Response("abc", { status: testCase.status ?? 200, headers }));
    await login(nas); const descriptor = await nas.prepareDownload(item);
    const error = await nas.fetchDownload(descriptor.id).catch(error => error);
    expect(error).toMatchObject({ code: testCase.status === 500 ? "DOWNLOAD_HTTP_ERROR" : "INVALID_DOWNLOAD_RESPONSE", status: 502, diagnostic: testCase.diagnostic });
    expect(JSON.stringify(error)).not.toMatch(/nas\.test|synthetic-nas|other\.json|inline|gzip|bytes|Cookie/);
  });
  it.each(["fetch", "read", "empty", "short", "overflow"])("classifies %s body/transport failure without upstream text", async stage => {
    const { nas } = fixture(url => {
      if (url.pathname === "/v2/file/info") return json({ code: 200, data: info });
      if (stage === "fetch") throw Object.assign(new Error("synthetic-private-upstream"), { diagnostic: "synthetic-private-diagnostic" });
      const body = stage === "empty" ? null : stage === "read" ? new ReadableStream({ pull(c) { c.error(new Error("synthetic-private-upstream")); } }) : new TextEncoder().encode(stage === "short" ? "ab" : "abcd");
      return new Response(body, { headers: { "Content-Disposition": "attachment; filename=a.json" } });
    });
    await login(nas); const descriptor = await nas.prepareDownload(item);
    const error = await (async () => { const response = await nas.fetchDownload(descriptor.id); await response.arrayBuffer(); })().catch(error => error);
    expect(error).toMatchObject({ code: ["fetch", "read"].includes(stage) ? "DOWNLOAD_NETWORK" : "INVALID_DOWNLOAD_RESPONSE", diagnostic: ["fetch", "read"].includes(stage) ? "DOWNLOAD_TRANSPORT" : stage === "empty" ? "DOWNLOAD_BODY_EMPTY" : "DOWNLOAD_SIZE_MISMATCH" });
    expect(JSON.stringify(error)).not.toMatch(/synthetic-private|nas\.test|Cookie/);
  });
  it.each(['attachment; filename="wrong.json"', 'attachment; filename=""', 'attachment; filename="../a.json"', 'attachment; filename="synthetic-nas+token"', 'attachment; xfilename="a.json"', 'attachment; filename*=UTF-8\'\'%ZZ', 'attachment; filename="a.json"; filename="wrong.json"'])("rejects invalid or mismatched filename identity %s", async disposition => {
    const { nas } = fixture(url => url.pathname === "/v2/file/info" ? json({ code: 200, data: info }) : new Response("abc", { headers: { "Content-Disposition": disposition } }));
    await login(nas); const descriptor = await nas.prepareDownload(item);
    await expect(nas.fetchDownload(descriptor.id)).rejects.toMatchObject({ code: "INVALID_DOWNLOAD_RESPONSE" });
  });
  it("accepts filename* and omits upstream private headers", async () => {
    const { nas } = fixture(url => url.pathname === "/v2/file/info" ? json({ code: 200, data: info }) : new Response("abc", { headers: { "Content-Disposition": "attachment; filename*=UTF-8''a.json", "X-Nas-Secret": "synthetic-nas+token", "Content-Type": "application/json" } }));
    await login(nas); const descriptor = await nas.prepareDownload(item); const response = await nas.fetchDownload(descriptor.id);
    expect(response.headers.get("X-Nas-Secret")).toBeNull(); expect(await response.text()).toBe("abc");
  });
  it("rejects encrypted display-title-only identity", async () => {
    const { nas } = fixture(); await login(nas);
    await expect(nas.prepareDownload({ id: "e", name: "Display title", metadata: { encrypted_path: "E.synthetic", from: "pub_album" } })).rejects.toMatchObject({ code: "INVALID_DOWNLOAD" });
  });
  it("rejects stale native registration and clears its old authority", async () => {
    let register!: (value: string) => void;
    nativeCore.invoke.mockImplementation(command => command === "nas_download_register" ? new Promise<string>(resolve => { register = resolve; }) : Promise.resolve());
    const nas = new OfficialNas(fixture(() => json({ code: 200, data: info })).fetcher as typeof fetch, { transport: "native" });
    await login(nas); const old = nas.sessionId; const pending = nas.prepareDownload(item);
    await vi.waitFor(() => expect(register).toBeTypeOf("function")); nas.logout(); await login(nas);
    register("a".repeat(64)); await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(nativeCore.invoke).toHaveBeenCalledWith("nas_media_clear", { sessionId: old });
  });
});

describe("complete browser download streaming", () => {
  const item={id:"a",name:"display",path:"/my/a"};
  it.each([
    { size: 4, bytes: "abc", length: undefined, range: undefined, status: 200 },
    { size: undefined, bytes: "abc", length: "4", range: undefined, status: 200 },
    { size: undefined, bytes: "abc", length: "3", range: "bytes 0-2/6", status: 206 },
    { size: 3, bytes: "abc", length: "4", range: undefined, status: 200 },
  ])("rejects mismatched full file framing %#", async fixtureData => {
    const {nas}=fixture(url=>url.pathname==="/v2/file/info" ? json({code:200,data:{path:item.path,name:"a",is_dir:false,...(fixtureData.size===undefined?{}:{size:fixtureData.size})}}) : new Response(fixtureData.bytes,{status:fixtureData.status,headers:{"Content-Disposition":'attachment; filename="a"',...(fixtureData.length===undefined?{}:{"Content-Length":fixtureData.length}),...(fixtureData.range===undefined?{}:{"Content-Range":fixtureData.range})}}));
    await login(nas);const descriptor=await nas.prepareDownload(item);
    await expect((async()=>{const response=await nas.fetchDownload(descriptor.id);await response.arrayBuffer();})()).rejects.toMatchObject({code:"INVALID_DOWNLOAD_RESPONSE"});
  });
  it("streams complete bytes above media limits and preserves unknown size", async()=>{
    const bytes=new Uint8Array((8<<20)+13).fill(59);
    const {nas}=fixture(url=>url.pathname==="/v2/file/info"?json({code:200,data:{path:item.path,name:"a",is_dir:false}}):new Response(bytes,{headers:{"Content-Disposition":"attachment; filename*=UTF-8''a"}}));
    await login(nas);const descriptor=await nas.prepareDownload(item);expect(descriptor).not.toHaveProperty("size");
    const response=await nas.fetchDownload(descriptor.id);expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
  });
  it("aborts an old download body after logout and replacement",async()=>{
    let body!:ReadableStreamDefaultController<Uint8Array>;
    const {nas}=fixture(url=>url.pathname==="/v2/file/info"?json({code:200,data:{path:item.path,name:"a",is_dir:false}}):new Response(new ReadableStream<Uint8Array>({start(controller){body=controller;}}),{headers:{"Content-Disposition":'attachment; filename="a"'}}));
    await login(nas);const descriptor=await nas.prepareDownload(item);const response=await nas.fetchDownload(descriptor.id);
    const read=response.arrayBuffer();nas.logout();await login(nas);body.enqueue(new Uint8Array([1]));
    await expect(read).rejects.toMatchObject({code:"REQUEST_CANCELLED"});
  });
});

it("public download descriptor mutation cannot replace private response identity or expected size",async()=>{
  const {nas}=fixture(url=>url.pathname==="/v2/file/info"?json({code:200,data:{path:"/my/a",name:"a",is_dir:false,size:4}}):new Response("abc",{headers:{"Content-Disposition":'attachment; filename="changed"',"Content-Length":"3"}}));
  await login(nas);const descriptor=await nas.prepareDownload({id:"a",name:"a",path:"/my/a"});const id=descriptor.id;
  descriptor.name="changed";descriptor.size=3;
  await expect(nas.fetchDownload(id)).rejects.toMatchObject({code:"INVALID_DOWNLOAD_RESPONSE"});
});


describe("official indexed file search", () => {

  it.each([
    ["\u0001report\u0002.txt", "report.txt", "/real/report.txt"],
    ["中文\u0001资料\u0002.png", "中文资料.png", "/real/中文资料.png"],
    ["<img src=x>\u0001报告\u0002.txt", "<img src=x>报告.txt", "/real/markup.txt"],
  ])("removes only observed search name markers from %j and prepares the existing authoritative download", async (marked, plain, path) => {
    const rawId = "returned\u0001id\u0002";
    const { nas, fetcher } = fixture((url, _init, form) => {
      if (url.pathname === "/v2/file/info") {
        expect(form.get("path")).toBe(path);
        return json({ code: 200, data: { info: { path, name: plain, is_dir: false, size: 17 } } });
      }
      return json({ code: 200, data: { list: [{ id: rawId, path, name: marked, file_name: marked, is_dir: false, size: 17 }], total: 1 } });
    });
    await login(nas);
    const result = await nas.read("files.search", { name: "资料" });
    const item = result.items[0];
    expect(item).toMatchObject({ id: path, path, name: plain, metadata: { id: rawId, path, name: plain, file_name: plain } });
    expect(result.values?.list).toEqual([expect.objectContaining({ path, name: plain, file_name: plain })]);
    const count = fetcher.mock.calls.length;
    expect(await nas.prepareDownload(item)).toMatchObject({ name: plain, size: 17, sessionId: nas.sessionId });
    expect(fetcher.mock.calls.length).toBe(count + 1);
  });

  it("normalizes search encrypted actual name metadata without altering encrypted identity", async () => {
    const { nas, fetcher } = fixture(() => json({ code: 200, data: { list: [{ path: "E.returned-search", name: "\u0001图片\u0002.jpg", file_name: "\u0001图片\u0002.jpg", encrypted_path: "E.returned-encrypted", from: "search", is_dir: false, size: 17 }], total: 1 } }));
    await login(nas);
    const item = (await nas.read("files.search", { name: "图片" })).items[0];
    expect(item).toMatchObject({ id: "E.returned-search", path: "E.returned-search", name: "图片.jpg", metadata: { name: "图片.jpg", file_name: "图片.jpg", encrypted_path: "E.returned-encrypted", from: "search" } });
    const count = fetcher.mock.calls.length;
    expect(await nas.prepareDownload(item)).toMatchObject({ name: "图片.jpg", size: 17 });
    expect(fetcher.mock.calls.length).toBe(count);
    const preview = new URL(await nas.imagePreview(item));
    expect(preview.searchParams.get("encrypted_path")).toBe("E.returned-encrypted");
    expect(preview.searchParams.get("from")).toBe("search");
  });

  it("cleans private tokens reconstructed by search name marker removal in items, metadata and values", async () => {
    const splitToken = "synthetic-\u0001nas+\u0002token";
    const nested = { name: splitToken, children: [{ file_name: splitToken }, [{ name: encodeURIComponent("synthetic-") + "\u0001nas%2B\u0002token" }]] };
    const { nas } = fixture(() => json({ code: 200, data: { list: [{ path: "/real/private-label", name: splitToken, file_name: splitToken, is_dir: false, nested }], total: 1, nested } }));
    await login(nas);
    const result = await nas.read("files.search", { name: "private" });
    expect(result.items[0]).toMatchObject({ id: "/real/private-label", path: "/real/private-label", name: "", metadata: { name: "", file_name: "", nested: { name: "", children: [{ file_name: "" }, [{ name: "" }]] } } });
    expect(result.values?.nested).toEqual(result.items[0].metadata?.nested);
    expect(JSON.stringify(result)).not.toContain("synthetic-");
  });

  it.each(["\u0000", "\u0003", "\n", "\t", "\u007f"])("preserves non-marker search controls %j and keeps encrypted download filename guards", async control => {
    const name = `bad${control}name.txt`;
    const { nas } = fixture(() => json({ code: 200, data: { list: [{ path: "E.returned", name: "\u0001bad\u0002" + control + "name.txt", encrypted_path: "E.returned", from: "search", is_dir: false }], total: 1 } }));
    await login(nas);
    const item = (await nas.read("files.search", { name: "bad" })).items[0];
    expect(item.name).toBe(name);
    await expect(nas.prepareDownload(item)).rejects.toMatchObject({ code: "INVALID_DOWNLOAD" });
  });

  it.each(["files.list", "files.info"])("leaves ordinary %s names and identity unchanged", async operation => {
    const row = { id: "returned-id", path: "/real/ordinary.txt", name: "\u0001ordinary\u0002.txt", file_name: "\u0001ordinary\u0002.txt", is_dir: false };
    const { nas } = fixture(() => json({ code: 200, data: operation === "files.info" ? { info: row } : { list: [row], total: 1 } }));
    await login(nas);
    expect((await nas.read(operation, { path: row.path })).items[0]).toMatchObject({ id: row.id, path: row.path, name: row.name, metadata: { name: row.name, file_name: row.file_name } });
  });

  it("posts a bounded global Chinese query with official defaults and returned path identity", async () => {
    const { nas } = fixture((url, init, form) => {
      expect(url.pathname).toBe("/file_search/file_search");
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("Content-Type")).toBe("application/x-www-form-urlencoded");
      expect(String(init.body)).toContain("name=%E4%B8%AD%E6%96%87+%2B+%26");
      const expected = { name: "中文 + &", file_path: "", start: "0", num: "20", order_by: "0", ftype: "", is_dir: "", min_size: "0", max_size: "0", shared_only: "2", show_hidden: "0" };
      for (const [key, value] of Object.entries(expected)) expect(form.get(key)).toBe(value);
      expect(form.has("path")).toBe(false);
      expect(form.has("page")).toBe(false);
      return json({ code: 200, data: { list: [
        { id: "display-only-id", name: "报告.docx", path: "/real/report.docx", is_dir: 0, size: 123 },
        { id: "directory-label", name: "资料", path: "/real/folder", is_dir: 1 },
      ], total: 67 } });
    });
    await login(nas);
    const result = await nas.read("files.search", { name: "  中文 + &  " });
    expect(result.total).toBe(67);
    expect(result.items).toMatchObject([
      { id: "/real/report.docx", name: "报告.docx", path: "/real/report.docx", kind: "file", size: 123 },
      { id: "/real/folder", name: "资料", path: "/real/folder", kind: "directory" },
    ]);
    expect(result.items[1].size).toBeUndefined();
  });

  it("uses the actual directory and issues real requests for page two", async () => {
    const seen: string[] = [];
    const { nas } = fixture((_url, _init, form) => {
      seen.push(form.get("start")!);
      expect(form.get("file_path")).toBe("/real/中文 目录");
      expect(form.get("shared_only")).toBe("0");
      expect(form.get("num")).toBe("7");
      return json({ code: 200, data: { list: [{ name: "same-name", path: "/real/中文 目录/" + form.get("start"), is_dir: false }], total: "21" } });
    });
    await login(nas);
    const first = await nas.read("files.search", { name: "report", path: "/real/中文 目录", pageSize: 7 });
    const second = await nas.read("files.search", { name: "report", path: "/real/中文 目录", page: 2, pageSize: 7 });
    expect(seen).toEqual(["0", "7"]);
    expect(first.items[0].id).not.toBe(second.items[0].id);
    expect(second.total).toBe(21);
  });

  it("rejects unknown index options and invalid high-level parameters before a content request", async () => {
    const { nas, fetcher } = fixture();
    await login(nas);
    const count = fetcher.mock.calls.length;
    const invalid = [
      {}, { name: "" }, { name: "   " }, { name: 123 }, { name: "a".repeat(257) },
      ...["\n", "\r", "\t", "\0", "\x7f", "\x85"].map(control => ({ name: "query" + control })),
      ...["", "   ", null, undefined, false, 1, "a".repeat(8193), "/real\npath"].map(path => ({ name: "query", path })),
      ...[0, -1, 10001, 1.5, NaN, Infinity, null, "2", true].map(page => ({ name: "query", page })),
      ...[0, -1, 201, 1.5, NaN, Infinity, null, "20", true].map(pageSize => ({ name: "query", pageSize })),
      ...["token", "shared_only", "file_path", "order_by", "show_hidden", "start", "num", "page_size", "action", "ftype", "is_dir", "min_size", "max_size"].map(key => ({ name: "query", [key]: "1" })),
    ];
    for (const params of invalid) {
      await expect(nas.read("files.search", params)).rejects.toMatchObject({ code: "INVALID_PARAMS" });
      expect(fetcher.mock.calls.length).toBe(count);
    }
    await expect(nas.read("files.search", { name: "a".repeat(256), path: "/" + "a".repeat(8191), page: 10000, pageSize: 200 })).resolves.toMatchObject({ total: 0 });
  });

  it.each([
    {}, { list: [] }, { total: 0 }, { list: {}, total: 0 }, { list: null, total: 0 },
    ...[undefined, null, true, false, "", "private-body", -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, {}].map(total => ({ list: [], total })),
    ...[null, "row", {}, { name: "guessed-name", is_dir: false }, { path: "", is_dir: false }, { path: "/real" }, { path: "/real", is_dir: "unknown" }, { path: "/bad\npath", is_dir: false }].map(row => ({ list: [row], total: 1 })),
  ])("rejects malformed search response %j safely", async (data) => {
    const { nas } = fixture(() => json({ code: 200, data }));
    await login(nas);
    await expect(nas.read("files.search", { name: "query" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("accepts a genuine empty result with server total zero", async () => {
    const { nas } = fixture(); await login(nas);
    expect(await nas.read("files.search", { name: "missing" })).toMatchObject({ items: [], total: 0 });
  });

  it("drops a delayed successful search after session replacement", async () => {
    let finish!: (value: Response) => void;
    const { nas } = fixture(() => new Promise<Response>(resolve => { finish = resolve; }));
    await login(nas);
    const pending = nas.read("files.search", { name: "old-query" });
    const outcome = pending.then(value => value, error => error);
    await new Promise(resolve => setTimeout(resolve, 0));
    const current = await login(nas);
    expect(finish).toBeTypeOf("function");
    finish(json({ code: 200, data: { list: [{ path: "/old/path", is_dir: false }], total: 1 } }));
    expect(await outcome).toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(nas.sessionId).toBe(current.sessionId);
  });

  it("redacts metadata and exposes only a fixed safe search expiry error", async () => {
    let expired = false;
    const { nas } = fixture(() => expired ? json({ code: "N001208", message: "synthetic-nas+token Cookie=private" }) : json({ code: 200, data: { list: [{ path: "/real/report", name: "report", is_dir: false, token: "synthetic-nas+token", password: "private", sign: "private", nested: { cookie: "private", text: "synthetic-nas+token" } }], total: 1, token: "private" } }));
    await login(nas);
    const result = await nas.read("files.search", { name: "report" });
    expect(JSON.stringify(result)).not.toMatch(/synthetic-nas|private|password|cookie|sign/i);
    expired = true;
    await expect(nas.read("files.search", { name: "report" })).rejects.toMatchObject({ code: "SESSION_EXPIRED", message: "NAS 登录已失效，请重新登录" });
    expect(nas.session()).toBeNull();
  });

  it("keeps search capabilities private and prepares image preview from actual metadata on demand", async () => {
    const { nas } = fixture(() => json({ code: 200, data: { list: [{ path: "/real/photo.jpg", name: "photo.jpg", is_dir: false, size: 17,
      thumbnail: "http://nas.test:5055/transcode/thumb?token=private-token", stream: "/v2/file/download?sign=private-sign", url: "/play/private",
    }], total: 1, url: "/play/private", items: [{ path: "/ignored", is_dir: false }] } }));
    await login(nas);
    const result = await nas.read("files.search", { name: "  " + "a".repeat(256) + "  " });
    const item = result.items[0];
    expect(item).toMatchObject({ id: "/real/photo.jpg", path: "/real/photo.jpg", size: 17 });
    expect(item.thumbnail).toBeUndefined(); expect(item.stream).toBeUndefined();
    expect(item.metadata).not.toHaveProperty("url");
    expect(result.values).not.toHaveProperty("url");
    expect(JSON.stringify(result)).not.toMatch(/private-token|private-sign|[?&](token|sign)=/);
    const preview = new URL(await nas.imagePreview(item));
    expect(preview.pathname).toBe("/transcode/thumb");
    expect(preview.searchParams.get("file_path")).toBe(item.path);
  });

  it("recursively omits search media capabilities in rows, root metadata and nested arrays while retaining preview/download identity", async () => {
    const mediaFields = ["thumbnail", "thumb", "poster", "cover", "cover_url", "image_url", "song_cover", "stream", "stream_url", "play_url", "url", "uri"];
    const capabilities = Object.fromEntries(mediaFields.map(field => [field, "/play/synthetic-capability/" + field]));
    const nested = { ...capabilities, note: "returned-note", path: "/real/related", children: [{ ...capabilities, size: 3, kind: "returned-kind" }, [{ ...capabilities, from: "returned-source" }]] };
    const { nas, fetcher } = fixture(() => json({ code: 200, data: {
      list: [{ path: "/real/photo.jpg", name: "photo.jpg", is_dir: false, size: 17, encrypted_path: "E.synthetic-photo", from: "pub_album", nested }],
      total: 1, other: nested, arrays: [[nested]],
    } }));
    await login(nas);
    const result = await nas.read("files.search", { name: "photo" });
    expect(JSON.stringify(result)).not.toContain("synthetic-capability");
    const item = result.items[0];
    expect(item).toMatchObject({ id: "/real/photo.jpg", path: "/real/photo.jpg", kind: "file", size: 17,
      metadata: { path: "/real/photo.jpg", encrypted_path: "E.synthetic-photo", from: "pub_album", is_dir: false, size: 17 } });
    const preserved = { note: "returned-note", path: "/real/related", children: [{ size: 3, kind: "returned-kind" }, [{ from: "returned-source" }]] };
    expect(item.metadata?.nested).toEqual(preserved);
    expect(result.values?.other).toEqual(preserved);
    expect(result.values?.arrays).toEqual([[preserved]]);
    const count = fetcher.mock.calls.length;
    const preview = new URL(await nas.imagePreview(item));
    expect(preview.pathname).toBe("/transcode/decrypt/thumb");
    expect(preview.searchParams.get("encrypted_path")).toBe("E.synthetic-photo");
    expect(preview.searchParams.get("from")).toBe("pub_album");
    expect(preview.searchParams.get("s")).toBe("17");
    expect(await nas.prepareDownload(item)).toMatchObject({ name: "photo.jpg", size: 17, sessionId: nas.sessionId });
    expect(fetcher.mock.calls.length).toBe(count);
  });

  it("preserves existing nested optional media metadata for other read operations", async () => {
    const { nas } = fixture(() => json({ code: 200, data: { list: [{ path: "/real/photo.jpg", name: "photo.jpg", is_dir: false,
      nested: { url: "/play/returned-media", children: [{ thumb: "/thumb/returned-media" }] },
    }], total: 1 } }));
    await login(nas);
    const result = await nas.read("files.list", { path: "/real" });
    expect(result.items[0].metadata?.nested).toEqual({ url: "/play/returned-media", children: [{ thumb: "/thumb/returned-media" }] });
    expect(result.values?.list).toEqual([expect.objectContaining({ nested: result.items[0].metadata?.nested })]);
  });

  it("uses POST for the exact native official search URL", async () => {
    const { fetcher } = fixture(); nativePlugin.fetch.mockImplementation(fetcher);
    const nas = new OfficialNas(undefined, { transport: "native" }); await login(nas);
    const result = await nas.read("files.search", { name: "report" });
    expect(nativeCore.invoke).not.toHaveBeenCalledWith("nas_media_register", expect.anything());
    expect(JSON.stringify(result)).not.toContain("synthetic-nas");
    const [url, init] = nativePlugin.fetch.mock.calls.at(-1)!;
    expect(new URL(String(url)).pathname).toBe("/file_search/file_search");
    expect(init).toMatchObject({ method: "POST", maxRedirections: 0 });
    expect(new URLSearchParams(String(init.body)).get("name")).toBe("report");
  });
});

describe('session-owned upload source registry', () => {
  it('requires current login and returns only safe opaque browser metadata', async () => {
    const {nas}=fixture(); const file=new File(['abc'],'选定.txt',{lastModified:7});
    await expect(nas.selectBrowserUploadSource(file)).rejects.toMatchObject({code:'NO_SESSION'});
    await login(nas); const source=await nas.selectBrowserUploadSource(file);
    expect(source).toEqual({sourceId:expect.stringMatching(/^[a-f0-9]{32}$/),name:'选定.txt',size:3,lastModified:7,sessionId:nas.sessionId});
    // The random opaque identifier may legitimately contain the hex substring "abc".
    const {sourceId: opaqueId, sessionId: ownerSessionId, ...publicMetadata} = source;
    expect(opaqueId).toMatch(/^[a-f0-9]{32}$/);
    expect(ownerSessionId).toBe(nas.sessionId);
    expect(JSON.stringify(publicMetadata)).not.toMatch(/synthetic-nas|abc|File|adapter/);
    await nas.releaseUploadSource(source.sourceId); await nas.releaseUploadSource(source.sourceId);
  });
  it('rejects source names containing the captured private token without echoing it',async()=> {
    const {nas}=fixture(); await login(nas);
    await expect(nas.selectBrowserUploadSource(new File([],'synthetic-nas+token.txt',{lastModified:0}))).rejects.toMatchObject({code:'INVALID_UPLOAD_SOURCE',message:'请选择有效的普通文件'});
  });
  it('caps registry at64 and release frees only its exact source slot',async()=> {
    const {nas}=fixture(); await login(nas); const file=new File([],'empty',{lastModified:0});
    const selected=[]; for(let i=0;i<64;i++)selected.push(await nas.selectBrowserUploadSource(file));
    await expect(nas.selectBrowserUploadSource(file)).rejects.toMatchObject({code:'UPLOAD_SOURCE_LIMIT'});
    await nas.releaseUploadSource('foreign'); await expect(nas.selectBrowserUploadSource(file)).rejects.toMatchObject({code:'UPLOAD_SOURCE_LIMIT'});
    await nas.releaseUploadSource(selected[0].sourceId); await nas.selectBrowserUploadSource(file);
    nas.logout(); await login(nas); for(let i=0;i<64;i++)await nas.selectBrowserUploadSource(file);
  });
  it('native picker uses captured SDK credentials and source release leaves media authority intact',async()=> {
    const {nas}=fixture(); await login(nas);
    // Browser fixture only supplies normal login; transport selection remains private.
    const wire=fixture(); const native=new OfficialNas(wire.fetcher as typeof fetch,{transport:'native'}); await login(native);
    nativeCore.invoke.mockImplementation(async(command:string,args:any)=>command==='nas_upload_pick'?{id:'a'.repeat(64),name:'chosen.bin',size:3,lastModified:7,sessionId:args.sessionId}:undefined);
    const source=await native.pickUploadSource(); expect(source).toEqual({sourceId:expect.stringMatching(/^[a-f0-9]{32}$/),name:'chosen.bin',size:3,lastModified:7,sessionId:native.sessionId});
    expect(nativeCore.invoke).toHaveBeenCalledWith('nas_upload_pick',{base:'http://nas.test:5055',cookie:expect.stringContaining('zenithtoken=synthetic-nas+token'),sessionId:native.sessionId});
    expect(source!.sourceId).not.toBe('a'.repeat(64)); await native.releaseUploadSource(source!.sourceId);
    await vi.waitFor(()=>expect(nativeCore.invoke).toHaveBeenCalledWith('nas_upload_release',{id:'a'.repeat(64),sessionId:source!.sessionId}));
    expect(nativeCore.invoke.mock.calls.some(([cmd])=>cmd==='nas_media_clear')).toBe(false);
  });
  it('late old picker releases only its captured old native session after logout/new login',async()=> {
    const wire=fixture(); const nas=new OfficialNas(wire.fetcher as typeof fetch,{transport:'native'}); await login(nas); const old=nas.sessionId;
    let finish!:(value:unknown)=>void; const pending=new Promise(resolve=>{finish=resolve;});
    nativeCore.invoke.mockImplementation(async(command:string)=>command==='nas_upload_pick'?pending:undefined);
    const picker=nas.pickUploadSource(); const outcome=picker.catch(error=>error); for(let i=0;i<12;i++)await Promise.resolve();
    await vi.waitFor(()=>expect(nativeCore.invoke.mock.calls.some(([cmd])=>cmd==='nas_upload_pick')).toBe(true));
    nas.logout(); await login(nas); const current=nas.sessionId;
    finish({id:'b'.repeat(64),name:'old.bin',size:0,lastModified:0,sessionId:old});
    expect(await outcome).toMatchObject({code:'REQUEST_CANCELLED'});
    await vi.waitFor(()=>expect(nativeCore.invoke).toHaveBeenCalledWith('nas_upload_release',{id:'b'.repeat(64),sessionId:old})); expect(nas.sessionId).toBe(current);
  });
  it('native expiry revokes sources while stale expiry cannot revoke the new session',async()=> {
    const wire=fixture(); const nas=new OfficialNas(wire.fetcher as typeof fetch,{transport:'native'}); await login(nas);
    nativeCore.invoke.mockImplementation(async(command:string,args:any)=>command==='nas_upload_pick'?{id:'a'.repeat(64),name:'file',size:0,lastModified:0,sessionId:args.sessionId}:undefined);
    const source=await nas.pickUploadSource(); const callback=nativeEvents.listen.mock.calls.find(([event])=>event==='nas-media-session-expired')![1];
    callback({payload:source!.sessionId}); for(let i=0;i<12;i++)await Promise.resolve(); expect(nas.sessionId).toBe('');
    await vi.waitFor(()=>expect(nativeCore.invoke).toHaveBeenCalledWith('nas_upload_release',{id:'a'.repeat(64),sessionId:source!.sessionId}));
    await login(nas); const current=nas.sessionId; callback({payload:source!.sessionId}); expect(nas.sessionId).toBe(current);
  });
  it('cancellation/no selection is null and malformed native picker results are sanitized',async()=> {
    const wire=fixture(); const nas=new OfficialNas(wire.fetcher as typeof fetch,{transport:'native'}); await login(nas);
    nativeCore.invoke.mockResolvedValueOnce(null); expect(await nas.pickUploadSource()).toBeNull();
    nativeCore.invoke.mockResolvedValueOnce({id:'c'.repeat(64),name:'/private/path',size:0,lastModified:0,sessionId:nas.sessionId});
    await expect(nas.pickUploadSource()).rejects.toMatchObject({code:'INVALID_UPLOAD_SOURCE',message:'请选择有效的普通文件'});
  });
});

describe('revoked picker preparation never waits for noncooperative dependencies',()=> {
  function deferred<T>() {let resolve!:(value:T)=>void, reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
  it.each([['logout','fulfill'],['replacement','fulfill'],['logout','reject'],['replacement','reject']] as const)('settles during pending expiry listener on %s and handles late %s',async(mode,ending)=> {
    const wire=fixture(), nas=new OfficialNas(wire.fetcher as typeof fetch,{transport:'native'});await login(nas);const old=nas.sessionId;
    const pending=deferred<()=>void>(), unlisten=vi.fn(); nativeEvents.listen.mockReturnValueOnce(pending.promise); nativeCore.invoke.mockImplementation(async(cmd:string)=>cmd==='nas_upload_pick'?null:undefined);
    const settled=vi.fn(), picker=nas.pickUploadSource().then(value=>settled(value),error=>settled(error));
    try {
      await vi.waitFor(()=>expect(nativeEvents.listen).toHaveBeenCalledWith('nas-media-session-expired',expect.any(Function)));
      const callback=nativeEvents.listen.mock.calls[0][1];
      if(mode==='logout'){nas.logout();await login(nas);}else await login(nas);
      const current=nas.sessionId;
      await vi.waitFor(()=>expect(settled).toHaveBeenCalledTimes(1),{timeout:250});
      expect(settled.mock.calls[0][0]).toMatchObject({code:'REQUEST_CANCELLED',message:'NAS 会话已改变，请重新选择文件'});
      expect(nativeCore.invoke.mock.calls.filter(([cmd])=>cmd==='nas_upload_pick')).toHaveLength(0);
      if(ending==='fulfill')pending.resolve(unlisten);else pending.reject(new Error('private-path-token'));
      await picker;for(let i=0;i<20;i++)await Promise.resolve();
      callback({payload:old});expect(nas.sessionId).toBe(current);expect(unlisten).not.toHaveBeenCalled();
      nativeEvents.listen.mockResolvedValue(unlisten);expect(await nas.pickUploadSource()).toBeNull();
      expect(nativeCore.invoke.mock.calls.filter(([cmd])=>cmd==='nas_upload_pick')).toHaveLength(1);
      expect(nativeEvents.listen).toHaveBeenCalledTimes(ending==='fulfill'?1:2);expect(unlisten).not.toHaveBeenCalled();
    } finally {pending.resolve(unlisten);await picker;nas.logout();}
  });
  it('does not hold a revoked malformed selection behind old-source cleanup',async()=> {
    const wire=fixture(),nas=new OfficialNas(wire.fetcher as typeof fetch,{transport:'native'});await login(nas);const old=nas.sessionId;
    const release=deferred<void>(),settled=vi.fn();nativeCore.invoke.mockImplementation(async(cmd:string,args:any)=>cmd==='nas_upload_pick'?{id:'d'.repeat(64),name:'/private/path',size:0,lastModified:0,sessionId:args.sessionId}:cmd==='nas_upload_release'?release.promise:undefined);
    const picker=nas.pickUploadSource().then(value=>settled(value),error=>settled(error));
    try {
      await vi.waitFor(()=>expect(nativeCore.invoke).toHaveBeenCalledWith('nas_upload_release',{id:'d'.repeat(64),sessionId:old}));
      nas.logout();await login(nas);const current=nas.sessionId;
      await vi.waitFor(()=>expect(settled).toHaveBeenCalledTimes(1),{timeout:250});
      expect(settled.mock.calls[0][0]).toMatchObject({code:expect.stringMatching(/^(INVALID_UPLOAD_SOURCE|REQUEST_CANCELLED)$/)});
      release.reject(new Error('private-path-token'));await picker;await new Promise(resolve=>setTimeout(resolve,0));expect(nas.sessionId).toBe(current);
      expect(nativeCore.invoke.mock.calls.filter(([cmd])=>cmd==='nas_upload_release')).toEqual([['nas_upload_release',{id:'d'.repeat(64),sessionId:old}]]);
    } finally {release.resolve();await picker;nas.logout();}
  });
  it('settles core import cancellation before module fulfillment without dispatching an old picker',async()=> {
    const wire=fixture(),nas=new OfficialNas(wire.fetcher as typeof fetch,{transport:'native'});await login(nas);
    const pending=deferred<typeof nativeCore>(),entered=vi.fn(),settled=vi.fn();
    vi.resetModules();vi.doMock('@tauri-apps/api/core',async()=> {entered();return pending.promise;});
    const picker=nas.pickUploadSource().then(value=>settled(value),error=>settled(error));
    try {
      await vi.waitFor(()=>expect(entered).toHaveBeenCalledTimes(1));nas.logout();await login(nas);const current=nas.sessionId;
      await vi.waitFor(()=>expect(settled).toHaveBeenCalledTimes(1),{timeout:250});expect(settled.mock.calls[0][0]).toMatchObject({code:'REQUEST_CANCELLED'});
      pending.resolve(nativeCore);await picker;await new Promise(resolve=>setTimeout(resolve,0));
      expect(nativeCore.invoke.mock.calls.filter(([cmd])=>cmd==='nas_upload_pick')).toHaveLength(0);expect(nas.sessionId).toBe(current);
      nativeCore.invoke.mockImplementation(async(cmd:string)=>cmd==='nas_upload_pick'?null:undefined);expect(await nas.pickUploadSource()).toBeNull();
    } finally {pending.resolve(nativeCore);await picker;vi.doMock('@tauri-apps/api/core',()=>nativeCore);vi.resetModules();nas.logout();}
  });

});
