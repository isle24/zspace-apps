import { ManagementOverlay } from "./ManagementOverlay";
/*
 * Docker 窗口：容器 / 镜像 / 日志（只读）
 *
 * 官方那条路走不通：极空间前端调 `/docker/api/*`，nginx 转到本机 9123，
 * 但这台 NAS 上 9123 没有监听（官方 Docker 应用没在跑），一律 502。
 * 所以数据来自我们容器里的同源只读接口 `/api/docker/*`（见 deploy/nas-appstore/proxy/docker.go），
 * 那里直接问 Docker Engine —— 只有读，没有任何启停/删除/exec。
 *
 * 没挂 docker socket 时接口会返回 container-socket-missing，界面照实说明，不假装有数据。
 */
import { lazy, Suspense, useRef, useState } from "react";
import { Cube, HardDrives, ArrowClockwise, Gear, Scroll, Stack, X } from "@phosphor-icons/react";
import { formatBytes, Status, useResource } from "./common";
import { api, message } from "../api/client";

const DockerCreate=lazy(()=>import("./DockerCreate").then(m=>({default:m.DockerCreate})));
const DockerComposeCreate=lazy(()=>import("./DockerComposeCreate").then(m=>({default:m.DockerComposeCreate})));
type Container = {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  created: number;
  ports: string[];
  protected?: boolean;
};
type Image = { displayName?:string; id: string; tags: string[]; size: number; created: number };

/** Compose 项目（按 Docker 自己打的 project 标签分组，只读） */
type ComposeProject = {
  name: string;
  running: number;
  total: number;
  services: string[];
  state?: "saved" | "running" | "stopped" | "unknown";
  directory?: string;
  official?: boolean;
};

/** 引擎信息（只读；改设置要在设备上做） */
type DockerEngine = {
  serverVersion?: string;
  apiVersion?: string;
  minApiVersion?: string;
  goVersion?: string;
  driver?: string;
  os?: string;
  architecture?: string;
  cpus?: number;
  memoryTotal?: number;
  rootDir?: string;
  counts?: { containers?: number; containersRun?: number; containersStop?: number; images?: number };
  hint?: string;
};

/** 容器状态 → 中文 + 用于着色的分类（设备给的是 Docker 自己的英文状态词） */
export function containerState(state?: string): { label: string; tone: "up" | "down" | "idle" } {
  switch ((state || "").toLowerCase()) {
    case "running":
      return { label: "运行中", tone: "up" };
    case "exited":
      return { label: "已停止", tone: "down" };
    case "paused":
      return { label: "已暂停", tone: "idle" };
    case "restarting":
      return { label: "重启中", tone: "idle" };
    case "created":
      return { label: "已创建", tone: "idle" };
    case "dead":
      return { label: "异常", tone: "down" };
    default:
      return { label: state || "未知", tone: "idle" };
  }
}

/** "nginx:1.27" → 短名 + 标签；没有标签的镜像显示 sha 短 id */
export function imageLabel(image: Image): { name: string; tag?: string } {
  const first = (image.tags || [])[0];
  if (!first || first === "<none>:<none>") return { name: image.displayName||"未命名镜像", tag: "无仓库标签" };
  const index = first.lastIndexOf(":");
  if (index <= 0) return { name: first };
  return { name: first.slice(0, index), tag: first.slice(index + 1) };
}

export function createdText(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds)) return "—";
  const when = new Date(seconds * 1000);
  if (Number.isNaN(when.getTime())) return "—";
  return when.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

