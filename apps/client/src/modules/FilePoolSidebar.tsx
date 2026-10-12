import { ArrowClockwise, HardDrives } from "@phosphor-icons/react";
import type { Item } from "../api/client";

// Only ordinary returned directory paths can identify a pool boundary. Opaque
// search paths remain usable by existing navigation, without guessing a pool.
export function accessiblePools(items: Item[]): Item[] {
  return items.filter(item => item.id && item.name.trim() &&
    ["directory", "folder", "root"].includes(item.kind || "") &&
    typeof item.path === "string" && item.path.startsWith("/") &&
    !/[\\\u0000-\u001f\u007f]/.test(item.path) &&
    !item.path.split("/").some(part => part === "." || part === ".."));
}
export function poolForPath(pools: Item[], path?: string): Item | undefined {
  if (!path) return undefined;
  return pools.filter(pool => {
    const root = pool.path!.replace(/\/+$/, "") || "/";
    return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
  }).sort((a, b) => b.path!.length - a.path!.length)[0];
}
export function FilePoolSidebar({ pools, currentPath, connected, loading, error, reload, onOpen }: {
  pools: Item[]; currentPath?: string; connected: boolean; loading: boolean;
  error: string; reload: () => void; onOpen: (item: Item) => void;
}) {
  const active = poolForPath(pools, currentPath);
  return <div className="file-pool-group" role="group" aria-label="存储池">
    <div className="file-pool-heading">
      <p>存储池</p>
      <button className="icon-button" aria-label="刷新存储池" onClick={reload} disabled={!connected || loading}><ArrowClockwise /></button>
    </div>
    {!connected ? <p className="file-pool-state">连接 NAS 后显示存储池</p>
      : loading ? <p className="file-pool-state" role="status">正在读取存储池…</p>
      : error ? <p className="file-pool-state error" role="alert">{error}</p>
      : !pools.length ? <p className="file-pool-state">暂无可访问的存储池</p>
      : pools.map(pool => <button key={`${pool.id}:${pool.path}`} className={`file-pool-button ${active === pool ? "selected" : ""}`}
        aria-label={`打开存储池：${pool.name}${pools.some(other => other !== pool && other.name === pool.name) ? `（${pool.path}）` : ""}`} aria-current={active === pool ? "page" : undefined}
        title={pool.name} onClick={() => onOpen(pool)}>
        <HardDrives weight="duotone" /><span>{pool.name}</span>
      </button>)}
  </div>;
}
