import { extractEmbeddedArtwork } from "./embedded-art";
import { dockerAppTemplates, dockerFieldValid, supportsOfficialDockerInstall, type DockerInstallField } from "./docker-app-templates";
export { supportsOfficialDockerInstall } from "./docker-app-templates";
/** Direct adapter for the current official NAS HTTP protocol; no custom NAS server. */
import { normalizeStoreAddress } from "./store-address";
import { JSEncrypt } from "jsencrypt";
import type { Collection, DirectoryCreation, FileDownload, Item, NasSession } from "./client";
import { clearSessionCookie, cookieFacts, credentialsFor, writeSessionCookie } from "./session-cookie";
import { createBrowserUploadSource, createNativeUploadSource, validateNativeUploadSource, type UploadSourceAdapter, type UploadSourceDescriptor } from "./upload-sources";
import { safeOfficialDownloadDiagnostic, type DownloadFailureDiagnostic } from "./download-diagnostics";

import { createUploadTask, uploadPieceHeaders, strictUploadSize, completeUploadListing, verifyUploadReplyTarget, OfficialUploadError,
  type UploadDestination, type UploadSnapshot, type UploadCallbacks, type UploadEngineCallbacks, type RetainedUploadTask, type UploadPiece } from "./official-upload";
import { computeUploadUUID, validateUploadHashInput } from "./upload-hashes";

type RecordData = Record<string, unknown>;
type Active = {
  public: NasSession;
  token: string;
  nasId: string;
  generation: number;
};
type Operation = {
  method: "GET" | "POST";
  path: string;
  params: string;
  app?: string;
};
// Only the directory action requests an envelope; ordinary reads retain their
// decoded-data contract. Authority and response timestamps stay SDK-private.
type DirectoryContext = {
  signal: AbortSignal;
  assertCurrent: () => void;
  envelope?: boolean;
  onDispatch?: () => void;
};
export class OfficialNasError extends Error {
  readonly diagnostic?: DownloadFailureDiagnostic;
  constructor(
    message: string,
    public code: string,
    public status: number,
    public readonly mayHaveCreated = false,
    diagnostic?: DownloadFailureDiagnostic,
  ) {
    super(message);
    this.name = "OfficialNasError";
    this.diagnostic = safeOfficialDownloadDiagnostic(code, diagnostic);
  }
}
export type LoginVerificationChallenge = { id: string; expiresAt: number };
type LoginVerificationState = LoginVerificationChallenge & {
  base: string; username: string; nasId: string; generation: number; deviceId: string;
  controller: AbortController; timer?: ReturnType<typeof setTimeout>; busy: boolean; sent: boolean; retryAt: number;
};
export class OfficialNasVerificationRequired extends OfficialNasError {
  constructor(public readonly verification: LoginVerificationChallenge) {
    super("此设备需要短信验证（N001414），请发送验证码后继续登录", "CHALLENGE_REQUIRED", 403);
  }
}
export type PersonalSettingKey = "show_hidden" | "file_hash_check" | "file_hash_check_option" | "fs_evt_monitor" | "disk_stats_sec";
export type DockerEndpoint = "capabilities" | "containers" | "images" | "compose" | "info" | "control" | "create" | "compose-create" | `logs/${string}` | `details/${string}`;
export type NativeAppPlan = { appName: string; version: number; disks: Array<{ mp: string; name: string; free: number }> };
export type DownloadEngineState = { current: 1 | 2; engines: Array<{ type: 1 | 2; name: string; version: string }>; status: number };
export type OfficialRemoteEntry = { id: string; name: string; address: string; url?: string; color?: string; proxy: boolean; desktopVisible: boolean };
export type OfficialNote = { id: string; title: string; body: string; noteType: number; classifyId: number; updatedAt?: number };
export type OfficialDockerAppPlan = { appName: string; version: number; roots: Array<{ id: string; name: string; path: string }>; portMin: number; portMax: number; fields?: DockerInstallField[]; autoStartDefault?: boolean; requiresRiskConfirmation?: boolean; primaryLabel?: string };
const fail = (code: string, message: string, status = 400) =>
  new OfficialNasError(message, code, status);
const downloadFail = (code: string, message: string, diagnostic: DownloadFailureDiagnostic) =>
  new OfficialNasError(message, code, 502, false, diagnostic);
const operations: Record<string, Operation> = {
  "files.roots": { method: "POST", path: "/system/polling2", params: "" },
  "files.list": {
    method: "POST",
    path: "/v2/file/list",
    params: "path start num sortby order show_hidden",
  },
  "files.info": { method: "POST", path: "/v2/file/info", params: "path" },
  "files.search": { method: "POST", path: "/file_search/file_search", params: "" },
  "files.recent": {
    method: "POST",
    path: "/v2/recent/list",
    params: "start num scope show_hidden with_fields",
  },
  "photos.albums": {
    method: "POST",
    path: "/v2/album/home",
    params: "page page_size",
    app: "album",
  },
  "photos.timeline": {
    method: "POST",
    // The official timeline endpoint returns date counts, not photo records.
    // Our flat photo view uses the official feed-list paging contract.
    path: "/v2/album/feed/list",
    params: "start num sort order dir_id cdate_list",
    app: "album",
  },
  "photos.feeds": {
    method: "POST",
    path: "/v2/album/album/feeds",
    params: "album_id start num sort order cdate_list",
    app: "album",
  },
  "photos.favorites": {method:"POST",path:"/v2/album/feed/list",params:"start num sort order",app:"album"},
  "photos.folders": {method:"POST",path:"/v2/album/dirs",params:"",app:"album"},
  "photos.smart": {method:"POST",path:"/v2/album/albums",params:"",app:"album"},
  "photos.dates": {method:"POST",path:"/v2/album/feed/timeline",params:"",app:"album"},
  "photos.growth": {method:"POST",path:"/v2/album/babygrowth/timeline",params:"album_id order isMilestone",app:"album"},
  "video.libraries": {
    method: "POST",
    path: "/zvideo/classification/list",
    params: "",
  },
  "video.list": {
    method: "POST",
    path: "/zvideo/video/v2/list",
    params:
      "classification_id start limit field sort system seen collection_type",
  },
  "video.info": {
    method: "POST",
    path: "/zvideo/collection/info",
    params: "collection_id classification_id",
  },
  "video.files": {
    method: "POST",
    path: "/zvideo/collection/video",
    params: "collection_id classification_id file_path",
  },
  "video.play": {
    method: "GET",
    path: "/transcode/play",
    params: "file_path",
  },
  "music.songs": {
    method: "POST",
    path: "/zmusic/api/v2/song/list",
    params:
      "page page_size filter_type filter_value sort_field order playlist_id",
    app: "music",
  },
  "music.albums": {
    method: "GET",
    path: "/zmusic/api/v2/album/list",
    params: "page page_size filter_type filter_value sort_field order",
    app: "music",
  },

  "music.playlists": {
    method: "GET",
    path: "/zmusic/api/v2/playlist/list",
    params: "page page_size filter_type filter_value sort_field order",
    app: "music",
  },
  // 歌词：实测 GET + song_id → { song_lyrics: "[00:29.078] When I see you with her\n…" }
  // （另一个 /file/info/lyrics 只有 POST 能用，且对纯音乐返回空串，别用错）
  "music.lyrics": {
    method: "GET",
    path: "/zmusic/api/v2/song/info/lyrics",
    params: "song_id id",
    app: "music",
  },
  "music.play": {
    method: "GET",
    path: "/transcode/audio/play",
    params: "path file_path dest_fmt",
    app: "music",
  },
  "downloads.list": {
    method: "POST",
    path: "/downloader/list",
    params: "type start size sortby order dir status",
  },
  // 下载任务批量操作：实测（2026-10-12）form 或 JSON 空体都能 200。
  // 单任务 start/stop/del 的**参数名未知**：id/gid/hash/ids 全试过都是 N202003 参数错误，
  // 且这台设备上 0 个任务、无法从数据反推，所以不做——宁可少一个按钮也不猜。
  "downloads.startAll": { method: "POST", path: "/downloader/start/all", params: "" },
  "downloads.stopAll": { method: "POST", path: "/downloader/stop/all", params: "" },
  "notes.list": { method: "POST", path: "/v2/file/notepad/list", params: "" },
  "recycle.list": { method: "POST", path: "/v2/file/nb/list", params: "" },

  // 实测：本机固件上 /system 返回 404，官方前端对应接口是 /system/home（同模块 shutdown/reboot 同级）。
  "system.overview": { method: "POST", path: "/system/home", params: "" },
  // 官方前端 ZP.monitor() 与 ZP.monitorDelay()：桌面资源挂件的真实取数接口
  "system.monitor": { method: "POST", path: "/system/recent", params: "" },
  "system.monitorDelay": { method: "POST", path: "/system/delay", params: "" },
  // 官方监控页把每个服务的 io.read_ps / io.write_ps 求和得到设备读写总量
  "system.services": { method: "POST", path: "/manager/services", params: "" },
  "system.processes": { method: "POST", path: "/manager/v2/processes", params: "" },
  "system.storage": { method: "POST", path: "/storagepool/info2", params: "" },
  "system.network": {
    method: "GET",
    path: "/network-settings/v1/interface/list",
    params: "",
  },
  "system.settings": { method: "POST", path: "/setting/load", params: "" },
  // 远程访问（zrps 服务）：实测 GET 才有数据，POST 返回空体。
  // /zrps/api/speed/query → { saddr, ip, isp, snode, finish, direction }
  "remote.speed": { method: "GET", path: "/zrps/api/speed/query", params: "" },
  "apps.list": { method: "POST", path: "/AppStore/v1/list", params: "" },
  "apps.native": { method: "POST", path: "/AppStore/v1/list", params: "" },
  "apps.disks": { method: "POST", path: "/AppStore/v1/disks", params: "" },
  // 官方商店的容器类应用（实测 16 项，is_docker=1）；原生应用在 apps.list（实测 58 项）
  "apps.docker": { method: "POST", path: "/zdocker/AppStore/v1/list", params: "" },
  // 任务中心：官方 /task/list（下载、同步、备份等任务共用一张列表，条目字段按 type 不同）
  "tasks.list": { method: "POST", path: "/task/list", params: "" },
};
const DEVICE_KEY = "space-desktop:nas-device-id";
let memoryDeviceId: string | undefined;
function identifier() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (v) => v.toString(16).padStart(2, "0")).join("");
}
function deviceIdentity() {
  try {
    const saved = localStorage.getItem(DEVICE_KEY);
    if (saved && /^[a-f0-9]{32}$/.test(saved)) return saved;
    const id = (memoryDeviceId ??= identifier());
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return (memoryDeviceId ??= identifier());
  }
}
function baseAddress(raw: string) {
  try {
    const u = new URL(raw);
    if (
      !["http:", "https:"].includes(u.protocol) ||
      !u.hostname ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      (u.pathname !== "/" && u.pathname !== "")
    )
      throw 0;
    return u.origin;
  } catch {
    throw fail(
      "INVALID_BASE_URL",
      "请输入不含账号、密码、路径或查询参数的 NAS 地址",
    );
  }
}
function record(v: unknown): RecordData | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as RecordData)
    : undefined;
}
function text(v: RecordData, ...keys: string[]) {
  for (const key of keys) {
    const x = v[key];
    if (typeof x === "string" || typeof x === "number") return String(x);
  }
  return "";
}
function number(v: unknown) {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" && v.trim() !== ""
        ? Number(v)
        : 0;
  return Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : 0;
}
function knownNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 && result <= Number.MAX_SAFE_INTEGER ? result : undefined;
}
function knownUpdate(value: unknown): string | undefined {
  const numeric = knownNumber(value);
  if (numeric !== undefined) return String(numeric);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}[ T]/.test(value) && Number.isFinite(Date.parse(value))) return value;
}
const directoryControls = /[\u0000-\u001f\u007f-\u009f]/;
function validDirectoryText(value: unknown, limit: number): value is string {
  if (typeof value !== "string" || value.length > limit || directoryControls.test(value)) return false;
  // TextEncoder replaces lone surrogates; reject them before measuring bytes.
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return new TextEncoder().encode(value).length <= limit;
}
function ordinaryDirectoryPath(value: unknown): value is string {
  return validDirectoryText(value, 8192) && value.startsWith("/") && !value.includes("\\") &&
    (value === "/" || value.slice(1).split("/").every((part) => part !== "" && part !== "." && part !== ".."));
}
function directoryInfo(data: unknown): RecordData | undefined {
  const root = record(data);
  return record(root?.info) ?? root;
}
function ordinaryDirectory(info: RecordData | undefined, path: string): info is RecordData {
  return !!info && ordinaryDirectoryPath(info.path) && info.path === path &&
    (info.is_dir === true || info.is_dir === 1 || info.is_dir === "1") && !info.encrypted_path;
}
function directoryTimestamp(value: unknown): number | undefined {
  if (typeof value === "string" && !/^\d+$/.test(value)) return;
  const result = knownNumber(value);
  return result !== undefined && result > 0 && Number.isInteger(result) ? result : undefined;
}
const imageExtension = /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?|avif)$/i;
type ImageItem = Pick<Item, "path" | "name" | "size" | "metadata"> & { kind?: string };
export function supportsImagePreview(item: ImageItem): boolean {
  const path = item.metadata?.encrypted_path || item.path;
  if (typeof path !== "string" || !path.trim() ||
    ["directory", "folder", "root", "storage", "album", "playlist", "library"].includes(item.kind || "") ||
    item.metadata?.is_dir === true || String(item.metadata?.is_dir ?? item.metadata?.di) === "1") return false;
  return imageExtension.test(path.startsWith("E.") || item.metadata?.encrypted_path ? item.name : path);
}
function previewSource(item: ImageItem, format: "small" | "large"): string | undefined {
  const encrypted = text(item.metadata || {}, "encrypted_path") || (item.path?.startsWith("E.") ? item.path : "");
  const path = encrypted || item.path;
  if (!path?.trim() || (!encrypted && (!path.startsWith("/") || path.startsWith("//"))) || /[\u0000-\u001f\u007f]/.test(path)) return;
  const query = new URLSearchParams(encrypted
    ? { encrypted_path: encrypted, from: text(item.metadata || {}, "from") || "pub_album" }
    : { file_path: path });
  const size = knownNumber(item.size);
  const update = knownUpdate(item.metadata?.up ?? item.metadata?.updated_at);
  if (size !== undefined) query.set("s", String(size));
  if (update !== undefined) query.set("up", String(update));
  query.set("dest_fmt", format);
  query.set("request_purpose", "5");
  return `${encrypted ? "/transcode/decrypt/thumb" : "/transcode/thumb"}?${query}`;
}
function storeCredentialEcho(value: string, token: string) {
  if (secretText(value, token)) return true;
  const encoded = btoa(Array.from(new TextEncoder().encode(token), byte => String.fromCharCode(byte)).join(""));
  return [encoded, encoded.replace(/=+$/, ""), encoded.replace(/\+/g, "-").replace(/\//g, "_"), encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")].some(candidate => secretText(value, candidate));
}
function secretText(raw: string, token: string) {
  if (!token) return false;
  let values = [raw];
  for (let round = 0; round < 4; round++) {
    const next: string[] = [];
    for (const value of values) {
      if (value.includes(token)) return true;
      for (const source of [value, value.replace(/\+/g, " ")]) {
        try {
          const decoded = decodeURIComponent(source);
          if (decoded !== value) next.push(decoded);
        } catch {
          /* Malformed encodings remain opaque. */
        }
      }
    }
    values = next;
  }
  return false;
}
function sensitive(key: string) {
  return (
    /token|password|passwd|secret|credential|privatekey|publickey|authorization|cookie|apikey|accesskey|sign/.test(
      key.toLowerCase().replace(/[_\-\s]/g, ""),
    ) || ["key", "pwd"].includes(key.toLowerCase())
  );
}
function clean(value: unknown, token: string): unknown {
  if (typeof value === "string") {
    if (secretText(value, token)) return "";
    try {
      if (value.startsWith("/") || /^https?:/i.test(value)) {
        const url = new URL(value, "http://placeholder.invalid");
        if (
          url.username ||
          url.password ||
          Array.from(url.searchParams.keys()).some(sensitive)
        )
          return "";
      }
    } catch {
      /* Preserve ordinary labels. */
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((x) => clean(x, token));
  const obj = record(value);
  if (obj) {
    return Object.fromEntries(
      Object.entries(obj)
        .filter(([k]) => !sensitive(k))
        .map(([k, v]) => [k, clean(v, token)]),
    );
  }
  return value;
}
function businessError(code: unknown) {
  switch (String(code)) {
    case "N001207":
    case "N001208":
    case "N001100":
    case "N001413":
    case "N001001":
    case "N001209":
    case "401":
    case "403":
      return fail("SESSION_EXPIRED", "NAS 登录已失效，请重新登录", 401);
    case "N001223":
      return fail("LOGIN_FAILED", "NAS 账号或密码验证失败", 403);
    case "N001205":
    case "N001206":
      return fail("NAS_BUSINESS_ERROR", `NAS 拒绝此请求（${String(code)}），请在官方页面查看账号状态或登录限制后重试`, 403);
    case "N001414":
      return fail("CHALLENGE_REQUIRED", "此设备需要短信验证（N001414），请重新登录并发送验证码", 403);
    default:
      // Only the fixed official code format is suitable for diagnostics. The
      // server message and arbitrary code text may contain account secrets.
      return fail(
        "NAS_BUSINESS_ERROR",
        /^[NS]\d{6}$/.test(String(code))
          ? `NAS 未能完成此请求（${String(code)}）`
          : "NAS 未能完成此请求",
        502,
      );
  }
}
export function decodeOfficialResponse(value: unknown): unknown {
  const data = record(value);
  if (!data) throw fail("INVALID_RESPONSE", "NAS 返回无法识别的数据", 502);
  if (data.success === false) throw businessError(data.code);
  const code = String(data.code);
  const ok =
    code === "200" ||
    code === "S000200" ||
    (data.code === undefined && data.error === 0) ||
    (data.code === undefined &&
      data.error === undefined &&
      data.success === true);
  if (!ok) {
    if (
      data.code === undefined &&
      data.error === undefined &&
      data.success === undefined
    )
      throw fail("INVALID_RESPONSE", "NAS 响应缺少成功状态", 502);
    throw businessError(data.code ?? data.error);
  }
  if ("data" in data) return data.data;
  const { code: _code, error: _error, success: _success, ...rest } = data;
  return rest;
}
const allowedMedia = (path: string) =>
  [
    "/transcode/thumb",
    "/transcode/decrypt/thumb",
    "/transcode/cover",
    "/v2/file/download",
    "/v2/file/decrypt/download",
    "/transcode/play",
    "/transcode/audio/stream",
  ].includes(path) ||
  [
    "/play/",
    // 音乐播放返回的是 /splay/<hash>（转码缓存目录由 nginx 直接从磁盘提供），
    // 之前不在白名单里，导致"song 有名字但没有播放地址"
    "/splay/",
    // 封面：影视 /zvideo_static/<id>/<id>_cover.jpg?t=…，音乐 /zmusic_static/<xx>/<hash>.jpg?u=…
    // （实测字段是 cover / song_cover；不在白名单时海报墙只剩占位图标）
    "/zvideo_static/",
    "/zmusic_static/",
    "/thumb/",
    "/zmusic/play/",
    "/zmusic/cover/",
    "/zvideo/play/",
  ].some((prefix) => path.startsWith(prefix));

// Parse only an attachment with one unambiguous filename. Quoted parameter
// separators and UTF-8 filename* are supported; unknown headers stay private.
function downloadFilename(header: string): string | undefined {
  if (header.length > 4096 || /[\u0000-\u001f\u007f]/.test(header)) return;
  const kind = /^attachment(?=\s*(?:;|$))/i.exec(header);
  if (!kind) return;
  let rest = header.slice(kind[0].length);
  const parameters = new Map<string, string>();
  while (rest.trim()) {
    const part = /^\s*;\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*("(?:[^"\\\r\n]|\\[^\r\n])*"|[^\s;"]+)\s*/.exec(rest);
    if (!part) return;
    const key = part[1].toLowerCase();
    if (parameters.has(key)) return;
    const value = part[2].startsWith('"') ? part[2].slice(1, -1).replace(/\\(.)/g, "$1") : part[2];
    parameters.set(key, value);
    rest = rest.slice(part[0].length);
  }
  let name = parameters.get("filename");
  if (parameters.has("filename*")) {
    const value = /^UTF-8'[^']*'(.*)$/i.exec(parameters.get("filename*")!);
    if (!value) return;
    try { name = decodeURIComponent(value[1]); } catch { return; }
  }
  return name && name.length <= 255 && ![".", ".."].includes(name) && !/[/\\\u0000-\u001f\u007f]/.test(name) ? name : undefined;
}