type Details = { id: string; name: string; image: string; state: string; exitCode: number; startedAt: string; restartPolicy: string; network: string; mounts: Array<{type: string; name: string; target: string; writable: boolean}>; protected: boolean };
type Action = "start" | "stop" | "restart" | "pause" | "unpause";
const actionNames: Record<Action,string> = {start:"启动",stop:"停止",restart:"重启",pause:"暂停",unpause:"恢复"};
export function DockerView({ connected }: { connected: boolean }) {
 const [tab,setTab] = useState<"containers"|"images"|"compose"|"engine">("containers"), [query,setQuery] = useState("");
 const [panel,setPanel] = useState<{container:Container;kind:"logs"|"details"}>(), [confirmation,setConfirmation] = useState<{container:Container;action:Action}>();
 const [busy,setBusy] = useState(false), [error,setError] = useState(""), [notice,setNotice] = useState("");
 const [creating,setCreating]=useState(false),[creatingCompose,setCreatingCompose]=useState(false);
 const lock=useRef(false);
 const capabilities=useResource(async()=>connected?api.docker<{manage:boolean;available:boolean}>("capabilities"):undefined,[api.nasSession,connected]);
 const resource=useResource(async()=>{
  if(!connected)return undefined;
  const endpoint=tab==="engine"?"info":tab;
  const result=await api.docker<Record<string,any>>(endpoint);
  if(tab==="containers"&&!Array.isArray(result.containers)||tab==="images"&&!Array.isArray(result.images)||tab==="compose"&&!Array.isArray(result.projects)||tab==="engine"&&!result.engine)throw new Error("设备没有返回可识别的 Docker 数据");
  return result;
 },[api.nasSession,connected,tab]);
 async function control(){
  if(!confirmation||lock.current)return;lock.current=true;setBusy(true);setError("");setNotice("");const session=api.nasSession;
  try{await api.docker("control",{id:confirmation.container.id,action:confirmation.action});if(session!==api.nasSession)return;setConfirmation(undefined);setNotice("操作完成，设备状态已确认。");resource.reload()}
  catch(e){if(session===api.nasSession)setError(message(e))}
  finally{lock.current=false;if(session===api.nasSession)setBusy(false)}
 }
 const containers=(resource.data?.containers??[]) as Container[], images=(resource.data?.images??[]) as Image[], projects=(resource.data?.projects??[]) as ComposeProject[], engine=resource.data?.engine as DockerEngine|undefined;
 const visible=containers.filter(c=>`${c.name} ${c.image}`.toLowerCase().includes(query.toLowerCase()));
 const manage=capabilities.data?.manage===true;
 return <div className="docker-view"><div className="content-heading"><div><h1>Docker</h1><p>管理容器、查看镜像、项目和运行环境</p></div><button className="icon-button" aria-label="刷新 Docker" onClick={()=>{resource.reload();capabilities.reload()}}><ArrowClockwise /></button></div>
 {capabilities.data?.manage&&<div className="management-actions"><button className="primary" onClick={()=>setCreating(true)}>新建容器</button><button className="secondary" onClick={()=>setCreatingCompose(true)}>新建 Compose</button></div>}
 <nav className="docker-tabs" aria-label="Docker 功能">{([["containers","容器",Cube],["images","镜像",HardDrives],["compose","Compose 项目",Stack],["engine","运行环境",Gear]] as const).map(([key,label,Icon])=><button key={key} className={tab===key?"active":""} onClick={()=>{setTab(key);setError("");setNotice("")}}><Icon />{label}</button>)}</nav>
 <Status {...resource} connected={connected} retry={resource.reload}/><Status error={capabilities.error} connected={connected} retry={capabilities.reload}/>
 {notice&&<p role="status">{notice}</p>}{error&&<p role="alert" className="error-text">{error}</p>}
 {resource.data&&!resource.error&&tab==="containers"&&<><label className="official-search"><input aria-label="搜索容器" placeholder="搜索容器名称或镜像" value={query} onChange={e=>setQuery(e.target.value)}/></label><p className="hint">{containers.length} 个容器 · 运行中 {containers.filter(c=>c.state==="running").length}{!manage&&" · 当前账号仅可查看"}</p>
 <div className="docker-grid">{visible.map(c=><article className="docker-card" key={c.id}><header><Cube/><strong title={c.name}>{c.name}</strong><span className={`docker-state ${containerState(c.state).tone}`}>{containerState(c.state).label}</span></header><p className="docker-image" title={c.image}>{c.image}</p><p className="docker-ports" title={c.ports.join(" · ")}>端口：{c.ports.join(" · ")||"未发布端口"}</p>
 <footer><button className="secondary" aria-label={`查看${c.name}详情`} onClick={()=>setPanel({container:c,kind:"details"})}>详情</button><button className="secondary" aria-label={`查看${c.name}日志`} disabled={!manage} onClick={()=>setPanel({container:c,kind:"logs"})}><Scroll/>日志</button></footer>
 <div className="docker-actions">{(c.state==="running"?["stop","restart","pause"]:c.state==="paused"?["unpause"]:c.state==="exited"||c.state==="created"?["start"]:[]).map(action=><button className="secondary" key={action} aria-label={`${actionNames[action as Action]}${c.name}`} disabled={busy||!manage||c.protected} onClick={()=>{setError("");setConfirmation({container:c,action:action as Action})}}>{actionNames[action as Action]}</button>)}</div>{c.protected&&<small>客户端运行服务，受保护</small>}</article>)}</div>{!visible.length&&<p>没有匹配的容器。</p>}</>}
 {resource.data&&!resource.error&&tab==="images"&&<div className="docker-table">{images.map(i=><div className="docker-row" key={i.id}><span className="docker-row-name" title={i.tags.join(" · ")}>{imageLabel(i).name}<em>{imageLabel(i).tag}</em></span><span>{formatBytes(i.size)}</span><span className="docker-created">{createdText(i.created)}</span></div>)}{!images.length&&<p>还没有本地镜像。</p>}</div>}
 {resource.data&&!resource.error&&tab==="compose"&&<>{resource.data.hint&&<p className="hint">{String(resource.data.hint)}</p>}<div className="docker-grid">{projects.map(p=><article className="docker-card" key={p.name}><header><Stack/><strong>{p.name}</strong></header><p>{p.total===0&&p.official?(p.state==="saved"?"已保存，尚未创建容器":"已登记项目，尚未确认容器状态"):<>{p.running} / {p.total} 个容器运行中</>}</p>{p.directory&&<p className="docker-ports" title={p.directory}>{p.directory}</p>}<p>{p.services.join(" · ")}</p>{p.total===0&&p.state==="saved"&&<small>配置已在 NAS 保存；可在官方 Docker 中启动项目。</small>}<button className="secondary" disabled={p.total===0} onClick={()=>{setQuery(p.name==="（非 Compose 容器）"?"":p.services[0]??"");setTab("containers")}}>查看项目容器</button></article>)}</div></>}
 {engine&&tab==="engine"&&!resource.error&&<section className="sys-card"><h3>Docker 运行环境</h3><dl className="management-facts">{[["版本",engine.serverVersion],["存储驱动",engine.driver],["系统",engine.os],["处理器架构",engine.architecture],["CPU 核数",engine.cpus],["可用内存",formatBytes(engine.memoryTotal)],["数据目录",engine.rootDir]].map(([name,value])=><div key={name}><dt>{name}</dt><dd>{value??"—"}</dd></div>)}</dl></section>}
 {creatingCompose&&<Suspense fallback={<p role="status">正在打开项目编辑器…</p>}><DockerComposeCreate close={()=>setCreatingCompose(false)} finished={()=>{setTab("compose");resource.reload()}}/></Suspense>}
 {creating&&<Suspense fallback={<p role="status">正在打开容器编辑器…</p>}><DockerCreate close={()=>setCreating(false)} finished={()=>{setTab("containers");resource.reload()}}/></Suspense>}
 {panel&&<DockerPanel key={`${api.nasSession}:${panel.container.id}:${panel.kind}`} {...panel} close={()=>setPanel(undefined)}/>}
 {confirmation&&<ManagementOverlay><section className="management-dialog" role="dialog" aria-modal="true" aria-label="确认容器操作"><h2>{actionNames[confirmation.action]} {confirmation.container.name}</h2><p>{["stop","restart","pause"].includes(confirmation.action)?"正在使用该服务的连接和任务可能中断。":"将执行容器操作并确认设备状态。"}</p><p className="docker-image">{confirmation.container.image}</p><div className="management-actions"><button className="primary" disabled={busy} onClick={()=>void control()}>{busy?"正在操作并确认…":`确认${actionNames[confirmation.action]}`}</button><button className="secondary" disabled={busy} onClick={()=>setConfirmation(undefined)}>取消</button></div>{error&&<p role="alert" className="error-text">{error}</p>}</section></ManagementOverlay>}
 </div>;
}
function DockerPanel({container,kind,close}:{container:Container;kind:"logs"|"details";close:()=>void}){
 const resource=useResource(async()=>kind==="logs"?api.docker<{lines:string[]}>(`logs/${container.id}`):api.docker<Details>(`details/${container.id}`),[api.nasSession,container.id,kind]);
 const details=kind==="details"?resource.data as Details|undefined:undefined;
 return <ManagementOverlay><section className="management-dialog" role="dialog" aria-modal="true" aria-label={`${container.name}${kind==="logs"?"日志":"详情"}`}><header><h2>{container.name} · {kind==="logs"?"日志":"详情"}</h2><button className="icon-button" aria-label="关闭容器面板" onClick={close}><X/></button></header><Status {...resource} retry={resource.reload}/>
 {kind==="logs"&&resource.data&&!resource.error&&<pre className="docker-log-content">{Array.isArray((resource.data as {lines:string[]}).lines)?(resource.data as {lines:string[]}).lines.join("\n")||"当前没有日志。":"日志格式无法识别"}</pre>}
 {details&&!resource.error&&<><dl className="management-facts">{[["镜像",details.image],["状态",containerState(details.state).label],["退出码",details.exitCode],["重启策略",details.restartPolicy],["网络",details.network],["启动时间",details.startedAt]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value||"—"}</dd></div>)}</dl><h3>数据挂载</h3>{details.mounts.map((m,index)=><p key={index}>{m.name||m.type} → {m.target} · {m.writable?"可写":"只读"}</p>)}</>}
 </section></ManagementOverlay>;
}
