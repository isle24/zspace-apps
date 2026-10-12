import { describe, expect, it } from "vitest";
import { OfficialNas } from "./official-nas";
import { officialFixture, officialJson } from "./direct-test-fixture";
async function session(read: Parameters<typeof officialFixture>[0]) {
  const nas = new OfficialNas(officialFixture(read));
  await nas.login("http://nas.test:5055", "fixture", "synthetic-password");
  return nas;
}
describe("official download engine", () => {
  it("selects an advertised engine through the official switch and reads its actual state", async () => {
    let current = 1; const writes: URLSearchParams[] = [];
    const nas = await session((url, init) => {
      if (url.pathname.endsWith("/get/setting")) return officialJson({ code: 200, data: { bt_engine_type: current, bt_engine_type_list: [{ type: 1, name: "Transmission", version: "4" }, { type: 2, name: "qBittorrent", version: "5" }] } });
      if (url.pathname.endsWith("/engin/switch/exec")) { const f = new URLSearchParams(String(init.body)); writes.push(f); current = Number(f.get("bt_engine_type")); }
      if (url.pathname.endsWith("/engin/switch/status")) return officialJson({ code: 200, data: { status: 5 } });
      return officialJson({ code: 200, data: { taskStatus: 0 } });
    });
    const result = await nas.switchDownloadEngine(2);
    expect(result.current).toBe(2); expect(result.status).toBe(5);
    expect(writes).toHaveLength(1); expect(writes[0].has("force")).toBe(false);
  });
  it("never forces a device-rejected switch or selects an unadvertised engine", async () => {
    const writes: string[] = [];
    const nas = await session((url) => {
      if (url.pathname.endsWith("/get/setting")) return officialJson({ code: 200, data: { bt_engine_type: 1, bt_engine_type_list: [{ type: 1, name: "Transmission" }] } });
      writes.push(url.pathname); return officialJson({ code: 200, data: {} });
    });
    await expect(nas.switchDownloadEngine(2)).rejects.toThrow(); expect(writes).toEqual([]);
  });
});
describe("official remote entries", () => {
  it("reads remoteAccess from NAS and replaces device loopback only for the opened address", async () => {
    const nas = await session((url, init) => {
      expect(url.pathname).toBe("/kv/load"); expect(new URLSearchParams(String(init.body)).get("k")).toBe("remoteAccess");
      return officialJson({ code: 200, data: { value: JSON.stringify([{ remarks: "NAS service", url: "127.0.0.1:8096/web", https: false, proxy: true, desktopVisible: true, color: "rgb(80, 183, 200)" }, { remarks: "Unsafe", url: "javascript:alert(1)" }]) } });
    });
    const rows = await nas.remoteEntries(); expect(rows[0].url).toBe("http://nas.test:8096/web"); expect(rows[0].name).toBe("NAS service"); expect(rows[0].proxy).toBe(true); expect(rows[1].url).toBeUndefined();
  });
});
describe("official notes", () => {
  it("lists note titles using regular notes location, without carrying bodies into summaries", async () => {
    const nas = await session((url, init) => {
      expect(url.pathname).toBe("/v2/file/notepad/list"); const form = new URLSearchParams(String(init.body));
      expect(form.get("location")).toBe("2"); expect(form.get("start")).toBe("20");
      return officialJson({ code: 200, data: { total: 1, list: [{ id: 9, title: "My note", body: "private body", in_brief: "private summary", note_type: 2 }] } });
    });
    const rows = await nas.read("notes.list", { page: 2, pageSize: 20 }); expect(rows.items[0].name).toBe("My note"); expect(JSON.stringify(rows)).not.toContain("private body"); expect(JSON.stringify(rows)).not.toContain("private summary");
  });
  it("creates Markdown notes with official identity and confirms the stored text", async () => {
    const writes: URLSearchParams[] = [];
    const nas = await session((url, init) => {
      if (url.pathname.endsWith("/new")) { writes.push(new URLSearchParams(String(init.body))); return officialJson({ code: 200, data: { id: 10 } }); }
      return officialJson({ code: 200, data: { id: 10, title: "New note", body: "Hello", note_type: 2, classify_id: 0 } });
    });
    const note = await nas.saveNote({ title: "New note", body: "Hello" }); expect(note.id).toBe("10"); expect(writes[0].get("note_type")).toBe("2"); expect(writes[0].get("location")).toBe("2");
  });
  it("refuses to overwrite a note changed by another client", async () => {
    let wrote = false;
    const nas = await session(url => { if (url.pathname.endsWith("/modify")) wrote = true; return officialJson({ code: 200, data: { id: 10, title: "Changed", body: "another client", note_type: 2, classify_id: 0 } }); });
    await expect(nas.saveNote({ id: "10", title: "Mine", body: "mine", expectedBody: "original", expectedTitle: "Original" })).rejects.toThrow(); expect(wrote).toBe(false);
  });
});
describe("official recycle bin", () => {
  it("reads the official personal bin and restores only a listed path using paths[]", async () => {
    let restored = false; const nas = await session((url, init) => {
      if (url.pathname === "/v2/file/nb/list") return officialJson({ code: 200, data: { list: restored ? [] : [{ path: "/.recycle/my/review", name: "review.txt", is_dir: false }], total: restored ? 0 : 1 } });
      expect(url.pathname).toBe("/v2/file/mrestore"); const f = new URLSearchParams(String(init.body)); expect(f.get("paths[]")).toBe("/.recycle/my/review"); expect(f.has("paths")).toBe(false); restored = true;
      return officialJson({ code: 200, data: { paths: ["/data_n001/my/data/review.txt"] } });
    });
    expect((await nas.read("recycle.list", { scope: "personal", page: 1, pageSize: 20 })).items).toHaveLength(1);
    expect(await nas.recycleAction({ scope: "personal", path: "/.recycle/my/review", action: "restore" })).toEqual({ accepted: true });
  });
  it("rejects an arbitrary filesystem path before any mutation", async () => {
    let wrote = false; const nas = await session(url => { if (url.pathname.includes("restore") || url.pathname.includes("remove")) wrote = true; return officialJson({ code: 200, data: { list: [], total: 0 } }); });
    await expect(nas.recycleAction({ scope: "personal", path: "/data_n001/my/data/user-file", action: "delete" })).rejects.toThrow(); expect(wrote).toBe(false);
  });
});
describe("official uninstall", () => {
  it("checks removable and dependencies and always retains application data", async () => {
    let installed = true; let remove: URLSearchParams | undefined;
    const nas = await session((url, init) => {
      if (url.pathname.endsWith("/list")) return officialJson({ code: 200, data: { list: [{ app_name: "backup", installed: +installed, removable: 1, status: installed ? "running" : "stop", local_info: { version: { version_int: 101 } } }] } });
      if (url.pathname.endsWith("/depend/by")) return officialJson({ code: 200, data: { apps: [] } });
      expect(url.pathname).toBe("/AppStore/v1/pkg/remove"); remove = new URLSearchParams(String(init.body)); installed = false; return officialJson({ code: 200, data: {} });
    });
    expect((await nas.uninstallApp({ appName: "backup", docker: false })).installed).toBe(false); expect(remove?.get("with_data")).toBe("0");
  });
});

