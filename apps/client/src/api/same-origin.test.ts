import { describe, expect, it, vi } from "vitest";
import { resolveNasOrigin, sameOriginNas, type OriginFacts } from "./same-origin";

const facts = (protocol: string, hostname: string, origin?: string): OriginFacts => ({
  protocol,
  hostname,
  origin: origin ?? `${protocol}//${hostname}`,
});

describe("same-origin NAS address", () => {
  it("uses the page origin when the client is served from the NAS", () => {
    expect(sameOriginNas(false, facts("http:", "192.168.3.56", "http://192.168.3.56:5055"))).toBe(
      "http://192.168.3.56:5055",
    );
    expect(sameOriginNas(false, facts("https:", "nas.example.com"))).toBe("https://nas.example.com");
    expect(sameOriginNas(false, facts("http:", "10.0.0.7", "http://10.0.0.7:5055"))).toBe(
      "http://10.0.0.7:5055",
    );
  });

  it("still asks for an address during local development", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "[::1]", "app.localhost"]) {
      expect(sameOriginNas(false, facts("http:", host))).toBe("");
    }
  });

  it("requires an explicit address in the native app and for non-http origins", () => {
    expect(sameOriginNas(true, facts("https:", "nas.example.com"))).toBe("");
    expect(sameOriginNas(false, facts("file:", ""))).toBe("");
    expect(sameOriginNas(false, facts("tauri:", "localhost"))).toBe("");
    expect(sameOriginNas(false, null)).toBe("");
  });
});

describe("deployment runtime config", () => {
  const facts = { protocol: "http:", hostname: "192.168.3.56", origin: "http://192.168.3.56:18436" };

  it("uses the configured NAS origin even though the page origin is the container", () => {
    // 容器部署：页面在 NAS 的 18436，接口在 5055，同源推断会得到错误的地址
    expect(resolveNasOrigin({ nasOrigin: "http://192.168.3.56:5055" }, false, facts)).toBe(
      "http://192.168.3.56:5055",
    );
  });

  it("tolerates a trailing slash and ignores unusable values", () => {
    expect(resolveNasOrigin({ nasOrigin: "http://192.168.3.56:5055/" }, false, facts)).toBe(
      "http://192.168.3.56:5055",
    );
    for (const bad of ["", "   ", "not-a-url", "ftp://x", "http://h:5055/some/path", 42, null]) {
      expect(resolveNasOrigin({ nasOrigin: bad }, false, facts)).toBe("http://192.168.3.56:18436");
    }
  });

  it("falls back to the same-origin rule when nothing is configured", () => {
    expect(resolveNasOrigin(null, false, facts)).toBe("http://192.168.3.56:18436");
    expect(
      resolveNasOrigin(null, false, { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" }),
    ).toBe("");
    expect(resolveNasOrigin(null, true, facts)).toBe("");
  });
});

describe("session restore helpers", () => {
  it("caches the deployment config so login and desktop agree on the origin", async () => {
    const { loadRuntimeConfig, resetRuntimeConfigCache } = await import("./same-origin");
    resetRuntimeConfigCache();
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ nasOrigin: "http://192.168.3.56:5055" }),
    });
    vi.stubGlobal("fetch", fetcher);
    const first = await loadRuntimeConfig();
    const second = await loadRuntimeConfig();
    expect(first).toEqual({ nasOrigin: "http://192.168.3.56:5055" });
    expect(second).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);   // 只取一次
    resetRuntimeConfigCache();
    vi.unstubAllGlobals();
  });

  it("returns null instead of throwing when the config is missing or broken", async () => {
    const { loadRuntimeConfig, resetRuntimeConfigCache } = await import("./same-origin");
    resetRuntimeConfigCache();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect(await loadRuntimeConfig()).toBeNull();
    resetRuntimeConfigCache();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await loadRuntimeConfig()).toBeNull();
    resetRuntimeConfigCache();
    vi.unstubAllGlobals();
  });
});
