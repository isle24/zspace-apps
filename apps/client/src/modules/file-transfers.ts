import type { FileDownload, FileTransfer, Item } from "../api/client";
import { BrowserDownloadError, type BrowserDownloadOptions, type BrowserDownloadResult } from "../api/browser-download";
import { downloadDiagnosticLabel } from "../api/download-diagnostics";
export type TransferRow = Readonly<FileTransfer & {
  delivery: "native" | "browser";
  mayHavePartial?: boolean;
  cancelRequested?: boolean;
}>;
export type TransferDependencies = {
  session(): string;
  native(): boolean;
  prepare(item: Item): Promise<FileDownload>;
  fetch(id: string, options: {
    signal: AbortSignal;
  }): Promise<Response>;
  deliver(options: BrowserDownloadOptions): Promise<BrowserDownloadResult>;
  listen(callback: (row: FileTransfer) => void): Promise<() => void>;
  startNative(reference: string): Promise<FileTransfer>;
  cancelNative(id: string): Promise<void>;
  nativeTasks(sessionId: string): Promise<FileTransfer[]>;
};
const active = (row?: FileTransfer) => row?.status === "choosing" || row?.status === "running";
const basename = (name: unknown): name is string => typeof name === "string" && !!name && name.length <= 255 && !/[\\/\u0000-\u001f\u007f]/.test(name) && name !== "." && name !== "..";
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export function downloadUnavailable(item?: Item): string {
  if (!item)
    return "请先选择一个文件";
  const metadata = item.metadata ?? {};
  if (["folder", "directory", "root"].includes(item.kind || "") || metadata.is_dir === true || String(metadata.is_dir ?? metadata.di) === "1")
    return "文件夹暂不支持下载，请打开后选择单个文件";
  const encrypted = metadata.encrypted_path || (item.path?.startsWith("E.") ? item.path : undefined);
  if (!item.id || !basename(item.name) || (encrypted ? typeof metadata.from !== "string" || !metadata.from || !basename(metadata.name || metadata.file_name) : !item.path?.startsWith("/") || item.path.startsWith("//")))
    return "此文件缺少可验证的下载身份，请刷新列表";
  return "";
}
type Run = {
  key: string;
  item: Item;
  rowId: string;
  session: string;
  generation: number;
  abort: AbortController;
  native: boolean;
  nativeId?: string;
  nativeStarting?: boolean;
  cancelled: boolean;
};
/** Owns transport outside Files/task window lifetimes. Retry inputs never enter public snapshots. */
export class FileTransfersController {
  private session: string;
  private generation = 0;
  private rows: readonly TransferRow[] = [];
  private subscribers = new Set<() => void>();
  #runs = new Map<string, Run>();
  private sequence = 0;
  private revision = 0;
  private nativeRevisions = new Map<string, number>();
  private listening?: Promise<void>;
  private unlisten?: () => void;
  private disposed = false;
  private issue = "";
  constructor(private deps: TransferDependencies) {
    this.session = deps.session();
  }
  getSnapshot = () => this.rows;
  getIssue = () => this.issue;
  subscribe = (callback: () => void) => {
    this.subscribers.add(callback);
    return () => { this.subscribers.delete(callback); };
  };
  private publish(rows: readonly TransferRow[]) {
    this.rows = Object.freeze(rows.map(row => Object.freeze({ ...row })));
    for (const subscriber of this.subscribers)
      subscriber();
  }
  private update(id: string, change: Partial<TransferRow>) {
    this.publish(this.rows.map(row => row.id === id ? { ...row, ...change } : row));
  }
  syncSession() {
    const session = this.deps.session();
    if (session === this.session)
      return;
    for (const run of this.#runs.values()) {
      run.cancelled = true;
      run.abort.abort();
      if (run.nativeId && active(this.rows.find(row => row.id === run.rowId)))
        void this.deps.cancelNative(run.nativeId).catch(() => { });
    }
    this.session = session;
    this.generation++;
    this.#runs.clear();
    this.nativeRevisions.clear();
    this.issue = "";
    this.publish([]);
  }
  private current(run: Run) {
    return !this.disposed && !run.cancelled && run.generation === this.generation &&
      run.session === this.session && this.deps.session() === run.session;
  }
  private ensureListener() {
    if (!this.listening) {
      this.listening = this.deps.listen(row => this.acceptNative(row)).then(unlisten => {
        if (this.disposed) unlisten();
        else this.unlisten = unlisten;
      }).catch(error => {
        this.listening = undefined;
        throw error;
      });
    }
    return this.listening;
  }
  private acceptNative(value: FileTransfer, snapshotRevision?: number) {
    if (this.disposed || !this.deps.native() || !value || !this.session ||
      this.deps.session() !== this.session || value.sessionId !== this.session ||
      !/^[a-f0-9]{64}$/.test(value.id) || !basename(value.name) || !count(value.received) ||
      (value.total !== undefined && !count(value.total)) ||
      !["choosing", "running", "completed", "failed", "cancelled"].includes(value.status))
      return;
    if (snapshotRevision !== undefined && (this.nativeRevisions.get(value.id) ?? 0) > snapshotRevision)
      return;
    const previous = this.rows.find(row => row.id === value.id);
    if (previous && ((!active(previous) && previous.status !== value.status) || (previous.status === "running" && value.status === "choosing") || value.received < previous.received))
      return;
    const retainedPartial = value.retainedPartial === true || previous?.retainedPartial === true;
    const cancelRequested = previous?.cancelRequested === true && active(value);
    const message = cancelRequested ? this.nativeCancelMessage(value) : retainedPartial ? "新建的不完整文件已保留，请检查后再重新下载" : value.status === "completed" ? "文件已保存到本机" : value.status === "failed" ? "下载失败，请检查设备连接、文件权限或保存位置" : value.status === "cancelled" ? "下载已取消" : undefined;
    const row: TransferRow = {
      id: value.id, sessionId: value.sessionId, name: value.name, received: value.received,
      ...(value.total === undefined ? {} : { total: value.total }),
      status: value.status, delivery: "native",
      ...(retainedPartial ? { retainedPartial: true } : {}), ...(message ? { message } : {}),
      ...(cancelRequested ? { cancelRequested: true } : {}),
    };
    if (snapshotRevision === undefined)
      this.nativeRevisions.set(row.id, ++this.revision);
    this.publish(previous ? this.rows.map(value => value.id === row.id ? row : value) : [...this.rows, row]);
  }
  isDownloading(item: Item) {
    const key = JSON.stringify([this.session, item.path, item.metadata?.encrypted_path, item.metadata?.from]);
    return [...this.#runs.values()].some(run => run.key === key && active(this.rows.find(row => row.id === run.rowId)));
  }
  canRetry(id: string) {
    return this.#runs.has(id) && ["failed", "cancelled"].includes(this.rows.find(row => row.id === id)?.status || "");
  }
  async download(item: Item, mode: "auto" | "compatible" = "auto") {
    this.syncSession();
    if (this.disposed || !this.session || downloadUnavailable(item))
      return;
    const key = JSON.stringify([this.session, item.path, item.metadata?.encrypted_path, item.metadata?.from]);
    if ([...this.#runs.values()].some(run => run.key === key && active(this.rows.find(row => row.id === run.rowId))))
      return;
    const run: Run = { key, item: structuredClone(item), rowId: `local-${++this.sequence}`, session: this.session, generation: this.generation, abort: new AbortController(), native: this.deps.native(), cancelled: false };
    this.#runs.set(run.rowId, run);
    this.publish([...this.rows, { id: run.rowId, sessionId: run.session, name: item.name, received: 0, ...(count(item.size) ? { total: item.size } : {}), status: "choosing", delivery: run.native ? "native" : "browser", message: "正在准备下载" }]);
    try {
      if (run.native)
        await this.ensureListener();
      if (!this.current(run))
        return;
      const descriptor = await this.deps.prepare(run.item);
      if (!this.current(run) || descriptor.sessionId !== run.session)
        return;
      this.update(run.rowId, { name: descriptor.name, total: descriptor.size });
      if (run.native) {
        run.nativeStarting = true;
        const result = await this.deps.startNative(descriptor.id);
        run.nativeStarting = false;
        if (this.disposed || run.generation !== this.generation || run.session !== this.session || this.deps.session() !== run.session) {
          if (result?.sessionId === run.session && /^[a-f0-9]{64}$/.test(result.id))
            void this.deps.cancelNative(result.id).catch(() => { });
          return;
        }
        // A progress event can arrive before the start response. Bind by the returned opaque id,
        // then merge without downgrading that event; cancellation during IPC must follow this id.
        const provisional = run.rowId;
        run.nativeId = result.id;
        run.rowId = result.id;
        this.#runs.delete(provisional);
        this.#runs.set(run.rowId, run);
        this.publish(this.rows.filter(row => row.id !== provisional));
        this.acceptNative(result);
        if (run.cancelled) await this.requestNativeCancellation(result.id);
      }
      else {
        this.update(run.rowId, { status: "running", message: undefined });
        const result = await this.deps.deliver({
          download: descriptor, mode, fetchDownload: this.deps.fetch,
          signal: run.abort.signal, isSessionCurrent: () => this.current(run),
          onProgress: progress => {
            if (this.current(run) && count(progress.received))
              this.update(run.rowId, { received: progress.received, ...(progress.total === undefined ? {} : { total: progress.total }) });
          },
        });
        if (this.current(run))
          this.update(run.rowId, { received: result.received, ...(result.total === undefined ? {} : { total: result.total }), status: "completed", message: "已交给浏览器下载管理器，请在其中确认保存结果" });
      }
    }
    catch (error) {
      if (!this.current(run)) {
        if (run.nativeStarting && run.cancelled && !this.disposed && run.generation === this.generation && run.session === this.deps.session())
          this.update(run.rowId, { status: "failed", cancelRequested: undefined, message: "无法确认保存任务结果，请刷新本机任务" });
        return;
      }
      const browser = error instanceof BrowserDownloadError;
      const label = browser && error.code === "DELIVERY_FAILED" ? downloadDiagnosticLabel(error.diagnostic) : undefined;
      const message = browser ? new BrowserDownloadError(error.code, error.browserHandoffStarted).message : "无法安全准备或启动下载，请刷新文件列表后重试";
      this.update(run.rowId, { status: browser && ["CANCELLED", "PAGE_UNLOADED", "SESSION_CHANGED"].includes(error.code) ? "cancelled" : "failed", message: label ? `${message}；${label}` : message, ...(browser && error.mayHavePartial ? { mayHavePartial: true } : {}) });
    }
  }
  async retry(id: string, mode: "auto" | "compatible" = "auto") {
    this.syncSession();
    const run = this.#runs.get(id), row = this.rows.find(value => value.id === id);
    if (run && row && ["failed", "cancelled"].includes(row.status) && run.session === this.session)
      await this.download(run.item, mode);
  }
  private nativeCancelMessage(row: FileTransfer) {
    return row.status === "choosing" ? "正在取消，请关闭保存对话框" : "正在取消，请等待任务结束";
  }
  private async requestNativeCancellation(id: string) {
    const row = this.rows.find(value => value.id === id), generation = this.generation;
    if (!row || !active(row) || row.cancelRequested) return;
    // The command acknowledges a cancel flag; only a native event/snapshot can settle the task.
    // In particular, completion may already be committed while its renderer event is delayed.
    this.update(id, { cancelRequested: true, message: this.nativeCancelMessage(row) });
    try {
      await this.deps.cancelNative(id);
    } catch {
      if (generation === this.generation && this.deps.session() === row.sessionId && active(this.rows.find(value => value.id === id))) {
        const run = this.#runs.get(id);
        if (run) run.cancelled = false;
        this.update(id, { cancelRequested: undefined, message: "取消未成功，请重试" });
      }
    }
  }
  async cancel(id: string) {
    this.syncSession();
    const row = this.rows.find(value => value.id === id), run = this.#runs.get(id);
    if (!row || !active(row) || row.cancelRequested) return;
    if (row.delivery === "native" && !id.startsWith("local-")) {
      await this.requestNativeCancellation(id);
      return;
    }
    if (run) {
      run.cancelled = true;
      run.abort.abort();
    }
    if (row.delivery === "native" && run?.nativeStarting) {
      // The native task id is not available yet. Bind and cancel it as soon as start replies.
      this.update(id, { cancelRequested: true, message: "正在取消，等待保存任务响应" });
      return;
    }
    this.update(id, {
      status: "cancelled",
      message: row.delivery === "browser"
        ? "下载已取消；如已出现浏览器下载任务，请检查其中的不完整文件"
        : "下载已取消",
    });
  }
  async refresh() {
    this.syncSession();
    if (!this.session || !this.deps.native() || this.disposed)
      return;
    const session = this.session, generation = this.generation, revision = this.revision;
    // A snapshot requested before an event cannot replace that event when its IPC reply is delayed.
    try {
      await this.ensureListener();
      const rows = await this.deps.nativeTasks(session);
      if (generation === this.generation && session === this.session && session === this.deps.session()) {
        for (const row of rows) this.acceptNative(row, revision);
        this.issue = "";
        this.publish(this.rows);
      }
    } catch {
      if (!this.disposed && generation === this.generation && session === this.deps.session()) {
        this.issue = "暂时无法读取本机下载任务，请点击刷新重试";
        this.publish(this.rows);
      }
    }
  }
  pageUnload() {
    for (const run of this.#runs.values()) {
      if (run.native || !active(this.rows.find(row => row.id === run.rowId)))
        continue;
      run.cancelled = true;
      run.abort.abort();
      this.update(run.rowId, { status: "cancelled", message: "页面已离开，下载未完成，请查看浏览器下载管理器" });
    }
  }
  dispose() {
    this.disposed = true;
    this.unlisten?.();
    for (const run of this.#runs.values()) {
      run.cancelled = true;
      run.abort.abort();
    }
    this.#runs.clear();
    this.subscribers.clear();
  }
}
