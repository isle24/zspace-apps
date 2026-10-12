import { useEffect, useRef, useState } from "react";
import { api, message } from "../api/client";
import { AppArtwork } from "./AppArtwork";
import { ExternalLink } from "./ExternalLink";
import { Status, useResource, formatBytes } from "./common";
import { useInstanceGenerations } from "./RuntimeInstanceDetails";
import {
  initializationLabel,
  safeAppURL,
  type PlanRequest,
  type RuntimeInstance,
  type RuntimeSnapshot,
} from "./runtime-types";
export function RuntimeLogs({ instance }: { instance: RuntimeInstance }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen((value) => !value)}>
        {open ? "关闭日志" : "查看日志"}
      </button>
      {open && <LogData instance={instance} />}
    </>
  );
}
function LogData({ instance }: { instance: RuntimeInstance }) {
  const { resource, valid, current, active } = useInstanceGenerations(instance);
  const services = active?.recipe?.services || [];
  const [selected, setSelected] = useState<string>();
  const service = selected ?? services.find(item => item.entry)?.id ?? "";
  const allowed = services.some(item => item.id === service);
  const logs = useResource(
    async () => {
      if (!valid || !current() || !allowed) return undefined;
      const result = await api.store<{ text: string }>(
        `v2/instances/${encodeURIComponent(instance.id)}/logs?service=${encodeURIComponent(service)}`,
      );
      if (!current()) throw new Error("商店服务或会话已改变，请重新打开日志");
      return result;
    },
    [instance.id, instance.activeGenerationId, service, allowed, valid],
  );
  if (!valid) return <p className="notice">商店服务或会话已改变，请重新打开日志。</p>;
  return (
    <div>
      <Status {...resource} retry={resource.reload} />
      {resource.data && !active && <p>当前代次记录尚未返回，不能读取服务日志。</p>}
      {active && !services.length && <p>当前代次没有已声明服务，不能读取日志。</p>}
      {!!services.length && <label className="field">日志服务
        <select value={service} onChange={e => { if (services.some(item => item.id === e.target.value)) setSelected(e.target.value); }}>
          {!service && <option value="">选择已声明服务</option>}
          {services.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}
        </select>
      </label>}
      <Status {...logs} retry={logs.reload} />
      {logs.data && <pre>{logs.data.text || "当前没有日志"}</pre>}
    </div>
  );
}
export function RuntimeDesktop() {
  const resource = useResource(
    () => api.store<{ items: RuntimeInstance[] }>("v2/desktop"),
    [],
  );
  return (
    <section>
      <h2>应用桌面</h2>
      <Status
        {...resource}
        retry={resource.reload}
        empty={!!resource.data && !resource.data.items.length}
      />
      <div className="runtime-grid">
        {resource.data?.items.map((instance) => (
          <article className="runtime-card" key={instance.id}>
            <span className="store-app-icon">
              <AppArtwork appId={instance.appId} />
            </span>
            <h3>{instance.name || instance.appId}</h3>
            <p>健康检查：{instance.health}</p>
            <p>
              首次配置：
              {initializationLabel(instance.initialization)}
            </p>
            {safeAppURL(instance.accessUrl) ? (
              <ExternalLink href={safeAppURL(instance.accessUrl)}>
                打开应用 / 首次配置
              </ExternalLink>
            ) : (
              <p>暂无安全访问地址，请核对任务。</p>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
export function RuntimeSnapshots({
  busy,
  onPlan,
}: {
  busy: boolean;
  onPlan: (request: PlanRequest) => void;
}) {
  const resource = useResource(
      () => api.store<{ items: RuntimeSnapshot[] }>("v2/snapshots"),
      [],
    ),
    [error, setError] = useState(""),
    [downloading, setDownloading] = useState(""),
    [progress, setProgress] = useState<{ verified: number; total: number }>();
  const alive = useRef(true),
    downloadController = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      downloadController.current?.abort();
    };
  }, []);
  async function download(snapshot: RuntimeSnapshot) {
    if (downloading) return;
    const session = api.storeSession,
      address = api.storeAddress;
    const current = () =>
      alive.current &&
      session === api.storeSession &&
      address === api.storeAddress;
    const controller = new AbortController();
    downloadController.current = controller;
    setProgress(undefined);
    setDownloading(snapshot.id);
    setError("");
    try {
      const blob = await api.downloadStore(
        `v2/snapshots/${encodeURIComponent(snapshot.id)}/download`,
        { sizeBytes: snapshot.sizeBytes, sha256: snapshot.sha256 },
        controller.signal,
        (verified, total) => {
          if (current()) setProgress({ verified, total });
        },
      );
      if (!current()) return;
      const url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = `${snapshot.appId}-${snapshot.id}.tar`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      if (current()) setError(message(e));
    } finally {
      if (current()) setDownloading("");
    }
  }
  return (
    <section>
      <h2>私有备份与恢复</h2>
      <p className="hint">恢复会创建新数据副本，原应用数据与快照继续保留。</p>
      <Status
        {...resource}
        retry={resource.reload}
        empty={!!resource.data && !resource.data.items.length}
      />
      {error && <p role="alert">{error}</p>}
      {!!downloading && progress && (
        <p role="status">
          正在校验快照：{formatBytes(progress.verified)} /{" "}
          {formatBytes(progress.total)}
        </p>
      )}
      {resource.data?.items.map((snapshot) => (
        <article className="runtime-card" key={snapshot.id}>
          <h3>
            {snapshot.appId} · {snapshot.version}
          </h3>
          <p>
            {snapshot.createdAt} · {formatBytes(snapshot.sizeBytes)}
          </p>
          <p className="runtime-digest">SHA256：{snapshot.sha256}</p>
          <small>{snapshot.path}</small>
          <div className="runtime-actions">
            <button
              disabled={!!downloading}
              onClick={() => void download(snapshot)}
            >
              {downloading === snapshot.id ? "下载中…" : "下载私有快照"}
            </button>
            <button
              disabled={busy}
              onClick={() =>
                onPlan({
                  kind: "restore",
                  instanceId: snapshot.instanceId,
                  snapshotId: snapshot.id,
                })
              }
            >
              生成恢复计划
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
