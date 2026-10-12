import { useEffect, useState } from "react";
import { ArrowClockwise, MagnifyingGlass } from "@phosphor-icons/react";
import { api, message } from "../api/client";
export function useResource<T>(loader: () => Promise<T>, keys: unknown[]) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    setData(undefined);
    loader()
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setError(message(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [...keys, revision]);
  return { data, error, loading, reload: () => setRevision((n) => n + 1) };
}
export function Status({
  error,
  loading,
  empty = false,
  connected = true,
  retry,
  disconnected,
}: {
  error?: string;
  loading?: boolean;
  empty?: boolean;
  connected?: boolean;
  retry?: () => void;
  disconnected?: { title: string; detail: string };
}) {
  if (loading)
    return (
      <div className="state-panel" role="status">
        <span className="spinner" />
        <h3>正在读取设备数据</h3>
        <p>连接你的私人空间</p>
      </div>
    );
  if (!connected)
    return (
      <div className="state-panel">
        <StateArt kind="offline" />
        <h3>{disconnected?.title || "连接 NAS，打开你的空间"}</h3>
        <p>{disconnected?.detail || "当前未连接设备。登录后即可读取真实内容。"}</p>
      </div>
    );
  if (error)
    return (
      <div className="state-panel error" role="alert">
        <StateArt kind="denied" />
        <h3>暂时无法读取</h3>
        <p>{error}</p>
        {retry && (
          <button className="primary" onClick={retry}>
            <ArrowClockwise />
            重新读取
          </button>
        )}
      </div>
    );
  if (empty)
    return (
      <div className="state-panel">
        <StateArt kind="empty" />
        <h3>这里还没有内容</h3>
        <p>设备返回的列表为空</p>
      </div>
    );
  return null;
}
/**
 * 飞牛 fnOS 真实空状态插画（取自用户本机 /usr/trim/www/assets）。
 * 深浅色各一套，通过 <picture> 让浏览器按 data-theme 选择。
 */
export function StateArt({
  kind,
}: {
  kind: "empty" | "offline" | "denied" | "media" | "search";
}) {
  const light: Record<typeof kind, string> = {
    empty: "/state/empty-light.png",
    offline: "/state/offline-light.png",
    denied: "/state/denied-light.png",
    media: "/state/media-light.png",
    search: "/state/search-light.png",
  };
  const dark: Record<typeof kind, string> = {
    empty: "/state/empty-dark.svg",
    offline: "/state/offline-dark.png",
    denied: "/state/denied-dark.png",
    media: "/state/media-dark.png",
    search: "/state/search-dark.png",
  };
  return (
    <span className="state-art" aria-hidden="true">
      <img className="state-art-light" src={light[kind]} alt="" />
      <img className="state-art-dark" src={dark[kind]} alt="" />
    </span>
  );
}
export function Search({
  value,
  onChange,
  placeholder = "搜索当前内容",
}: {
  value: string;
  onChange: (s: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="search">
      <MagnifyingGlass />
      <input
        aria-label={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}
export function DataValues({ data }: { data: unknown }) {
  const values =
    data && typeof data === "object"
      ? "values" in data
        ? (data as any).values
        : data
      : undefined;
  if (!values || typeof values !== "object")
    return <p className="muted">设备尚未返回可识别的详细信息。</p>;
  return (
    <dl className="data-values">
      {Object.entries(values)
        .filter(
          ([key]) => !/(token|password|secret|cookie|authorization)/i.test(key),
        )
        .map(([key, value]) => (
          <div key={key}>
            <dt>{labels[key] || key}</dt>
            <dd>{dataValueText(value)}</dd>
          </div>
        ))}
    </dl>
  );
}

/*
 * 值的显示方式。
 *
 * 以前对象一律 `JSON.stringify` ——「设备应用」里于是直接糊了一屏原始 JSON
 * （用户反馈：系统设备还是官方 JSON）。现在：
 *   - 短数组（分享用户、盘位名这类）直接列出来，超过 6 个截断计数；
 *   - 对象显示"N 项"，不再把结构糊在脸上；
 *   - 布尔显示开启/关闭，数字保持原样。
 * **不做的事**：不猜单位、不把 0/1 说成开关（只有真的 boolean 才这么说）。
 */
function dataValueText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "开启" : "关闭";
  if (Array.isArray(value)) {
    if (!value.length) return "无";
    const simple = value.every(
      (entry) => typeof entry === "string" || typeof entry === "number",
    );
    if (simple && value.length <= 6) return value.join("、");
    return `${value.length} 项`;
  }
  if (typeof value === "object") {
    const count = Object.keys(value as Record<string, unknown>).length;
    return count ? `${count} 项` : "无";
  }
  return String(value);
}
const labels: Record<string, string> = {
  cpu: "CPU",
  memory: "内存",
  name: "设备名称",
  version: "系统版本",
  hostname: "主机名称",
  model: "设备型号",
  status: "状态",
  used: "已使用",
  total: "总容量",
  available: "可用容量",
  network: "网络",
  uptime: "运行时间",
  language: "语言",
  timezone: "时区",
};
/*
 * 容量单位：以前到 GB 就停了，所以 4TB 的盘显示成「4096.0 GB」——
 * 用户明确提过"超过 1024G 应该显示 TB"。这里补上 TB/PB，
 * 并且大于 1024 的整数不再留一位小数（1024.0 GB 这种读起来最别扭）。
 */
export const formatBytes = (n?: number) => {
  if (n === undefined) return "—";
  const units: Array<[number, string]> = [
    [1024 ** 5, "PB"],
    [1024 ** 4, "TB"],
    [1024 ** 3, "GB"],
    [1024 ** 2, "MB"],
    [1024, "KB"],
  ];
  for (const [scale, unit] of units) {
    if (n >= scale) {
      const value = n / scale;
      return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
    }
  }
  return `${n} B`;
};
export function requireConnected() {
  if (!api.nasSession) throw new Error("请先连接 NAS");
}
