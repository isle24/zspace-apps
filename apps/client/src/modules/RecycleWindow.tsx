import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, ArrowCounterClockwise, Trash } from "@phosphor-icons/react";
import { api, message, normalizeCollection, type Item } from "../api/client";
import { Status, useResource, formatBytes } from "./common";
import { Pagination, usePage } from "./Pagination";
import { ManagementOverlay } from "./ManagementOverlay";
import "../styles/nas-tools.css";
export function RecycleWindow({ connected }: { connected: boolean }) {
  const [scope, setScope] = useState<"personal" | "public">("personal");
  const { page, setPage } = usePage([api.nasSession, scope]);
  const resource = useResource(() => api.read("recycle.list", { scope, page, pageSize: 20 }).then(normalizeCollection), [api.nasSession, scope, page, connected]);
  const [selected, setSelected] = useState<{ item: Item; action: "restore" | "delete" }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const generation = useRef(0);
  useEffect(() => { generation.current++; setSelected(undefined); setError(""); setNotice(""); setBusy(false); return () => { generation.current++; }; }, [api.nasSession, scope]);
  async function act() {
    if (!selected?.item.path || busy) return;
    const stamp = generation.current; setBusy(true); setError(""); setNotice("");
    try {
      await api.recycleAction({ scope, path: selected.item.path, action: selected.action, page });
      if (stamp === generation.current) { setNotice(selected.action === "restore" ? "恢复请求已提交，请刷新列表和原目录确认结果。" : "永久删除请求已提交，请刷新列表确认结果。"); setSelected(undefined); resource.reload(); }
    } catch (e) { if (stamp === generation.current) setError(message(e)); }
    finally { if (stamp === generation.current) setBusy(false); }
  }
  return <div className="padded-module">
    <div className="content-heading"><div><h1>回收站</h1><p>设备上的已删除文件，恢复到原目录或逐项永久删除</p></div><button className="secondary" disabled={!connected || busy} onClick={resource.reload}><ArrowClockwise />刷新</button></div>
    <div className="tabs"><button className={scope === "personal" ? "active" : ""} disabled={busy} onClick={() => setScope("personal")}>个人文件</button><button className={scope === "public" ? "active" : ""} disabled={busy} onClick={() => setScope("public")}>公共文件</button></div>
    <Status {...resource} connected={connected} retry={resource.reload} empty={!!resource.data && !resource.data.items.length} />
    {resource.data?.items.map(item => <article className="nas-recycle-row" key={item.id}><Trash size={25} /><div><strong>{item.name}</strong><p>{item.kind === "directory" ? "文件夹" : formatBytes(item.size)}{item.metadata?.original_path ? ` · ${String(item.metadata.original_path)}` : ""}</p></div><span className="nas-recycle-actions"><button className="secondary" aria-label={`恢复 ${item.name}`} disabled={!item.path || busy} onClick={() => { setSelected({ item, action: "restore" }); setError(""); }}><ArrowCounterClockwise />恢复</button><button className="secondary" aria-label={`永久删除 ${item.name}`} disabled={!item.path || busy} onClick={() => { setSelected({ item, action: "delete" }); setError(""); }}>永久删除</button></span></article>)}
    {resource.data && <Pagination page={page} total={resource.data.total} count={resource.data.items.length} onPage={setPage} loading={resource.loading} />}{notice && <p role="status">{notice}</p>}
    {selected && <ManagementOverlay><section className="management-dialog" role="dialog" aria-modal="true" aria-label={selected.action === "restore" ? "恢复文件" : "永久删除文件"}><h2>{selected.action === "restore" ? "恢复文件" : "永久删除文件"}</h2><p>{selected.item.name}</p><p>{selected.action === "restore" ? "设备会尝试恢复到原来的目录，同名冲突会由设备报告。" : "此操作无法撤销，将只删除选中的回收站项目。"}</p><div className="management-actions"><button className="primary" disabled={busy} onClick={() => void act()}>{busy ? "正在提交…" : selected.action === "restore" ? "确认恢复" : "确认永久删除"}</button><button className="secondary" disabled={busy} onClick={() => setSelected(undefined)}>取消</button></div>{error && <p role="alert" className="error-text">{error}</p>}</section></ManagementOverlay>}
  </div>;
}
