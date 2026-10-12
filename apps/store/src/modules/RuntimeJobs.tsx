import { useEffect, useState, useRef } from "react";
import { api, message } from "../api/client";
import { Status, useResource } from "./common";
import { operationLabel, type RuntimeJob } from "./runtime-types";
const stages: Record<string, string> = {
  queued: "等待执行",
  validate: "核对操作计划",
  "stop-source": "停止原代次服务",
  "prepare-copy": "准备新数据副本",
  "launch-verify": "启动并核验服务",
  "switch-generation": "切换应用代次",
  complete: "操作完成",
  "needs-attention": "需要检查",
  stop: "停止服务",
  restart: "重启服务",
  reconciled: "保留资源核对完成",
  preflight: "操作预检",
  pull: "拉取固定镜像",
  prepare: "准备独立数据",
  snapshot: "创建私有快照",
  restore: "恢复数据副本",
  start: "启动服务",
  launch: "启动服务",
  health: "健康检查",
  initialization: "等待首次配置",
  switch: "切换应用代次",
  completed: "操作完成",
  failed: "操作失败",
  needs_attention: "需要处理",
};
const statuses: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  succeeded: "已完成",
  completed: "已完成",
  failed: "失败",
  needs_attention: "需处理",
  cancelled: "已取消",
};
export function RuntimeJobs({
  busy = false,
  onRetry,
  onInspect,
}: {
  busy?: boolean;
  onRetry?: (job: RuntimeJob) => void;
  onInspect?: (instanceId: string) => void;
} = {}) {
  const streamRevision = useRef(0);
  const persisted = useResource(async () => {
      const revision = streamRevision.current;
      const result = await api.store<{ items: RuntimeJob[] }>("v2/jobs");
      return { ...result, revision };
    }, []),
    [items, setItems] = useState<RuntimeJob[]>(),
    [streamError, setStreamError] = useState("");
  useEffect(() => {
    if (persisted.data && persisted.data.revision === streamRevision.current)
      setItems(persisted.data.items);
  }, [persisted.data]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let alive = true;
    const session = api.storeSession,
      address = api.storeAddress;
    const current = () =>
      alive &&
      !controller.signal.aborted &&
      session === api.storeSession &&
      address === api.storeAddress;
    async function connect() {
      try {
        await api.streamStore(
          "v2/jobs/events",
          (value) => {
            if (!current()) return;
            const data = (value as any)?.data || value;
            if (Array.isArray((data as any)?.items)) {
              streamRevision.current++;
              setItems((data as any).items);
              setStreamError("");
            } else if ((data as any)?.id) {
              streamRevision.current++;
              const job = data as RuntimeJob;
              setItems((list) => [
                job,
                ...(list || []).filter((item) => item.id !== job.id),
              ]);
            }
          },
          controller.signal,
        );
      } catch (e) {
        if (current()) setStreamError("实时连接中断：" + message(e));
      } finally {
        if (current()) {
          persisted.reload();
          timer = setTimeout(connect, 4000);
        }
      }
    }
    void connect();
    return () => {
      alive = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  return (
    <section>
      <h2>任务中心</h2>
      <p className="hint">展示持久化任务和真实阶段；连接恢复后重新读取记录。</p>
      <Status
        {...persisted}
        retry={persisted.reload}
        empty={!persisted.loading && !persisted.error && items?.length === 0}
      />
      {streamError && (
        <p className="notice" role="status">
          {streamError}
        </p>
      )}
      {items?.map((job) => (
        <article className="runtime-card" key={job.id}>
          <h3>
            {job.appId} · {statuses[job.status] || job.status}
          </h3>
          <p>{stages[job.stage] || job.stage}</p>
          <small>
            {job.id} · {job.updatedAt || job.createdAt}
          </small>
          {job.stages != null && (
            <details>
              <summary>阶段记录</summary>
              {Array.isArray(job.stages) ? (
                <ol>
                  {job.stages
                    .filter((stage) => stage && typeof stage.name === "string")
                    .map((stage, index) => (
                      <li key={index}>
                        {stages[stage.name] || stage.name} ·{" "}
                        {statuses[stage.status] || stage.status} ·{" "}
                        {stage.at || "时间未提供"}
                      </li>
                    ))}
                </ol>
              ) : (
                <p>服务未返回可识别的阶段记录。</p>
              )}
            </details>
          )}
          {job.error && <p role="alert">{job.error}</p>}
          {job.status === "failed" &&
            job.id &&
            job.planId &&
            job.appId &&
            job.instanceId &&
            job.kind &&
            Object.hasOwn(operationLabel, job.kind) &&
            onRetry && (
              <button disabled={busy} onClick={() => onRetry({ ...job })}>
                {busy ? "生成计划中…" : "生成重试计划"}
              </button>
            )}
          {job.status === "needs_attention" && (
            <>
              <p className="notice">需先检查当前应用代次与保留资源，再生成新的操作计划。</p>
              {job.instanceId && onInspect && (
                <button disabled={busy} onClick={() => onInspect(job.instanceId)}>
                  检查当前应用代次
                </button>
              )}
            </>
          )}
        </article>
      ))}
    </section>
  );
}
