import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ArrowClockwise, DownloadSimple, X } from "@phosphor-icons/react";
import { api, isNative, type Item } from "../api/client";
import { BLOB_DOWNLOAD_LIMIT, deliverBrowserDownload } from "../api/browser-download";
import {
  FileTransfersController,
  downloadUnavailable,
  type TransferRow,
} from "./file-transfers";
import { lazy, Suspense } from "react";
import type { Instance } from "./Store";

// 商店组件 465 KB（gzip 138 KB），只有切到"商店"这一栏才用得上 —— 按需加载。
// 仅改接入方式，没有动商店实现。
const Store = lazy(() => import("./Store").then((mod) => ({ default: mod.Store })));
import { formatBytes } from "./common";
import { DeviceTasks } from "./DeviceTasks";

export function createFileTransfersController() {
  return new FileTransfersController({
    session: () => api.nasSession,
    native: isNative,
    prepare: item => api.prepareDownload(item),
    fetch: (id, options) => api.fetchDownload(id, options),
    deliver: deliverBrowserDownload,
    listen: async callback => {
      const { listen } = await import("@tauri-apps/api/event");
      return listen("nas-download-progress", event => callback(event.payload as TransferRow));
    },
    startNative: async reference => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke("nas_download_start", { reference });
    },
    cancelNative: async taskId => {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("nas_download_cancel", { taskId });
    },
    nativeTasks: async sessionId => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke("nas_download_tasks", { sessionId });
    },
  });
}
const Context = createContext<FileTransfersController | undefined>(undefined);
const emptyRows: readonly TransferRow[] = [];
const emptySubscribe = () => () => {};
const emptySnapshot = () => emptyRows;
export function useFileTransfers() {
  return useContext(Context);
}
export function useTransferRows() {
  const controller = useFileTransfers();
  return useSyncExternalStore(
    controller?.subscribe ?? emptySubscribe,
    controller?.getSnapshot ?? emptySnapshot,
  );
}
export function FileTransfersProvider({ children, controller: supplied }: {
  controller?: FileTransfersController;
  children: ReactNode;
}) {
  const [controller] = useState(() => supplied ?? createFileTransfersController());
  const mounted = useRef(0);
  useEffect(() => {
    const revision = ++mounted.current;
    const expired = (event: Event) => {
      if ((event as CustomEvent).detail?.scope === "nas") controller.syncSession();
    };
    const unloaded = () => {
      if (!isNative()) controller.pageUnload();
    };
    window.addEventListener("space-session-expired", expired);
    window.addEventListener("pagehide", unloaded);
    return () => {
      window.removeEventListener("space-session-expired", expired);
      window.removeEventListener("pagehide", unloaded);
      // StrictMode replays effects using the same controller. Dispose after a real app unmount.
      queueMicrotask(() => {
        if (!supplied && mounted.current === revision) controller.dispose();
      });
    };
  }, [controller, supplied]);
  return <Context.Provider value={controller}>{children}</Context.Provider>;
}

