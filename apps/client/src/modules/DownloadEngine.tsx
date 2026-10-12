import { useEffect, useRef, useState } from "react";
import { api, message } from "../api/client";
import type { DownloadEngineState } from "../api/official-nas";
import { Status, useResource } from "./common";
import "../styles/nas-tools.css";
export function DownloadEngine({ connected, changed }: { connected: boolean; changed: () => void }) {
  const resource = useResource(() => api.downloadEngineState(), [api.nasSession, connected]);
  const [result, setResult] = useState<DownloadEngineState>();
  const [selection, setSelection] = useState(""), [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const generation = useRef(0);
  const state = result ?? resource.data;
  useEffect(() => { generation.current++; setResult(undefined); setSelection(""); setConfirm(false); setBusy(false); setError(""); return () => { generation.current++; }; }, [api.nasSession]);
  useEffect(() => {
    if (!state || ![1, 2].includes(state.status)) return;
    const stamp = generation.current;
    const timer = window.setTimeout(async () => {
      try { const next = await api.downloadEngineState(); if (stamp === generation.current) { setResult(next); if ([3, 4, 5].includes(next.status)) changed(); } }
      catch (e) { if (stamp === generation.current) setError(message(e)); }
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [state]);
  async function switchEngine(ack = false) {
    if (!state || busy) return;
    const stamp = generation.current;
    setBusy(true); setError("");
    try {
      const next = ack ? await api.acknowledgeDownloadEngineSwitch() : await api.switchDownloadEngine(Number(selection) as 1 | 2);
      if (stamp === generation.current) { setResult(next); setSelection(""); setConfirm(false); changed(); }
    } catch (e) { if (stamp === generation.current) setError(message(e)); }
    finally { if (stamp === generation.current) setBusy(false); }
  }
  const text = state ? ({ 1: "正在切换引擎…", 2: "正在迁移下载任务…", 3: "切换未完成，请检查设备任务状态。", 4: "切换已完成，部分任务需要检查。", 5: "切换已完成。" }[state.status]) : undefined;
  return <section className="nas-tool-card download-engine" aria-label="下载引擎设置">
    <div><h2>下载引擎</h2><p className="muted">新任务使用设备当前引擎。切换时设备会迁移已有任务。</p></div>
    <Status {...resource} connected={connected} retry={() => { setResult(undefined); resource.reload(); }} />
    {state && <><div className="nas-tool-controls"><label>下载引擎<select aria-label="下载引擎" value={selection || String(state.current)} disabled={busy || [1, 2].includes(state.status)} onChange={e => { setSelection(e.target.value); setConfirm(false); }}>{state.engines.map(engine => <option key={engine.type} value={engine.type}>{engine.name}{engine.version ? ` ${engine.version}` : ""}</option>)}</select></label><button className="secondary" disabled={!connected || busy || !selection || Number(selection) === state.current || [1, 2].includes(state.status)} onClick={() => setConfirm(true)}>切换引擎</button><button className="secondary" disabled={!connected || busy || resource.loading} onClick={() => { setResult(undefined); setSelection(""); setConfirm(false); resource.reload(); }}>刷新引擎</button></div>
      {confirm && <div className="management-confirm"><p>确认切换到 {state.engines.find(e => e.type === Number(selection))?.name}？下载任务会暂时中断，完成后请检查任务状态。</p><button className="primary" disabled={busy} onClick={() => void switchEngine()}>{busy ? "正在提交…" : "确认切换"}</button><button className="secondary" disabled={busy} onClick={() => setConfirm(false)}>取消</button></div>}
      {text && <p role="status">{text}</p>}{[3, 4, 5].includes(state.status) && <button className="secondary" disabled={busy} onClick={() => void switchEngine(true)}>已了解，确认结果</button>}
    </>}{error && <p role="alert" className="error-text">{error}</p>}
  </section>;
}
