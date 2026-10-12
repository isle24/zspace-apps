import { useEffect, useState } from "react";
import { ArrowClockwise, DownloadSimple, Pause, Play } from "@phosphor-icons/react";
import { api, normalizeCollection } from "../api/client";
import { Pagination, pagedRequest, usePage, PAGE_SIZE } from "./Pagination";
import { formatBytes, Status, useResource } from "./common";
import { DownloadCreate } from "./DownloadCreate";
import { DownloadEngine } from "./DownloadEngine";

/**
 * 下载中心窗口。从 NasModule.tsx 拆出来的（那边 700 多行），**只搬不改**。
 */
export function DownloadsWindow({ connected }: { connected: boolean }) {
  const [tab, setTab] = useState("loading");
  const [downloadDir, setDownloadDir] = useState("");
  const [bulk, setBulk] = useState<{ busy: boolean; text: string; tone: "" | "ok" | "error" }>({
    busy: false,
    text: "",
    tone: "",
  });
  const { page, setPage } = usePage([api.nasSession, tab]);
  const resource = useResource(() => {
    const r = pagedRequest(
      { operation: "downloads.list", params: { type: tab } },
      page,
    );
    return api.read(r.operation, r.params).then(normalizeCollection);
  }, [api.nasSession, tab, page]);
  const items = resource.data?.items || [];
  /** 批量操作成功后刷新列表；失败按设备返回的错误如实显示 */
  async function bulkAction(operation: string, okText: string) {
    setBulk({ busy: true, text: "正在发送请求…", tone: "" });
    try {
      await api.read(operation);
      resource.reload();
      setBulk({ busy: false, text: `${okText}（设备返回 200）`, tone: "ok" });
    } catch (error) {
      setBulk({
        busy: false,
        text: `操作失败：${error instanceof Error ? error.message : "设备没有返回可用的结果"}`,
        tone: "error",
      });
    }
  }
  useEffect(() => {
    if (!connected || downloadDir) return;
    let alive = true;
    api
      .downloadDirectory()
      .then((dir) => {
        if (alive && dir) setDownloadDir(dir);
      })
      .catch(() => {
        /* 取不到默认目录时留空，由 NAS 决定 */
      });
    return () => {
      alive = false;
    };
  }, [connected, downloadDir]);
  return (
    <div className="padded-module">
      <div className="content-heading">
        <div>
          <h1>下载中心</h1>
          <p>查看设备上的下载任务与传输状态</p>
        </div>
        <div className="heading-actions">
          <DownloadCreate
            connected={connected}
            dir={downloadDir}
            onDirChange={setDownloadDir}
            onDone={resource.reload}
          />
          {/* 批量操作：实测 /downloader/start/all 与 /stop/all 空体即 200；
              单任务的参数名未知（id/gid/hash/ids 都是 N202003），所以不提供单任务按钮 */}
          <button
            className="secondary"
            disabled={!connected || bulk.busy}
            onClick={() => void bulkAction("downloads.startAll", "已请求全部开始")}
          >
            <Play />
            全部开始
          </button>
          <button
            className="secondary"
            disabled={!connected || bulk.busy}
            onClick={() => void bulkAction("downloads.stopAll", "已请求全部暂停")}
          >
            <Pause />
            全部暂停
          </button>
          <button className="secondary" onClick={resource.reload}>
            <ArrowClockwise />
            刷新状态
          </button>
        </div>
      </div>
      {bulk.text && (
        <p className={`download-bulk ${bulk.tone}`} role="status">
          {bulk.text}
        </p>
      )}
      <DownloadEngine connected={connected} changed={resource.reload} />
      <div className="stats-row">
        <div>
          <DownloadSimple />
          <span>
            任务总数
            <strong>
              {resource.data?.total ?? resource.data?.items.length ?? "—"}
            </strong>
          </span>
        </div>
        <div>
          <span>
            连接状态<strong>{connected ? "已连接" : "未连接"}</strong>
          </span>
        </div>
        <div>
          <span>
            任务操作
            <strong className="small-text">全部开始 / 全部暂停 已验证</strong>
          </span>
        </div>
      </div>
      <div className="tabs">
        {[
          ["loading", "进行中"],
          ["complete", "已完成"],
        ].map(([key, label]) => (
          <button
            key={key}
            className={tab === key ? "active" : ""}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <Status
        {...resource}
        connected={connected}
        empty={!!resource.data && !items.length}
        retry={resource.reload}
      />
      <div className="download-list">
        {items.map((item) => (
          <article key={item.id}>
            <DownloadSimple size={32} />
            <div>
              <strong>{item.name}</strong>
              <p>
                {String(item.metadata?.status || "状态待验证")} ·{" "}
                {formatBytes(item.size)}
              </p>
              {typeof item.metadata?.progress === "number" && (
                <progress max={100} value={item.metadata.progress} />
              )}
            </div>
            <span>
              {typeof item.metadata?.speed === "number"
                ? `${formatBytes(item.metadata.speed)}/s`
                : "—"}
            </span>
          </article>
        ))}
      </div>
      {resource.data && (
        <Pagination
          page={page}
          total={resource.data.total}
          count={resource.data.items.length}
          onPage={setPage}
          loading={resource.loading}
        />
      )}
    </div>
  );
}