export type StoreNasBinding = { providerId: string; storeBase: string; storeId: string };
export type StoreNasSession = { sessionId: string; username: string; expiresAt: string; authSource: "nas" };
type StoreExchangeContext = StoreNasBinding & { assertCurrent: () => void; accept: (session: StoreNasSession) => void };
export type OfficialNasOptions = {
  onSessionChanged?: () => void;
  storeSessionContext?: () => Promise<StoreExchangeContext>;
  transport?: "browser" | "native";
  onNativeSessionExpired?: (sessionId: string) => void;
};
function nativeRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
// The plugin calls the selected official NAS over native HTTP. It does not
// introduce a REST service. Explicit maxRedirections is required by the plugin.
async function nativeOfficialFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const { fetch: nativeFetch } = await import("@tauri-apps/plugin-http");
  if (init?.signal?.aborted) throw fail("REQUEST_CANCELLED", "NAS 请求已中断", 409);
  return nativeFetch(input, {
    ...init,
    maxRedirections: 0,
    connectTimeout: 15_000,
  });
}
// Same value converter as the official bundled js-cookie module 36808.
// Header values remain ASCII; semicolons/newlines stay percent-encoded.
function officialCookieValue(value: string) {
  return encodeURIComponent(value).replace(
    /%(23|24|26|2B|3A|3C|3E|3D|2F|3F|40|5B|5D|5E|60|7B|7D|7C)/g,
    decodeURIComponent,
  );
}

// Official module 44809 maps successful container/codec probes to NAS names.
// An unavailable media API advertises no support; capabilities are never cached.
function playbackCodecs(): Record<string, string> {
  const video = typeof document === "undefined"
    ? undefined
    : document.createElement("video");
  const videos = new Set<string>(), audio = new Set<string>();
  const supports = (type: string) => {
    try {
      return !!video?.canPlayType?.(type);
    } catch {
      return false;
    }
  };
  const add = (type: string, codec: string, audioCodecs: string[] = []) => {
    if (!supports(type)) return;
    videos.add(codec);
    audioCodecs.forEach((name) => audio.add(name));
  };
  add('video/mp4; codecs="mp4v.20.8"', "mpeg4", ["aac"]);
  add('video/mp4; codecs="avc1.42E01E"', "h264", ["aac", "mp4a"]);
  add('video/mp4; codecs="hevc"', "hevc", ["aac", "mp4a"]);
  add('video/ogg; codecs="theora"', "theora", ["vorbis"]);
  add('video/webm; codecs="vp8"', "vp8", ["vorbis"]);
  add('video/webm; codecs="vp9"', "vp9", ["vorbis"]);
  if (
    supports('video/mp4; codecs="hev1.1.6.L93.B0"') ||
    supports('video/mp4; codecs="hvc1.1.6.L93.B0"')
  ) videos.add("hevc");
  return {
    video_codec: [...videos].join(","),
    audio_codec: [...audio].join(","),
  };
}

