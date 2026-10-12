import { useMemo } from "react";
import { asNumber, asRecord, asText } from "../modules/values";
import { ArrowClockwise, ListChecks } from "@phosphor-icons/react";
import { api, type Item } from "../api/client";
import { Status, formatBytes, useResource } from "./common";

/**
 * 设备任务（任务中心的第三个标签页）。
 *
 * 数据来自官方 `/task/list`：同一张列表里混着下载、同步、备份等不同类型的任务，
 * 条目的字段按类型不同（官方渲染时也是分支读的）：
 *   - 下载类：task_id / name / file_name / total_size / download_size / created_time
 *   - 同步类：task_id / name / finish_time / next_sync_time
 *   - 其它：app_name / type / type_name / status / progress / size / speed
 * 这里按"有就用、没有就不显示"处理，不替设备编造状态。
 */


const statusLabels: Record<string, string> = {
  loading: "进行中", waiting: "等待中", paused: "已暂停", error: "失败",
  success: "已完成", complete: "已完成", finished: "已完成", uploading: "上传中",
  downloading: "下载中", syncing: "同步中", idle: "空闲",
};

const stamp = (value: unknown): string | undefined => {
  const seconds = asNumber(value);
  if (seconds !== undefined && seconds > 0) {
    const ms = seconds > 1e12 ? seconds : seconds * 1000;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString("zh-CN", { hour12: false });
  }
  return asText(value);
};

function progressOf(item: Item): number | undefined {
  const raw = asNumber(item.metadata?.progress);
  if (raw === undefined) return undefined;
  return raw <= 1 ? raw * 100 : raw;
}

export function DeviceTasks() {
  const resource = useResource(() => api.read("tasks.list"), [api.nasSession]);
  const items = useMemo(() => {
    const collection = resource.data as { items?: Item[] } | undefined;
    return Array.isArray(collection?.items) ? collection.items : [];
  }, [resource.data]);

  return (
    <div className="module-main transfer-main">
      <div className="content-heading">
        <div>
          <h1>设备任务</h1>
          <p>设备自己维护的任务：下载、同步、备份等，来自官方任务接口。</p>
        </div>
        <button className="icon-button" aria-label="刷新设备任务" onClick={resource.reload}>
          <ArrowClockwise />
        </button>
      </div>
      <Status
        {...resource}
        empty={!!resource.data && !items.length}
        retry={resource.reload}
      />
      <ul className="device-tasks">
        {items.map((item) => {
          const meta = (item.metadata ?? {}) as Record<string, unknown>;
          const status = asText(meta.status) ?? asText(meta.queue_status) ?? asText(meta.task_status);
          const progress = progressOf(item);
          const total = asNumber(meta.total_size) ?? item.size;
          const done = asNumber(meta.download_size);
          const created = stamp(meta.created_time) ?? stamp(meta.start_time);
          const next = stamp(meta.next_sync_time) ?? stamp(meta.finish_time);
          return (
            <li key={item.id}>
              <span className="device-task-icon" aria-hidden="true">
                <ListChecks weight="duotone" />
              </span>
              <div className="device-task-body">
                <strong>{asText(meta.file_name) ?? item.name}</strong>
                <p>
                  {[
                    asText(meta.type_name) ?? asText(meta.type) ?? asText(meta.task_type) ?? asText(meta.app_name),
                    status ? statusLabels[status.toLowerCase()] ?? status : undefined,
                    created ? `创建于 ${created}` : undefined,
                    next ? `下次 ${next}` : undefined,
                  ].filter(Boolean).join(" · ") || "设备未返回更多信息"}
                </p>
                {progress !== undefined && <progress max={100} value={progress} />}
              </div>
              <span className="device-task-size">
                {done !== undefined && total !== undefined
                  ? `${formatBytes(done)} / ${formatBytes(total)}`
                  : formatBytes(total)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
