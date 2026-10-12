/** Development-only transport for original official routes. No NAS REST service. */
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline } from "node:stream";
import type { Connect } from "vite";

const bodyLimit = 64 << 10;
const uploadBodyLimit = 2 << 20;
const uploadHeaderBudget = 16 << 10;
const timeout = 30_000;
const officialReads = new Map<string, string>([
  ["/key/pub", "GET"], ["/auth/login", "POST"],
  ["/file_search/file_search", "POST"],
  ["/v2/file/sysdir", "POST"], ["/v2/file/list", "POST"], ["/v2/file/info", "POST"], ["/v2/recent/list", "POST"],
  ["/v2/album/albums", "POST"], ["/v2/album/feed/timeline", "POST"], ["/v2/album/album/feeds", "POST"],
  ["/v2/album/feed/list", "POST"], ["/v2/album/home", "POST"], ["/system/polling2", "POST"], ["/zspool/info", "POST"],
  ["/system/recent", "POST"], ["/system/delay", "POST"],
  ["/manager/services", "POST"], ["/manager/v2/processes", "POST"], ["/task/list", "POST"],
  ["/zvideo/classification/list", "POST"], ["/zvideo/video/v2/list", "POST"], ["/zvideo/collection/v2/info", "POST"], ["/zvideo/video/media", "POST"],
  ["/zvideo/collection/info", "POST"], ["/zvideo/collection/video", "POST"],
  ["/zmusic/api/v2/song/list", "POST"], ["/zmusic/api/v2/album/list", "GET"], ["/zmusic/api/v2/playlist/list", "GET"], ["/zmusic/api/v2/song/info/lyrics", "GET"], ["/zmusic/api/v2/playlist/record/list", "GET"],
  ["/transcode/audio/play", "GET"], ["/downloader/list", "POST"], ["/system/home", "POST"], ["/storagepool/info2", "POST"], ["/network-settings/v1/interface/list", "GET"], ["/setting/load", "POST"], ["/AppStore/v1/list", "POST"], ["/zdocker/AppStore/v1/list", "POST"],
]);
for (const path of ["/setting/change", "/AppStore/v1/disks", ...["/AppStore/v1", "/zdocker/AppStore/v1"].flatMap(prefix => ["start", "stop", "restart", "depend/check", "install"].map(action => `${prefix}/pkg/${action}`))]) officialReads.set(path, "POST");
officialReads.set("/zdocker/app_check_port", "GET");
for (const path of ["/zdocker/AppStore/v1/pkg/preinstall", "/zdocker/AppStore/v1/pkg/install", "/zdocker/AppStore/v1/pkg/depend/check"]) officialReads.set(path, "POST");
const mediaPaths = new Set(["/transcode/thumb", "/transcode/decrypt/thumb", "/transcode/cover", "/v2/file/download", "/transcode/play", "/transcode/audio/stream"]);
for (const path of ["/kv/load", "/v2/file/notepad/list", "/v2/file/notepad/info", "/v2/file/notepad/new", "/v2/file/notepad/modify", "/v2/file/nb/list", "/v2/file/mrestore", "/v2/public/recycle/restore", "/v2/file/remove", "/downloader/engin/switch/exec", "/downloader/engin/switch/status", "/downloader/engin/switch/confirm", "/AppStore/v1/pkg/depend/by", "/AppStore/v1/pkg/remove", "/zdocker/AppStore/v1/pkg/remove"]) officialReads.set(path, "POST");
const mediaPrefixes = ["/play/", "/thumb/", "/zmusic/play/", "/zmusic/cover/", "/zvideo/play/"];
const hopHeaders = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const requestHeaders = new Set(["accept", "accept-language", "accept-encoding", "content-type", "range", "if-range", "if-modified-since", "if-none-match"]);
const suppressedResponseHeaders = new Set(["set-cookie", "set-cookie2", "location", "refresh", "cache-control", "expires", "pragma"]);