export class OfficialNas {
  #active: Active | null = null;
  #generation = 0;
  #loginVerification?: LoginVerificationState;
  #storeGrant?: { base: string; sessionId: string };
  #uploadSources = new Map<string, { active: Active; controller: AbortController; adapter?: UploadSourceAdapter; file?: File; nativeId?: string; descriptor?: UploadSourceDescriptor }>();
  #uploadTasks = new Map<string, { active: Active; sourceId: string; engine: RetainedUploadTask; snapshot: () => UploadSnapshot; lock: string; lockOwner: object; source: object; created: DirectoryCreation }>();
  #uploadTargetLocks = new Map<string, object>();
  #uploadPreparations = new Set<AbortController>();
  #downloads = new Map<string, { source?: string; active: Active; descriptor: FileDownload }>();
  #downloadRequests = new Set<AbortController>();
  #directoryRequests = new Set<AbortController>();
  #directoryLocks = new Map<string, AbortController>();
  #registeredNativeURIs = new Set<string>();
  #ownedProxyURIs = new Set<string>();
  #devProxyTarget: string | undefined;
  #deviceId = deviceIdentity();
  #fetcher: typeof fetch;
  #transport: "browser" | "native";
  #nativeExpiryListener?: Promise<void>;
  #onNativeSessionExpired?: (sessionId: string) => void;
  #onSessionChanged?: () => void;
  #storeSessionContext?: () => Promise<StoreExchangeContext>;
  constructor(fetcher?: typeof fetch, options: OfficialNasOptions = {}) {
    this.#onNativeSessionExpired = options.onNativeSessionExpired;
    this.#onSessionChanged = options.onSessionChanged;
    this.#storeSessionContext = options.storeSessionContext;
    this.#transport =
      options.transport ?? (!fetcher && nativeRuntime() ? "native" : "browser");
    if (
      import.meta.env.DEV &&
      typeof import.meta.env.VITE_NAS_DEV_TARGET === "string"
    ) {
      try {
        this.#devProxyTarget = baseAddress(import.meta.env.VITE_NAS_DEV_TARGET);
      } catch {
        this.#devProxyTarget = undefined;
      }
    }
    this.#fetcher =
      fetcher ??
      (this.#transport === "native"
        ? nativeOfficialFetch
        : (...args) => fetch(...args));
  }
  #proxyURL(source: URL, base: string): string {
    if (
      this.#transport !== "browser" ||
      this.#devProxyTarget !== base ||
      source.origin !== base ||
      !/^https?:$/.test(location.protocol)
    )
      return source.href;
    return new URL("/__nas" + source.pathname + source.search, location.origin)
      .href;
  }
  #headers(active?: Active | null, extra: Record<string, string> = {}) {
    const headers = new Headers(extra);
    if (this.#transport === "native") {
      /*
       * 原生端必须自己拼 Cookie 头（浏览器的 document.cookie 在这里不适用）。
       *
       * 这里原本只发 `device_id` + `zenithtoken`，而网页版登录后会写五个
       * cookie：token / device_id / device / version / plat —— 转码服务
       * （/transcode/*）正是额外校验 device/version/plat 的那一组，
       * 少一个就返回 `T000001 参数错误`（浏览器端就是这么查出来的）。
       *
       * 不补齐的话，同一份影片在浏览器里能播、在 Mac 客户端里播不了，
       * 而这属于"只有客户端坏"的一类问题 —— 前面白名单那次已经吃过一次亏。
       * zenithtoken 是官方客户端的名字，一并保留，两个名字都发不影响。
       */
      const common = this.#common();
      const token = active ? officialCookieValue(active.token) : "";
      const pairs: Array<[string, string]> = [
        ["token", token],
        ["device_id", this.#deviceId],
        ["device", "SpaceDesktop"],
        ["version", common.version],
        ["plat", "web"],
        ["zenithtoken", token],
      ];
      headers.set(
        "Cookie",
        pairs.filter(([, value]) => value).map(([name, value]) => `${name}=${value}`).join("; "),
      );
    }
    return headers;
  }
  get sessionGeneration() { return this.#generation; }
  get sessionId() {
    return this.#active?.public.sessionId ?? "";
  }
  session(): NasSession | null {
    return this.#active ? structuredClone(this.#active.public) : null;
  }
  logout(): void {
    this.#generation++;
    this.#clearLoginVerification();
    const active = this.#active;
    if (active) clearSessionCookie(cookieFacts(active.public.baseUrl, this.#transport === "native"));
    this.#active = null;
    this.#releaseUploadSources();
    this.#onSessionChanged?.();
    this.#downloads.clear();
    for (const controller of this.#downloadRequests) controller.abort();
    this.#downloadRequests.clear();
    this.#abortDirectories();
    this.#registeredNativeURIs.clear();
    this.#ownedProxyURIs.clear();
    if (active) this.#clearNativeMedia(active.public.sessionId);
  }
  #releaseUploadSources() {
    for (const controller of this.#uploadPreparations) controller.abort();
    this.#uploadPreparations.clear();
    for (const task of this.#uploadTasks.values()) task.engine.cancel();
    this.#uploadTasks.clear();
    this.#uploadTargetLocks.clear();
    const sources = [...this.#uploadSources.values()];
    this.#uploadSources.clear();
    for (const source of sources) {
      source.controller.abort();
      if (source.adapter) void source.adapter.release().catch(() => {});
    }
  }
  #reserveUploadSource() {
    const active = this.#active;
    if (!active) throw fail("NO_SESSION", "请先连接 NAS", 401);
    if (active.generation !== this.#generation) throw fail("REQUEST_CANCELLED", "NAS 会话已改变，请重新选择文件", 409);
    if (this.#uploadSources.size >= 64) throw fail("UPLOAD_SOURCE_LIMIT", "选定文件过多，请先释放其他文件", 409);
    const sourceId = identifier();
    const record = { active, controller: new AbortController() } as { active: Active; controller: AbortController; adapter?: UploadSourceAdapter; file?: File; nativeId?: string; descriptor?: UploadSourceDescriptor };
    this.#uploadSources.set(sourceId, record);
    const current = () => this.#active === active && this.#generation === active.generation && this.#uploadSources.get(sourceId) === record && !record.controller.signal.aborted;
    const assert = () => { if (!current()) throw fail("REQUEST_CANCELLED", "NAS 会话已改变，请重新选择文件", 409); };
    return { active, sourceId, record, current, assert };
  }
  async selectBrowserUploadSource(file: File): Promise<UploadSourceDescriptor> {
    const source = this.#reserveUploadSource();
    try {
      source.assert();
      const adapter = createBrowserUploadSource(file, source.current);
      if (secretText(file.name, source.active.token)) throw 0;
      source.assert();
      const descriptor = { sourceId: source.sourceId, name: file.name, size: adapter.size, lastModified: adapter.lastModified, sessionId: source.active.public.sessionId };
      Object.assign(source.record, { adapter, file, descriptor });
      return { ...descriptor };
    } catch (error) {
      if (this.#uploadSources.get(source.sourceId) === source.record) this.#uploadSources.delete(source.sourceId);
      source.record.controller.abort();
      if (error instanceof OfficialNasError) throw error;
      throw fail("INVALID_UPLOAD_SOURCE", "请选择有效的普通文件");
    }
  }
  async #releasePickedUpload(value: unknown, sessionId: string) {
    const raw = record(value);
    if (!raw || typeof raw.id !== "string" || !/^[a-f0-9]{64}$/.test(raw.id) || raw.sessionId !== sessionId) return;
    try { const { invoke } = await import("@tauri-apps/api/core"); await invoke("nas_upload_release", { id: raw.id, sessionId }); } catch { /* Only captured old-source cleanup. */ }
  }
  #awaitUploadPreparation<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      let ended = false;
      const cancel = () => {
        if (ended) return;
        ended = true; signal.removeEventListener("abort", cancel);
        reject(fail("REQUEST_CANCELLED", "NAS 会话已改变，请重新选择文件", 409));
      };
      signal.addEventListener("abort", cancel, { once: true });
      // Shared expiry infrastructure is never torn down by one picker. Its
      // eventual success/failure is handled even after this owner has left.
      Promise.resolve(pending).then(value => {
        if (ended) return;
        if (signal.aborted) { cancel(); return; }
        ended = true; signal.removeEventListener("abort", cancel); resolve(value);
      }, error => {
        if (ended) return;
        if (signal.aborted) { cancel(); return; }
        ended = true; signal.removeEventListener("abort", cancel); reject(error);
      });
      if (signal.aborted) cancel();
    });
  }
  async pickUploadSource(): Promise<UploadSourceDescriptor | null> {
    if (this.#transport !== "native") throw fail("UPLOAD_PICKER_UNAVAILABLE", "请使用浏览器文件选择器", 501);
    const source = this.#reserveUploadSource();
    let selected: unknown;
    try {
      source.assert();
      await this.#awaitUploadPreparation(this.#listenNativeMediaExpiry(), source.record.controller.signal); source.assert();
      const { invoke } = await this.#awaitUploadPreparation(import("@tauri-apps/api/core"), source.record.controller.signal); source.assert();
      const pending = invoke<unknown>("nas_upload_pick", { base: source.active.public.baseUrl, cookie: this.#headers(source.active).get("Cookie"), sessionId: source.active.public.sessionId });
      // Handle late picker output with its original owner, even after the caller has left.
      selected = await new Promise<unknown>((resolve, reject) => {
        let ended = false;
        const cancel = () => { if (ended) return; ended = true; reject(fail("REQUEST_CANCELLED", "NAS 会话已改变，请重新选择文件", 409)); };
        const signal = source.record.controller.signal;
        signal.addEventListener("abort", cancel, { once: true });
        Promise.resolve(pending).then(value => {
          signal.removeEventListener("abort", cancel);
          if (ended || !source.current()) { void this.#releasePickedUpload(value, source.active.public.sessionId); cancel(); return; }
          ended = true; resolve(value);
        }, () => { signal.removeEventListener("abort", cancel); if (!ended) { ended = true; reject(fail("UPLOAD_PICK_FAILED", "无法选择本机文件", 502)); } });
        if (signal.aborted) cancel();
      });
      source.assert();
      if (selected === null) return null;
      const native = validateNativeUploadSource(selected, source.active.public.sessionId);
      if (secretText(native.name, source.active.token)) throw 0;
      const adapter = createNativeUploadSource(native, source.current);
      source.assert();
      const descriptor = { sourceId: source.sourceId, name: native.name, size: adapter.size, lastModified: adapter.lastModified, sessionId: native.sessionId };
      Object.assign(source.record, { adapter, nativeId: native.id, descriptor });
      return { ...descriptor };
    } catch (error) {
      void this.#releasePickedUpload(selected, source.active.public.sessionId).catch(() => {});
      if (!source.current()) throw fail("REQUEST_CANCELLED", "NAS 会话已改变，请重新选择文件", 409);
      if (error instanceof OfficialNasError) throw error;
      throw fail("INVALID_UPLOAD_SOURCE", "请选择有效的普通文件");
    } finally {
      if (!source.record.adapter && this.#uploadSources.get(source.sourceId) === source.record) {
        this.#uploadSources.delete(source.sourceId); source.record.controller.abort();
      }
    }
  }
  /** The current production classifier deliberately has no absent mapping yet. */
  async #uploadAvailability(active: Active, path: string, context: DirectoryContext): Promise<"exists" | "absent" | "unknown"> {
    try {
      const data = record(await this.#awaitUploadPreparation(this.#request(active.public.baseUrl, operations["files.info"], { path }, active, context), context.signal));
      context.assertCurrent();
      const info = directoryInfo(data);
      return info && info.path === path && typeof info.name === "string" && typeof info.is_dir === "boolean" ? "exists" : "unknown";
    } catch (error) {
      context.assertCurrent();
      if (error instanceof OfficialNasError && (error.status === 401 || error.code === "REQUEST_CANCELLED")) throw error;
      // N001320, HTTP404, permission/business failure and empty payload are not absence evidence.
      return "unknown";
    }
  }
  async prepareUpload(sourceId: string, destination: UploadDestination, options: { signal?: AbortSignal } = {}): Promise<UploadSnapshot> {
    const active = this.#active;
    if (!active) throw new OfficialUploadError("NO_SESSION", false, 401);
    const source = this.#uploadSources.get(sourceId);
    if (!source || source.active !== active || !source.adapter || !source.descriptor || source.controller.signal.aborted)
      throw new OfficialUploadError("INVALID_UPLOAD_SOURCE");
    const parent = destination?.parent, name = destination?.name ?? source.descriptor.name, directory = destination?.newDirectory;
    const path = parent?.path;
    const safeName = (value: unknown): value is string => typeof value === "string" && validDirectoryText(value, 255) && !!value.trim() && value !== "." && value !== ".." && !/[/\\]/.test(value) && !secretText(value, active.token);
    if (!ordinaryDirectoryPath(path) || !["directory", "folder", "root"].includes(parent?.kind ?? "") || parent.metadata?.encrypted_path || secretText(path, active.token) || !safeName(directory) || !safeName(name))
      throw new OfficialUploadError("INVALID_UPLOAD_DESTINATION");
    const actualParent = `${path === "/" ? "" : path}/${directory}`, target = `${actualParent}/${name}`;
    try { validateUploadHashInput(source.adapter.size, source.adapter.lastModified, target); } catch { throw new OfficialUploadError("INVALID_UPLOAD_DESTINATION"); }
    const controller = new AbortController(), lock = JSON.stringify([active.public.sessionId, target]), owner = {};
    const abort = () => controller.abort();
    source.controller.signal.addEventListener("abort", abort, { once: true }); options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const assertCurrent = () => { if (this.#active !== active || this.#generation !== active.generation || this.#uploadSources.get(sourceId) !== source || source.controller.signal.aborted || controller.signal.aborted) throw new OfficialUploadError("REQUEST_CANCELLED"); };
    const context = { signal: controller.signal, assertCurrent };
    let retained = false;
    try {
      assertCurrent();
      if (this.#uploadTasks.size + this.#uploadPreparations.size >= 64) throw new OfficialUploadError("UPLOAD_TASK_LIMIT");
      if (this.#uploadTargetLocks.has(lock)) throw new OfficialUploadError("UPLOAD_TARGET_BUSY");
      this.#uploadTargetLocks.set(lock, owner); this.#uploadPreparations.add(controller);
      const verifyParent = async (parentPath: string, ctx: DirectoryContext) => {
        const info = directoryInfo(await this.#awaitUploadPreparation(this.#request(active.public.baseUrl, operations["files.info"], { path: parentPath }, active, ctx), ctx.signal));
        ctx.assertCurrent(); if (!ordinaryDirectory(info, parentPath)) throw new OfficialUploadError("INVALID_UPLOAD_PARENT");
      };
      await verifyParent(path, context);
      const availability = await this.#uploadAvailability(active, actualParent, context);
      if (availability !== "absent") throw new OfficialUploadError(availability === "exists" ? "UPLOAD_TARGET_EXISTS" : "UPLOAD_TARGET_UNKNOWN");
      // Only this SDK operation's actual creation/readback may become a private readiness record.
      const created = await this.#awaitUploadPreparation(this.createDirectory(parent, directory, { signal: controller.signal }), controller.signal);
      assertCurrent();
      const listing = completeUploadListing(await this.#awaitUploadPreparation(this.#request(active.public.baseUrl, operations["files.list"], { path: actualParent, start: "0", num: "200", sortby: "name", order: "asc", show_hidden: "1" }, active, context), controller.signal));
      assertCurrent(); if (!listing || listing.length !== 0 || created.item.path !== actualParent) throw new OfficialUploadError("UPLOAD_DIRECTORY_UNVERIFIED");
      await verifyParent(actualParent, context);
      const taskId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
      const taskCurrent = () => { if (this.#active !== active || this.#generation !== active.generation || this.#uploadSources.get(sourceId) !== source || source.controller.signal.aborted || this.#uploadTasks.get(taskId)?.source !== source) throw new OfficialUploadError("REQUEST_CANCELLED"); };
      const engine = createUploadTask(source.adapter, target, {
        assertCurrent: taskCurrent,
        verifyParent: signal => verifyParent(actualParent, { signal, assertCurrent: taskCurrent }),
        verifyTarget: async signal => {
          const ctx = { signal, assertCurrent: taskCurrent };
          const state = await this.#uploadAvailability(active, target, ctx);
          if (state !== "absent") throw new OfficialUploadError(state === "exists" ? "UPLOAD_TARGET_EXISTS" : "UPLOAD_TARGET_UNKNOWN");
          const partial = record(await this.#uploadRequest("tmpinfo", active, target, computeUploadUUID(source.adapter!.size, source.adapter!.lastModified, target), signal, taskCurrent));
          taskCurrent();
          // Successful tmpinfo size is old partial evidence. No documented missing reply means no initial dispatch.
          throw new OfficialUploadError(strictUploadSize(partial?.size) !== undefined ? "UPLOAD_PARTIAL_EXISTS" : "UPLOAD_PARTIAL_UNKNOWN");
        },
        queryPartial: (hashes, signal) => this.#uploadRequest("tmpinfo", active, target, hashes.uuid, signal, taskCurrent),
        sendChunk: async (piece, signal) => { await this.#uploadRequest("upload", active, target, piece.hashes.uuid, signal, taskCurrent, piece, source.adapter!.lastModified); },
        readFinalInfo: async signal => directoryInfo(await this.#awaitUploadPreparation(this.#request(active.public.baseUrl, operations["files.info"], { path: target }, active, { signal, assertCurrent: taskCurrent }), signal)),
      });
      const snapshot = () => ({ ...engine.snapshot(), taskId, sourceId, sessionId: active.public.sessionId, name });
      this.#uploadTasks.set(taskId, { active, sourceId, engine, snapshot, lock, lockOwner: owner, source, created });
      retained = true; return snapshot();
    } catch (error) {
      if (!this.#active && this.#generation === active.generation) throw new OfficialUploadError("SESSION_EXPIRED", false, 401);
      if (error instanceof OfficialUploadError) throw error;
      if (error instanceof OfficialNasError) throw new OfficialUploadError(error.code, false, error.status);
      throw new OfficialUploadError("UPLOAD_PREPARATION_FAILED", false, 502);
    } finally {
      source.controller.signal.removeEventListener("abort", abort); options.signal?.removeEventListener("abort", abort);
      this.#uploadPreparations.delete(controller);
      if (!retained && this.#uploadTargetLocks.get(lock) === owner) this.#uploadTargetLocks.delete(lock);
    }
  }
  async #uploadRequest(kind: "upload" | "tmpinfo", active: Active, path: string, uuid: string, signal: AbortSignal, current: () => void, piece?: UploadPiece, lastModified?: number): Promise<unknown> {
    current();
    const url = new URL(kind === "upload" ? "/v2/file/upload" : "/v2/file/tmpinfo", active.public.baseUrl);
    const common = this.#common(active);
    const auth = { app: "file", token: encodeURIComponent(active.token), plat: "web", nasid: active.nasId, version: common.version, device_id: this.#deviceId, device: encodeURIComponent(common.device) };
    if (url.origin !== active.public.baseUrl || !/^[a-f0-9]{40}$/.test(uuid)) throw new OfficialUploadError("INVALID_UPLOAD_REQUEST");
    const upload = kind === "upload";
    if (upload && (!piece || piece.hashes.uuid !== uuid || lastModified === undefined)) throw new OfficialUploadError("INVALID_UPLOAD_REQUEST");
    url.search = new URLSearchParams(upload ? { remote_port: "8050" } : { path, uuid }).toString();
    const headers = this.#headers(active, { ...auth, ...(upload ? uploadPieceHeaders(path, lastModified!, piece!.hashes, piece!.seek, piece!.bytes.byteLength) : {}) });
    // 16KiB is an explicit outbound request budget, independent of Node's response-parser limit.
    if (Array.from(headers).reduce((sum, [key, value]) => sum + key.length + value.length + 4, 256) > 16 << 10) throw new OfficialUploadError("UPLOAD_HEADER_LIMIT");
    const controller = new AbortController(), abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    const assertCurrent = () => { current(); if (controller.signal.aborted) throw new OfficialUploadError("REQUEST_CANCELLED"); };
    const timer = setTimeout(abort, 30000);
    let response: Response | undefined, completed = false;
    try {
      assertCurrent();
      const wire = this.#proxyURL(url, active.public.baseUrl);
      const pending = this.#fetcher(wire, { method: upload ? "POST" : "GET", headers, credentials: credentialsFor(active?.public.baseUrl ?? "", this.#transport === "native"), redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal, ...(upload ? { body: piece!.bytes as unknown as BodyInit } : {}) });
      void pending.then(reply => {
        if (!controller.signal.aborted) return;
        try { if (reply.body && !reply.body.locked) void reply.body.cancel().catch(() => {}); } catch { /* A late response cannot retain transport authority. */ }
      }).catch(() => {});
      response = await this.#awaitUploadPreparation(pending, controller.signal);
      assertCurrent();
      if (response.redirected || (response.url && new URL(response.url).origin !== new URL(wire).origin)) throw new OfficialUploadError("NAS_REDIRECT_BLOCKED", true, 502);
      if (response.status === 401 || response.status === 403) throw fail("SESSION_EXPIRED", "NAS 登录已失效，请重新登录", 401);
      if (!response.ok) throw new OfficialUploadError("NAS_HTTP_ERROR", upload, 502);
      const body = await this.#awaitUploadPreparation(this.#directoryBody(response, controller.signal, assertCurrent, () => { completed = true; }), controller.signal);
      assertCurrent();
      if (record(body)?.code === "N001301") throw new OfficialUploadError("UPLOAD_TARGET_EXISTS", upload);
      const data = decodeOfficialResponse(body); if (upload) verifyUploadReplyTarget(data, path); assertCurrent(); return data;
    } catch (error) {
      if (error instanceof OfficialNasError && error.code === "SESSION_EXPIRED") { if (this.#active === active && this.#generation === active.generation) this.#expire(active); throw error; }
      if (error instanceof OfficialUploadError || error instanceof OfficialNasError) throw error;
      throw new OfficialUploadError("UPLOAD_TRANSPORT_FAILED", upload, 502);
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (!completed) { controller.abort(); try { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); } catch { /* Safe disposal only. */ } }
    }
  }
  async #runUpload(taskId: string, resume: boolean, callbacks: UploadCallbacks): Promise<UploadSnapshot> {
    const task = this.#uploadTasks.get(taskId); if (!task) throw new OfficialUploadError("UPLOAD_TASK_MISSING");
    try {
      const ownedCallbacks: UploadEngineCallbacks = { ...callbacks, onProgress: () => callbacks.onProgress?.(task.snapshot()) };
      await (resume ? task.engine.resume(ownedCallbacks) : task.engine.run(ownedCallbacks));
      return task.snapshot();
    } finally {
      if (task.engine.snapshot().phase === "completed" && this.#uploadTasks.get(taskId) === task) {
        this.#uploadTasks.delete(taskId); if (this.#uploadTargetLocks.get(task.lock) === task.lockOwner) this.#uploadTargetLocks.delete(task.lock);
        void this.releaseUploadSource(task.sourceId).catch(() => {});
      }
    }
  }
  runUpload(taskId: string, callbacks: UploadCallbacks = {}): Promise<UploadSnapshot> { return this.#runUpload(taskId, false, callbacks); }
  resumeUpload(taskId: string, callbacks: UploadCallbacks = {}): Promise<UploadSnapshot> { return this.#runUpload(taskId, true, callbacks); }
  async pauseUpload(taskId: string): Promise<UploadSnapshot> { const task = this.#uploadTasks.get(taskId); if (!task) throw new OfficialUploadError("UPLOAD_TASK_MISSING"); task.engine.pause(); return task.snapshot(); }
  async cancelUpload(taskId: string): Promise<void> {
    const task = this.#uploadTasks.get(taskId); if (!task) return;
    task.engine.cancel();
    if (this.#uploadTasks.get(taskId) === task) { this.#uploadTasks.delete(taskId); if (this.#uploadTargetLocks.get(task.lock) === task.lockOwner) this.#uploadTargetLocks.delete(task.lock); }
    void this.releaseUploadSource(task.sourceId).catch(() => {});
  }
  async releaseUploadSource(sourceId: string): Promise<void> {
    const source = this.#uploadSources.get(sourceId);
    if (!source) return;
    for (const [taskId, task] of this.#uploadTasks) {
      if (task.source !== source) continue;
      task.engine.cancel(); this.#uploadTasks.delete(taskId);
      if (this.#uploadTargetLocks.get(task.lock) === task.lockOwner) this.#uploadTargetLocks.delete(task.lock);
    }
    this.#uploadSources.delete(sourceId); source.controller.abort();
    try { await source.adapter?.release(); } catch { throw fail("UPLOAD_SOURCE_RELEASE_FAILED", "无法释放选定文件", 502); }
  }
  #abortDirectories() {
    for (const controller of this.#directoryRequests) controller.abort();
    this.#directoryRequests.clear();
    this.#directoryLocks.clear();
  }
  #clearNativeMedia(sessionId: string): Promise<void> {
    if (this.#transport !== "native") return Promise.resolve();
    // Native tombstones reject late registrations for this exact old session.
    return import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("nas_media_clear", { sessionId }))
      .then(() => undefined)
      .catch(() => {});
  }
  #expire(active: Active) {
    if (this.#active !== active) return;
    this.#active = null;
    this.#releaseUploadSources();
    this.#onSessionChanged?.();
    this.#downloads.clear();
    for (const controller of this.#downloadRequests) controller.abort();
    this.#downloadRequests.clear();
    this.#abortDirectories();
    this.#registeredNativeURIs.clear();
    this.#ownedProxyURIs.clear();
    this.#clearNativeMedia(active.public.sessionId);
  }
  #common(active?: Active | null) {
    return {
      plat: "web",
      version: "2.3.2026092801",
      device_id: this.#deviceId,
      device: "SpaceDesktop",
      _l: "zh-CN",
      webagent: "v2",
      rnd: String(Date.now()),
      token: active?.token ?? "",
      nasid: active?.nasId ?? "",
    };
  }
  async prepareNativeApp(appName: string): Promise<NativeAppPlan> {
    const active = this.#active;
    if (!active) throw fail("NO_SESSION", "请先登录 NAS", 401);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(appName)) throw fail("INVALID_PARAMS", "应用标识无效");
    const list = record(await this.#request(active.public.baseUrl, operations["apps.native"], {}, active));
    const app = (Array.isArray(list?.list) ? list.list : []).map(record).find(a => a?.app_name === appName);
    const version = Number(record(record(app?.latest_version)?.version)?.version_int);
    if (!app || Number(app.installed) === 1 || !Number.isSafeInteger(version) || version <= 0 || Number(app.is_docker) === 1) throw fail("APP_PLAN_INVALID", "当前应用无法进行原生安装，请刷新应用列表", 409);
    const dependencies = record(await this.#request(active.public.baseUrl, { method: "POST", path: "/AppStore/v1/pkg/depend/check", params: "" }, { app_name: appName, version_int: String(version), isDocker: "0" }, active));
    if (!dependencies || dependencies.sys_ver || dependencies.app_ver || (Array.isArray(dependencies.apps) && dependencies.apps.length)) throw fail("APP_DEPENDENCY_REQUIRED", "该应用需要先更新系统、客户端或安装依赖，请在官方应用商店检查依赖", 409);
    const disks = record(await this.#request(active.public.baseUrl, operations["apps.disks"], {}, active));
    if (this.#active !== active) throw fail("REQUEST_CANCELLED", "NAS 会话已改变", 409);
    return { appName, version, disks: (Array.isArray(disks?.list) ? disks.list : []).map(record).filter((d): d is RecordData => !!d && typeof d.mp === "string" && /^\/data_[a-zA-Z0-9]+$/.test(d.mp)).map(d => ({ mp: String(d.mp), name: String(d.name || d.mp), free: Number(d.free) })) };
  }
  async installNativeApp(input: { appName: string; version: number; mp: string }): Promise<{ installed: boolean; status: string }> {
    const active = this.#active;
    if (!active) throw fail("NO_SESSION", "请先登录 NAS", 401);
    const plan = await this.prepareNativeApp(input.appName);
    if (this.#active !== active || plan.version !== input.version || !plan.disks.some(d => d.mp === input.mp && d.free > 0)) throw fail("APP_PLAN_STALE", "版本或安装磁盘已变化，请重新检查安装计划", 409);
    await this.#request(active.public.baseUrl, { method: "POST", path: "/AppStore/v1/pkg/install", params: "" }, { app_name: input.appName, version_int: String(plan.version), mp: input.mp, isDocker: "0" }, active);
    const result = record(await this.#request(active.public.baseUrl, operations["apps.native"], {}, active));
    if (this.#active !== active) throw fail("REQUEST_CANCELLED", "NAS 会话已改变", 409);
    const app = (Array.isArray(result?.list) ? result.list : []).map(record).find(a => a?.app_name === input.appName);
    return { installed: Number(app?.installed) === 1, status: String(app?.status || "pending") };
  }
  async prepareDockerApp(appName: string): Promise<OfficialDockerAppPlan> {
    const active = this.#active;
    if (!active) throw fail("NO_SESSION", "请先登录 NAS", 401);
    if (!supportsOfficialDockerInstall(appName)) throw fail("APP_DOCKER_TEMPLATE_UNSUPPORTED", "此厂商应用的初始化模板尚未核对，请在官方应用商店安装", 501);
    const catalogue = record(await this.#request(active.public.baseUrl, operations["apps.docker"], {}, active));
    this.#assertToolSession(active);
    const app = (Array.isArray(catalogue?.list) ? catalogue.list : []).map(record).find(row => row?.app_name === appName);
    const version = Number(record(record(app?.latest_version)?.version)?.version_int);
    if (!app || Number(app.installed) === 1 || Number(app.is_docker) !== 1 || !Number.isSafeInteger(version) || version <= 0) throw fail("APP_PLAN_INVALID", "当前应用无法安装，请刷新官方应用列表", 409);
    const native = record(await this.#request(active.public.baseUrl, operations["apps.native"], {}, active));
    this.#assertToolSession(active);
    const engine = [...(Array.isArray(native?.list) ? native.list : []), ...(Array.isArray(catalogue?.list) ? catalogue.list : [])].map(record).find(row => row?.app_name === "docker");
    if (!engine || Number(engine.installed) !== 1 || engine.status !== "running") throw fail("APP_DOCKER_NOT_RUNNING", "请先在官方应用商店启动 Docker，再安装此应用", 409);
    const dependencies = record(await this.#request(active.public.baseUrl, { method: "POST", path: "/zdocker/AppStore/v1/pkg/depend/check", params: "" }, { app_name: appName, version_int: String(version), isDocker: "1" }, active));
    this.#assertToolSession(active);
    if (!dependencies || dependencies.sys_ver || dependencies.app_ver || (dependencies.apps !== undefined && (!Array.isArray(dependencies.apps) || dependencies.apps.length))) throw fail("APP_DEPENDENCY_REQUIRED", "此应用需要先更新系统、客户端或安装依赖，请在官方应用商店检查", 409);
    const files = await this.read("files.roots");
    this.#assertToolSession(active);
    const roots = files.items.filter((item): item is Item & { path: string } => typeof item.path === "string" && ordinaryDirectoryPath(item.path)).map(item => ({ id: item.id, name: item.name, path: item.path }));
    if (!roots.length) throw fail("APP_DISKS_UNAVAILABLE", "设备没有可用的数据磁盘", 409);
    const template = dockerAppTemplates[appName];
    return { appName, version, roots, portMin: 50000, portMax: 65535, fields: structuredClone(template.fields || []), autoStartDefault: template.autoStart, requiresRiskConfirmation: !!template.risk, primaryLabel: template.primaryLabel || "应用数据" };
  }
  async installDockerApp(input: { appName: string; version: number; dataPath: string; port: number; autoStart: boolean; settings?: Record<string, string>; riskAccepted?: boolean }): Promise<{ installed: boolean; status: string }> {
    const active = this.#active;
    if (!active) throw fail("NO_SESSION", "请先登录 NAS", 401);
    if (!ordinaryDirectoryPath(input.dataPath) || !Number.isInteger(input.port) || input.port < 50000 || input.port > 65535 || typeof input.autoStart !== "boolean") throw fail("INVALID_PARAMS", "请选择应用专用目录和 50000–65535 之间的有效端口");
    const plan = await this.prepareDockerApp(input.appName);
    this.#assertToolSession(active);
    const template = dockerAppTemplates[input.appName];
    const fields = template.fields || [], settings = input.settings || {};
    if (typeof settings !== "object" || Array.isArray(settings) || Object.keys(settings).some(key => !fields.some(field => field.key === key)) || (template.risk && input.riskAccepted !== true)) throw fail("INVALID_PARAMS", "请填写厂商配置并确认安装说明");
    const extra: Record<string, string> = {};
    for (const field of fields) {
      const value = settings[field.key] ?? field.defaultValue ?? "";
      if (!dockerFieldValid(field, value)) throw fail("INVALID_PARAMS", `请检查${field.label}的格式与范围`);
      extra[field.key] = value;
    }
    const ports = [input.port, ...fields.filter(field => field.type === "port").map(field => Number(extra[field.key]))];
    if (new Set(ports).size !== ports.length) throw fail("INVALID_PARAMS", "各服务端口必须不同");
    const root = plan.roots.find(row => input.dataPath.startsWith(row.path + "/"));
    if (plan.version !== input.version || !root) throw fail("APP_PLAN_STALE", "应用版本或数据磁盘已变化，请重新选择安装位置", 409);
    const info = directoryInfo(await this.#request(active.public.baseUrl, operations["files.info"], { path: input.dataPath }, active));
    this.#assertToolSession(active);
    if (!ordinaryDirectory(info, input.dataPath)) throw fail("APP_DATA_PATH_INVALID", "NAS 未确认选中的普通目录，请刷新目录后重试", 409);
    const username = text(active.public.user, "username");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(username)) throw fail("APP_USER_IDENTITY_INVALID", "设备未提供可用的目录映射身份，请重新登录", 409);
    const segments = input.dataPath.split("/");
    const aliases: Record<string, string> = { zenith_sata: "sata1", zenith_m2: "nvme2", zenith_esata: "esata3" };
    segments[1] = aliases[segments[1]] || segments[1];
    if (segments[2] !== "my") throw fail("APP_DATA_PATH_INVALID", "请选择个人数据磁盘上的应用专用目录", 409);
    // Same mapping as the verified vendor form: personal alias -> actual user
    // directory under /tmp/zfsv3. Pool identity came from mounted NAS roots.
    segments[2] = /^\d.+/.test(username) ? username : `_${username}`;
    const realPath = `/tmp/zfsv3${segments.join("/")}`;
    for (const field of fields.filter(field => field.type === "directory")) {
      const path = extra[field.key];
      if (!ordinaryDirectoryPath(path) || !plan.roots.some(row => path.startsWith(row.path + "/"))) throw fail("APP_DATA_PATH_INVALID", `请重新选择${field.label}目录`, 409);
      const directory = directoryInfo(await this.#request(active.public.baseUrl, operations["files.info"], { path }, active));
      this.#assertToolSession(active);
      if (!ordinaryDirectory(directory, path)) throw fail("APP_DATA_PATH_INVALID", `设备未确认${field.label}目录`, 409);
      const parts = path.split("/"); parts[1] = aliases[parts[1]] || parts[1]; parts[2] = /^\d.+/.test(username) ? username : `_${username}`;
      extra[field.key] = `/tmp/zfsv3${parts.join("/")}`;
    }
    for (const port of ports) {
      await this.#request(active.public.baseUrl, { method: "GET", path: "/zdocker/app_check_port", params: "" }, { port: String(port) }, active);
      this.#assertToolSession(active);
    }
    await this.#request(active.public.baseUrl, { method: "POST", path: "/zdocker/AppStore/v1/pkg/preinstall", params: "" }, { app_name: input.appName, version_int: String(plan.version) }, active);
    this.#assertToolSession(active);
    try {
      await this.#request(active.public.baseUrl, { method: "POST", path: "/zdocker/AppStore/v1/pkg/install", params: "" }, { app_name: input.appName, version_int: String(plan.version), isDocker: "1", upgrade: "0", [template.portField || "appstore_port"]: String(input.port), [template.dataField]: realPath, appstore_restart_policy: input.autoStart ? "always" : "no", ...extra }, active);
      this.#assertToolSession(active);
      const after = record(await this.#request(active.public.baseUrl, operations["apps.docker"], {}, active));
      this.#assertToolSession(active);
      if (!Array.isArray(after?.list)) throw new OfficialNasError("安装请求已提交，请刷新应用列表检查结果", "APP_INSTALL_UNCONFIRMED", 502, true);
      const app = after.list.map(record).find(row => row?.app_name === input.appName);
      return { installed: Number(app?.installed) === 1, status: String(app?.status || "pending") };
    } catch (e) {
      if (e instanceof OfficialNasError && ["NAS_UNAVAILABLE", "NAS_HTTP_ERROR", "INVALID_RESPONSE", "REQUEST_CANCELLED"].includes(e.code)) throw new OfficialNasError("安装结果尚未确认，请刷新应用列表检查，避免重复安装", "APP_INSTALL_UNCONFIRMED", 502, true);
      throw e;
    }
  }
  async docker<T = Record<string, unknown>>(endpoint: DockerEndpoint, body?: Record<string, unknown>): Promise<T> {
    const active = this.#active;
    if (!active) throw fail("NO_SESSION", "请先登录 NAS", 401);
    if (!["capabilities", "containers", "images", "compose", "info", "control", "create", "compose-create"].includes(endpoint) && !/^(logs|details)\/[a-f0-9]{64}$/.test(endpoint)) throw fail("INVALID_PARAMS", "Docker 请求无效");
    const write = ["control", "create", "compose-create"].includes(endpoint);
    if (write !== (body !== undefined)) throw fail("INVALID_PARAMS", "Docker 请求方式无效");
    const target = new URL(`/api/docker/${endpoint}`, active.public.baseUrl);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await this.#fetcher(this.#proxyURL(target, active.public.baseUrl), {
        method: write ? "POST" : "GET", credentials: credentialsFor(active.public.baseUrl, this.#transport === "native"), redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal,
        headers: this.#headers(active, { "X-Space-Request": "1", ...(write ? { "Content-Type": "application/json" } : {}) }), ...(write ? { body: JSON.stringify(body) } : {}),
      });
      if (this.#active !== active) throw fail("REQUEST_CANCELLED", "NAS 会话已改变", 409);
      if (response.status === 401) throw fail("SESSION_EXPIRED", "NAS 登录已失效，请重新登录", 401);
      let data: RecordData | undefined;
      try { data = record(await response.json()); } catch { throw fail("DOCKER_UNAVAILABLE", "当前设备地址未提供 Docker 管理服务，请连接已部署客户端服务的地址", 503); }
      if (this.#active !== active) throw fail("REQUEST_CANCELLED", "NAS 会话已改变", 409);
      if (!response.ok) throw fail("DOCKER_FAILED", String(clean(data?.hint || "Docker 操作失败，请刷新后重试", active.token)), response.status);
      if (!data) throw fail("INVALID_RESPONSE", "Docker 返回的数据无法识别", 502);
      return clean(data, active.token) as T;
    } finally { clearTimeout(timer); }
  }
  async saveSetting(key: PersonalSettingKey, value: string | number): Promise<void> {
    const active = this.#active;
    if (!active) throw fail("NO_SESSION", "请先登录 NAS", 401);
    const allowed: Record<PersonalSettingKey, Array<string | number>> = { show_hidden: [0, 1], file_hash_check: [0, 1], file_hash_check_option: ["simple", "complete"], fs_evt_monitor: [0, 1], disk_stats_sec: [3600, 7200, 21600, 43200, 86400, 259200, 604800] };
    if (!Object.hasOwn(allowed, key) || !allowed[key].includes(value)) throw fail("INVALID_PARAMS", "此设置或取值不受支持");
    await this.#request(active.public.baseUrl, { method: "POST", path: "/setting/change", params: "" }, { [key]: String(value) }, active);
    const result = record(await this.#request(active.public.baseUrl, operations["system.settings"], {}, active));
    if (this.#active !== active) throw fail("REQUEST_CANCELLED", "NAS 会话已改变", 409);
    const file = record(result?.file);
    const actual = key === "show_hidden" ? file?.show_hidden : key === "file_hash_check" ? file?.hash_check : key === "file_hash_check_option" ? file?.hash_check_option : result?.[key];
    if (String(actual) !== String(value)) throw fail("SETTING_UNCONFIRMED", "设备未确认保存的设置，请刷新后检查", 409);
  }
  async controlApp(input: { appName: string; docker: boolean; action: "start" | "stop" | "restart" }): Promise<void> {
    const active = this.#active;
    if (!active) throw fail("NO_SESSION", "请先登录 NAS", 401);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.appName) || typeof input.docker !== "boolean" || !["start", "stop", "restart"].includes(input.action))
      throw fail("INVALID_PARAMS", "应用操作参数无效");
    const prefix = input.docker ? "/zdocker/AppStore/v1" : "/AppStore/v1";
    const op = { method: "POST" as const, path: `${prefix}/list`, params: "" };
    const before = record(await this.#request(active.public.baseUrl, op, {}, active));
    const rows = Array.isArray(before?.list) ? before.list : [];
    const app = rows.map(record).find(row => row?.app_name === input.appName);
    if (this.#active !== active) throw fail("REQUEST_CANCELLED", "NAS 会话已改变", 409);
    if (!app || Number(app.installed) !== 1 || Number(app.toggleable) !== 1)
      throw fail("APP_CONTROL_FORBIDDEN", "当前应用不支持此操作", 403);
    await this.#request(active.public.baseUrl, { ...op, path: `${prefix}/pkg/${input.action}` }, { app_name: input.appName, isDocker: input.docker ? "1" : "0" }, active);
    const after = record(await this.#request(active.public.baseUrl, op, {}, active));
    if (this.#active !== active) throw fail("REQUEST_CANCELLED", "NAS 会话已改变", 409);
    const state = (Array.isArray(after?.list) ? after.list : []).map(record).find(row => row?.app_name === input.appName)?.status;
    if (input.action === "stop" ? !["stop", "stopped"].includes(String(state)) : state !== "running")
      throw fail("APP_STATE_PENDING", "设备已接受操作，应用状态尚未更新，请刷新查看", 409);
  }
  #assertToolSession(active: Active): void {
    if (this.#active !== active || active.generation !== this.#generation) throw fail("REQUEST_CANCELLED", "NAS 会话已改变，请刷新内容", 409);
  }
  async uninstallApp(input: { appName: string; docker: boolean }): Promise<{ installed: boolean; status: string }> {
    const active = this.#active;
    if (!active) throw fail("NO_SESSION", "请先登录 NAS", 401);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.appName) || typeof input.docker !== "boolean") throw fail("INVALID_PARAMS", "应用标识无效");
    const op = operations[input.docker ? "apps.docker" : "apps.native"];
    const before = record(await this.#request(active.public.baseUrl, op, {}, active));
    this.#assertToolSession(active);
    const app = (Array.isArray(before?.list) ? before.list : []).map(record).find(a => a?.app_name === input.appName);
    const version = Number(record(record(app?.local_info)?.version)?.version_int);
    if (!app || Number(app.installed) !== 1 || Number(app.removable) !== 1 || !Number.isSafeInteger(version) || version <= 0) throw fail("APP_REMOVE_FORBIDDEN", "当前应用不能卸载，请刷新应用列表", 403);
    const depend = record(await this.#request(active.public.baseUrl, { method: "POST", path: "/AppStore/v1/pkg/depend/by", params: "" }, { app_name: input.appName, version_int: String(version) }, active));
    this.#assertToolSession(active);
    if (!depend || (depend.apps !== undefined && (!Array.isArray(depend.apps) || depend.apps.length))) throw fail("APP_DEPENDENCY_REQUIRED", "其他应用依赖此应用，请先在官方商店检查依赖", 409);
    // Official UninstallConfirmDialog defaults with_data=0. Never remove user data.
    await this.#request(active.public.baseUrl, { method: "POST", path: `${input.docker ? "/zdocker" : ""}/AppStore/v1/pkg/remove`, params: "" }, { app_name: input.appName, isDocker: input.docker ? "1" : "0", with_data: "0" }, active);
    this.#assertToolSession(active);
    const after = record(await this.#request(active.public.baseUrl, op, {}, active));
    this.#assertToolSession(active);
    if (!Array.isArray(after?.list)) throw fail("APP_REMOVE_UNCONFIRMED", "卸载请求已提交，请刷新应用列表确认结果", 409);
    const result = (Array.isArray(after?.list) ? after.list : []).map(record).find(a => a?.app_name === input.appName);
    return { installed: Number(result?.installed) === 1, status: String(result?.status || "pending") };
  }
  async downloadEngineState(): Promise<DownloadEngineState> {
    const active = this.#active;
    if (!active) throw fail("NO_SESSION", "请先登录 NAS", 401);
    const settings = await this.downloadSettings();
    this.#assertToolSession(active);
    const current = Number(settings.bt_engine_type);
    const engines = (Array.isArray(settings.bt_engine_type_list) ? settings.bt_engine_type_list : []).map(record).filter((row): row is RecordData => !!row && [1, 2].includes(Number(row.type))).map(row => ({ type: Number(row.type) as 1 | 2, name: text(row, "name"), version: text(row, "version") }));
    if (![1, 2].includes(current) || !engines.length || engines.some(e => !e.name)) throw fail("INVALID_RESPONSE", "设备未提供可用的下载引擎列表", 502);
    const state = record(await this.#request(active.public.baseUrl, { method: "POST", path: "/downloader/engin/switch/status", params: "" }, {}, active));
    this.#assertToolSession(active);
    const status = Number(state?.status);
    if (!Number.isInteger(status) || status < 0 || status > 5) throw fail("INVALID_RESPONSE", "设备未返回有效的引擎切换状态", 502);
    return { current: current as 1 | 2, engines, status };
  }
  async switchDownloadEngine(type: 1 | 2): Promise<DownloadEngineState> {
    const active = this.#active;
    if (!active) throw fail("NO_SESSION", "请先登录 NAS", 401);
    if (![1, 2].includes(type)) throw fail("INVALID_PARAMS", "下载引擎无效");
    const settings = await this.downloadSettings();
    this.#assertToolSession(active);
    if (!(Array.isArray(settings.bt_engine_type_list) && settings.bt_engine_type_list.some(raw => Number(record(raw)?.type) === type))) throw fail("INVALID_PARAMS", "设备不支持此下载引擎");
    if (Number(settings.bt_engine_type) === type) return this.downloadEngineState();
    const tasks = record(await this.#request(active.public.baseUrl, operations["downloads.list"], { start: "0", size: "1" }, active));
    this.#assertToolSession(active);
    if (![0, 1].includes(Number(tasks?.taskStatus))) throw fail("INVALID_RESPONSE", "设备未返回下载任务迁移状态，请刷新后重试", 502);
    if (Number(tasks?.taskStatus) === 1) throw fail("DOWNLOAD_ENGINE_BUSY", "设备正在迁移下载任务，请刷新切换状态", 409);
    await this.#request(active.public.baseUrl, { method: "POST", path: "/downloader/engin/switch/exec", params: "" }, { bt_engine_type: String(type) }, active);
    this.#assertToolSession(active);
    return this.downloadEngineState();
  }
  async acknowledgeDownloadEngineSwitch(): Promise<DownloadEngineState> {
    const active = this.#active;
    if (!active) throw fail("NO_SESSION", "请先登录 NAS", 401);
    const state = await this.downloadEngineState();
    this.#assertToolSession(active);
    if (![3, 4, 5].includes(state.status)) throw fail("DOWNLOAD_ENGINE_PENDING", "引擎切换尚未结束，请稍后刷新", 409);
    await this.#request(active.public.baseUrl, { method: "POST", path: "/downloader/engin/switch/confirm", params: "" }, {}, active);
    this.#assertToolSession(active);
    return this.downloadEngineState();
  }
  async remoteEntries(): Promise<OfficialRemoteEntry[]> {
    const active = this.#active;
    if (!active) throw fail("NO_SESSION", "请先登录 NAS", 401);
    const result = record(await this.#request(active.public.baseUrl, { method: "POST", path: "/kv/load", params: "" }, { k: "remoteAccess" }, active));
    this.#assertToolSession(active);
    if (result?.value === "undefined" || result?.value === "" || result?.value === undefined) return [];
    let rows: unknown;
    try { rows = JSON.parse(String(result.value)); } catch { throw fail("INVALID_RESPONSE", "NAS 远程入口配置无法识别", 502); }
    if (!Array.isArray(rows)) throw fail("INVALID_RESPONSE", "NAS 远程入口配置无法识别", 502);
    return rows.map(record).filter((row): row is RecordData => !!row && row.type !== "add").map((raw, index) => {
      const row = clean(raw, active.token) as RecordData;
      const address = text(row, "url");
      let url: string | undefined;
      try {
        const candidate = new URL(`${row.https === true || row.https === 1 || row.https === "1" ? "https" : "http"}://${address}`);
        if (!address || /\s|[\u0000-\u001f\u007f]/.test(address) || candidate.username || candidate.password || !candidate.hostname || candidate.hash || address.includes("://")) throw 0;
        if (candidate.hostname === "127.0.0.1" || candidate.hostname === "localhost") candidate.hostname = new URL(active.public.baseUrl).hostname;
        url = candidate.href;
      } catch { /* Invalid official rows remain visible without an open action. */ }
      const color = text(row, "color");
      return { id: String(index), name: text(row, "remarks") || "未命名入口", address, url, color: /^(#[a-f0-9]{3,8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/i.test(color) ? color : undefined, proxy: [true, 1, "1"].includes(row.proxy as never), desktopVisible: [true, 1, "1"].includes(row.desktopVisible as never) };
    });
  }
  async note(id: string): Promise<OfficialNote> {
    const active = this.#active;
    if (!active) throw fail("NO_SESSION", "请先登录 NAS", 401);
    if (!/^[1-9]\d{0,17}$/.test(id)) throw fail("INVALID_PARAMS", "便签标识无效");
    const data = record(await this.#request(active.public.baseUrl, { method: "POST", path: "/v2/file/notepad/info", params: "" }, { id, location: "2" }, active));
    this.#assertToolSession(active);
    if (!data || typeof data.title !== "string" || typeof data.body !== "string" || ![0, 1, 2].includes(Number(data.note_type))) throw fail("INVALID_RESPONSE", "便签内容无法识别", 502);
    const safe = clean(data, active.token) as RecordData;
    return { id: String(safe.id || id), title: String(safe.title), body: String(safe.body), noteType: Number(safe.note_type), classifyId: Number(safe.classify_id), ...(knownNumber(safe.updated_at) === undefined ? {} : { updatedAt: knownNumber(safe.updated_at) }) };
  }
  async saveNote(input: { id?: string; title: string; body: string; expectedBody?: string; expectedTitle?: string }): Promise<OfficialNote> {
    const active = this.#active;
    if (!active) throw fail("NO_SESSION", "请先登录 NAS", 401);
    const title = input.title.trim();
    if (!title || title.length > 200 || /[\u0000-\u001f\u007f]/.test(title) || typeof input.body !== "string" || input.body.length > 50000) throw fail("INVALID_PARAMS", "请填写标题，内容不能超过 50000 字");
    if (input.id) {
      const before = await this.note(input.id);
      this.#assertToolSession(active);
      if (typeof input.expectedBody !== "string" || typeof input.expectedTitle !== "string" || before.body !== input.expectedBody || before.title !== input.expectedTitle) throw fail("NOTE_CONFLICT", "便签已被其他客户端修改，请重新打开后再编辑", 409);
      if (before.classifyId === -1 || (before.noteType !== 2 && input.body !== before.body)) throw fail("NOTE_READ_ONLY", "当前便签内容需在官方富文本编辑器中修改", 409);
    }
    const form: Record<string, string> = { title, body: input.body, in_brief: "", location: "2", ...(input.id ? { id: input.id } : { classify_id: "0", note_type: "2" }) };
    try {
      const data = record(await this.#request(active.public.baseUrl, { method: "POST", path: `/v2/file/notepad/${input.id ? "modify" : "new"}`, params: "" }, form, active));
      this.#assertToolSession(active);
      const id = String(data?.id || input.id || "");
      if (!/^[1-9]\d{0,17}$/.test(id)) throw new OfficialNasError("保存结果尚未确认，请刷新便签列表检查", "NOTE_UNCONFIRMED", 502, !input.id);
      const after = await this.note(id);
      this.#assertToolSession(active);
      if (after.title !== title || after.body !== input.body) throw new OfficialNasError("设备尚未确认保存的便签，请刷新检查", "NOTE_UNCONFIRMED", 409, !input.id);
      return after;
    } catch (e) {
      if (e instanceof OfficialNasError && ["NAS_UNAVAILABLE", "REQUEST_CANCELLED", "NAS_HTTP_ERROR", "INVALID_RESPONSE"].includes(e.code)) throw new OfficialNasError("保存结果尚未确认，请刷新便签列表检查，避免重复保存", "NOTE_UNCONFIRMED", 502, !input.id);
      throw e;
    }
  }
  async recycleAction(input: { scope: "personal" | "public"; path: string; action: "restore" | "delete"; page?: number }): Promise<{ accepted: boolean }> {
    const active = this.#active;
    if (!active) throw fail("NO_SESSION", "请先登录 NAS", 401);
    const root = input.scope === "personal" ? "/.recycle/my" : input.scope === "public" ? "/.public_recycle" : "";
    const binPath = input.scope === "personal" ? /^\/(?:\.recycle\/my|[A-Za-z0-9_]+\/\.recycle\/my)\/.+$/ : /^\/(?:\.public_recycle|[A-Za-z0-9_]+\/\.?public_recycle)\/.+$/;
    if (!root || typeof input.path !== "string" || !binPath.test(input.path) || input.path.split("/").some(part => [".", ".."].includes(part)) || /[\u0000-\u001f\u007f]/.test(input.path) || !["restore", "delete"].includes(input.action)) throw fail("INVALID_PARAMS", "回收站操作无效");
    const page = input.page ?? 1;
    if (!Number.isInteger(page) || page < 1 || page > 10000) throw fail("INVALID_PARAMS", "回收站页码无效");
    // Recheck the exact visible page. A concurrent list shift requires refresh,
    // rather than scanning an arbitrarily large bin before one selected action.
    const collection = await this.read("recycle.list", { scope: input.scope, page, pageSize: 20 });
    this.#assertToolSession(active);
    if (!collection.items.some(item => item.path === input.path)) throw fail("RECYCLE_ITEM_STALE", "该项目已移出当前列表，请刷新后重试", 409);
    const path = input.action === "delete" ? "/v2/file/remove" : input.scope === "personal" ? "/v2/file/mrestore" : "/v2/public/recycle/restore";
    await this.#request(active.public.baseUrl, { method: "POST", path, params: "" }, { "paths[]": input.path }, active);
    this.#assertToolSession(active);
    return { accepted: true };
  }
  async #request(
    base: string,
    operation: Operation,
    params: Record<string, string>,
    active?: Active | null,
    directory?: DirectoryContext,
  ): Promise<unknown> {
    const url = new URL(operation.path, base);
    if (url.origin !== base)
      throw fail("INVALID_REQUEST", "API 地址不属于当前 NAS");
    const form = new URLSearchParams({ ...this.#common(active), ...params });
    if (operation.method === "GET") url.search = form.toString();
    const wireURL = this.#proxyURL(url, base);
    const controller = new AbortController();
    const abort = () => controller.abort();
    directory?.signal.addEventListener("abort", abort, { once: true });
    if (directory?.signal.aborted) abort();
    const assertCurrent = () => {
      directory?.assertCurrent();
      if (directory && controller.signal.aborted) throw fail("REQUEST_CANCELLED", "NAS 请求已中断，请刷新查看", 409);
    };
    const timer = setTimeout(() => controller.abort(), 30_000);
    let response: Response | undefined, bodyCompleted = false;
    try {
      assertCurrent();
      directory?.onDispatch?.();
      response = await this.#fetcher(wireURL, {
        method: operation.method,
        credentials: credentialsFor(base, this.#transport === "native"),
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
        headers: this.#headers(
          active,
          operation.method === "POST"
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : {},
        ),
        ...(operation.method === "POST"
          ? {
              body: form.toString(),
            }
          : {}),
      });
      assertCurrent();
      if (
        response.redirected ||
        (response.url &&
          new URL(response.url).origin !== new URL(wireURL).origin)
      )
        throw fail("NAS_REDIRECT_BLOCKED", "NAS API 重定向被拒绝", 502);
      if (response.status === 401 || response.status === 403)
        throw fail("SESSION_EXPIRED", "NAS 登录已失效，请重新登录", 401);
      if (!response.ok) throw fail("NAS_HTTP_ERROR", "NAS 返回 HTTP 错误", 502);
      let body: unknown;
      try {
        body = directory ? await this.#directoryBody(response, controller.signal, assertCurrent, () => { bodyCompleted = true; }) : await response.json();
      } catch {
        assertCurrent();
        throw fail("INVALID_RESPONSE", "NAS 返回无法识别的数据", 502);
      }
      assertCurrent();
      const envelope = record(body);
      if (directory?.envelope && (envelope?.code === "N001301" || envelope?.code === "N001322"))
        throw fail("DIRECTORY_CONFLICT", "同名文件夹已存在，请刷新查看", 409);
      const decoded = decodeOfficialResponse(body);
      return directory?.envelope ? { data: decoded, ts: envelope?.ts } : decoded;
    } catch (error) {
      assertCurrent();
      if (error instanceof OfficialNasError) {
        if (
          error.code === "SESSION_EXPIRED" &&
          active &&
          this.#active === active
        )
          this.#expire(active);
        throw error;
      }
      throw fail(
        "NAS_UNAVAILABLE",
        "无法直接连接 NAS，请检查地址、网络与浏览器跨域条件",
        502,
      );
    } finally {
      clearTimeout(timer);
      // Directory request slots must not outlive an unconsumed transport body.
      // Aborting also drops native HTTP resources; cancellation is observed but
      // never awaited because an upstream cleanup promise may never settle.
      if (directory && !bodyCompleted) {
        controller.abort();
        try {
          if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
        } catch { /* Disposal cannot replace the safe public request error. */ }
      }
      directory?.signal.removeEventListener("abort", abort);
    }
  }
  async #directoryBody(response: Response, signal: AbortSignal, assertCurrent: () => void, onComplete: () => void): Promise<unknown> {
    const limit = 64 << 10;
    const length = response.headers.get("Content-Length");
    if (length && (!/^\d+$/.test(length) || Number(length) > limit))
      throw fail("INVALID_RESPONSE", "NAS 返回数据超出范围", 502);
    if (!response.body) throw fail("INVALID_RESPONSE", "NAS 返回无法识别的数据", 502);
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    let size = 0, completed = false;
    try {
      assertCurrent();
      for (;;) {
        const chunk = await reader.read();
        assertCurrent();
        if (chunk.done) { completed = true; onComplete(); break; }
        size += chunk.value.byteLength;
        if (size > limit) throw fail("INVALID_RESPONSE", "NAS 返回数据超出范围", 502);
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } finally {
      signal.removeEventListener("abort", cancel);
      if (!completed) cancel();
      reader.releaseLock();
    }
  }
  async checkConnection(
    baseUrl: string,
  ): Promise<{ baseUrl: string; reachable: true }> {
    const base = baseAddress(baseUrl);
    const data = record(
      await this.#request(
        base,
        { method: "GET", path: "/key/pub", params: "" },
        { signme: "1" },
      ),
    );
    if (!data || !text(data, "key"))
      throw fail("INVALID_RESPONSE", "NAS 未提供登录公钥", 502);
    const rsa = new JSEncrypt();
    rsa.setPublicKey(text(data, "key"));
    if (!rsa.encrypt("connection-check"))
      throw fail("INVALID_RESPONSE", "NAS 登录公钥无效", 502);
    return { baseUrl: base, reachable: true };
  }
  #clearLoginVerification() {
    const challenge = this.#loginVerification;
    this.#loginVerification = undefined;
    if (challenge) { clearTimeout(challenge.timer); challenge.controller.abort(); challenge.username = ""; }
  }
  cancelLoginVerification() {
    this.#generation++;
    this.#clearLoginVerification();
  }
  #verification(id: string, baseUrl: string, username: string): LoginVerificationState {
    const challenge = this.#loginVerification;
    if (!challenge || challenge.id !== id) throw fail("VERIFICATION_EXPIRED", "本次验证已失效，请重新登录", 409);
    if (challenge.base !== baseAddress(baseUrl) || challenge.username !== username || challenge.generation !== this.#generation ||
      challenge.deviceId !== this.#deviceId || challenge.expiresAt <= Date.now()) {
      this.cancelLoginVerification();
      throw fail("VERIFICATION_EXPIRED", "本次验证已失效，请重新登录", 409);
    }
    return challenge;
  }
  #assertVerification(challenge: LoginVerificationState) {
    if (this.#loginVerification !== challenge || challenge.generation !== this.#generation ||
      challenge.deviceId !== this.#deviceId || challenge.controller.signal.aborted || challenge.expiresAt <= Date.now())
      throw fail("REQUEST_CANCELLED", "本次登录验证已取消，请重新登录", 409);
  }
  async #verificationRequest(challenge: LoginVerificationState, path: "/key/pub" | "/sms/usend" | "/sms/ucheck", params: Record<string, string>): Promise<RecordData> {
    // This fixed HTTPS boundary intentionally uses neither NAS common params nor NAS headers.
    const url = new URL(path, "https://api.zenithspace.net");
    const form = new URLSearchParams(params), method = path === "/key/pub" ? "GET" : "POST";
    if (method === "GET") url.search = form.toString();
    const controller = new AbortController();
    let reject!: (reason: OfficialNasError) => void;
    const deadline = new Promise<never>((_, fail) => { reject = fail; });
    const cancel = () => { controller.abort(); reject(fail("REQUEST_CANCELLED", "本次登录验证已取消，请重新登录", 409)); };
    challenge.controller.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => { controller.abort(); reject(fail("VERIFICATION_TIMEOUT", "官方短信验证服务响应超时，请重试", 504)); }, 15_000);
    let response: Response | undefined;
    try {
      this.#assertVerification(challenge);
      return await Promise.race([(async () => {
        response = await this.#fetcher(url.href, {
          method, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal,
          ...(method === "POST" ? { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() } : {}),
        });
        this.#assertVerification(challenge);
        if (response.redirected || (response.url && (new URL(response.url).origin !== url.origin || new URL(response.url).pathname !== path)) || !response.ok)
          throw fail("VERIFICATION_UNAVAILABLE", "无法连接官方短信验证服务，请稍后重试", 502);
        const body = await this.#directoryBody(response, controller.signal, () => {
          this.#assertVerification(challenge);
          if (controller.signal.aborted) throw fail("VERIFICATION_TIMEOUT", "官方短信验证服务响应超时，请重试", 504);
        }, () => {});
        this.#assertVerification(challenge);
        try {
          const decoded = decodeOfficialResponse(body);
          // The send endpoint confirms delivery through the envelope alone.
          if (path === "/sms/usend") return {};
          const data = record(decoded);
          if (data) return data;
        } catch {
          const code = String(record(body)?.code ?? "");
          throw fail("VERIFICATION_FAILED", `官方短信验证未完成${/^[NS]\d{6}$/.test(code) ? `（${code}）` : ""}，请检查验证码或稍后重试`, 400);
        }
        throw fail("INVALID_RESPONSE", "官方短信验证服务返回的数据无效，请重试", 502);
      })(), deadline]);
    } catch (error) {
      this.#assertVerification(challenge);
      if (error instanceof OfficialNasError && error.code.startsWith("VERIFICATION_")) throw error;
      throw fail("VERIFICATION_UNAVAILABLE", "无法连接官方短信验证服务，请稍后重试", 502);
    } finally {
      clearTimeout(timer);
      challenge.controller.signal.removeEventListener("abort", cancel);
      controller.abort();
      try { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); } catch { /* Disposal stays private. */ }
    }
  }
  async #verificationIdentity(challenge: LoginVerificationState) {
    const key = await this.#verificationRequest(challenge, "/key/pub", { signme: "1", webagent: "v2", rnd: identifier() });
    if (!text(key, "key") || !text(key, "key_id")) throw fail("VERIFICATION_UNAVAILABLE", "官方短信验证服务未提供有效公钥，请重试", 502);
    const rsa = new JSEncrypt(); rsa.setPublicKey(text(key, "key"));
    const username = rsa.encrypt(challenge.username);
    if (!username) throw fail("VERIFICATION_UNAVAILABLE", "官方短信验证公钥无效或账号长度超出范围", 502);
    return { key_id: text(key, "key_id"), nasid: challenge.nasId, username };
  }
  async sendLoginVerificationCode(id: string, baseUrl: string, username: string): Promise<{ retryAt: number }> {
    const challenge = this.#verification(id, baseUrl, username);
    if (challenge.busy) throw fail("VERIFICATION_BUSY", "短信验证请求正在进行，请稍候", 409);
    if (challenge.retryAt > Date.now()) throw fail("VERIFICATION_SEND_COOLDOWN", "验证码已发送，请稍候再试", 429);
    challenge.busy = true;
    try {
      const identity = await this.#verificationIdentity(challenge);
      await this.#verificationRequest(challenge, "/sms/usend", { ...identity, type: "new_device" });
      this.#assertVerification(challenge);
      challenge.sent = true;
      return { retryAt: challenge.retryAt = Date.now() + 60_000 };
    } finally { challenge.busy = false; }
  }
  async completeLoginVerification(id: string, input: { baseUrl: string; username: string; password: string; code: string }): Promise<NasSession> {
    const challenge = this.#verification(id, input.baseUrl, input.username);
    if (challenge.busy) throw fail("VERIFICATION_BUSY", "短信验证请求正在进行，请稍候", 409);
    if (!challenge.sent) throw fail("VERIFICATION_NOT_SENT", "请先发送短信验证码", 400);
    if (!/^(?:\d{4}|\d{6})$/.test(input.code)) throw fail("VERIFICATION_CODE_INVALID", "请输入 4 位或 6 位数字验证码", 400);
    if (!input.password) throw fail("INVALID_REQUEST", "请输入 NAS 登录密码");
    challenge.busy = true;
    try {
      const identity = await this.#verificationIdentity(challenge);
      const data = await this.#verificationRequest(challenge, "/sms/ucheck", { ...identity, sms_code: input.code });
      const proof = text(data, "sms_proof") || text(data, "email_proof");
      if (!proof || proof.length > 8192 || /[\u0000-\u001f\u007f]/.test(proof)) throw fail("VERIFICATION_FAILED", "官方短信验证未返回有效凭证，请重新获取验证码", 502);
      this.#assertVerification(challenge);
      const session = await this.#login(challenge.base, input.username, input.password, challenge.generation, proof);
      this.#clearLoginVerification();
      return session;
    } finally { challenge.busy = false; }
  }
  async login(baseUrl: string, username: string, password: string): Promise<NasSession> {
    this.#clearLoginVerification();
    const generation = ++this.#generation;
    const base = baseAddress(baseUrl);
    if (!username || !password) throw fail("INVALID_REQUEST", "请输入 NAS 账号和密码");
    this.#releaseUploadSources();
    this.#onSessionChanged?.();
    this.#abortDirectories();
    return this.#login(base, username, password, generation);
  }
  async #login(base: string, username: string, password: string, generation: number, proof?: string): Promise<NasSession> {
    const keyData = record(
      await this.#request(
        base,
        { method: "GET", path: "/key/pub", params: "" },
        { signme: "1" },
      ),
    );
    if (!keyData || !text(keyData, "key"))
      throw fail("INVALID_RESPONSE", "NAS 未提供新鲜登录公钥", 502);
    if (generation !== this.#generation)
      throw fail("REQUEST_CANCELLED", "登录操作已取消", 409);
    const encryptor = new JSEncrypt();
    encryptor.setPublicKey(text(keyData, "key"));
    const encryptedUser = encryptor.encrypt(username),
      encryptedPassword = encryptor.encrypt(password);
    password = "";
    if (!encryptedUser || !encryptedPassword)
      throw fail("INVALID_RESPONSE", "NAS 登录公钥无效或凭据长度超出范围", 502);
    let data: RecordData | undefined;
    try {
      data = record(await this.#request(base, { method: "POST", path: "/auth/login", params: "" }, {
        username: encryptedUser, password: encryptedPassword,
        ...(text(keyData, "sign") ? { sign: text(keyData, "sign") } : {}),
        ...(proof ? { sms_proof: proof } : {}),
      }));
    } catch (error) {
      if (generation !== this.#generation) throw fail("REQUEST_CANCELLED", "登录操作已取消", 409);
      if (error instanceof OfficialNasError && error.code === "CHALLENGE_REQUIRED") {
        this.#clearLoginVerification();
        const nasId = text(keyData, "sign") || text(keyData, "nasid", "nas_id");
        if (!nasId) throw fail("VERIFICATION_UNAVAILABLE", "NAS 未提供短信验证标识，请在官方页面检查设备绑定后重试（N001414）", 502);
        const challenge: LoginVerificationState = { id: identifier(), expiresAt: Date.now() + 5 * 60_000,
          base, username, nasId, generation, deviceId: this.#deviceId, controller: new AbortController(), busy: false, sent: false, retryAt: 0 };
        this.#loginVerification = challenge;
        challenge.timer = setTimeout(() => { if (this.#loginVerification === challenge) this.cancelLoginVerification(); }, 5 * 60_000);
        throw new OfficialNasVerificationRequired({ id: challenge.id, expiresAt: challenge.expiresAt });
      }
      throw error;
    } finally { username = ""; }
    if (generation !== this.#generation) throw fail("REQUEST_CANCELLED", "登录操作已取消", 409);
    const token = data && text(data, "token");
    if (!data || !token)
      throw fail("INVALID_RESPONSE", "NAS 登录响应缺少会话", 502);
    // 官方网页版在登录后写入同一组 cookie：nginx 用它放行 /v2/ 等受保护路由，
    // 转码服务还额外校验 device_id/device/version/plat。跨源或原生端不写（发了也没用）。
    writeSessionCookie(cookieFacts(base, this.#transport === "native"), {
      token,
      deviceId: this.#deviceId,
      device: "SpaceDesktop",
      version: this.#common().version,
      plat: "web",
    });
    if (generation !== this.#generation)
      throw fail("REQUEST_CANCELLED", "登录操作已取消", 409);
    const user = clean(
      {
        username: text(data, "username"),
        name: text(data, "nickname", "name", "username"),
        role: text(data, "role", "user_type"),
      },
      token,
    ) as RecordData;
    const session: NasSession = {
      sessionId: identifier(),
      baseUrl: base,
      user,
    };
    const previous = this.#active;
    this.#downloads.clear();
    for (const controller of this.#downloadRequests) controller.abort();
    this.#downloadRequests.clear();
    this.#registeredNativeURIs.clear();
    this.#ownedProxyURIs.clear();
    if (previous) this.#clearNativeMedia(previous.public.sessionId);
    this.#active = {
      public: session,
      token,
      nasId: text(data, "nasid", "nas_id") || text(keyData, "nasid", "nas_id"),
      generation,
    };
    this.#onSessionChanged?.();
    return structuredClone(session);
  }
  /**
   * 用 cookie 里的会话恢复登录态（官方网页版就是这么做的：刷新后靠 cookie 免登录）。
   * 只接受同源场景，且必须先用一次真实读取证明这个 token 还有效，
   * 失败就清掉 cookie，绝不把不确定的 token 当成已登录。
   */
  async restoreSession(baseUrl: string, token: string, user: Record<string, unknown> = {}): Promise<NasSession> {
    const base = baseAddress(baseUrl);
    if (!token || token.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/.test(token))
      throw fail("INVALID_SESSION", "cookie 中的会话无效", 401);
    this.#clearLoginVerification();
    const generation = ++this.#generation;
    const candidate: Active = {
      public: { sessionId: identifier(), baseUrl: base, user: clean({ ...user }, token) as RecordData },
      token,
      nasId: "",
      generation,
    };
    const previous = this.#active;
    this.#active = candidate;
    try {
      await this.#request(base, operations["files.roots"], {}, candidate);
    } catch (error) {
      if (this.#active === candidate) this.#active = previous;
      throw error;
    }
    if (generation !== this.#generation) throw fail("REQUEST_CANCELLED", "会话已变更", 409);
    this.#onSessionChanged?.();
    return structuredClone(candidate.public);
  }

  // No destination or token arguments: the owner supplies its configured,
  // explicitly trusted shop boundary. Private NAS credentials never leave this class.
  async connectStoreWithNas(options: { signal?: AbortSignal } = {}): Promise<StoreNasSession> {
    const controller = new AbortController();
    let reject!: (error: Error) => void;
    const deadline = new Promise<never>((_, fail) => { reject = fail; });
    const cancel = () => { controller.abort(); reject(fail("STORE_SESSION_CHANGED", "会话已改变，请重新连接商店", 409)); };
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const timer = setTimeout(() => { controller.abort(); reject(fail("STORE_NAS_AUTH_TIMEOUT", "NAS 商店授权超时，请重试", 504)); }, 5000);
    try { return await Promise.race([this.#connectStoreWithNas({ signal: controller.signal }), deadline]); }
    finally { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); }
  }
  async #connectStoreWithNas(options: { signal?: AbortSignal }): Promise<StoreNasSession> {
    const active = this.#active, generation = this.#generation;
    const cancelled = () => fail("STORE_SESSION_CHANGED", "会话已改变，请重新连接商店", 409);
    const nasCurrent = () => {
      if (!active || this.#active !== active || active.generation !== generation || generation !== this.#generation || options.signal?.aborted) throw cancelled();
    };
    if (!active) throw fail("NO_SESSION", "请先连接 NAS", 401);
    nasCurrent();
    if (!this.#storeSessionContext) throw fail("STORE_TRUST_REQUIRED", "请先确认商店授权目标", 403);
    const context = await this.#storeSessionContext();
    const assertCurrent = () => { nasCurrent(); context.assertCurrent(); };
    assertCurrent();
    if (context.providerId !== active.public.baseUrl || !/^[a-f0-9]{48}$/.test(context.storeId))
      throw fail("STORE_PROVIDER_MISMATCH", "商店配置的 NAS 与当前设备不一致", 403);
    const base = normalizeStoreAddress(context.storeBase);
    if (base !== context.storeBase) throw fail("STORE_PROVIDER_MISMATCH", "商店授权目标无效", 403);
    if(!active.nasId){
      // Official IP login obtains the device identity from zhelper/state, not
      // from key/pub. Read it only inside the explicitly trusted store handoff.
      const identity=record(await this.#request(active.public.baseUrl,{method:"GET",path:"/zhelper/state",params:""},{},active));
      assertCurrent();active.nasId=identity?text(identity,"nasid","nas_id"):"";
    }
    if (!active.token || new TextEncoder().encode(active.token).length > 8192 || !active.nasId || new TextEncoder().encode(active.nasId).length > 256 || /[\u0000-\u001f\u007f]/.test(active.token + active.nasId))
      throw fail("STORE_NAS_AUTH_FAILED", "NAS 会话信息无效，请重新登录", 401);
    const transport = this.#fetcher;
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    let minted = "", accepted = false, bodyCompleted = false;
    let response: Response | undefined;
    try {
      assertCurrent();
      response = await transport(base + "/api/store/nas-session", {
        method: "POST", credentials: credentialsFor(active?.public.baseUrl ?? "", this.#transport === "native"), redirect: "error", referrerPolicy: "no-referrer",
        signal: controller.signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: context.providerId, storeId: context.storeId, token: active.token, deviceId: this.#deviceId, nasId: active.nasId }),
      });
      // Decode even an abandoned response to reclaim a freshly minted SID at
      // its original destination; only a fully current request may accept it.
      let stale = false;
      const observe = () => { try { assertCurrent(); } catch { stale = true; } };
      observe();
      const body = record(await this.#directoryBody(response, controller.signal, observe, () => { bodyCompleted = true; }));
      observe();
      const data = record(body?.data);
      if (typeof data?.sessionId === "string" && /^[a-f0-9]{48}$/.test(data.sessionId) && !storeCredentialEcho(data.sessionId, active.token)) minted = data.sessionId;
      if (stale || controller.signal.aborted) throw cancelled();
      assertCurrent();
      if (response.redirected || (response.url && response.url !== base + "/api/store/nas-session"))
        throw fail("INVALID_RESPONSE", "商店授权返回无效数据", 502);
      if (!response.ok || body?.ok !== true) {
        if (response.status === 401) throw fail("NAS_ADMIN_REQUIRED", "NAS 管理员身份校验失败，请确认账号权限或重新登录", 401);
        if (response.status === 403) throw fail("NAS_ADMIN_REQUIRED", "当前 NAS 账号没有商店管理员权限", 403);
        throw fail("STORE_NAS_AUTH_FAILED", "NAS 商店授权失败，请检查登录与服务配置", 401);
      }
      const expiry = typeof data?.expiresAt === "string" ? Date.parse(data.expiresAt) : NaN;
      if (!minted || data?.authSource !== "nas" || typeof data.username !== "string" || !data.username.trim() || data.username.length > 256 || /[\u0000-\u001f\u007f]/.test(data.username) || storeCredentialEcho(data.username, active.token) || !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 20 * 60_000 + 5000)
        throw fail("INVALID_RESPONSE", "商店授权返回无效数据", 502);
      const result: StoreNasSession = { sessionId: minted, username: data.username, expiresAt: new Date(expiry).toISOString(), authSource: "nas" };
      assertCurrent();
      context.accept(result);
      this.#storeGrant = { base, sessionId: minted };
      accepted = true;
      return result;
    } catch (error) {
      if (error instanceof OfficialNasError) throw error;
      try { assertCurrent(); } catch { throw cancelled(); }
      throw fail("STORE_NAS_AUTH_FAILED", "NAS 商店授权失败，请检查登录与服务配置", 502);
    } finally {
      options.signal?.removeEventListener("abort", abort);
      if (!bodyCompleted) {
        controller.abort();
        try { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); } catch { /* Preserve fixed error. */ }
      }
      if (minted && !accepted) {
        // Never consult the owner's current base while revoking an old grant.
        this.#revokeStoreSession(base, minted);
      }
    }
  }
  releaseStoreNasSession() {
    const grant = this.#storeGrant;
    this.#storeGrant = undefined;
    if (grant) this.#revokeStoreSession(grant.base, grant.sessionId);
  }
  #revokeStoreSession(base: string, sessionId: string) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
    void this.#fetcher(base + "/api/store/logout", { method: "POST", credentials: credentialsFor(base, this.#transport === "native"), redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal,
      headers: { "Content-Type": "application/json", "X-Store-Session": sessionId }, body: "{}" })
      .then(response => { void response.body?.cancel().catch(() => {}); })
      .catch(() => {}).finally(() => clearTimeout(timer));
  }
  /**
   * 离线下载（下载中心）。接口与参数取自官方前端 76237 chunk 的 creatTask：
   *   - `POST /downloader/get/protocols` → 支持的协议列表（"http,https,ftp,ftps,sftp,magnet"）
   *   - `POST /downloader/add/link`      → 请求体 `{uri, dir}`，**磁力链接走同一个接口**
   *     （官方把 magnet 当成一种协议前缀，不区分单独的 BT 接口）
   *   - 官方把多行文本按行拆分逐个提交；重复任务返回 code 1000
   *   - 种子文件是两步：`preprocess/torrent/parse/nas` 解析出文件树 → 用户勾选 →
   *     `preprocess/torrent/effect` 提交 `{id, hash, dir, name, checked}`
   */
  async downloadProtocols(options: { signal?: AbortSignal } = {}): Promise<string[]> {
    const active = this.#requireActive();
    const data = await this.#request(active.public.baseUrl, { method: "POST", path: "/downloader/get/protocols", params: "" }, {}, active, { ...this.#taskContext(options.signal) });
    if (Array.isArray(data)) return data.filter((item): item is string => typeof item === "string");
    const list = text(record(data) ?? {}, "protocols", "data", "list");
    if (typeof list === "string") return list.split(",").map((p) => p.trim()).filter(Boolean);
    // 官方在前端也留了同样的兜底列表
    return ["http", "https", "ftp", "ftps", "sftp", "magnet"];
  }

  async downloadSettings(options: { signal?: AbortSignal } = {}): Promise<RecordData> {
    const active = this.#requireActive();
    const data = record(await this.#request(active.public.baseUrl, { method: "POST", path: "/downloader/get/setting", params: "" }, {}, active, { ...this.#taskContext(options.signal) }));
    return data ?? {};
  }

  async downloadDirectory(options: { signal?: AbortSignal } = {}): Promise<string | undefined> {
    const active = this.#requireActive();
    const data = await this.#request(active.public.baseUrl, { method: "POST", path: "/downloader/downloaddir", params: "" }, {}, active, { ...this.#taskContext(options.signal) });
    const root = record(data);
    return text(root ?? {}, "dir", "path", "download_dir") || (typeof data === "string" ? data : undefined);
  }

  /** 提交一条下载链接（http/ftp/sftp/magnet 均可）。重复任务由 NAS 返回 code 1000。 */
  async addDownloadLink(uri: string, dir: string | undefined, options: { signal?: AbortSignal } = {}): Promise<void> {
    const active = this.#requireActive();
    const link = uri.trim();
    if (!link || link.length > 8192 || /[\u0000-\u001f\u007f-\u009f]/.test(link) || secretText(link, active.token))
      throw fail("INVALID_DOWNLOAD_LINK", "下载链接为空或包含不支持的字符");
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(link))
      throw fail("INVALID_DOWNLOAD_LINK", "链接缺少协议前缀（如 http:// 或 magnet:）");
    if (dir !== undefined && !ordinaryDirectoryPath(dir))
      throw fail("INVALID_DOWNLOAD_DIR", "保存目录无效，请在设置中重新选择");
    await this.#request(
      active.public.baseUrl,
      { method: "POST", path: "/downloader/add/link", params: "uri dir" },
      { uri: link, ...(dir ? { dir } : {}) },
      active,
      { ...this.#taskContext(options.signal, { envelope: true, onDispatch: () => {} }) },
    );
  }

  /** 解析 NAS 上已有的种子文件，返回文件树（官方 preProcessNasBT）。 */
  async parseNasTorrent(path: string, options: { signal?: AbortSignal } = {}): Promise<RecordData> {
    const active = this.#requireActive();
    if (!ordinaryDirectoryPath(path)) throw fail("INVALID_DOWNLOAD_DIR", "种子文件路径无效");
    const data = record(await this.#request(
      active.public.baseUrl,
      { method: "POST", path: "/downloader/preprocess/torrent/parse/nas", params: "path" },
      { path }, active, { ...this.#taskContext(options.signal) },
    ));
    if (!data || !text(data, "hash")) throw fail("INVALID_RESPONSE", "NAS 未返回种子解析结果", 502);
    return data;
  }

  /** 提交种子勾选结果（官方 preProcessEffect）：id 为选中的文件 id，checked 为 wanted/unwanted。 */
  async applyTorrentSelection(
    input: { hash: string; dir?: string; name?: string; ids: Array<number | string>; checked: "wanted" | "unwanted" },
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const active = this.#requireActive();
    if (!input.hash.trim() || secretText(input.hash, active.token))
      throw fail("INVALID_DOWNLOAD_LINK", "种子标识无效");
    if (input.dir !== undefined && !ordinaryDirectoryPath(input.dir))
      throw fail("INVALID_DOWNLOAD_DIR", "保存目录无效，请在设置中重新选择");
    if (!Array.isArray(input.ids) || input.ids.some((id) => typeof id !== "number" && typeof id !== "string"))
      throw fail("INVALID_PARAMS", "种子文件选择无效");
    await this.#request(
      active.public.baseUrl,
      { method: "POST", path: "/downloader/preprocess/torrent/effect", params: "id hash dir name checked" },
      {
        id: JSON.stringify(input.ids),
        hash: input.hash,
        ...(input.dir ? { dir: input.dir } : {}),
        ...(input.name ? { name: input.name } : {}),
        checked: input.checked,
      },
      active,
      { ...this.#taskContext(options.signal, { envelope: true, onDispatch: () => {} }) },
    );
  }

  /** 放弃一次种子解析（官方 preProcessCancel）。 */
  async cancelTorrentParse(hash: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    const active = this.#requireActive();
    if (!hash.trim() || secretText(hash, active.token)) return;
    try {
      await this.#request(
        active.public.baseUrl,
        { method: "POST", path: "/downloader/preprocess/torrent/cancel", params: "hash" },
        { hash }, active, { ...this.#taskContext(options.signal) },
      );
    } catch {
      /* 取消解析失败不影响用户操作，静默处理 */
    }
  }

  /** 给下载任务类请求生成最小可用的 DirectoryContext（其余字段按需覆盖）。 */
  #taskContext(signal?: AbortSignal, extra: Partial<DirectoryContext> = {}): DirectoryContext {
    return { signal: signal ?? new AbortController().signal, assertCurrent: () => {}, ...extra };
  }

  #requireActive(): Active {
    const active = this.#active;
    if (!active) throw fail("NO_SESSION", "请先连接 NAS", 401);
    return active;
  }

  async createDirectory(parent: Item, name: string, options: { signal?: AbortSignal } = {}): Promise<DirectoryCreation> {
    const active = this.#active;
    if (!active) throw fail("NO_SESSION", "请先连接 NAS", 401);
    if (!validDirectoryText(name, 255) || !name.trim() || name === "." || name === ".." || /[/\\]/.test(name) || secretText(name, active.token))
      throw fail("INVALID_DIRECTORY_NAME", "请输入有效的文件夹名称（最多 255 字节）");
    const path = parent?.path;
    if (!ordinaryDirectoryPath(path) || !["directory", "folder", "root"].includes(parent?.kind ?? "") || parent.metadata?.encrypted_path || secretText(path, active.token))
      throw fail("INVALID_DIRECTORY_PARENT", "请打开一个普通文件夹后再新建");
    const expected = `${path === "/" ? "" : path}/${name}`;
    if (!ordinaryDirectoryPath(expected) || secretText(expected, active.token)) throw fail("INVALID_DIRECTORY_NAME", "文件夹路径超出支持范围");
    const controller = new AbortController(), generation = this.#generation;
    const callerSignal = options.signal;
    const abort = () => controller.abort();
    callerSignal?.addEventListener("abort", abort, { once: true });
    if (callerSignal?.aborted) abort();
    const assertCurrent = () => {
      if (this.#active !== active || active.generation !== generation || generation !== this.#generation || controller.signal.aborted)
        throw fail("REQUEST_CANCELLED", "NAS 请求已中断，请刷新查看", 409);
    };
    const lock = JSON.stringify([active.public.sessionId, path, name]);
    let dispatched = false, ownsLock = false;
    try {
      assertCurrent();
      if (this.#directoryLocks.has(lock)) throw fail("DIRECTORY_IN_FLIGHT", "此文件夹请求正在处理，请稍候", 409);
      if (this.#directoryLocks.size >= 64) throw fail("DIRECTORY_LIMIT", "文件夹请求过多，请稍候再试", 429);
      this.#directoryLocks.set(lock, controller); ownsLock = true;
      this.#directoryRequests.add(controller);
      const context: DirectoryContext = { signal: controller.signal, assertCurrent };
      const info = directoryInfo(await this.#request(active.public.baseUrl, operations["files.info"], { path }, active, context));
      assertCurrent();
      if (!ordinaryDirectory(info, path)) throw fail("INVALID_DIRECTORY_PARENT", "NAS 未确认当前普通文件夹", 502);
      const envelope = record(await this.#request(active.public.baseUrl, { method: "POST", path: "/v2/file/newdir", params: "parent name rename" },
        { parent: path, name, rename: "0" }, active, { ...context, envelope: true, onDispatch: () => { dispatched = true; } }));
      assertCurrent();
      const data = record(envelope?.data), ts = directoryTimestamp(envelope?.ts), modified = directoryTimestamp(data?.modify_time);
      if (!data || data.path !== expected || !ordinaryDirectoryPath(data.path) || ts === undefined || modified === undefined ||
        Math.abs(Math.floor(ts / 1000) - modified) > 2)
        throw fail("DIRECTORY_UNVERIFIED", "文件夹结果尚未确认，请刷新查看", 502);
      const actual = directoryInfo(await this.#request(active.public.baseUrl, operations["files.info"], { path: expected }, active, context));
      assertCurrent();
      if (!ordinaryDirectory(actual, expected) || actual.name !== name)
        throw fail("DIRECTORY_UNVERIFIED", "文件夹结果尚未确认，请刷新查看", 502);
      const size = knownNumber(actual.size), update = knownNumber(actual.modify_time);
      // Whitelist actual readback fields. Never normalize a mutation result into
      // media/download capabilities or promote the clock guard to inode ownership.
      return { sessionId: active.public.sessionId, outcome: "directory-ready", item: {
        id: expected, name: actual.name as string, kind: "directory", path: actual.path as string,
        ...(size === undefined ? {} : { size }), metadata: { is_dir: true, ...(update === undefined ? {} : { modify_time: update }) },
      } };
    } catch (error) {
      const safe = error instanceof OfficialNasError ? error : fail("DIRECTORY_UNVERIFIED", "文件夹请求未完成，请刷新查看", 502);
      throw new OfficialNasError(safe.message, safe.code, safe.status, dispatched && safe.code !== "DIRECTORY_CONFLICT");
    } finally {
      callerSignal?.removeEventListener("abort", abort);
      this.#directoryRequests.delete(controller);
      if (ownsLock && this.#directoryLocks.get(lock) === controller) this.#directoryLocks.delete(lock);
    }
  }
  async read(
    operation: string,
    params: Record<string, unknown> = {},
  ): Promise<Collection> {
    const active = this.#active;
    if (!active) throw fail("NO_SESSION", "请先连接 NAS", 401);
    const original = Object.hasOwn(operations, operation)
      ? operations[operation]
      : undefined;
    if (!original)
      throw fail(
        "UNSUPPORTED_OPERATION",
        "当前官方 NAS 协议尚未验证此能力",
        501,
      );
    const op = { ...original },
      input = { ...params },
      form: Record<string, string> = {};
    if (operation === "notes.list" || operation === "recycle.list") {
      const page = input.page ?? 1, pageSize = input.pageSize ?? 20;
      const allowed = operation === "notes.list" ? ["page", "pageSize"] : ["scope", "page", "pageSize"];
      if (Object.keys(input).some(k => !allowed.includes(k)) || typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > 10000 || typeof pageSize !== "number" || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw fail("INVALID_PARAMS", "分页参数无效");
      Object.assign(form, { start: String((page - 1) * pageSize), num: String(pageSize) });
      if (operation === "notes.list") Object.assign(form, { location: "2", classify_id: "0", label_id: "", sortby: "1" });
      else {
        if (!["personal", "public"].includes(String(input.scope))) throw fail("INVALID_PARAMS", "回收站范围无效");
        form.path = input.scope === "personal" ? "/.recycle/my" : "/.public_recycle";
        if (input.scope === "public") op.path = "/v2/file/list";
      }
      for (const k of Object.keys(input)) delete input[k];
    }
    if (operation === "files.search") {
      // Keep indexed search options private; callers supply only this bounded
      // high-level contract, with an actual directory path when scoped.
      const { name, path, page = 1, pageSize = 20 } = input;
      const validText = (value: unknown, limit: number): value is string =>
        typeof value === "string" && !!value.trim() && value.length <= limit &&
        !/[\u0000-\u001f\u007f-\u009f]/.test(value);
      if (Object.keys(input).some(key => !["name", "path", "page", "pageSize"].includes(key)) ||
        typeof name !== "string" || !validText(name.trim(), 256) || /[\u0000-\u001f\u007f-\u009f]/.test(name) ||
        (Object.hasOwn(input, "path") && !validText(path, 8192)) ||
        typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > 10000 ||
        typeof pageSize !== "number" || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200)
        throw fail("INVALID_PARAMS", "文件搜索参数超出范围或包含不支持的选项");
      Object.assign(form, {
        name: name.trim(), file_path: path ?? "", start: String((page - 1) * pageSize), num: String(pageSize),
        order_by: "0", ftype: "", is_dir: "", min_size: "0", max_size: "0",
        shared_only: Object.hasOwn(input, "path") ? "0" : "2", show_hidden: "0",
      });
      for (const key of Object.keys(input)) delete input[key];
    }
    if (
      ["files.list", "files.recent", "photos.timeline", "photos.feeds", "photos.favorites", "video.list", "downloads.list"].includes(
        operation,
      )
    ) {
      const page = number(input.page ?? 1),
        size = number(input.pageSize ?? input.page_size ?? 20);
      if (
        !Number.isInteger(page) ||
        page < 1 ||
        page > 10000 ||
        !Number.isInteger(size) ||
        size < 1 ||
        size > 200
      )
        throw fail("INVALID_PARAMS", "分页参数超出范围");
      delete input.page;
      delete input.pageSize;
      delete input.page_size;
      form.start = String(
        (page - 1) * size + (operation === "video.list" ? 1 : 0),
      );
      form[
        operation === "video.list"
          ? "limit"
          : operation === "downloads.list"
            ? "size"
            : "num"
      ] = String(size);
      if (operation === "downloads.list") form.type = "loading";
      if (["photos.timeline", "photos.feeds", "photos.favorites"].includes(operation)) {
        form.sort = "id";
        form.order = "desc";
      }
    }
    if (operation === "files.recent") {
      form.scope = "1";
      form.show_hidden = "0";
      form.with_fields =
        "encrypted,encrypt_icon,duration,nshare,ori,ext,height,weight,type,is_sys,dw,labels";
    }
    for (let [key, value] of Object.entries(input)) {
      if (key === "pageSize") key = "page_size";
      if (
        !op.params.split(" ").includes(key) ||
        !["string", "number", "boolean"].includes(typeof value) ||
        (typeof value === "number" && !Number.isFinite(value))
      )
        throw fail("INVALID_PARAMS", "读取请求包含不支持的参数");
      if (
        ["page", "page_size"].includes(key) &&
        (!Number.isInteger(Number(value)) ||
          Number(value) < 1 ||
          Number(value) > (key === "page" ? 10000 : 200))
      )
        throw fail("INVALID_PARAMS", "分页参数超出范围");
      if (operation === "music.play" && key === "path") key = "file_path";
      form[key] = String(value);
    }
    if (["video.info", "video.files"].includes(operation)) {
      for (const key of ["collection_id", "classification_id"]) {
        const id = input[key];
        if (!((typeof id === "string" && id.trim()) ||
          (typeof id === "number" && Number.isFinite(id))))
          throw fail("INVALID_PARAMS", "设备未返回视频集合或媒体库标识，暂不能读取");
      }
    }
    if (operation === "video.info") form.get_type = "all";
    if (operation === "video.play") {
      if (typeof input.file_path !== "string" || !input.file_path.trim())
        throw fail("INVALID_PARAMS", "设备未返回视频文件路径，暂不能播放");
      Object.assign(form, playbackCodecs(), { from: "zvideo", play_env: "1" });
    }
    if(operation === "photos.smart")form.types="100,110,120,130,150";
    if(operation === "photos.favorites")form.liked="1";
    if(operation === "photos.timeline" && ((form.dir_id && !/^\d+$/.test(form.dir_id)) || (form.cdate_list && !/^\d{8}(,\d{8})*$/.test(form.cdate_list))))throw fail("INVALID_PARAMS","照片目录或日期标识无效");
    if (operation === "music.songs" && form.playlist_id) {
      op.method = "GET";
      op.path = "/zmusic/api/v2/playlist/record/list";
    }
    if (operation === "photos.feeds" && !form.album_id)
      op.path = "/v2/album/feed/list";
    if (operation === "music.play" && !form.dest_fmt) form.dest_fmt = "HQ";
    if (operation === "photos.albums") {
      // Current official album home returns the complete combine.list. These
      // UI paging arguments must not invent unsupported server parameters.
      delete form.page;
      delete form.page_size;
    }
    if (op.app) form.app = op.app;
    let storageVersion: string | undefined;
    if (operation === "system.storage") {
      const polling = record(await this.#request(
        active.public.baseUrl,
        { method: "POST", path: "/system/polling2", params: "" },
        {},
        active,
      ));
      if (this.#active !== active)
        throw fail("REQUEST_CANCELLED", "NAS 会话已改变，请刷新内容", 409);
      storageVersion = polling && text(polling, "sp_ver");
      if (!["v1", "v2", "v3"].includes(storageVersion ?? ""))
        throw fail("UNVERIFIED_STORAGE_VERSION", "当前存储版本尚未验证，暂不能读取存储详情", 501);
      if (storageVersion === "v3") op.path = "/zspool/info";
    }
    let data: unknown;
    if (operation === "apps.list") {
      // Official module 81792 combines these two read-only lists. Require both
      // requests to succeed so an unavailable Docker list is not shown as empty.
      const results = await Promise.all([
        this.#request(active.public.baseUrl, op, form, active),
        this.#request(
          active.public.baseUrl,
          { ...op, path: "/zdocker/AppStore/v1/list" },
          form,
          active,
        ),
      ]);
      const lists = results.map((result) => {
        const list = record(result)?.list;
        return Array.isArray(list) ? list : [];
      });
      const list = lists.flat();
      data = { list, count: list.length };
    } else {
      data = await this.#request(active.public.baseUrl, op, form, active);
    }
    if (this.#active !== active)
      throw fail("REQUEST_CANCELLED", "NAS 会话已改变，请刷新内容", 409);
    if (operation === "files.search") {
      const search = record(data);
      const total = knownNumber(search?.total);
      if (!search || !Array.isArray(search.list) || total === undefined || !Number.isInteger(total))
        throw fail("INVALID_RESPONSE", "NAS 文件搜索结果结构尚未验证", 502);
      for (const raw of search.list) {
        const row = record(raw);
        const path = row && clean(row.path, active.token);
        if (!row || typeof path !== "string" || !path.trim() || path.length > 8192 ||
          /[\u0000-\u001f\u007f-\u009f]/.test(path) ||
          ![true, false, 0, 1, "0", "1"].includes(row.is_dir as boolean | number | string))
          throw fail("INVALID_RESPONSE", "NAS 文件搜索结果结构尚未验证", 502);
      }
      const safe = clean(search, active.token) as RecordData;
      const mediaFields = new Set(["thumbnail", "thumb", "poster", "cover", "cover_url", "image_url", "song_cover", "stream", "stream_url", "play_url", "url", "uri"]);
      // Optional media fields can occur in arbitrary nested metadata. Search
      // exposes file identity; selected preview/download prepares capabilities.
      const prepareSearchData = (value: unknown): void => {
        if (Array.isArray(value)) {
          for (const item of value) prepareSearchData(item);
          return;
        }
        const object = record(value);
        if (!object) return;
        for (const [key, child] of Object.entries(object)) {
          if (mediaFields.has(key)) delete object[key];
          else if (["name", "file_name"].includes(key) && typeof child === "string") {
            // The indexed-search protocol wraps matches in these two markers.
            // Transform names only; identity and all other controls stay intact.
            object[key] = child.replace(/[\u0001\u0002]/g, "");
          } else prepareSearchData(child);
        }
      };
      prepareSearchData(safe);
      // Removing match markers can reconstruct a private token in a name.
      data = clean(safe, active.token);
    }
    if (operation === "files.roots") {
      // Official startup stores polling.pools, keeps mounted pools, and uses
      // /${key}/my/data as the personal root. Never derive paths from labels
      // or expose arbitrary device filesystem paths returned as other fields.
      const pools = record(data)?.pools;
      if (!Array.isArray(pools))
        throw fail("INVALID_RESPONSE", "NAS 文件存储池结构尚未验证", 502);
      const list: RecordData[] = [];
      for (const raw of pools) {
        const pool = record(raw);
        if (!pool || ![true, false, 0, 1].includes(pool.mounted as boolean | number))
          throw fail("INVALID_RESPONSE", "NAS 文件存储池结构尚未验证", 502);
        if (!pool.mounted) continue;
        const key = pool.key;
        if (
          typeof key !== "string" ||
          !key ||
          key === "." ||
          key === ".." ||
          /[/\\\s?#%\u0000-\u001f\u007f]/.test(key) ||
          (pool.name !== undefined && typeof pool.name !== "string")
        )
          throw fail("INVALID_RESPONSE", "NAS 文件存储池结构尚未验证", 502);
        list.push({
          id: key,
          name: pool.name || key,
          path: `/${key}/my/data`,
          mounted: pool.mounted,
          is_dir: true,
        });
      }
      data = { list, count: list.length };
    }
    if (operation === "photos.albums") {
      const list = record(record(data)?.combine)?.list;
      if (!Array.isArray(list))
        throw fail("INVALID_RESPONSE", "NAS 相册列表结构尚未验证", 502);
      data = { list, count: list.length };
    }
    if(operation === "photos.growth")data={list:Array.isArray(data)?data:[],count:Array.isArray(data)?data.length:0};
    if (operation === "notes.list") {
      const source = record(data);
      if (!Array.isArray(source?.list)) throw fail("INVALID_RESPONSE", "便签列表无法识别", 502);
      data = { total: source.total, list: source.list.map(record).filter(Boolean).map(row => ({ id: row!.id, title: row!.title, note_type: row!.note_type, updated_at: row!.updated_at, classify_id: row!.classify_id })) };
    }
    if (storageVersion) {
      const storage = record(data);
      if (!storage || (storageVersion === "v3" && !Array.isArray(storage.pool_list)))
        throw fail("INVALID_RESPONSE", "NAS 存储详情结构尚未验证", 502);
      data = { ...storage, sp_ver: storageVersion };
    }
    const collection = this.#normalize(data, operation, params, active);
    return this.#transport === "native" && operation !== "files.search"
      ? this.#nativeCollection(collection, data, active)
      : collection;
  }
  async createPhotoAlbum(input:{name:string;type:10|60;birthday?:string;gender?:"M"|"F";relationship?:string}):Promise<Item>{
    const active=this.#active;if(!active)throw fail("NO_SESSION","请先连接 NAS",401);
    const name=input.name.trim();if(!name||new TextEncoder().encode(name).length>60||/[\u0000-\u001f\u007f]/.test(name)||![10,60].includes(input.type))throw fail("INVALID_PARAMS","请输入有效相册名称，建议不超过20个字");
    const form:Record<string,string>={name,type:String(input.type),desc:""};
    if(input.type===60){const birthday=input.birthday||"";const parsed=new Date(birthday+"T00:00:00Z");if(!/^\d{4}-\d{2}-\d{2}$/.test(birthday)||Number.isNaN(parsed.getTime())||parsed.toISOString().slice(0,10)!==birthday||parsed.getTime()>Date.now()||!['M','F'].includes(input.gender||'')||!['爸爸','妈妈','家人'].includes(input.relationship||''))throw fail("INVALID_PARAMS","请填写宝宝生日、性别和你的身份");Object.assign(form,{birthday,gender:input.gender,iam:input.relationship,perm:"3",users:"[]",iams:"[]"})}
    let created:RecordData|undefined;
    try{created=record(await this.#request(active.public.baseUrl,{method:"POST",path:"/v2/album/album/create",params:""},form,active))}catch(error){if(error instanceof OfficialNasError&&error.code!=='INVALID_PARAMS'&&error.code!=='SESSION_EXPIRED')throw new OfficialNasError("创建结果尚未确认，请先刷新相册检查，避免重复创建",'PHOTO_CREATE_UNCONFIRMED',502,true);throw error}
    if(this.#active!==active)throw fail("REQUEST_CANCELLED","NAS 会话已改变",409);
    const id=String(created?.id??"");const list=await this.read("photos.albums");const item=list.items.find(i=>i.id===id&&i.name===name&&Number(i.metadata?.type)===input.type);if(!item)throw new OfficialNasError("创建结果尚未确认，请刷新相册检查",'PHOTO_CREATE_UNCONFIRMED',502,true);return item;
  }
  async musicArtwork(item:Item):Promise<Blob|null>{
    const active=this.#active;if(!active)throw fail("NO_SESSION","请先连接 NAS",401);
    let path=item.path;
    if(!path&&item.kind==="album"){
      const songs=await this.read("music.songs",{filter_type:"album",filter_value:item.id,page:1,pageSize:1});path=songs.items[0]?.path;
    }
    if(this.#active!==active)throw fail("REQUEST_CANCELLED","NAS 会话已改变",409);
    const urlText=this.#media(item.thumbnail||"",active);
    const load=async(url:URL,range?:string)=>{
      const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),15000);
      try{
        const res=await this.#fetcher(this.#proxyURL(url,active.public.baseUrl),{credentials:credentialsFor(active.public.baseUrl,this.#transport==="native"),redirect:"error",referrerPolicy:"no-referrer",headers:this.#headers(active,range?{Range:range}:{}),signal:controller.signal});
        if(!res.ok||res.redirected){await res.body?.cancel();return null}
        const reader=res.body?.getReader();if(!reader)return null;const chunks:Uint8Array[]=[];let length=0;
        try{while(length<6*1024*1024){const result=await reader.read();if(result.done)break;if(length+result.value.byteLength>6*1024*1024)return null;chunks.push(result.value);length+=result.value.byteLength}}finally{await reader.cancel().catch(()=>{})}
        if(this.#active!==active)throw fail("REQUEST_CANCELLED","NAS 会话已改变",409);
        const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
        return {bytes,type:res.headers.get("content-type")||""};
      }finally{clearTimeout(timeout)}
    };
    if(urlText){const url=new URL(urlText,active.public.baseUrl);if(url.origin===active.public.baseUrl){try{const loaded=await load(url);if(loaded&&/^image\/(jpeg|png|webp)$/.test(loaded.type.split(";")[0]))return new Blob([loaded.bytes],{type:loaded.type.split(";")[0]})}catch(error){if(this.#active!==active)throw error}}}
    if(!path||!path.startsWith("/")||path.startsWith("//")||!/[.](mp3|flac)$/i.test(path))return null;
    const url=new URL("/v2/file/download",active.public.baseUrl);url.searchParams.set("path",path);
    let loaded=await load(url,"bytes=0-262143");if(!loaded)return null;let picture=extractEmbeddedArtwork(loaded.bytes);
    const b=loaded.bytes;const tag=b[0]===73&&b[1]===68&&b[2]===51?10+b[6]*2097152+b[7]*16384+b[8]*128+b[9]:0;
    if(!picture&&tag>b.length&&tag<6*1024*1024){loaded=await load(url,`bytes=0-${tag-1}`);picture=loaded?extractEmbeddedArtwork(loaded.bytes):null}return picture;
  }
  async prepareDownload(item: Item): Promise<FileDownload> {
    const active = this.#active;
    if (!active) throw fail("NO_SESSION", "请先连接 NAS", 401);
    const safe = clean(item, active.token) as Item;
    const metadata = safe.metadata ?? {};
    const directory = safe.kind === "directory" || metadata.is_dir === true || String(metadata.is_dir ?? metadata.di) === "1";
    const encrypted = text(metadata, "encrypted_path") || (safe.path?.startsWith("E.") ? safe.path : "");
    const path = safe.path;
    if (directory || (!encrypted && (!path?.startsWith("/") || path.startsWith("//"))) ||
      (encrypted && !text(metadata, "from")))
      throw fail("INVALID_DOWNLOAD", "此项目缺少单文件下载身份", 400);
    let name: string, size: number | undefined;
    if (encrypted) {
      name = text(metadata, "name", "file_name");
      if (!name) throw fail("INVALID_DOWNLOAD", "加密文件缺少实际文件名", 400);
      size = knownNumber(metadata.size ?? metadata.s ?? safe.size);
    } else {
      const data = record(await this.#request(active.public.baseUrl, operations["files.info"], { path: path! }, active));
      if (this.#active !== active) throw fail("REQUEST_CANCELLED", "NAS 会话已改变，请刷新内容", 409);
      const actual = record(data?.info) ?? data;
      if (!actual || text(actual, "path") !== path || ![false, 0, "0"].includes(actual.is_dir as false | 0 | "0"))
        throw fail("INVALID_DOWNLOAD", "NAS 未返回有效单文件身份", 502);
      const cleanActual = clean(actual, active.token) as RecordData;
      name = text(cleanActual, "name");
      size = knownNumber(cleanActual.size);
    }
    if (!name || name.length > 255 || /[/\\\u0000-\u001f\u007f]/.test(name) || [".", ".."].includes(name))
      throw fail("INVALID_DOWNLOAD", "NAS 未返回有效文件名", 502);
    if (this.#active !== active) throw fail("REQUEST_CANCELLED", "NAS 会话已改变，请刷新内容", 409);
    const source = new URL(encrypted ? "/v2/file/decrypt/download" : "/v2/file/download", active.public.baseUrl);
    source.search = new URLSearchParams({ ...this.#common(active),
      ...(encrypted ? { encrypted_path: encrypted, from: text(metadata, "from") } : { path: path! }),
      request_purpose: "5", show_hidden: String(metadata.show_hidden ?? "0") === "1" ? "1" : "0",
    }).toString();
    let id: string;
    if (this.#transport === "native") {
      try {
        await this.#listenNativeMediaExpiry();
        if (this.#active !== active) throw 0;
        const { invoke } = await import("@tauri-apps/api/core");
        id = await invoke<string>("nas_download_register", {
          baseUrl: active.public.baseUrl, sourceUrl: source.href,
          cookie: this.#headers(active).get("Cookie"), sessionId: active.public.sessionId,
          name, ...(size === undefined ? {} : { size }),
        });
      } catch {
        if (this.#active !== active) {
          await this.#clearNativeMedia(active.public.sessionId);
          throw fail("REQUEST_CANCELLED", "NAS 会话已改变，请刷新内容", 409);
        }
        throw fail("DOWNLOAD_REGISTER_FAILED", "无法安全准备文件下载", 502);
      }
    } else {
      id = identifier() + identifier();
    }
    if (this.#active !== active) {
      await this.#clearNativeMedia(active.public.sessionId);
      throw fail("REQUEST_CANCELLED", "NAS 会话已改变，请刷新内容", 409);
    }
    if (!/^[a-f0-9]{64}$/.test(id)) throw fail("INVALID_DOWNLOAD_REFERENCE", "文件下载引用无效", 502);
    const descriptor = { id, name, ...(size === undefined ? {} : { size }), sessionId: active.public.sessionId };
    if (this.#downloads.size >= 4096) throw fail("DOWNLOAD_LIMIT", "文件下载引用已达上限，请重新登录", 429);
    this.#downloads.set(id, { ...(this.#transport === "browser" ? { source: this.#proxyURL(source, active.public.baseUrl) } : {}), active, descriptor });
    return { ...descriptor };
  }
  async fetchDownload(id: string, options: { signal?: AbortSignal } = {}): Promise<Response> {
    const reference = this.#downloads.get(id), active = this.#active;
    if (!/^[a-f0-9]{64}$/.test(id) || !reference || reference.active !== active || !active)
      throw fail("INVALID_DOWNLOAD_REFERENCE", "文件下载引用已失效", 409);
    if (this.#transport === "native") throw fail("NATIVE_DOWNLOAD_ONLY", "请通过系统保存对话框下载文件", 400);
    const controller = new AbortController();
    this.#downloadRequests.add(controller);
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const finish = () => { this.#downloadRequests.delete(controller); options.signal?.removeEventListener("abort", abort); };
    let response: Response;
    try {
      response = await this.#fetcher(reference.source!, { method: "GET", credentials: "omit", redirect: "error",
        referrerPolicy: "no-referrer", signal: controller.signal, headers: this.#headers(active) });
      if (this.#active !== active) throw fail("REQUEST_CANCELLED", "NAS 会话已改变，请刷新内容", 409);
      if (response.redirected || (response.url && new URL(response.url).origin !== new URL(reference.source!).origin) || (response.status >= 300 && response.status < 400))
        throw fail("DOWNLOAD_REDIRECT_BLOCKED", "文件下载重定向被拒绝", 502);
      if (response.status === 401 || response.status === 403) {
        this.#expire(active);
        throw fail("SESSION_EXPIRED", "NAS 登录已失效，请重新登录", 401);
      }
      if (response.status !== 200 && response.status !== 206) throw downloadFail("DOWNLOAD_HTTP_ERROR", "NAS 无法提供此文件", "DOWNLOAD_HTTP");
      const disposition = response.headers.get("Content-Disposition");
      const filename = downloadFilename(disposition ?? "");
      if (filename !== reference.descriptor.name)
        throw downloadFail("INVALID_DOWNLOAD_RESPONSE", "NAS 未返回可验证的文件响应", disposition === null ? "DOWNLOAD_DISPOSITION_MISSING" : filename === undefined ? "DOWNLOAD_DISPOSITION_INVALID" : "DOWNLOAD_FILENAME_MISMATCH");
      const encoding = response.headers.get("Content-Encoding");
      if (encoding && encoding.toLowerCase() !== "identity") throw downloadFail("INVALID_DOWNLOAD_RESPONSE", "NAS 文件编码无效", "DOWNLOAD_ENCODING");
      const rawLength = response.headers.get("Content-Length");
      const length = rawLength === null ? undefined : /^\d+$/.test(rawLength) ? knownNumber(rawLength) : undefined;
      if (rawLength !== null && length === undefined) throw downloadFail("INVALID_DOWNLOAD_RESPONSE", "NAS 文件长度无效", "DOWNLOAD_LENGTH_INVALID");
      const range = response.headers.get("Content-Range");
      let rangeSize: number | undefined;
      if (response.status === 206) {
        const match = /^bytes 0-(\d+)\/(\d+)$/.exec(range ?? "");
        rangeSize = match ? knownNumber(match[2]) : undefined;
        if (!match || !rangeSize || Number(match[1]) + 1 !== rangeSize)
          throw downloadFail("INVALID_DOWNLOAD_RESPONSE", "NAS 未提供完整文件范围", "DOWNLOAD_RANGE_INVALID");
      } else if (range) throw downloadFail("INVALID_DOWNLOAD_RESPONSE", "NAS 文件范围无效", "DOWNLOAD_RANGE_INVALID");
      const expected = reference.descriptor.size;
      if ((expected !== undefined && length !== undefined && expected !== length) ||
        (rangeSize !== undefined && ((expected !== undefined && expected !== rangeSize) || (length !== undefined && length !== rangeSize))))
        throw downloadFail("INVALID_DOWNLOAD_RESPONSE", "NAS 文件长度不匹配", "DOWNLOAD_SIZE_MISMATCH");
      const reader = response.body?.getReader();
      let received = 0;
      const body = new ReadableStream<Uint8Array>({
        pull: async stream => {
          try {
            if (this.#active !== active || controller.signal.aborted) throw fail("REQUEST_CANCELLED", "文件下载已中断", 409);
            const chunk = reader ? await reader.read() : { done: true, value: undefined };
            if (this.#active !== active || controller.signal.aborted) throw fail("REQUEST_CANCELLED", "文件下载已中断", 409);
            if (chunk.done) {
              if ([expected, length, rangeSize].some(size => size !== undefined && size !== received))
                throw downloadFail("INVALID_DOWNLOAD_RESPONSE", "文件下载不完整", received === 0 ? "DOWNLOAD_BODY_EMPTY" : "DOWNLOAD_SIZE_MISMATCH");
              finish(); stream.close();
            } else {
              received += chunk.value!.byteLength;
              if ([expected, length, rangeSize].some(size => size !== undefined && received > size))
                throw downloadFail("INVALID_DOWNLOAD_RESPONSE", "NAS 文件长度不匹配", "DOWNLOAD_SIZE_MISMATCH");
              stream.enqueue(chunk.value!);
            }
          } catch (error) { controller.abort(); finish(); await reader?.cancel().catch(() => {}); stream.error(error instanceof OfficialNasError ? error : downloadFail("DOWNLOAD_NETWORK", "文件下载已中断", "DOWNLOAD_TRANSPORT")); }
        },
        cancel: async () => { controller.abort(); finish(); await reader?.cancel().catch(() => {}); },
      });
      const headers = new Headers({ "Cache-Control": "no-store", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(reference.descriptor.name)}` });
      const mime = response.headers.get("Content-Type")?.split(";", 1)[0].trim();
      if (mime && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mime) && !secretText(mime, active.token)) headers.set("Content-Type", mime);
      if (length !== undefined) headers.set("Content-Length", String(length));
      if (rangeSize !== undefined) headers.set("Content-Range", `bytes 0-${rangeSize - 1}/${rangeSize}`);
      return new Response(body, { status: response.status, headers });
    } catch (error) {
      controller.abort(); finish();
      throw error instanceof OfficialNasError ? error : this.#active !== active ? fail("REQUEST_CANCELLED", "文件下载已中断", 502) : downloadFail("DOWNLOAD_NETWORK", "文件下载已中断", "DOWNLOAD_TRANSPORT");
    }
  }
  async imagePreview(item: Pick<Item, "path" | "name" | "size" | "metadata">): Promise<string> {
    const active = this.#active;
    if (!active) throw fail("NO_SESSION", "请先连接 NAS", 401);
    // Preview identity is supplied by the returned file, never inferred from a display label.
    const safe = clean(item, active.token) as ImageItem;
    const source = supportsImagePreview(safe) && previewSource(safe, "large");
    const url = source && this.#media(source, active);
    if (!url) throw fail("INVALID_IMAGE", "此项目缺少图片路径或暂不支持预览", 400);
    if (this.#transport === "native") return this.#registerNativeMedia(url, active);
    await Promise.resolve();
    if (this.#active !== active) throw fail("REQUEST_CANCELLED", "NAS 会话已改变，请刷新内容", 409);
    return url;
  }
  async imageOriginal(item: Item): Promise<string> {
    const active = this.#active;
    if (!active) throw fail("NO_SESSION", "请先连接 NAS", 401);
    const safe = clean(item, active.token) as Item;
    if (!supportsImagePreview(safe)) throw fail("INVALID_IMAGE", "此项目缺少图片身份", 400);
    const encrypted = text(safe.metadata ?? {}, "encrypted_path") || (safe.path?.startsWith("E.") ? safe.path : "");
    const source = new URL(encrypted ? "/v2/file/decrypt/download" : "/v2/file/download", active.public.baseUrl);
    // Official photo viewer.viewOrigin uses pub_album for encrypted photos;
    // feed rows commonly contain only the E. identity and actual filename.
    const from = text(safe.metadata ?? {}, "from") || "pub_album";
    if (!encrypted && !ordinaryDirectoryPath(safe.path)) throw fail("INVALID_IMAGE", "图片路径无法验证", 400);
    source.search = new URLSearchParams(encrypted ? { encrypted_path: encrypted, from, remote_port: "8050" } : { path: safe.path!, remote_port: "8050" }).toString();
    const url = this.#media(source.href, active);
    if (!url) throw fail("INVALID_IMAGE", "原图地址无法验证", 400);
    if (this.#transport === "native") return this.#registerNativeMedia(url, active);
    return url;
  }
  safeMediaUrl(value: unknown): string | undefined {
    const active = this.#active;
    if (!active || typeof value !== "string") return;
    if (this.#transport === "native")
      return this.#registeredNativeURIs.has(value) ? value : undefined;
    if (this.#ownedProxyURIs.has(value)) return value;
    return this.#officialMediaUrl(value, active);
  }
  #officialMediaUrl(value: unknown, active: Active): string | undefined {
    if (!active || typeof value !== "string" || !value) return;
    try {
      if (this.#ownedProxyURIs.has(value)) {
        const proxy = new URL(value);
        value =
          active.public.baseUrl +
          proxy.pathname.slice("/__nas".length) +
          proxy.search;
      }
      const url = new URL(value as string, active.public.baseUrl);
      if (
        url.origin !== active.public.baseUrl ||
        url.username ||
        url.password ||
        url.hash ||
        (url.searchParams.has("token") &&
          url.searchParams.get("token") !== active.token) ||
        !allowedMedia(url.pathname) ||
        /\.m3u8?(?:$|\/)/i.test(url.pathname)
      )
        return;
      return url.href;
    } catch {
      return;
    }
  }
  #media(value: unknown, active: Active): string | undefined {
    const safe = this.#officialMediaUrl(value, active);
    if (!safe) return;
    const url = new URL(safe);
    for (const [key, value] of Object.entries(this.#common(active)))
      url.searchParams.set(key, value);
    const wire = this.#proxyURL(url, active.public.baseUrl);
    if (wire !== url.href && this.#active === active)
      this.#ownedProxyURIs.add(wire);
    return wire;
  }
  #normalize(
    data: unknown,
    operation: string,
    params: Record<string, unknown>,
    active: Active,
  ): Collection {
    const root = record(data);
    let rows: unknown[] = Array.isArray(data) ? data : [];
    if (root) {
      for (const key of [
        ...(operation === "files.search" ? ["list"] : ["items", "list"]),
        "albums",
        "feeds",
        "songs",
        "tasks",
        "apps",
        ...(operation === "system.storage" ? ["pool_list"] : []),
        "data",
      ]) {
        if (Array.isArray(root[key])) {
          rows = root[key] as unknown[];
          break;
        }
      }
      if (!rows.length && operation !== "files.search") {
        const info = record(root.info);
        if (info) rows = [info];
        else if (
          text(
            root,
            "id",
            "name",
            "path",
            "title",
            "song_id",
            "file_path",
            "uri",
            "play_url",
          )
        )
          rows = [root];
      }
    }
    if (operation === "video.files") {
      const videos = root?.video_list,
        files = record(root?.file_list)?.list;
      if (!root ||
        (!Array.isArray(videos) && !Array.isArray(files)) ||
        (Object.hasOwn(root, "video_list") && !Array.isArray(videos)) ||
        (Object.hasOwn(root, "file_list") && !Array.isArray(files)))
        throw fail("INVALID_RESPONSE", "NAS 视频文件列表结构尚未验证", 502);
      rows = Array.isArray(videos) ? [...videos] : [];
      const videoCount = rows.length;
      const identity = (row: RecordData) => ({
        path: text(row, "path", "file_path", "song_path", "play_file_path"),
        kind: row.is_dir === true || String(row.is_dir ?? row.di) === "1" ? "directory" : "video",
        video: text(row, "video_id"),
        version: text(row, "version_id"),
        file: text(row, "file_id", "id"),
      });
      for (const raw of Array.isArray(files) ? files : []) {
        const file = record(raw);
        const incoming = file && identity(file);
        // Only reconcile cross-list representations sharing an actual path or
        // file identity. Explicit conflicting identities always remain separate.
        const index = incoming ? rows.findIndex((rawVideo, index) => {
          const video = index < videoCount && record(rawVideo);
          if (!video) return false;
          const current = identity(video);
          return current.kind === incoming.kind &&
            ["path", "video", "version", "file"].every(key => {
              const field = key as keyof typeof current;
              return !current[field] || !incoming[field] || current[field] === incoming[field];
            }) && !!((current.path && current.path === incoming.path) ||
              (current.file && current.file === incoming.file));
        }) : -1;
        if (index < 0) rows.push(raw);
        else {
          const video = record(rows[index])!;
          const completeness = (row: RecordData) =>
            Object.values(identity(row)).filter(Boolean).length;
          rows[index] = completeness(video) >= completeness(file!)
            ? { ...file, ...video }
            : { ...video, ...file };
        }
      }
    }
    const items: Item[] = [];
    const videoFiles = new Set<string>();
    for (const raw of rows) {
      const row = record(raw);
      if (!row) continue;
      const safe = clean(row, active.token) as RecordData;
      const imageOperation = operation.startsWith("files.") || operation.startsWith("photos.");
      if (!imageOperation) {
        delete safe.encrypted_path;
        if (row.encrypted_path !== undefined) delete safe.from;
      }
      if (operation === "video.files") {
        for (const key of ["collection_id", "classification_id"]) {
          if (safe[key] === undefined && text(params, key))
            safe[key] = clean(params[key], active.token);
        }
      }
      let name = text(
        safe,
        ...(operation === "video.files" ? ["file_name"] : []),
        // 歌曲行的字段是 song_name/song_title，而它同时带 album/album_name。
        // 之前 album 排在前面，导致歌曲列表显示的是专辑名（用户反馈"音乐显示不对"）。
        ...(operation.startsWith("music.") ? ["song_name", "song_title"] : []),
        "name",
        "title",
        "album_name",
        "album",
        "playlist_name",
        "song_name",
        "song_title",
        "classification_name",
        "file_name",
        "app_name",
        "n",
      );
      if (operation === "downloads.list") {
        if (!name && Array.isArray(safe.files) && safe.files.length === 1) {
          const file = record(safe.files[0]);
          if (file) name = text(file, "name");
        }
        const totalSize = number(safe.totalSize);
        if (totalSize > 0 && safe.completeSize !== undefined)
          safe.progress = Math.min(100, number(safe.completeSize) / totalSize * 100);
        if (safe.rateDownload !== undefined)
          safe.speed = number(safe.rateDownload);
      }
      if(operation === "photos.smart" && !name)name=Number(safe.type)===100?"未命名人物":"未命名分类";
      if(operation === "photos.folders" && !name)name=text(safe,"path").split("/").filter(Boolean).at(-1)||"相册文件夹";
      let path = text(safe, "path", "file_path", "song_path", "play_file_path");
      // Compatibility for a returned relative filename under the requested directory.
      // Titles and album labels are display data and cannot identify a file.
      const filename = text(safe, "name", "file_name", "n");
      if (!path && operation === "files.list" && filename && filename !== "." && filename !== ".." &&
        !/[/\\\u0000-\u001f\u007f]/.test(filename) && typeof params.path === "string" &&
        params.path.startsWith("/") && !params.path.startsWith("//"))
        path = `${params.path.replace(/\/$/, "")}/${filename}`;
      if (!path && operation === "downloads.list" && text(safe, "downloadDir"))
        path = `${text(safe, "downloadDir").replace(/\/$/, "")}/${name}`;
      path = String(clean(path, active.token));
      let kind =
        row.is_dir === true || String(row.is_dir ?? row.di) === "1"
          ? "directory"
          : operation.startsWith("photos.")
            ? "photo"
            : operation.startsWith("music.")
              ? "music"
              : operation.startsWith("video.")
                ? "video"
                : operation === "apps.list"
                  ? "app"
                  : operation === "downloads.list"
                    ? "download"
                    : "file";
      if (["photos.albums", "photos.smart", "music.albums"].includes(operation)) kind = "album";
      if (operation === "music.playlists") kind = "playlist";
      if (operation === "video.libraries") {
        kind = "library";
        // 影视库自带真实计数（collection_count 影片数 / series_count 剧集数），
        // 飞牛左栏「分类」右侧显示的就是这个数；没有计数就不放这个字段，由界面留空。
        const libraryCount = knownNumber(safe.collection_count ?? safe.series_count);
        if (libraryCount !== undefined) safe.count = libraryCount;
      }
      if (["files.roots","photos.folders"].includes(operation)) kind = "directory";
      if (operation === "system.storage") kind = "storage";
      const cover = text(
        row,
        ...(operation.startsWith("photos.") ? ["bb_cover","autograph_cover"] : []),
        "thumbnail",
        "thumb",
        "poster",
        "cover",
        "cover_url",
        "image_url",
        "song_cover",
        "album_cover",
      );
      const sizeValue = (operation === "downloads.list" ? safe.totalSize : undefined) ?? safe.size ?? safe.s ?? safe.song_size ?? safe.file_size ?? (operation === "system.storage" ? safe.total_size : undefined);
      const size = imageOperation ? knownNumber(sizeValue) : number(sizeValue);
      const imageItem = { name, path, kind, size, metadata: safe };
      const encryptedPath = text(row, "encrypted_path") || (path.startsWith("E.") ? path : "");
      const autoMedia = !["files.search", "notes.list", "recycle.list"].includes(operation);
      let thumbnail = autoMedia ? this.#media(cover, active) : undefined;
      if(autoMedia && !thumbnail && cover.startsWith("E."))thumbnail=this.#media(previewSource({name,path:cover,metadata:{encrypted_path:cover,from:"pub_album"}},"small"),active);
      if (
        autoMedia && !thumbnail &&
        cover.startsWith("/") &&
        !cover.startsWith("//") &&
        !cover.includes("?") &&
        !secretText(cover, active.token)
      )
        thumbnail = this.#media(
          previewSource({ name, path: cover, ...(cover === path ? { size, metadata: safe } : {}) }, "small"),
          active,
        );
      if (
        autoMedia && !thumbnail &&
        ((imageOperation && supportsImagePreview(imageItem)) || (!encryptedPath && /\.(mp4|mkv|mov)$/i.test(path)))
      )
        thumbnail = this.#media(
          previewSource(imageItem, "small"),
          active,
        );
      let stream = autoMedia ? this.#media(
        text(row, "stream", "stream_url", "play_url", "url", "uri"),
        active,
      ) : undefined;
      if (autoMedia && !stream && path && !encryptedPath && kind !== "directory" && kind !== "storage")
        stream = this.#media(
          `/v2/file/download?path=${encodeURIComponent(path)}`,
          active,
        );
      const id = operation === "files.search" ? path : operation === "video.files"
        ? JSON.stringify([
            path,
            kind,
            text(safe, "video_id"),
            text(safe, "version_id"),
            text(safe, "file_id", "id"),
          ])
        : text(
          safe,
          // A generic row ID may identify a list record rather than the song,
          // album or playlist required by the corresponding detail API.
          ...(operation === "music.songs" ? ["song_id"] : operation === "music.albums" ? ["album_id"] : operation === "music.playlists" ? ["playlist_id"] : []),
          "id",
          "file_id",
          "feed_id",
          "album_id",
          "playlist_id",
          "song_id",
          "collection_id",
          "classification_id",
          "app_name",
          "hash",
        ) || path;
      if (operation === "video.files") {
        if (videoFiles.has(id)) continue;
        videoFiles.add(id);
      }
      items.push({
        id,
        name,
        kind,
        path,
        thumbnail,
        backdrop: operation.startsWith("video.") ? this.#media(text(row, "backdrop", "backdrop_path"), active) : undefined,
        stream,
        size,
        metadata: safe,
      });
    }
    const values =
      record(clean(data, active.token)) ??
      (typeof data === "string" ? { text: clean(data, active.token) } : {});
    if (operation.startsWith("video.")) {
      const backdrop = this.#media(text(root ?? {}, "backdrop", "backdrop_path"), active);
      delete values.backdrop_path;
      if (backdrop) values.backdrop = backdrop;
      else delete values.backdrop;
    }
    if (
      operation !== "files.search" &&
      this.#transport === "browser" &&
      this.#devProxyTarget === active.public.baseUrl &&
      root
    ) {
      for (const key of ["stream", "url", "uri"])
        if (key in root) {
          const media = this.#media(root[key], active);
          if (media) values[key] = media;
          else delete values[key];
        }
    }
    // Preserve official semantics. DEV-only matching NAS transport may rewrite
    // resource paths to the fixed same-origin proxy; tokens are never persisted.
    return {
      items,
      total:
        root && (root.total !== undefined || root.count !== undefined)
          ? number(root.total ?? root.count)
          : undefined,
      values,
    };
  }

  async #nativeCollection(
    collection: Collection,
    data: unknown,
    active: Active,
  ): Promise<Collection> {
    const registrations = new Map<string, Promise<string>>();
    const register = (
      source: string | undefined,
    ): Promise<string | undefined> => {
      if (!source) return Promise.resolve(undefined);
      if (this.#active !== active)
        return Promise.reject(
          fail("REQUEST_CANCELLED", "NAS 会话已改变，请刷新内容", 409),
        );
      const previous = registrations.get(source);
      if (previous) return previous;
      const pending = this.#registerNativeMedia(source, active);
      registrations.set(source, pending);
      return pending;
    };
    const items = await Promise.all(
      collection.items.map(async (item) => ({
        ...item,
        thumbnail: await register(item.thumbnail),
        backdrop: await register(item.backdrop),
        stream: await register(item.stream),
      })),
    );
    const values = { ...collection.values };
    const original = record(data);
    for (const key of ["stream", "url", "uri", "backdrop"]) {
      if (original && key in original) {
        const source = this.#media(original[key], active);
        const uri = await register(source);
        if (uri) values[key] = uri;
        else delete values[key];
      }
    }
    if (this.#active !== active) {
      await this.#clearNativeMedia(active.public.sessionId);
      throw fail("REQUEST_CANCELLED", "NAS 会话已改变，请刷新内容", 409);
    }
    return { ...collection, items, values };
  }
  #listenNativeMediaExpiry(): Promise<void> {
    if (!this.#nativeExpiryListener) {
      const pending = import("@tauri-apps/api/event").then(async ({ listen }) => {
        await listen<string>("nas-media-session-expired", ({ payload }) => {
          const active = this.#active;
          if (!active || active.generation !== this.#generation || typeof payload !== "string" || !/^[a-zA-Z0-9_.-]{1,128}$/.test(payload) || payload !== active.public.sessionId) return;
          this.#expire(active);
          this.#onNativeSessionExpired?.(payload);
        });
      });
      this.#nativeExpiryListener = pending;
      pending.catch(() => { if (this.#nativeExpiryListener === pending) this.#nativeExpiryListener = undefined; });
    }
    return this.#nativeExpiryListener;
  }
  async #registerNativeMedia(
    sourceUrl: string,
    active: Active,
  ): Promise<string> {
    let uri: string;
    try {
      await this.#listenNativeMediaExpiry();
      if (this.#active !== active) throw fail("REQUEST_CANCELLED", "NAS 会话已改变，请刷新内容", 409);
      const { invoke } = await import("@tauri-apps/api/core");
      // Cookie comes exclusively from this SDK's own successful normal login.
      uri = await invoke<string>("nas_media_register", {
        baseUrl: active.public.baseUrl,
        sourceUrl,
        cookie: this.#headers(active).get("Cookie"),
        sessionId: active.public.sessionId,
      });
    } catch {
      if (this.#active !== active) {
        await this.#clearNativeMedia(active.public.sessionId);
        throw fail("REQUEST_CANCELLED", "NAS 会话已改变，请刷新内容", 409);
      }
      throw fail(
        "MEDIA_REGISTER_FAILED",
        "此媒体暂不能在原生界面安全读取",
        501,
      );
    }
    if (this.#active !== active) {
      await this.#clearNativeMedia(active.public.sessionId);
      throw fail("REQUEST_CANCELLED", "NAS 会话已改变，请刷新内容", 409);
    }
    try {
      const parsed = new URL(uri);
      const origin =
        (parsed.protocol === "nas-media:" && parsed.hostname === "localhost") ||
        (parsed.protocol === "http:" &&
          parsed.hostname === "nas-media.localhost");
      if (
        !origin ||
        parsed.port ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        !/^\/[a-f0-9]{64}$/.test(parsed.pathname)
      )
        throw 0;
    } catch {
      throw fail("INVALID_MEDIA_REFERENCE", "原生媒体引用无效", 502);
    }
    this.#registeredNativeURIs.add(uri);
    return uri;
  }
  /** For strict redirect protection use this fetch entrypoint, rather than letting a DOM element follow redirects. */
  async fetchMedia(
    value: unknown,
    options: { range?: string; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const active = this.#active;
    const generation = this.#generation;
    const url = active && this.#media(value, active);
    if (!active || !url)
      throw fail("INVALID_MEDIA_URL", "媒体地址不属于当前 NAS");
    let response: Response;
    try {
      response = await this.#fetcher(url, {
        method: "GET",
        credentials: credentialsFor(active?.public.baseUrl ?? "", this.#transport === "native"),
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: options.signal,
        headers: this.#headers(
          active,
          options.range ? { Range: options.range } : {},
        ),
      });
    } catch {
      throw fail("MEDIA_REDIRECT_OR_NETWORK", "无法安全读取 NAS 媒体", 502);
    }
    if (this.#active !== active || generation !== this.#generation)
      throw fail("REQUEST_CANCELLED", "NAS 会话已改变，请刷新内容", 409);
    if (
      response.redirected ||
      (response.url && new URL(response.url).origin !== new URL(url).origin) ||
      (response.status >= 300 && response.status < 400)
    )
      throw fail("MEDIA_REDIRECT_BLOCKED", "媒体重定向被拒绝", 502);
    if (response.status === 401 || response.status === 403) {
      if (this.#active === active) this.#expire(active);
      throw fail("SESSION_EXPIRED", "NAS 登录已失效，请重新登录", 401);
    }
    if (!response.ok && response.status !== 416)
      throw fail("NAS_HTTP_ERROR", "NAS 无法提供此媒体", 502);
    const mime = response.headers.get("Content-Type")?.toLowerCase() ?? "";
    if (/json|html|javascript|mpegurl|xml|svg/.test(mime))
      throw fail("UNSUPPORTED_MEDIA", "媒体格式尚需官方播放器适配", 501);
    return response;
  }
}
export const officialNas = new OfficialNas();
