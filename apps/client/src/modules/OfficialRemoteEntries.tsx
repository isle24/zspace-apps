import { ArrowClockwise, Globe } from "@phosphor-icons/react";
import { api } from "../api/client";
import { ExternalLink } from "./ExternalLink";
import { Status, useResource } from "./common";
import { RemoteRelayCard } from "./RemoteAccess";
import "../styles/nas-tools.css";
export function OfficialRemoteEntries({ connected }: { connected: boolean }) {
  const resource = useResource(() => api.remoteEntries(), [api.nasSession, connected]);
  return <div className="official-remote-entries">
    <div className="shortcut-head"><p>设备上的远程访问入口</p><button className="secondary" disabled={!connected} onClick={resource.reload}><ArrowClockwise />刷新</button></div>
    <Status {...resource} connected={connected} retry={resource.reload} empty={!!resource.data && !resource.data.length} />
    <div className="official-remote-grid">{resource.data?.map(row => <article key={row.id} className="official-remote-entry">
      <span className="official-remote-avatar" style={{ backgroundColor: row.color }}><Globe /></span><div><h2>{row.name}</h2><p>{row.address || "设备未提供地址"}</p><small>{row.proxy ? "设备已启用代理模式" : "直接访问"}{row.desktopVisible ? " · 显示在官方桌面" : ""}</small></div>
      {row.url ? <ExternalLink className="secondary" href={row.url}>打开 {row.name}</ExternalLink> : <span className="error-text">地址无法打开</span>}
    </article>)}</div>
    <p className="hint">入口从当前 NAS 账号读取。在官方客户端修改后，刷新即可同步。浏览器直接打开局域网地址；外网代理访问请使用官方客户端。</p>
    <RemoteRelayCard connected={connected} />
  </div>;
}
