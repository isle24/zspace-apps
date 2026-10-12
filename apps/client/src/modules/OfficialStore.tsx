import { ManagementOverlay } from "./ManagementOverlay";
import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, Cube, MagnifyingGlass, ShoppingBag, X } from "@phosphor-icons/react";
import { api, message, normalizeCollection, type Item } from "../api/client";
import { formatBytes, Status, useResource } from "./common";
import { NativeAppInstall } from "./NativeAppInstall";
import { DockerAppInstall } from "./DockerAppInstall";
import { supportsOfficialDockerInstall } from "../api/official-nas";
import { asRecord } from "./values";

type App = { key: string; id: string; name: string; intro: string; icon?: string; version?: string; size?: number; category: string[]; installed: boolean; docker: boolean; toggleable: boolean; removable: boolean; status: string; saveTo?: string };
const obj = (v: unknown) => asRecord(v) ?? {};
const yes = (v: unknown) => v === 1 || v === true || v === "1";
const str = (v: unknown) => typeof v === "string" ? v : "";
const stateText = (app: App) => !app.installed ? "未安装" : ({ running: "运行中", stop: "已停止", stopped: "已停止", installing: "安装中", uninstalling: "卸载中" }[app.status] || "状态待确认");
function catalogueApp(item: Item, docker: boolean): App {
  const meta = obj(item.metadata), installed = yes(meta.installed);
  const local = obj(meta.local_info), latest = obj(meta.latest_version);
  const info = installed ? local : latest;
  const locales = Array.isArray(info.i18n) ? info.i18n.map(obj) : [];
  const locale = locales.find(l => l.lang === "zh_cn") ?? locales.find(l => l.lang === "zh-CN") ?? locales[0] ?? {};
  const tags = Array.isArray(locale.tags) ? locale.tags.map(obj).map(t => str(t.name)).filter(Boolean) : [];
  const icons = Array.isArray(info.icons) ? info.icons.map(obj) : [];
  const source = str((icons.find(i => str(i.spec).startsWith("PC:")) ?? icons[0])?.url);
  let icon: string | undefined;
  try {
    const url = new URL(source, api.nas.session()?.baseUrl || location.origin);
    if (source && /^https?:$/.test(url.protocol) && !url.username && !url.password && !url.search && !url.hash) icon = url.href;
  } catch { /* no unverified icon */ }
  const id = str(meta.app_name) || item.id;
  return { key: `${docker ? "docker" : "native"}:${id}`, id, docker, name: str(locale.name) || item.name, intro: str(locale.intro) || "设备未提供应用介绍", icon,
    version: str(obj(info.version).version) || undefined, size: item.size || Number(meta.pkg_size) || Number(obj(info.version).size) || undefined,
    category: tags.length ? tags : [docker ? "容器应用" : "其他应用"], installed, toggleable: yes(meta.toggleable), removable: yes(meta.removable), status: str(meta.status), saveTo: str(meta.save_to) || undefined };
}
function AppIcon({ app }: { app: App }) {
  const [failed, setFailed] = useState(false);
  if (app.icon && !failed) return <img src={app.icon} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
  return <Cube weight="duotone" />;
}
export function OfficialStore({ onInstances }: { onInstances?: (items: never[]) => void }) {
  const [tab, setTab] = useState("discover"), [category, setCategory] = useState("全部应用"), [query, setQuery] = useState("");
  const [detail,setDetail] = useState<App>();
  const [selected, setSelected] = useState<string>(), [confirm, setConfirm] = useState<"start" | "stop" | "restart" | "uninstall">();
  const [installing,setInstalling] = useState(false);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [actionError, setActionError] = useState("");
  const generation = useRef(0);
  useEffect(() => { onInstances?.([]); return () => { generation.current++; }; }, [api.nasSession]);
  const resource = useResource(async () => {
    const [native, docker] = await Promise.all([api.read("apps.native"), api.read("apps.docker")]);
    const rows = [...normalizeCollection(native).items.map(i => catalogueApp(i, false)), ...normalizeCollection(docker).items.map(i => catalogueApp(i, true))];
    return [...new Map(rows.map(a => [a.key, a])).values()];
  }, [api.nasSession]);
  const all = resource.data ?? [], current = all.find(a => a.key === selected) ?? (detail?.key === selected ? detail : undefined);
  const categories = [...new Set(all.flatMap(a => a.category))].sort();
  const visible = all.filter(a => (tab !== "installed" || a.installed) && (category === "全部应用" || a.category.includes(category)) && `${a.name} ${a.intro} ${a.id}`.toLowerCase().includes(query.toLowerCase()));
  async function control() {
    if (!current || !confirm || busy) return;
    const stamp = generation.current;
    setBusy(true); setActionError(""); setNotice("");
    try {
      const result = confirm === "uninstall" ? await api.uninstallApp({ appName: current.id, docker: current.docker }) : (await api.controlApp({ appName: current.id, docker: current.docker, action: confirm }), undefined);
      if (stamp === generation.current) { setNotice(result ? result.installed ? "卸载任务已提交，设备正在处理。应用数据会保留，请刷新确认卸载完成。" : "应用已卸载，应用数据已按保留选项提交。" : "设备状态已确认，正在更新应用列表。"); resource.reload(); setConfirm(undefined); }
    }
    catch (error) { if (stamp === generation.current) setActionError(message(error)); }
    finally { if (stamp === generation.current) setBusy(false); }
  }
  return <div className="official-market">
    <nav className="official-categories" aria-label="应用商店分类">
      <h2><ShoppingBag />应用商店</h2>
      <button className={tab === "discover" ? "selected" : ""} onClick={() => { setTab("discover"); setCategory("全部应用"); }}>发现应用</button>
      <button className={tab === "installed" ? "selected" : ""} onClick={() => { setTab("installed"); setCategory("全部应用"); }}>已安装</button>
      <p>分类</p>
      {["全部应用", ...categories].map(c => <button key={c} className={category === c ? "selected" : ""} onClick={() => setCategory(c)}>{c}</button>)}
    </nav>
    <section className="official-market-main">
      <header className="content-heading"><div><h1>{tab === "installed" ? "我的应用" : "发现适合你的应用"}</h1><p>{all.length} 款应用 · 已安装 {all.filter(a => a.installed).length} 款</p></div>
        <button className="icon-button" aria-label="刷新应用列表" onClick={resource.reload}><ArrowClockwise /></button></header>
      <label className="official-search"><MagnifyingGlass /><input aria-label="搜索应用" placeholder="搜索名称、用途或应用 ID" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <Status {...resource} connected retry={resource.reload} />
      {!resource.loading && !resource.error && !visible.length && <p className="official-empty">没有匹配的应用，试试其他名称或分类。</p>}
      <div className="official-market-grid">{visible.map(app => <article className="market-app" key={app.key}>
        <button className="market-app-info" aria-label={`查看${app.name}详情`} onClick={() => { setDetail(app); setSelected(app.key); setConfirm(undefined); setInstalling(false); setActionError(""); setNotice(""); }}>
          <span className="market-app-icon"><AppIcon app={app} /></span><span><strong>{app.name}</strong><small>{app.category.join(" · ")}</small></span>
        </button><p className="market-app-intro">{app.intro}</p><footer><span className={`docker-state ${app.status === "running" && app.installed ? "up" : "idle"}`}>{stateText(app)}</span><button className="secondary" onClick={() => { setDetail(app); setSelected(app.key); setConfirm(undefined); setInstalling(false); setActionError(""); }}>查看详情</button></footer>
      </article>)}</div>
    </section>
    {current && <ManagementOverlay><section className="management-dialog" role="dialog" aria-modal="true" aria-label={`${current.name}详情`}>
      <header><span className="market-app-icon"><AppIcon app={current} /></span><div><h2>{current.name}</h2><p>{current.category.join(" · ")}</p></div><button className="icon-button" aria-label="关闭应用详情" disabled={busy} onClick={() => setSelected(undefined)}><X /></button></header>
      <p>{current.intro}</p><dl className="management-facts"><div><dt>版本</dt><dd>{current.version || "设备未提供"}</dd></div><div><dt>应用状态</dt><dd>{stateText(current)}</dd></div><div><dt>类型</dt><dd>{current.docker ? "Docker 应用" : "原生应用"}</dd></div>{current.size && <div><dt>安装包大小</dt><dd>{formatBytes(current.size)}</dd></div>}{current.saveTo && <div><dt>安装位置</dt><dd>{current.saveTo}</dd></div>}</dl>
      {current.installed && current.toggleable && <div className="management-actions">{current.status === "running" ? <><button className="secondary" disabled={busy} onClick={() => setConfirm("stop")}>停止应用</button><button className="secondary" disabled={busy} onClick={() => setConfirm("restart")}>重启应用</button></> : <button className="primary" disabled={busy} onClick={() => setConfirm("start")}>启动应用</button>}</div>}
      {current.installed && current.removable && <button className="secondary" disabled={busy} onClick={() => setConfirm("uninstall")}>卸载应用</button>}
      {!current.installed && (!current.docker || supportsOfficialDockerInstall(current.id)) && <button className="primary" onClick={()=>setInstalling(true)}>安装应用</button>}
      {installing && !current.docker && <NativeAppInstall key={current.key} appName={current.id} finished={resource.reload}/>}
      {installing && current.docker && supportsOfficialDockerInstall(current.id) && <DockerAppInstall key={current.key} appName={current.id} finished={resource.reload}/>}
      {!current.installed && current.docker && !supportsOfficialDockerInstall(current.id) && <p className="hint">此厂商应用的初始化模板尚未核对，请在官方应用商店安装。不同应用的数据目录、端口与服务配置需要按厂商模板填写。</p>}
      {confirm && <div className="management-confirm"><p>{confirm === "uninstall" ? "确认卸载此应用？保留应用数据，依赖检查通过后才会提交卸载。" : confirm === "stop" ? "停止后会禁用应用，使用这个应用的任务和连接会中断。" : confirm === "restart" ? "重启期间，应用会暂时无法访问。" : "确认启动这个应用？"}</p><button className="primary" disabled={busy} onClick={() => void control()}>{busy ? "正在操作并读取状态…" : confirm === "uninstall" ? "确认卸载" : "确认操作"}</button><button className="secondary" disabled={busy} onClick={() => setConfirm(undefined)}>取消</button></div>}
      {notice && <p role="status">{notice}</p>}{actionError && <p role="alert" className="error-text">{actionError}</p>}
    </section></ManagementOverlay>}
  </div>;
}