export function FileDownloadActions({ item, connected }: {
  item?: Item;
  connected: boolean;
}) {
  const controller = useFileTransfers();
  useTransferRows();
  const [feedback, setFeedback] = useState("");
  useEffect(() => setFeedback(""), [item?.id, item?.path, connected]);
  const unavailable = !connected ? "请先连接 NAS" : downloadUnavailable(item);
  const busy = !!item && !!controller?.isDownloading(item);
  const disabled = !!unavailable || !controller || busy;
  function download(mode: "auto" | "compatible") {
    if (!item || disabled) return;
    void controller!.download(item, mode);
    setFeedback("已添加到任务中心，可关闭文件窗口继续下载");
  }
  return (
    <div className="file-download-actions">
      <div>
        <button className="secondary" disabled={disabled} onClick={() => download("auto")}>
          <DownloadSimple />下载到本机
        </button>
        {!isNative() && (
          <button
            className="secondary"
            disabled={disabled || (item?.size !== undefined && item.size > BLOB_DOWNLOAD_LIMIT)}
            onClick={() => download("compatible")}
          >
            兼容下载（最多 64 MiB）
          </button>
        )}
      </div>
      <small role="status">
        {unavailable || (busy ? "文件正在下载，可在任务中心查看或取消" : feedback) || (
          isNative()
            ? "选择文件后可在本机保存"
            : "流式下载受浏览器支持影响，可手动选择兼容下载"
        )}
      </small>
    </div>
  );
}
function statusLabel(row: TransferRow) {
  if (row.cancelRequested) return "正在取消";
  switch (row.status) {
    case "choosing": return row.message ? "正在准备" : "选择保存位置";
    case "running": return "下载中";
    case "completed": return row.delivery === "browser" ? "已交给浏览器" : "已保存";
    case "failed": return "下载失败";
    case "cancelled": return "已取消";
  }
}
function TransferTaskRow({ row, controller }: {
  row: TransferRow;
  controller?: FileTransfersController;
}) {
  const running = ["choosing", "running"].includes(row.status);
  return (
    <li className={`transfer-row ${row.status}`}>
      <DownloadSimple className="transfer-icon" weight="duotone" />
      <div className="transfer-detail">
        <div className="transfer-title">
          <strong>{row.name}</strong><span>{statusLabel(row)}</span>
        </div>
        <p>
          {formatBytes(row.received)}
          {row.total === undefined ? " · 大小未知" : ` / ${formatBytes(row.total)}`}
        </p>
        {row.total !== undefined && row.total > 0 && (
          <progress
            aria-label={`${row.name}下载进度`}
            max={row.total}
            value={Math.min(row.received, row.total)}
          />
        )}
        {row.message && <p className="transfer-message">{row.message}</p>}
      </div>
      <div className="transfer-actions">
        {running ? (
          <button
            className="secondary"
            aria-label={`取消下载 ${row.name}`}
            disabled={row.cancelRequested}
            onClick={() => void controller?.cancel(row.id)}
          >
            <X />{row.cancelRequested ? "取消中" : "取消"}
          </button>
        ) : controller?.canRetry(row.id) && (
          <>
            <button
              className="secondary"
              aria-label={`重新下载 ${row.name}`}
              onClick={() => void controller.retry(row.id)}
            >
              <ArrowClockwise />重新下载
            </button>
            {row.delivery === "browser" && (row.total === undefined || row.total <= BLOB_DOWNLOAD_LIMIT) && (
              <button
                className="secondary"
                aria-label={`兼容下载 ${row.name}（最多 64 MiB）`}
                onClick={() => void controller.retry(row.id, "compatible")}
              >
                兼容下载（最多 64 MiB）
              </button>
            )}
          </>
        )}
      </div>
    </li>
  );
}
export function FileTransferTasks({ onInstances }: {
  onInstances: (instances: Instance[]) => void;
}) {
  const controller = useFileTransfers();
  const rows = useTransferRows();
  const issue = controller?.getIssue();
  const [tab, setTab] = useState("local");
  useEffect(() => { void controller?.refresh(); }, [controller]);
  return (
    <div className="transfer-tasks">
      <div className="toolbar">
        <div className="tabs">
          <button className={tab === "local" ? "active" : ""} onClick={() => setTab("local")}>
            本机下载
          </button>
          <button className={tab === "device" ? "active" : ""} onClick={() => setTab("device")}>
            设备任务
          </button>
          <button className={tab === "store" ? "active" : ""} onClick={() => setTab("store")}>
            商店安装
          </button>
        </div>
        <span className="spacer" />
        {tab === "local" && (
          <button
            className="icon-button"
            aria-label="刷新本机下载任务"
            onClick={() => void controller?.refresh()}
          >
            <ArrowClockwise />
          </button>
        )}
      </div>
      {tab === "device" ? <DeviceTasks /> : tab === "store" ? (
        <Suspense fallback={<p className="store-loading" role="status">正在载入空间商店…</p>}>
          <Store initialTab="jobs" onInstances={onInstances} />
        </Suspense>
      ) : (
        <div className="module-main transfer-main">
          <div className="content-heading">
            <div>
              <h1>本机下载</h1>
              <p>将 NAS 文件下载到当前设备。NAS 下载中心任务请在下载中心查看。</p>
            </div>
          </div>
          <p className="muted transfer-lifetime">
            关闭文件或任务窗口后继续下载；退出登录会停止传输。
            {isNative() ? "退出应用可能留下不完整文件。" : (
              "离开页面会停止尚未交付的下载，最终保存结果请查看浏览器下载管理器。兼容下载最多支持 64 MiB。"
            )}
          </p>
          {issue && <p className="error-text transfer-lifetime" role="alert">{issue}</p>}
          {!rows.length && !issue ? (
            <div className="state-panel">
              <DownloadSimple size={44} weight="duotone" />
              <h3>还没有本机下载任务</h3>
              <p>在文件管理中选择文件，再点击“下载到本机”</p>
            </div>
          ) : (
            <ul className="transfer-list" aria-label="本机下载任务">
              {rows.map(row => <TransferTaskRow key={row.id} row={row} controller={controller} />)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