class TransportError extends Error {
  constructor(public status: number) { super("NAS development transport rejected"); }
}
function reject(res: ServerResponse, status: number) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  res.end("NAS development transport unavailable");
}
function origin(target: string) {
  try {
    // Check the original string too: URL would silently normalize /../ and controls.
    if (!/^https?:\/\/[^/?#\s\\]+\/?$/.test(target) || /[\x00-\x20\x7f]/.test(target)) throw 0;
    const value = new URL(target);
    if (!value.hostname || value.username || value.password || value.search || value.hash || value.pathname !== "/") throw 0;
    return new URL(value.origin);
  } catch {
    throw new Error("Invalid NAS development target");
  }
}
function browserIsLocal(req: IncomingMessage) {
  try {
    const host = new URL("http://" + req.headers.host);
    if (host.username || host.password || host.pathname !== "/" || host.search || host.hash || !["127.0.0.1", "localhost", "[::1]"].includes(host.hostname)) return false;
    const peer = req.socket.remoteAddress;
    if (peer && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer)) return false;
    return !req.headers.origin || req.headers.origin === host.origin;
  } catch { return false; }
}
function allowed(path: string, method: string) {
  if (path === "/v2/file/upload") return method === "POST";
  if (path === "/v2/file/tmpinfo") return method === "GET";
  if (path === "/v2/file/newdir") return method === "POST";
  if (officialReads.get(path) === method) return true;
  if (path === "/v2/file/decrypt/download") return method === "GET";
  return (method === "GET" || method === "HEAD") && (mediaPaths.has(path) || mediaPrefixes.some((prefix) => path.startsWith(prefix) && path.length > prefix.length));
}
function route(raw: string) {
  const path = raw.split("?", 1)[0];
  if (!path.startsWith("/") || path.includes("//") || /[\\\x00-\x20\x7f#]/.test(raw) || /%(?:2f|5c|25)/i.test(path)) throw new TransportError(403);
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { throw new TransportError(403); }
  if (/[\\\x00-\x20\x7f]/.test(decoded) || decoded.split("/").some((part) => part === "." || part === "..")) throw new TransportError(403);
  return path;
}
function readForm(req: IncomingMessage, limit = bodyLimit): Promise<Buffer> {
  return new Promise((resolve, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => finish(new TransportError(408)), timeout);
    const finish = (error?: TransportError) => {
      clearTimeout(timer);
      req.off("data", data);
      req.off("end", end);
      req.off("error", aborted);
      req.off("aborted", aborted);
      if (error) { req.resume(); rejectBody(error); } else resolve(Buffer.concat(chunks));
    };
    const data = (value: Buffer) => {
      size += value.length;
      if (size > limit) finish(new TransportError(413));
      else chunks.push(value);
    };
    const end = () => finish();
    const aborted = () => finish(new TransportError(400));
    req.on("data", data).once("end", end).once("error", aborted).once("aborted", aborted);
  });
}
// Exact js-cookie value converter used by official-nas.ts and the official bundle.
function cookieValue(value: string) {
  return encodeURIComponent(value).replace(/%(23|24|26|2B|3A|3C|3E|3D|2F|3F|40|5B|5D|5E|60|7B|7D|7C)/g, decodeURIComponent);
}
function cookie(query: URLSearchParams, form: URLSearchParams) {
  const parameter = (name: string) => {
    const values = [...query.getAll(name), ...form.getAll(name)];
    if (values.length > 1) throw new TransportError(400);
    return values[0] ?? "";
  };
  const device = parameter("device_id"), token = parameter("token");
  if ((device && !/^[a-f0-9]{32}$/i.test(device)) || token.length > 8192 || /[\x00-\x1f\x7f]/.test(token)) throw new TransportError(400);
  if (token && !device) throw new TransportError(400);
  return [device ? `device_id=${cookieValue(device)}` : "", token ? `zenithtoken=${cookieValue(token)}` : ""].filter(Boolean).join("; ");
}
const uploadAuthFields = ["app", "token", "plat", "nasid", "version", "device_id", "device"];
const uploadPieceFields = ["path", "size", "uuid", "seek", "crtime", "modify_time", "rename", "split", "remote-port", "request-purpose"];
function uploadNumber(value: string | undefined): number | undefined {
  if (value === undefined || !/^(0|[1-9]\d*)$/.test(value)) return;
  const result = Number(value); if (Number.isSafeInteger(result) && result >= 0) return result;
}
function uploadPath(value: string): boolean {
  if (!value.startsWith("/") || value.endsWith("/") || /[\\\u0000-\u001f\u007f-\u009f]/.test(value) || Buffer.byteLength(value) > 8192) return false;
  const components = value.slice(1).split("/");
  return components.every(v => !!v && v !== "." && v !== ".." && Buffer.byteLength(v) <= 255 && v === Buffer.from(v).toString("utf8"));
}
function encodedHeader(value: string): string {
  try {
    const raw = decodeURIComponent(value);
    if (encodeURIComponent(raw) !== value || /[\u0000-\u001f\u007f-\u009f]/.test(raw)) throw 0;
    return raw;
  } catch { throw new TransportError(400); }
}
function uploadTransportHeaders(req: IncomingMessage, path: string, query: URLSearchParams, payload: Buffer) {
  const upload = path === "/v2/file/upload";
  if (req.headers["content-encoding"]) throw new TransportError(415);
  if (req.headers["content-length"] !== undefined && uploadNumber(String(req.headers["content-length"])) !== payload.length) throw new TransportError(400);
  const keys = [...query.keys()];
  if (upload ? keys.length !== 1 || keys[0] !== "remote_port" || query.get("remote_port") !== "8050" : keys.length !== 2 || !keys.includes("path") || !keys.includes("uuid") || query.getAll("path").length !== 1 || query.getAll("uuid").length !== 1)
    throw new TransportError(400);
  if (!upload && (!uploadPath(query.get("path")!) || !/^[a-f0-9]{40}$/.test(query.get("uuid")!))) throw new TransportError(400);
  const fields = new Set([...uploadAuthFields, ...(upload ? [...uploadPieceFields, "filehash", "filehashcheckoption", "content-type"] : []), "content-length", "content-encoding"]);
  const seen = new Set<string>();
  let budget = 256;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index].toLowerCase(), value = req.rawHeaders[index + 1];
    budget += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (fields.has(name) && seen.has(name)) throw new TransportError(400);
    seen.add(name);
  }
  if (budget > uploadHeaderBudget) throw new TransportError(431);
  const headers: Record<string,string> = {};
  const nominated = connectionHeaders(req.headers.connection);
  for (const key of [...uploadAuthFields, ...(upload ? [...uploadPieceFields, "filehash", "filehashcheckoption", "content-type"] : [])]) {
    const value = req.headers[key];
    if (Array.isArray(value) || nominated.has(key)) throw new TransportError(400);
    if (value !== undefined) { if (/[\u0000-\u001f\u007f-\u009f]/.test(value) || value.length > 8192 * 3) throw new TransportError(400); headers[key] = value; }
  }
  for (const key of uploadAuthFields) if (!headers[key]) throw new TransportError(400);
  const token = encodedHeader(headers.token), deviceName = encodedHeader(headers.device);
  if (Buffer.byteLength(token) > 8192 || !token || !deviceName || headers.app !== "file" || headers.plat !== "web" || !/^[a-f0-9]{32}$/.test(headers.device_id) || !/^[a-zA-Z0-9_.-]{1,255}$/.test(headers.nasid) || !/^[0-9.]{1,64}$/.test(headers.version)) throw new TransportError(400);
  if (upload) {
    for (const key of uploadPieceFields) if (headers[key] === undefined) throw new TransportError(400);
    const size = uploadNumber(headers.size), seek = uploadNumber(headers.seek), modified = uploadNumber(headers.modify_time);
    if (!uploadPath(encodedHeader(headers.path)) || size === undefined || seek === undefined || modified === undefined || seek > size || payload.length > size - seek || (payload.length === 0 && size !== 0) || !/^[a-f0-9]{40}$/.test(headers.uuid) || headers.rename !== "0" || headers.split !== "1" || headers.crtime !== "" || headers["remote-port"] !== "8050" || headers["request-purpose"] !== "4") throw new TransportError(400);
    const terminal = seek + payload.length === size;
    if (terminal ? !/^[a-f0-9]{32}$/.test(headers.filehash ?? "") || headers.filehashcheckoption !== "complete" : headers.filehash !== undefined || headers.filehashcheckoption !== undefined) throw new TransportError(400);
  }
  return { headers, ownCookie: `device_id=${cookieValue(headers.device_id)}; zenithtoken=${cookieValue(token)}` };
}
function connectionHeaders(value: string | string[] | undefined) {
  return new Set((Array.isArray(value) ? value.join(",") : value ?? "").toLowerCase().split(",").map((part) => part.trim()));
}
async function forward(req: IncomingMessage, res: ServerResponse, destination: URL, raw: string, payload: Buffer, ownCookie: string, uploadHeaders?: Record<string,string>) {
  const headers: Record<string, string | string[]> = {};
  const nominated = connectionHeaders(req.headers.connection);
  for (const [name, value] of Object.entries(req.headers)) {
    if (!uploadHeaders && value !== undefined && requestHeaders.has(name) && !nominated.has(name)) headers[name] = value;
  }
  if (uploadHeaders) Object.assign(headers, uploadHeaders);
  if (ownCookie) headers.cookie = ownCookie;
  if (req.method === "POST") headers["content-length"] = String(payload.length);
  await new Promise<void>((resolve) => {
    let upstream: IncomingMessage | undefined;
    let timedOut = false;
    const outgoing = (destination.protocol === "https:" ? httpsRequest : httpRequest)(destination, {
      method: req.method, path: raw, headers, maxHeaderSize: 16 << 10,
    });
    outgoing.maxHeadersCount = 128;
    const headerTimer = setTimeout(() => { timedOut = true; outgoing.destroy(); }, timeout);
    const cancel = () => { if (!res.writableFinished) { upstream?.destroy(); outgoing.destroy(); } };
    const cleanup = () => {
      clearTimeout(headerTimer);
      req.off("aborted", cancel);
      res.off("close", cancel);
    };
    req.once("aborted", cancel);
    res.once("close", cancel);
    outgoing.setTimeout(timeout, () => { timedOut = true; upstream?.destroy(); outgoing.destroy(); });
    outgoing.once("error", () => { cleanup(); reject(res, timedOut ? 504 : 502); resolve(); });
    outgoing.once("response", (reply) => {
      clearTimeout(headerTimer);
      upstream = reply;
      const nominatedResponse = connectionHeaders(reply.headers.connection);
      for (const [name, value] of Object.entries(reply.headers)) {
        if (value !== undefined && !hopHeaders.has(name) && !nominatedResponse.has(name) && !suppressedResponseHeaders.has(name) && !name.startsWith("access-control-")) res.setHeader(name, value);
      }
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.statusCode = reply.statusCode ?? 502;
      if (reply.statusMessage) res.statusMessage = reply.statusMessage;
      // Node HTTP never follows redirects; suppress Location/Refresh so DOM cannot either.
      pipeline(reply, res, () => { cleanup(); resolve(); });
    });
    outgoing.end(payload);
  });
}

