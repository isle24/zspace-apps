/**
 * 官方网页版把会话保存在一个 JS 写的 cookie 里（`document.cookie = "token=<会话令牌>; path=/"`），
 * 极空间 nginx 的 auth.lua 会读全部 cookie 去 /auth/token 校验后放行 /v2/、/zmusic/、/zvideo/、
 * /downloader/、/storagepool/、/network-settings/ 等受保护路由（实测：带 `Cookie: token=…` 返回 200，
 * 不带则 403）。客户端此前用 `credentials: "omit"`，既不存也不发 cookie，因此这些窗口在
 * 同源部署下会报「无法直接连接 NAS」。
 *
 * 规则：
 * - 只在浏览器（非原生）里写；
 * - 只在接口与页面**同源**时写——跨源时 cookie 既发不出去也没有意义；
 * - 退出时删除。
 */
export type CookieFacts = { origin: string; apiOrigin: string; native: boolean };

export function shouldUseSessionCookie(facts: CookieFacts): boolean {
  if (facts.native) return false;
  if (!facts.origin || !facts.apiOrigin) return false;
  if (!/^https?:/.test(facts.origin)) return false;
  return facts.origin === facts.apiOrigin;
}

export type IdentityCookies = {
  token: string;
  deviceId: string;
  device: string;
  version: string;
  plat: string;
};

/**
 * 官方网页版把客户端身份也放在 cookie 里，转码服务（/transcode/*）会校验它们：
 * 实测只带 `token` 调 `/transcode/play` 返回 `T000001 参数错误`，
 * 补上 `device_id`/`device`/`version`/`plat` 后返回 200 与 HLS 播放地址。
 * 这同时解释了缩略图 400（同一个服务）。
 *
 * 所以登录后按官方同样的一组 cookie 写入；仍然只在浏览器且同源时写。
 */
export function writeSessionCookie(facts: CookieFacts, identity: IdentityCookies): void {
  if (!identity.token || !shouldUseSessionCookie(facts)) return;
  if (typeof document === "undefined") return;
  const pairs: Array<[string, string]> = [
    ["token", identity.token],
    ["device_id", identity.deviceId],
    ["device", identity.device],
    ["version", identity.version],
    ["plat", identity.plat],
  ];
  try {
    // path=/ 才能覆盖全部接口路径；不设 domain，绑定当前主机
    for (const [name, value] of pairs) {
      if (!value) continue;
      document.cookie = `${name}=${encodeURIComponent(value)}; path=/; SameSite=Lax`;
    }
  } catch {
    /* cookie 不可用时（隐私模式）不影响内存中的会话 */
  }
}

export function clearSessionCookie(facts: CookieFacts): void {
  if (!shouldUseSessionCookie(facts)) return;
  if (typeof document === "undefined") return;
  try {
    for (const name of ["token", "device_id", "device", "version", "plat"]) {
      document.cookie = `${name}=; path=/; Max-Age=0; SameSite=Lax`;
    }
  } catch {
    /* 同上 */
  }
}

export function cookieFacts(baseUrl: string, native: boolean): CookieFacts {
  const origin = typeof location === "undefined" ? "" : location.origin;
  let apiOrigin = "";
  try {
    apiOrigin = new URL(baseUrl).origin;
  } catch {
    apiOrigin = "";
  }
  return { origin, apiOrigin, native };
}

/**
 * 取数请求的凭证策略：**只有**接口与页面同源时才允许携带 cookie（反代部署下 /v2/ 等
 * 受保护路由需要它），跨源一律 "omit"，保持"凭证不出本机页面来源"的既有约束。
 */
export function credentialsFor(baseUrl: string, native: boolean): RequestCredentials {
  if (native) return "omit";
  const origin = typeof location === "undefined" ? "" : location.origin;
  if (!origin || !/^https?:/.test(origin)) return "omit";
  try {
    // 同源（含端口）才放宽；反代部署时页面与接口是同一个 origin
    return new URL(baseUrl).origin === origin ? "same-origin" : "omit";
  } catch {
    return "omit";
  }
}
