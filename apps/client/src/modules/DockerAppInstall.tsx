import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Folder } from "@phosphor-icons/react";
import { api, message, normalizeCollection } from "../api/client";
import type { OfficialDockerAppPlan } from "../api/official-nas";
import { dockerFieldValid } from "../api/docker-app-templates";
import { Status, useResource } from "./common";
import { DirectoryCreate } from "./DirectoryCreate";
import { Pagination, usePage } from "./Pagination";
import "../styles/nas-tools.css";
function VendorDirectory({ label, roots, value, changed, locked }: { label: string; roots: OfficialDockerAppPlan["roots"]; value: string; changed: (path: string) => void; locked: boolean }) {
  const root = roots.find(row => value === row.path || value.startsWith(row.path + "/"));
  const { page, setPage } = usePage([api.nasSession, value]);
  const folders = useResource(async () => root && value ? normalizeCollection(await api.read("files.list", { path: value, page, pageSize: 20, sortby: "name", order: "asc" })) : { items: [], total: 0 }, [api.nasSession, value, page]);
  return <section className="nas-tool-card" aria-label={`选择${label}目录`}>
    <label className="field">{label}磁盘<select aria-label={`${label}磁盘`} disabled={locked} value={root?.id || ""} onChange={e => changed(roots.find(row => row.id === e.target.value)?.path || "")}><option value="">选择 NAS 数据磁盘</option>{roots.map(row => <option key={row.id} value={row.id}>{row.name} · {row.id}</option>)}</select></label>
    {root && <><label className="field">{label}目录<input aria-label={`${label}目录`} readOnly value={value} /></label><div className="nas-tool-toolbar"><button className="secondary" disabled={locked || value === root.path} onClick={() => changed(value.slice(0, value.lastIndexOf("/")) || root.path)}><ArrowLeft />上一级</button>{!locked && <DirectoryCreate key={`${api.nasSession}:${value}`} parent={{ id: value, path: value, name: value.split("/").at(-1) || root.name, kind: "directory" }} section="files" connected={!!api.nasSession} sessionId={api.nasSession || ""} onRefresh={folders.reload} />}</div>
      <Status {...folders} retry={folders.reload} /><div className="nas-notes-list">{folders.data?.items.filter(item => item.kind === "directory" && item.path?.startsWith(root.path + "/")).map(item => <button key={item.id} disabled={locked} aria-label={`打开文件夹 ${item.name}`} onClick={() => changed(item.path!)}><Folder /> {item.name}</button>)}</div>
      {folders.data && <Pagination page={page} total={folders.data.total} count={folders.data.items.length} onPage={setPage} loading={folders.loading || locked} />}<p className="hint">选择此用途的独立目录，也可在选中的磁盘上新建。不同用途可放在不同数据磁盘。</p>
    </>}
  </section>;
}
export function DockerAppInstall({ appName, finished }: { appName: string; finished: () => void }) {
  const plan = useResource(() => api.prepareDockerApp(appName), [api.nasSession, appName]);
  const [dataPath, setDataPath] = useState(""), [port, setPort] = useState("");
  const [settings, setSettings] = useState<Record<string,string>>({}), [riskAccepted, setRiskAccepted] = useState(false);
  const [autoStart, setAutoStart] = useState(true), [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [submitted, setSubmitted] = useState(false), [notice, setNotice] = useState(""), [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => { generation.current++; setDataPath(""); setPort(""); setSettings({}); setRiskAccepted(false); setConfirm(false); setBusy(false); setSubmitted(false); setNotice(""); setError(""); return () => { generation.current++; }; }, [api.nasSession, appName]);
  useEffect(() => { if (plan.data) { setSettings(Object.fromEntries((plan.data.fields || []).map(field => [field.key, field.defaultValue || ""]))); setAutoStart(plan.data.autoStartDefault ?? true); setRiskAccepted(false); setConfirm(false); } }, [plan.data]);
  const root = plan.data?.roots.find(row => dataPath.startsWith(row.path + "/"));
  const fields = plan.data?.fields || [];
  const pathAllowed = !!root;
  const validPort = Number.isInteger(Number(port)) && !!port && Number(port) >= (plan.data?.portMin ?? 50000) && Number(port) <= (plan.data?.portMax ?? 65535);
  const fieldsValid = fields.every(field => dockerFieldValid(field, settings[field.key] ?? field.defaultValue ?? "") && (field.type !== "directory" || !!plan.data?.roots.some(row => settings[field.key]?.startsWith(row.path + "/"))));
  const ports = [Number(port), ...fields.filter(field => field.type === "port").map(field => Number(settings[field.key]))];
  const portConflict = new Set(ports).size !== ports.length;
  const locked = busy || submitted;
  const canInstall = pathAllowed && validPort && fieldsValid && !portConflict && (!plan.data?.requiresRiskConfirmation || riskAccepted);
  function changed(key: string, value: string) { if (locked) return; setSettings(current => ({ ...current, [key]: value })); setConfirm(false); setError(""); }
  async function install() {
    if (!plan.data || !canInstall || locked) return;
    const stamp = generation.current; setBusy(true); setError("");
    try {
      const result = await api.installDockerApp({ appName, version: plan.data.version, dataPath, port: Number(port), autoStart, ...(fields.length ? { settings } : {}), ...(plan.data.requiresRiskConfirmation ? { riskAccepted } : {}) });
      if (stamp === generation.current) { setSubmitted(true); setSettings({}); setNotice(result.installed ? "应用安装状态已确认。" : "安装任务已提交，设备正在处理。请稍后刷新应用列表确认完成。"); finished(); }
    } catch (e) { if (stamp === generation.current) { setError(message(e)); if ((e as { mayHaveCreated?: boolean }).mayHaveCreated) setSubmitted(true); } }
    finally { if (stamp === generation.current) setBusy(false); }
  }
  return <section className="management-confirm docker-vendor-install" aria-label="Docker应用安装向导"><h3>安装 {appName}</h3><Status {...plan} retry={plan.reload} />
    {plan.data && <><VendorDirectory label={plan.data.primaryLabel || "应用数据"} roots={plan.data.roots} value={dataPath} locked={locked} changed={path => { setDataPath(path); setConfirm(false); }} />
      {fields.filter(field => field.type === "directory").map(field => <VendorDirectory key={field.key} label={field.label} roots={plan.data!.roots} value={settings[field.key] || ""} locked={locked} changed={path => changed(field.key,path)} />)}
      <label className="field">应用访问端口<input aria-label="应用访问端口" type="number" min={plan.data.portMin} max={plan.data.portMax} value={port} disabled={locked} placeholder={`${plan.data.portMin}–${plan.data.portMax}`} onChange={e => { setPort(e.target.value); setConfirm(false); }} /></label>
      {fields.filter(field => field.type !== "directory").map(field => <label className="field" key={field.key}>{field.label}{field.type === "select" ? <select aria-label={field.label} value={settings[field.key] || field.defaultValue || ""} disabled={locked} onChange={e => changed(field.key,e.target.value)}>{field.options?.map(value => <option key={value} value={value}>{field.key === "docker_ollama_igpu" ? value === "1" ? "启用" : "关闭" : value}</option>)}</select> : <input aria-label={field.label} type={field.type === "password" ? "password" : field.type === "port" ? "number" : "text"} autoComplete="off" value={settings[field.key] || ""} min={field.type === "port" ? 50000 : undefined} max={field.type === "port" ? 65535 : undefined} disabled={locked} onChange={e => changed(field.key,e.target.value)} />}{field.hint && <small>{field.hint}</small>}</label>)}
      <label className="field"><span><input type="checkbox" checked={autoStart} disabled={locked} onChange={e => { setAutoStart(e.target.checked); setConfirm(false); }} /> 自动启动应用</span></label>
      {plan.data.requiresRiskConfirmation && <label className="field"><span><input aria-label="确认厂商安装说明" type="checkbox" checked={riskAccepted} disabled={locked} onChange={e => { setRiskAccepted(e.target.checked); setConfirm(false); }} /> 我已确认目录与访问配置，并了解此应用会启动对应服务。</span></label>}
      {portConflict && <p className="error-text">各服务端口必须不同。</p>}<p className="hint">安装前会核对版本、依赖、目录和端口。Docker 镜像使用设备当前 Docker 存储位置。</p>
      {!confirm && !submitted && <button className="primary" disabled={busy || !canInstall} onClick={() => setConfirm(true)}>查看安装计划</button>}
      {confirm && !submitted && <section className="management-confirm" role="region" aria-label="Docker应用安装计划"><h4>确认安装计划</h4><p>{root?.name} · {dataPath}</p>{fields.filter(field => field.type === "directory").map(field => <p key={field.key}>{field.label}：{settings[field.key]}</p>)}<p>访问端口：{port} · {autoStart ? "自动启动" : "手动启动"}</p>{fields.filter(field => field.type !== "directory").map(field => <p key={field.key}>{field.label}：{field.type === "password" ? "已填写" : settings[field.key]}</p>)}<button className="primary" disabled={locked} onClick={() => void install()}>{busy ? "正在提交并核对状态…" : "确认安装"}</button><button className="secondary" disabled={locked} onClick={() => setConfirm(false)}>返回设置</button></section>}
    </>}{notice && <p role="status">{notice}</p>}{error && <p className="error-text" role="alert">{error}</p>}{submitted && !notice && <p className="hint">请先刷新应用列表检查结果，避免重复安装。</p>}
  </section>;
}
