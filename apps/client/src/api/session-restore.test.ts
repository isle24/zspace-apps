import { afterEach, describe, expect, it, vi } from "vitest";
import { officialFixture, officialJson } from "./direct-test-fixture";
import { OfficialNas } from "./official-nas";

afterEach(() => vi.restoreAllMocks());

/**
 * 刷新免登录：官方网页版把会话放在 cookie 里，我们读回来时必须**验证一次**再采用，
 * 验证不过要抛错（调用方据此清 cookie），绝不能把没验证过的 token 当成已登录。
 */
describe("restoreSession", () => {
  it("accepts a token that still reads the device", async () => {
    const fetcher = officialFixture((url) =>
      url.pathname === "/system/polling2"
        ? officialJson({ code: 200, data: { pools: [{ key: "nvme11", name: "M.2存储11", mounted: true }] } })
        : officialJson({ code: 200, data: {} }),
    );
    const nas = new OfficialNas(fetcher as unknown as typeof fetch);
    const session = await nas.restoreSession("http://nas.test:5055", "cookie-token", { username: "isle" });
    expect(session.baseUrl).toBe("http://nas.test:5055");
    expect(session.user).toMatchObject({ username: "isle" });
    expect(nas.sessionId).toBe(session.sessionId);
  });

  it("rejects an expired token so the caller can drop the cookie", async () => {
    const fetcher = officialFixture(() =>
      officialJson({ code: "N001208", msg: "token已失效", data: null }),
    );
    const nas = new OfficialNas(fetcher as unknown as typeof fetch);
    await expect(nas.restoreSession("http://nas.test:5055", "stale", {})).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
    });
    expect(nas.sessionId).toBe("");
  });

  it("refuses an obviously malformed token without touching the network", async () => {
    const fetcher = vi.fn();
    const nas = new OfficialNas(fetcher as unknown as typeof fetch);
    await expect(nas.restoreSession("http://nas.test:5055", "bad\u0000token", {})).rejects.toMatchObject({
      code: "INVALID_SESSION",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("media URL allowlist covers the measured playback prefixes", () => {
  it("accepts the audio and video uris the NAS actually returns", async () => {
    const { OfficialNas } = await import("./official-nas");
    const fetcher = officialFixture();
    const nas = new OfficialNas(fetcher as unknown as typeof fetch);
    // safeMediaUrl 只在有会话时才工作
    await nas.login("http://nas.test:5055", "synthetic-user", "synthetic-password");
    // 实测：音乐 /transcode/audio/play → /splay/<hash>；影视 /transcode/play → /play/m3u8/strm/<hash>
    expect(nas.safeMediaUrl("/splay/ZE.Sm3I6U4m2UdNOYJm2P58Rm3ytPxDJqCc9y6BzrlBwPm2aCd6XngJo9RR7m3E1GsaCgJm3asjHcVlbG1USPMddFWiEO"))
      .toContain("/splay/");
    expect(nas.safeMediaUrl("/play/m3u8/strm/CvDH84eeFm3XFdIy")).toContain("/play/m3u8/strm/");
    // 封面：影视 /zvideo_static/<id>/<id>_cover.jpg?t=…、音乐 /zmusic_static/<xx>/<hash>.jpg?u=…
    expect(nas.safeMediaUrl("/zvideo_static/27ae92e8c19b2b8/27ae92e8c19b2b8_cover.jpg?t=1790994034"))
      .toContain("/zvideo_static/");
    expect(nas.safeMediaUrl("/zmusic_static/5f/a1b066cd67915e65062d1a4eebbf51.jpg?u=17334"))
      .toContain("/zmusic_static/");
    expect(nas.safeMediaUrl("https://evil.example/x.mp4")).toBeUndefined();
  });
});

it("restores the NAS identity required for the store exchange after a page refresh",async()=>{
 const accept=vi.fn();
 const fetcher=officialFixture((url,init)=>{
  if(url.pathname==="/zhelper/state")return officialJson({code:200,data:{nasid:"synthetic"}});
  if(url.pathname==="/api/store/nas-session"){
   expect(JSON.parse(String(init.body)).nasId).toBe("synthetic");
   return officialJson({ok:true,data:{sessionId:"b".repeat(48),username:"owner",expiresAt:new Date(Date.now()+60000).toISOString(),authSource:"nas"}});
  }
  return officialJson({code:200,data:{pools:[]}});
 });
 const nas=new OfficialNas(fetcher,{storeSessionContext:async()=>({providerId:"http://nas.test:5055",storeBase:"http://shop.test",storeId:"a".repeat(48),assertCurrent:()=>{},accept})});
 await nas.restoreSession("http://nas.test:5055","cookie-token",{username:"fixture"});await nas.connectStoreWithNas();expect(accept).toHaveBeenCalledOnce();
});
it('restores this firmware without inventing a nasid on the public-key response',async()=>{const fetcher=vi.fn(async(input:any)=>{const url=new URL(String(input));if(url.pathname==='/key/pub')return officialJson({code:200,data:{key:'public',name:'NAS',sign:'challenge',br:'zspace'}});return officialJson({code:200,data:{pools:[]}})});const nas=new OfficialNas(fetcher as any);expect((await nas.restoreSession('http://nas.test:5055','cookie-token',{username:'owner'})).user.username).toBe('owner');expect(fetcher.mock.calls.some(c=>new URL(c[0]).pathname==='/key/pub')).toBe(false)});
