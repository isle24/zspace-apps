import { afterEach, describe, expect, it } from "vitest";
import {
  clearSessionCookie,
  cookieFacts,
  shouldUseSessionCookie,
  writeSessionCookie,
  type CookieFacts,
} from "./session-cookie";

/** 转码服务实测要求的一组客户端身份 cookie。 */
const identity = {
  token: "session-token-123",
  deviceId: "0123456789abcdef0123456789abcdef",
  device: "SpaceDesktop",
  version: "2.3.2026092801",
  plat: "web",
};

const same: CookieFacts = {
  origin: "http://192.168.3.56:18436",
  apiOrigin: "http://192.168.3.56:18436",
  native: false,
};
const cross: CookieFacts = { ...same, apiOrigin: "http://192.168.3.56:5055" };

const readCookie = () => document.cookie;

afterEach(() => {
  document.cookie = "token=; path=/; Max-Age=0";
});

describe("NAS session cookie", () => {
  it("only applies to a browser page that is same-origin with the API", () => {
    expect(shouldUseSessionCookie(same)).toBe(true);
    expect(shouldUseSessionCookie(cross)).toBe(false);      // 跨源发不出去
    expect(shouldUseSessionCookie({ ...same, native: true })).toBe(false);
    expect(shouldUseSessionCookie({ ...same, origin: "tauri://localhost" })).toBe(false);
    expect(shouldUseSessionCookie({ ...same, apiOrigin: "" })).toBe(false);
  });

  it("writes the token cookie the NAS gate expects", () => {
    writeSessionCookie(same, identity);
    expect(readCookie()).toContain("token=session-token-123");
  });

  it("does not write it for a cross-origin or native client", () => {
    writeSessionCookie(cross, identity);
    expect(readCookie()).not.toContain("session-token-123");
    writeSessionCookie({ ...same, native: true }, identity);
    expect(readCookie()).not.toContain("session-token-123");
  });

  it("clears it on logout and ignores an empty token", () => {
    writeSessionCookie(same, identity);
    clearSessionCookie(same);
    expect(readCookie()).not.toContain("session-token-123");
    writeSessionCookie(same, { ...identity, token: "" });
    expect(readCookie()).not.toContain("token=");
  });

  it("derives facts from the login address", () => {
    const facts = cookieFacts("http://192.168.3.56:5055", false);
    expect(facts.apiOrigin).toBe("http://192.168.3.56:5055");
    expect(typeof facts.origin).toBe("string");
  });
});

describe("client identity cookies required by the transcode service", () => {
  it("writes device_id, device, version and plat alongside the token", () => {
    writeSessionCookie(same, identity);
    const jar = document.cookie;
    expect(jar).toContain("device_id=0123456789abcdef0123456789abcdef");
    expect(jar).toContain("device=SpaceDesktop");
    expect(jar).toContain("version=2.3.2026092801");
    expect(jar).toContain("plat=web");
  });

  it("clears the whole set on logout", () => {
    writeSessionCookie(same, identity);
    clearSessionCookie(same);
    for (const name of ["token", "device_id", "device", "version", "plat"]) {
      expect(document.cookie).not.toContain(`${name}=`);
    }
  });

  it("still refuses to write anything cross-origin or in the native app", () => {
    writeSessionCookie(cross, identity);
    expect(document.cookie).not.toContain("device_id=");
    writeSessionCookie({ ...same, native: true }, identity);
    expect(document.cookie).not.toContain("device_id=");
  });
});
