import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, Plus } from "@phosphor-icons/react";
import { api, message, normalizeCollection } from "../api/client";
import type { OfficialNote } from "../api/official-nas";
import { Status, useResource } from "./common";
import { Pagination, usePage } from "./Pagination";
import "../styles/nas-tools.css";
function richText(body: string) {
  const document = new DOMParser().parseFromString(body, "text/html");
  document.querySelectorAll("script,style,iframe,object,embed").forEach(node => node.remove());
  document.querySelectorAll("p,div,h1,h2,h3,li,br").forEach(node => { node.appendChild(document.createTextNode("\n")); });
  return document.body.textContent || "";
}
export function NotesWindow({ connected }: { connected: boolean }) {
  const { page, setPage } = usePage([api.nasSession]);
  const resource = useResource(() => api.read("notes.list", { page, pageSize: 20 }).then(normalizeCollection), [api.nasSession, page, connected]);
  const [note, setNote] = useState<OfficialNote>();
  const [draft, setDraft] = useState<{ title: string; body: string }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [pending, setPending] = useState<string>();
  const generation = useRef(0), request = useRef(0);
  const dirty = !!draft && (!note ? !!(draft.title || draft.body) : draft.title !== note.title || draft.body !== note.body);
  useEffect(() => { generation.current++; setNote(undefined); setDraft(undefined); setError(""); setNotice(""); setPending(undefined); setBusy(false); return () => { generation.current++; }; }, [api.nasSession]);
  async function open(id: string, discard = false) {
    if (busy) return;
    if (dirty && !discard) { setPending(id); return; }
    setPending(undefined); setError(""); setNotice(""); setUncertain(false);
    if (id === "new") { setNote(undefined); setDraft({ title: "", body: "" }); return; }
    const stamp = generation.current, load = ++request.current; setBusy(true);
    try { const next = await api.note(id); if (stamp === generation.current && load === request.current) { setNote(next); setDraft({ title: next.title, body: next.body }); } }
    catch (e) { if (stamp === generation.current && load === request.current) setError(message(e)); }
    finally { if (stamp === generation.current && load === request.current) setBusy(false); }
  }
  async function save() {
    if (!draft || busy || uncertain) return;
    const stamp = generation.current; setBusy(true); setError(""); setNotice("");
    try {
      const result = await api.saveNote({ title: draft.title, body: draft.body, ...(note ? { id: note.id, expectedBody: note.body, expectedTitle: note.title } : {}) });
      if (stamp === generation.current) { setNote(result); setDraft({ title: result.title, body: result.body }); setNotice("便签已保存。"); resource.reload(); }
    } catch (e) { if (stamp === generation.current) { setError(message(e)); if ((e as { code?: string }).code === "NOTE_UNCONFIRMED") setUncertain(true); } }
    finally { if (stamp === generation.current) setBusy(false); }
  }
  const readonly = note?.classifyId === -1;
  return <div className="padded-module">
    <div className="content-heading"><div><h1>便签</h1><p>当前 NAS 账号的便签，保存后可在官方客户端同步查看</p></div><div className="heading-actions"><button className="primary" disabled={!connected || busy} onClick={() => void open("new")}><Plus />新建便签</button><button className="secondary" disabled={!connected} onClick={resource.reload}><ArrowClockwise />刷新列表</button></div></div>
    <Status {...resource} connected={connected} retry={resource.reload} />
    <div className="nas-notes-layout"><aside className="nas-notes-list" aria-label="便签列表">{resource.data?.items.map(item => <button key={item.id} className={note?.id === item.id ? "active" : ""} disabled={busy} onClick={() => void open(item.id)}><strong>{item.name || "未命名便签"}</strong><small>{Number(item.metadata?.note_type) === 2 ? "Markdown" : "富文本便签"}</small></button>)}{resource.data && <Pagination page={page} total={resource.data.total} count={resource.data.items.length} onPage={setPage} loading={resource.loading} />}{!resource.loading && resource.data && !resource.data.items.length && <p className="hint">还没有便签，点击新建开始记录。</p>}</aside>
    <section className="nas-note-editor" aria-label="便签编辑器">{draft ? <><label>便签标题<input aria-label="便签标题" value={draft.title} maxLength={200} disabled={busy || readonly} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>{!note || note.noteType === 2 ? <label>便签内容<textarea aria-label="便签内容" value={draft.body} maxLength={50000} disabled={busy || readonly} placeholder="支持 Markdown，内容保存在 NAS 上" onChange={e => setDraft({ ...draft, body: e.target.value })} /></label> : <><div className="nas-note-preview">{richText(draft.body)}</div><p className="hint">此便签是官方富文本格式，可修改标题；正文请在官方编辑器中修改以保留格式和附件。</p></>}
      <div className="nas-tool-toolbar"><button className="primary" disabled={!connected || !draft.title.trim() || busy || uncertain || readonly || (!!note && !dirty)} onClick={() => void save()}>{busy ? "正在读取或保存…" : "保存便签"}</button>{dirty && <span className="muted">尚未保存</span>}</div>{uncertain && <p className="hint">请先刷新列表，打开设备上的对应便签检查结果，再决定是否继续编辑。</p>}</> : <p className="hint">选择便签查看内容，或新建 Markdown 便签。</p>}
      {pending && <div className="management-confirm"><p>当前内容尚未保存，切换会放弃本次编辑。</p><button className="secondary" onClick={() => setPending(undefined)}>继续编辑</button><button className="primary" onClick={() => void open(pending, true)}>放弃编辑并切换</button></div>}
      {error && <p className="error-text" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    </section></div>
  </div>;
}