describe("official original images and wide artwork", () => {
  it("prepares actual original download identities without inventing transcode formats", async () => {
    const nas = await session(() => officialJson({ code: 200, data: {} }));
    const ordinary = new URL(await nas.imageOriginal({ id: "photo", kind: "photo", name: "a.jpg", path: "/data_n001/my/data/a.jpg" }));
    expect(ordinary.pathname).toBe("/v2/file/download"); expect(ordinary.searchParams.get("remote_port")).toBe("8050"); expect(ordinary.searchParams.has("fmt")).toBe(false);
    const encrypted = new URL(await nas.imageOriginal({ id: "photo", kind: "photo", name: "a.jpg", path: "E.photo", metadata: { encrypted_path: "E.photo", from: "pub_album" } }));
    expect(encrypted.pathname).toBe("/v2/file/decrypt/download"); expect(encrypted.searchParams.get("from")).toBe("pub_album"); expect(encrypted.searchParams.get("encrypted_path")).toBe("E.photo");
  });
  it("sanitizes returned backdrop artwork independently from the poster", async () => {
    const nas = await session(() => officialJson({ code: 200, data: { list: [{ collection_id: "movie", name: "Movie", cover: "/zvideo_static/movie/poster.jpg", backdrop: "/zvideo_static/movie/wide.jpg" }], backdrop: "https://tracker.example/wide.jpg" } }));
    const list = await nas.read("video.list", { page: 1, pageSize: 20 }); expect(new URL(list.items[0].backdrop!).pathname).toBe("/zvideo_static/movie/wide.jpg"); expect(list.values?.backdrop).toBeUndefined();
  });
});
it("accepts a device physical personal-bin path after verifying official membership", async () => {
  const path = "/nvme1/.recycle/my/20261012-review.txt";
  let restored = false; const nas = await session((url, init) => {
    if (url.pathname === "/v2/file/nb/list") return officialJson({ code: 200, data: { list: [{ path, name: "review.txt" }], total: 1 } });
    expect(url.pathname).toBe("/v2/file/mrestore"); expect(new URLSearchParams(String(init.body)).get("paths[]")).toBe(path); restored = true; return officialJson({ code: 200, data: {} });
  });
  await nas.recycleAction({ scope: "personal", path, action: "restore" }); expect(restored).toBe(true);
});
it("uses the public recycle endpoint and fixed aggregate path", async () => {
  const nas = await session((url, init) => { expect(url.pathname).toBe("/v2/file/list"); expect(new URLSearchParams(String(init.body)).get("path")).toBe("/.public_recycle"); return officialJson({ code: 200, data: { list: [], total: 0 } }); });
  expect((await nas.read("recycle.list", { scope: "public", page: 1, pageSize: 20 })).items).toEqual([]);
});
it("reports an ambiguous note creation without permitting automatic retry", async () => {
  const nas = await session(() => { throw new Error("synthetic disconnected"); });
  await expect(nas.saveNote({ title: "New", body: "Body" })).rejects.toMatchObject({ code: "NOTE_UNCONFIRMED", mayHaveCreated: true });
});
it("treats omitted apps in a successful official dependency reply as no dependencies", async () => {
  let removed = false;
  const nas = await session(url => {
    if (url.pathname.endsWith("/list")) return officialJson({ code: 200, data: { list: [{ app_name: "backup", installed: removed ? 0 : 1, removable: 1, local_info: { version: { version_int: 101 } } }] } });
    if (url.pathname.endsWith("/remove")) removed = true;
    return officialJson({ code: 200, data: {} });
  });
  await nas.uninstallApp({ appName: "backup", docker: false }); expect(removed).toBe(true);
});
it("uses the official album origin for encrypted photo identities without a from field", async () => {
  const nas = await session(() => officialJson({ code: 200, data: {} }));
  const original = new URL(await nas.imageOriginal({ id: "1", name: "a.jpg", kind: "photo", path: "E.photo" }));
  expect(original.pathname).toBe("/v2/file/decrypt/download"); expect(original.searchParams.get("from")).toBe("pub_album");
});
it("fences an uninstall dependency read when the NAS session changes before dispatch", async () => {
  let finish!: (response: Response) => void; let removed = false;
  const nas = await session(url => {
    if (url.pathname.endsWith("/list")) return officialJson({ code: 200, data: { list: [{ app_name: "backup", installed: 1, removable: 1, local_info: { version: { version_int: 101 } } }] } });
    if (url.pathname.endsWith("/depend/by")) return new Promise<Response>(resolve => { finish = resolve; });
    if (url.pathname.endsWith("/remove")) removed = true;
    return officialJson({ code: 200, data: {} });
  });
  const result = nas.uninstallApp({ appName: "backup", docker: false });
  while (!finish) await Promise.resolve(); nas.logout(); finish(officialJson({ code: 200, data: { apps: [] } }));
  await expect(result).rejects.toMatchObject({ code: "REQUEST_CANCELLED" }); expect(removed).toBe(false);
});
it("does not expose remote entries after logout during the read", async () => {
  let finish!: (response: Response) => void;
  const nas = await session(() => new Promise<Response>(resolve => { finish = resolve; }));
  const result = nas.remoteEntries(); nas.logout(); finish(officialJson({ code: 200, data: { value: JSON.stringify([{ remarks: "Private service", url: "127.0.0.1:8096" }]) } }));
  await expect(result).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
});