export function createNasProxy(target: string, prefix = "/__nas"): Connect.NextHandleFunction {
  const destination = origin(target);
  if (!/^\/[a-zA-Z0-9_-]+$/.test(prefix)) throw new Error("Invalid NAS development prefix");
  return (req, res, next) => {
    const url = req.url ?? "";
    if (url !== prefix && !url.startsWith(prefix + "/") && !url.startsWith(prefix + "?")) { next(); return; }
    void (async () => {
      if (!browserIsLocal(req)) throw new TransportError(403);
      const raw = url.slice(prefix.length);
      const path = route(raw);
      const method = req.method ?? "";
      if (!allowed(path, method)) throw new TransportError(403);
      const rawUpload = path === "/v2/file/upload", headerAuth = rawUpload || path === "/v2/file/tmpinfo";
      const limit = rawUpload ? uploadBodyLimit : bodyLimit;
      let payload: Buffer = Buffer.alloc(0);
      if (method === "POST") {
        if (req.headers["content-encoding"] || (req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase() !== (rawUpload ? "application/octet-stream" : "application/x-www-form-urlencoded")) throw new TransportError(415);
        if (Number(req.headers["content-length"] ?? 0) > limit) throw new TransportError(413);
        payload = await readForm(req, limit);
      } else if (Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"]) throw new TransportError(400);
      if (req.aborted || res.destroyed) return;
      const query = new URL(raw, destination).searchParams;
      if (headerAuth) {
        const { headers, ownCookie } = uploadTransportHeaders(req, path, query, payload);
        await forward(req, res, destination, raw, payload, ownCookie, headers);
      } else {
        const form = new URLSearchParams(payload.toString("utf8"));
        await forward(req, res, destination, raw, payload, cookie(query, form));
      }
    })().catch((error: unknown) => {
      req.resume();
      reject(res, error instanceof TransportError ? error.status : 502);
    });
  };
}
