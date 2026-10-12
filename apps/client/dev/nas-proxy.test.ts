// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { createNasProxy } from "./nas-proxy";

const device = "1234567890abcdef1234567890abcdef";
const servers: Server[] = [];
async function server(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const value = createServer(handler);
  servers.push(value);
  value.listen(0, "127.0.0.1");
  await once(value, "listening");
  const address = value.address();
  if (!address || typeof address === "string") throw new Error("No test listener");
  return `http://127.0.0.1:${address.port}`;
}
async function proxy(target: string) {
  const middleware = createNasProxy(target);
  return server((req, res) => middleware(req, res, () => {
    res.statusCode = 404;
    res.end("next middleware");
  }));
}
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((value) => new Promise<void>((resolve) => {
    value.closeAllConnections();
    value.close(() => resolve());
  })));
});

describe("transparent official NAS development proxy", () => {
  it("forwards current video collection reads and playback descriptors without allowing collection mutations", async () => {
    const paths: string[] = [];
    const upstream = await server((req, res) => {
      paths.push((req.url || "").split("?", 1)[0]);
      res.setHeader("Content-Type", "application/json");
      res.end('{"success":true,"data":{}}');
    });
    const front = await proxy(upstream);
    for (const path of ["/zvideo/collection/info", "/zvideo/collection/video"]) {
      expect((await fetch(front + "/__nas" + path, { method: "POST", body: new URLSearchParams({ token: "synthetic-own", device_id: device, collection_id: "c1", classification_id: "l1" }) })).status).toBe(200);
    }
    expect((await fetch(front + "/__nas/transcode/play?token=synthetic-own&device_id=" + device)).status).toBe(200);
    expect((await fetch(front + "/__nas/zvideo/collection/delete", { method: "POST" })).status).toBe(403);
    expect(paths).toEqual(["/zvideo/collection/info", "/zvideo/collection/video", "/transcode/play"]);
  });
  it("forwards the official Docker application list but rejects Docker mutation routes", async () => {
    const paths: string[] = [];
    const upstream = await server((req, res) => {
      paths.push(req.url || "");
      res.setHeader("Content-Type", "application/json");
      res.end('{"success":true,"data":{"list":[]}}');
    });
    const front = await proxy(upstream);
    const response = await fetch(front + "/__nas/zdocker/AppStore/v1/list", { method: "POST", body: new URLSearchParams({ token: "synthetic-own", device_id: device }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { list: [] } });
    for (const path of ["/zdocker/AppStore/v1/remove", "/zdocker/AppStore/v1/install"]) {
      expect((await fetch(front + "/__nas" + path, { method: "POST" })).status).toBe(403);
    }
    expect(paths).toEqual(["/zdocker/AppStore/v1/list"]);
  });

  it("allows the verified photo and storage reads without widening mutation access", async () => {
    const paths: string[] = [];
    const upstream = await server((req, res) => {
      paths.push(req.url || "");
      res.setHeader("Content-Type", "application/json");
      res.end('{"success":true,"data":{}}');
    });
    const front = await proxy(upstream);
    for (const path of ["/v2/album/feed/list", "/v2/album/home", "/system/polling2", "/zspool/info"]) {
      expect((await fetch(front + "/__nas" + path, { method: "POST", body: new URLSearchParams({ token: "synthetic-own", device_id: device }) })).status).toBe(200);
    }
    for (const path of ["/v2/album/feed/remove", "/zspool/delete", "/system/reset"]) {
      expect((await fetch(front + "/__nas" + path, { method: "POST" })).status).toBe(403);
    }
    expect(paths).toEqual(["/v2/album/feed/list", "/v2/album/home", "/system/polling2", "/zspool/info"]);
  });

  it("accepts a fixed origin and rejects credentials, paths, queries and unsafe schemes", () => {
    expect(() => createNasProxy("http://127.0.0.1:5055")).not.toThrow();
    for (const target of ["http://user:secret@127.0.0.1:5055", "http://127.0.0.1:5055/a", "http://127.0.0.1:5055?token=secret", "http://127.0.0.1:5055#fragment", "file:///tmp/nas", "http://127.0.0.1:5055/../", "http://127.0.0.1:5055\n", "http://127.0.0.1:5055\\"]) {
      expect(() => createNasProxy(target)).toThrow("Invalid NAS development target");
    }
    expect(() => createNasProxy("http://127.0.0.1:5055", "//foreign")).toThrow();
  });

  it("keeps official form bytes, business JSON and HTTP status while bridging only request-owned credentials", async () => {
    const original = '{"success":false,"code":"N001208","message":"official byte order"}';
    let seen: { path?: string; body?: string; headers?: IncomingMessage["headers"] } = {};
    const upstream = await server((req, res) => void (async () => {
      seen = { path: req.url, body: await body(req), headers: req.headers };
      res.writeHead(403, { "Content-Type": "application/json", "Set-Cookie": "zenithtoken=upstream-persisted; Path=/", "Cache-Control": "public,max-age=3600" });
      res.end(original);
    })());
    const front = await proxy(upstream);
    const form = new URLSearchParams({ token: "own;cookie=value", device_id: device, path: "/中文目录" }).toString();
    const response = await fetch(front + "/__nas/v2/file/sysdir?plat=web", {
      method: "POST", body: form,
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: "zenithtoken=foreign", Authorization: "Bearer foreign", Origin: front, Referer: front + "/secret", "X-Secret": "foreign", "X-Forwarded-Host": "foreign.invalid" },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe(original);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(seen.path).toBe("/v2/file/sysdir?plat=web");
    expect(seen.body).toBe(form);
    expect(seen.headers?.cookie).toBe(`device_id=${device}; zenithtoken=own%3Bcookie=value`);
    for (const key of ["authorization", "origin", "referer", "x-secret", "x-forwarded-host"]) expect(seen.headers?.[key]).toBeUndefined();
    expect(seen.headers?.host).toBe(new URL(upstream).host);
  });

  it("preserves passive media bytes, Range and official query while constructing a stateless cookie", async () => {
    let seen: IncomingMessage["headers"] = {};
    let seenPath: string | undefined;
    const upstream = await server((req, res) => {
      seen = req.headers;
      seenPath = req.url;
      res.writeHead(206, { "Content-Type": "application/octet-stream", "Content-Range": "bytes 0-2/100", "Accept-Ranges": "bytes", ETag: '"official"' });
      res.end(Buffer.from([0, 1, 255]));
    });
    const front = await proxy(upstream);
    const query = `?token=synthetic-own&device_id=${device}&path=%2Fmusic%2Fsample.mp3`;
    const response = await fetch(front + "/__nas/v2/file/download" + query, { headers: { Range: "bytes=0-2", "If-Range": '"official"', Cookie: "zenithtoken=foreign" } });
    expect(response.status).toBe(206);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 1, 255]);
    expect(response.headers.get("content-range")).toBe("bytes 0-2/100");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(seen.range).toBe("bytes=0-2");
    expect(seen["if-range"]).toBe('"official"');
    expect(seen.cookie).toBe(`device_id=${device}; zenithtoken=synthetic-own`);
    expect(seenPath).toBe("/v2/file/download" + query);
  });

  it("does not follow or expose a foreign redirect while preserving its status and body", async () => {
    let foreignHits = 0;
    const foreign = await server((_req, res) => { foreignHits++; res.end("foreign"); });
    const upstream = await server((_req, res) => {
      res.writeHead(302, { Location: foreign + "/capture", Refresh: `0;url=${foreign}` });
      res.end("official redirect bytes");
    });
    const front = await proxy(upstream);
    const response = await fetch(front + "/__nas/key/pub", { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(await response.text()).toBe("official redirect bytes");
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("refresh")).toBeNull();
    expect(foreignHits).toBe(0);
  });

  it("rejects unsupported writes, unknown paths, encoded traversal and cross-origin browser requests before contacting NAS", async () => {
    let upstreamHits = 0;
    const upstream = await server((_req, res) => { upstreamHits++; res.end("unexpected"); });
    const front = await proxy(upstream);
    for (const [method, path] of [["DELETE", "/v2/file/sysdir"], ["POST", "/v2/file/delete"], ["GET", "/system"], ["POST", "/setting/save"], ["GET", "/unknown"], ["GET", "/play/%252e%252e/delete"], ["GET", "/play/%2fdelete"]]) {
      const response = await fetch(front + "/__nas" + path, { method });
      expect(response.status).toBe(403);
    }
    const crossOrigin = await fetch(front + "/__nas/key/pub", { headers: { Origin: "http://foreign.invalid" } });
    expect(crossOrigin.status).toBe(403);
    expect(upstreamHits).toBe(0);
    const unrelated = await fetch(front + "/outside-proxy");
    expect(unrelated.status).toBe(404);
    expect(await unrelated.text()).toBe("next middleware");
  });

  it("rejects oversized forms and conflicting credential parameters without forwarding them", async () => {
    let upstreamHits = 0;
    const upstream = await server((_req, res) => { upstreamHits++; res.end("unexpected"); });
    const front = await proxy(upstream);
    const oversized = await fetch(front + "/__nas/auth/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "x=" + "a".repeat(65_536) });
    expect(oversized.status).toBe(413);
    const duplicate = await fetch(front + "/__nas/v2/file/sysdir?token=foreign", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `token=own&device_id=${device}` });
    expect(duplicate.status).toBe(400);
    const wrongType = await fetch(front + "/__nas/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"token":"own"}' });
    expect(wrongType.status).toBe(415);
    expect(upstreamHits).toBe(0);
  });

  it("cancels the upstream media stream when the browser closes its response", async () => {
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const upstream = await server((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.write(Buffer.alloc(1024));
      const timer = setInterval(() => res.write(Buffer.alloc(1024)), 10);
      res.on("close", () => { clearInterval(timer); resolveClosed(); });
    });
    const front = await proxy(upstream);
    await new Promise<void>((resolve, reject) => {
      const client = request(front + "/__nas/play/synthetic-file", (res) => {
        res.once("data", () => { res.destroy(); client.destroy(); resolve(); });
      });
      client.on("error", reject);
      client.end();
    });
    await Promise.race([closed, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Upstream was not cancelled")), 1500).unref())]);
  });

  it("supports HEAD media and removes headers nominated by hop-by-hop Connection", async () => {
    let seen: IncomingMessage["headers"] = {};
    let seenMethod: string | undefined;
    const upstream = await server((req, res) => {
      seen = req.headers;
      seenMethod = req.method;
      res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": "42", Connection: "x-private", "X-Private": "synthetic-hidden" });
      res.end();
    });
    const front = await proxy(upstream);
    const response = await new Promise<{ status?: number; headers: IncomingMessage["headers"]; body: string }>((resolve, reject) => {
      const client = request(front + "/__nas/transcode/thumb", { method: "HEAD", headers: { Connection: "range", Range: "bytes=0-1" } }, (res) => {
        void body(res).then((value) => resolve({ status: res.statusCode, headers: res.headers, body: value }), reject);
      });
      client.on("error", reject);
      client.end();
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-length"]).toBe("42");
    expect(response.headers["x-private"]).toBeUndefined();
    expect(response.body).toBe("");
    expect(seenMethod).toBe("HEAD");
    expect(seen.range).toBeUndefined();
    expect(seen.cookie).toBeUndefined();
  });

  it("enforces the form body limit on chunked requests without Content-Length", async () => {
    let upstreamHits = 0;
    const upstream = await server((_req, res) => { upstreamHits++; res.end("unexpected"); });
    const front = await proxy(upstream);
    const status = await new Promise<number>((resolve, reject) => {
      const client = request(front + "/__nas/auth/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      client.on("error", reject);
      client.write("x=" + "a".repeat(40_000));
      client.end("b".repeat(30_000));
    });
    expect(status).toBe(413);
    expect(upstreamHits).toBe(0);
  });

  it("matches the official cookie converter for plus, slash and non-ASCII values", async () => {
    let seenCookie: string | undefined;
    const upstream = await server((req, res) => { seenCookie = req.headers.cookie; res.end("official"); });
    const front = await proxy(upstream);
    const params = new URLSearchParams({ device_id: device, token: "合成+token/=value;" });
    const response = await fetch(front + "/__nas/key/pub?" + params);
    expect(await response.text()).toBe("official");
    expect(seenCookie).toBe(`device_id=${device}; zenithtoken=%E5%90%88%E6%88%90+token/=value%3B`);
  });
});

it("permits only exact POST newdir while blocking neighboring mutations and methods", async () => {
  const seen: { path?: string; form?: string; method?: string }[] = [];
  const upstream = await server((req, res) => void (async () => {
    seen.push({ path: req.url, method: req.method, form: await body(req) });
    res.setHeader("Content-Type", "application/json"); res.end('{"success":true,"ts":1790000000000,"data":{"path":"/real/child","modify_time":1790000000}}');
  })());
  const front = await proxy(upstream);
  const form = new URLSearchParams({ token: "synthetic-own", device_id: device, parent: "/real", name: "child", rename: "0" }).toString();
  expect((await fetch(front + "/__nas/v2/file/newdir", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form })).status).toBe(200);
  for (const [method, path] of [["GET", "/v2/file/newdir"], ["HEAD", "/v2/file/newdir"], ["PUT", "/v2/file/newdir"], ["DELETE", "/v2/file/newdir"], ["POST", "/v2/file/newdir/child"], ["POST", "/v2/file/modify"], ["POST", "/v2/file/delete"], ["POST", "/v2/file/clean"], ["POST", "/v2/file/recycle"]])
    expect((await fetch(front + "/__nas" + path, { method })).status).toBe(403);
  expect(seen).toEqual([{ path: "/v2/file/newdir", method: "POST", form }]);
});


it("allows only the exact encrypted image thumb read route", async () => {
  const paths: string[] = [];
  const upstream = await server((req, res) => { paths.push(req.url || ""); res.setHeader("Content-Type", "image/jpeg"); res.end(Buffer.from([255, 216, 255])); });
  const front = await proxy(upstream);
  const path = "/transcode/decrypt/thumb?encrypted_path=E.synthetic&from=pub_album&dest_fmt=large&request_purpose=5";
  expect((await fetch(front + "/__nas" + path)).status).toBe(200);
  expect((await fetch(front + "/__nas" + path, { method: "HEAD" })).status).toBe(200);
  for (const [method, source] of [["POST", path], ["GET", "/transcode/decrypt/delete"], ["GET", "/transcode/decrypt/thumb/other"]])
    expect((await fetch(front + "/__nas" + source, { method })).status).toBe(403);
  expect((await fetch(front + "/__nas" + path, { headers: { Origin: "http://foreign.invalid" } })).status).toBe(403);
  expect(paths).toEqual([path, path]);
});

it("allows exact encrypted single-file GET download without neighboring writes or HEAD", async () => {
  const paths: string[] = [];
  const upstream = await server((req,res)=>{paths.push(req.url||"");res.setHeader("Content-Disposition",'attachment; filename="a.svg"');res.setHeader("Content-Type","image/svg+xml");res.end("<svg/>");});
  const front=await proxy(upstream);const path="/v2/file/decrypt/download?encrypted_path=E.synthetic&from=pub_album&webagent=v2&request_purpose=5&show_hidden=0";
  const response=await fetch(front+"/__nas"+path);expect(response.status).toBe(200);expect(await response.text()).toBe("<svg/>");
  for(const [method,source] of [["POST",path],["HEAD",path],["GET","/v2/file/decrypt/download/other"],["GET","/v2/file/decrypt/delete"]])
    expect((await fetch(front+"/__nas"+source,{method})).status).toBe(403);
  expect(paths).toEqual([path]);
});


it("allows only exact POST indexed search and blocks GET, slow search and writes", async () => {
  const paths: string[] = [];
  const upstream = await server((req, res) => { paths.push(req.method + " " + req.url); res.setHeader("Content-Type", "application/json"); res.end('{"success":true,"data":{"list":[],"total":0}}'); });
  const front = await proxy(upstream);
  const form = new URLSearchParams({ token: "synthetic-own", device_id: device, name: "中文 + &", file_path: "/real/folder", start: "20", num: "20" });
  expect((await fetch(front + "/__nas/file_search/file_search", { method: "POST", body: form })).status).toBe(200);
  for (const [method, path] of [
    ["GET", "/file_search/file_search"], ["HEAD", "/file_search/file_search"], ["DELETE", "/file_search/file_search"],
    ["POST", "/file_search/file_search/extra"], ["POST", "/file_search/reindex"], ["POST", "/file_search/save_setting"],
    ["POST", "/file_search/skip_dir"], ["POST", "/file_search/history/delete"],
    ["POST", "/file_search/slow_file_search/start"], ["POST", "/file_search/slow_file_search/get_result"],
  ]) expect((await fetch(front + "/__nas" + path, { method })).status).toBe(403);
  expect(paths).toEqual(["POST /file_search/file_search"]);
});

const uploadHeaders = (size = 3, seek = 0, terminal = true): Record<string, string> => ({ 'Content-Type': 'application/octet-stream', app: 'file', path: encodeURIComponent('/新目录/文件.bin'), token: encodeURIComponent('中% ;+=token'), plat: 'web', nasid: 'synthetic', version: '2.3.2026092801', device_id: device, device: encodeURIComponent('SpaceDesktop'), size: String(size), seek: String(seek), uuid: 'a'.repeat(40), rename: '0', split: '1', crtime: '', modify_time: '1790000001', 'remote-port': '8050', 'request-purpose': '4', ...(terminal ? { fileHash: 'b'.repeat(32), fileHashCheckOption: 'complete' } : {}) });
describe('fixed raw upload and header-auth tmpinfo proxy', () => {
    it('preserves nonUTF8 raw bytes and converts raw token exactly once to Cookie', async () => { let seen: any; const upstream = await server((req, res) => void (async () => { const chunks = []; for await (const chunk of req)
        chunks.push(Buffer.from(chunk)); seen = { path: req.url, headers: req.headers, bytes: Buffer.concat(chunks) }; res.end('{"success":true,"data":{}}'); })()); const front = await proxy(upstream); const bytes = new Uint8Array([0, 255, 128]); const response = await fetch(front + '/__nas/v2/file/upload?remote_port=8050', { method: 'POST', headers: { ...uploadHeaders(), Cookie: 'foreign', Authorization: 'foreign' }, body: bytes }); expect(response.status).toBe(200); expect(seen.bytes).toEqual(Buffer.from(bytes)); expect(seen.headers.token).toBe(encodeURIComponent('中% ;+=token')); expect(seen.headers.cookie).toBe(`device_id=${device}; zenithtoken=%E4%B8%AD%25%20%3B+=token`); expect(seen.headers.authorization).toBeUndefined(); expect(seen.headers.filehash).toBe('b'.repeat(32)); });
    it('allows explicit zero terminal raw body', async () => { let count = 0; const upstream = await server((req, res) => { count++; res.end('{}'); }); const front = await proxy(upstream); expect((await fetch(front + '/__nas/v2/file/upload?remote_port=8050', { method: 'POST', headers: uploadHeaders(0), body: new Uint8Array(0) })).status).toBe(200); expect(count).toBe(1); });
    it('tmpinfo has only once-encoded raw path and uuid, with private header auth', async () => { let seen: any; const upstream = await server((req, res) => { seen = { url: req.url, headers: req.headers }; res.end('{}'); }); const front = await proxy(upstream); const headers = uploadHeaders(); for (const k of ['Content-Type', 'path', 'size', 'seek', 'uuid', 'rename', 'split', 'crtime', 'modify_time', 'remote-port', 'request-purpose', 'fileHash', 'fileHashCheckOption'])
        delete headers[k]; const query = new URLSearchParams({ path: '/新目录/a% b', uuid: 'a'.repeat(40) }); expect((await fetch(front + '/__nas/v2/file/tmpinfo?' + query, { headers })).status).toBe(200); expect(new URL(seen.url, upstream).searchParams.get('path')).toBe('/新目录/a% b'); expect(seen.headers.cookie).toContain('zenithtoken=%E4%B8%AD%25'); });
    it.each(['remote_port=8051', 'remote_port=8050&remote_port=8050', 'remote_port=8050&token=x', '', 'remote_port=8050&path=x'])('rejects upload query %s before forwarding', async (q) => { let count = 0; const front = await proxy(await server((_req, res) => { count++; res.end('{}'); })); expect((await fetch(front + '/__nas/v2/file/upload?' + q, { method: 'POST', headers: uploadHeaders(), body: new Uint8Array(3) })).status).toBe(400); expect(count).toBe(0); });
    it.each([{ seek: '01' }, { seek: '-1' }, { size: '1' }, { fileHash: 'invalid' }, { fileHashCheckOption: 'quick' }, { rename: '1' }, { split: '0' }, { path: '%2fnew' }, { token: '%zz' }, { token: '%0A' }, { 'request-purpose': '3' }])('rejects malformed upload headers %#', async (change) => { let count = 0; const front = await proxy(await server((_req, res) => { count++; res.end('{}'); })); expect((await fetch(front + '/__nas/v2/file/upload?remote_port=8050', { method: 'POST', headers: { ...uploadHeaders(), ...change } as unknown as Record<string, string>, body: new Uint8Array(3) })).status).toBe(400); expect(count).toBe(0); });
    it('rejects missing terminal MD5 and premature terminal MD5', async () => { const front = await proxy(await server((_req, res) => res.end('{}'))); expect((await fetch(front + '/__nas/v2/file/upload?remote_port=8050', { method: 'POST', headers: uploadHeaders(3, 0, false), body: new Uint8Array(3) })).status).toBe(400); expect((await fetch(front + '/__nas/v2/file/upload?remote_port=8050', { method: 'POST', headers: uploadHeaders(4), body: new Uint8Array(3) })).status).toBe(400); });
    it('caps binary body at2MiB while preserving regular form limit', async () => { let count = 0; const front = await proxy(await server((_req, res) => { count++; res.end('{}'); })); expect((await fetch(front + '/__nas/v2/file/upload?remote_port=8050', { method: 'POST', headers: uploadHeaders((2 << 20) + 1), body: new Uint8Array((2 << 20) + 1) })).status).toBe(413); expect(count).toBe(0); });
});
describe('upload proxy adversarial envelope boundaries', () => {
    it('forwards full bounded binary piece without terminal fields', async () => { let length = 0; let headers: any; const front = await proxy(await server((req, res) => void (async () => { for await (const chunk of req)
        length += chunk.length; headers = req.headers; res.end('{}'); })())); expect((await fetch(front + '/__nas/v2/file/upload?remote_port=8050', { method: 'POST', headers: uploadHeaders((2 << 20) + 1, 0, false), body: new Uint8Array(2 << 20) })).status).toBe(200); expect(length).toBe(2 << 20); expect(headers.filehash).toBeUndefined(); });
    it('rejects duplicate raw authentication header fields', async () => { let count = 0; const front = await proxy(await server((_req, res) => { count++; res.end('{}'); })); const status = await new Promise<number>(resolve => { const outgoing = request(front + '/__nas/v2/file/upload?remote_port=8050', { method: 'POST', headers: { ...uploadHeaders(), token: [encodeURIComponent('a'), encodeURIComponent('b')] } }, reply => { reply.resume(); resolve(reply.statusCode!); }); outgoing.end(Buffer.alloc(3)); }); expect(status).toBe(400); expect(count).toBe(0); });
    it('request header budget fails honestly before upstream forwarding', async () => { let count = 0; const front = await proxy(await server((_req, res) => { count++; res.end('{}'); })); const status = await new Promise<number>(resolve => { const outgoing = request(front + '/__nas/v2/file/upload?remote_port=8050', { method: 'POST', headers: { ...uploadHeaders(), token: encodeURIComponent('中'.repeat(1900)) } }, reply => { reply.resume(); resolve(reply.statusCode!); }); outgoing.end(Buffer.alloc(3)); }); expect(status).toBe(431); expect(count).toBe(0); });
    it.each(['path=%2Fx&uuid=' + 'a'.repeat(40) + '&token=x', 'path=%2Fx&path=%2Fy&uuid=' + 'a'.repeat(40), 'path=%2Fx&uuid=a', 'path=%2Fx&uuid=' + 'a'.repeat(40) + '&uuid=' + 'a'.repeat(40)])('rejects tmpinfo duplicate/foreign query %s', async (q) => { const front = await proxy(await server((_req, res) => res.end('{}'))); expect((await fetch(front + '/__nas/v2/file/tmpinfo?' + q, { headers: uploadHeaders() })).status).toBe(400); });
    it('rejects encoded/subroutes/wrong methods and compressed raw bodies', async () => { let count = 0; const front = await proxy(await server((_req, res) => { count++; res.end('{}'); })); for (const route of ['/v2/file/%75pload', '/v2/file/upload/child', '/v2/file/upload/whyfail'])
        expect((await fetch(front + '/__nas' + route + '?remote_port=8050', { method: 'POST', headers: uploadHeaders(), body: Buffer.alloc(3) })).status).toBe(403); expect((await fetch(front + '/__nas/v2/file/upload?remote_port=8050', { headers: uploadHeaders() })).status).toBe(403); expect((await fetch(front + '/__nas/v2/file/upload?remote_port=8050', { method: 'POST', headers: { ...uploadHeaders(), 'content-encoding': 'gzip' }, body: Buffer.alloc(3) })).status).toBe(415); expect(count).toBe(0); });
    it('rejects compressed tmpinfo without forwarding nonofficial range headers', async () => { let count = 0; let headers: any; const front = await proxy(await server((req, res) => { count++; headers = req.headers; res.end('{}'); })); const query = new URLSearchParams({ path: '/new/file', uuid: 'a'.repeat(40) }); expect((await fetch(front + '/__nas/v2/file/tmpinfo?' + query, { headers: { ...uploadHeaders(), 'content-encoding': 'gzip' } })).status).toBe(415); expect(count).toBe(0); expect((await fetch(front + '/__nas/v2/file/tmpinfo?' + query, { headers: { ...uploadHeaders(), range: 'bytes=0-1' } })).status).toBe(200); expect(headers.range).toBeUndefined(); });
});
it.each([{ path: encodeURIComponent('/new/a\u0085b') }, { token: encodeURIComponent('a\u0085b') }])('rejects encoded Unicode control fields %#', async (change) => { let count = 0; const front = await proxy(await server((_req, res) => { count++; res.end('{}'); })); expect((await fetch(front + '/__nas/v2/file/upload?remote_port=8050', { method: 'POST', headers: { ...uploadHeaders(), ...change } as unknown as Record<string, string>, body: new Uint8Array(3) })).status).toBe(400); expect(count).toBe(0); });
