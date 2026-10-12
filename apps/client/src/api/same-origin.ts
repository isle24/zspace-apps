/**
 * 从 NAS 同源访问时，页面地址本身就是接口地址，登录页不需要再让用户填地址。
 *
 * 规则：
 * - 原生 Tauri 客户端没有“同源”概念，必须显式地址；
 * - localhost / 127.0.0.1 / ::1 是本地开发，必须显式地址（有 Vite 代理）；
 * - 其它 http(s) 来源视为部署在 NAS 上，直接使用当前 origin。
 */
export type OriginFacts = {
  protocol: string;
  hostname: string;
  origin: string;
};

export function sameOriginNas(
  native: boolean,
  facts: OriginFacts | null,
): string {
  if (native) return "";
  if (!facts) return "";
  if (!/^https?:$/.test(facts.protocol)) return "";
  const host = facts.hostname.toLowerCase();
  const isLoopback =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost");
  if (isLoopback) return "";
  return facts.origin;
}

/**
 * 部署期配置：容器/反代部署时，页面来源不是 NAS 本身（例如跑在 NAS 的 Docker 里的
 * http://<nas>:18436），此时必须由 `runtime-config.json` 明确给出接口地址。
 * 配置优先于同源推断；为空或非法则退回同源规则。
 */
export type RuntimeConfig = { nasOrigin?: unknown };

export function resolveNasOrigin(
  config: RuntimeConfig | null | undefined,
  native: boolean,
  facts: OriginFacts | null,
): string {
  const configured = typeof config?.nasOrigin === "string" ? config.nasOrigin.trim() : "";
  if (configured) {
    try {
      const url = new URL(configured);
      if (/^https?:$/.test(url.protocol) && url.origin === configured.replace(/\/+$/, "")) {
        return url.origin;
      }
    } catch {
      /* 配置非法时按未配置处理 */
    }
  }
  return sameOriginNas(native, facts);
}

export function originFacts(): OriginFacts | null {
  if (typeof location === "undefined") return null;
  return {
    protocol: location.protocol,
    hostname: location.hostname,
    origin: location.origin,
  };
}

/**
 * 读取部署期配置（`runtime-config.json`）。整个应用只取一次，登录页与桌面共用，
 * 避免"桌面按同源推断、登录页按配置"这种不一致。
 * 读不到时返回 null，调用方按同源规则处理。
 */
let runtimeConfigPromise: Promise<RuntimeConfig | null> | null = null;

export function loadRuntimeConfig(): Promise<RuntimeConfig | null> {
  runtimeConfigPromise ??= (async () => {
    try {
      const response = await fetch("runtime-config.json", { cache: "no-store", credentials: "omit" });
      if (!response?.ok) return null;
      const config = await response.json();
      return config && typeof config === "object" ? (config as RuntimeConfig) : null;
    } catch {
      return null;
    }
  })();
  return runtimeConfigPromise;
}

/** 测试用：清掉缓存。 */
export function resetRuntimeConfigCache() {
  runtimeConfigPromise = null;
}
