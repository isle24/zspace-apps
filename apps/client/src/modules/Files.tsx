import { useEffect, useId, useRef, useState } from "react";
import { DownloadSimple, Folder, FileText, CaretRight, ArrowLeft, ArrowClockwise, List, GridFour, HardDrives, ClockCounterClockwise } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { api, normalizeCollection, safeMediaUrl, type Collection, type Item } from "../api/client";
import { fileRequest } from "../api/operations";
import { supportsImagePreview } from "../api/official-nas";
import { FileDownloadActions, useFileTransfers } from "./FileTransfers";
import { ImagePreview } from "./ImagePreview";
import { Pagination, pagedRequest, usePage } from "./Pagination";
import { formatBytes, Search, Status, useResource } from "./common";
import { FileInfo, fileKindLabel } from "./FileInfo";
import { nextSort, sortItems, sortLabel, type SortDir, type SortKey } from "./file-sort";
import { DirectoryCreate } from "./DirectoryCreate";
import { fileIconFor } from "./file-icons";
import { accessiblePools, FilePoolSidebar, poolForPath } from "./FilePoolSidebar";

export function Files({ connected }: { connected: boolean }) {
  // A new NAS session must never reuse the old directory or submitted search.
  return <FilesContent key={JSON.stringify([api.nasSession, connected])} connected={connected} />;
}
// fnOS 侧栏每个条目有自己的图标；两项都是真实可用的入口，没有无功能按钮。
const sections: Array<{ key: string; label: string; icon: Icon }> = [
  { key: "all", label: "我的文件", icon: Folder },
  { key: "recent", label: "最近访问", icon: ClockCounterClockwise },
];
function FilesContent({ connected }: { connected: boolean }) {
  const [sessionId] = useState(() => api.nasSession);
  const sidebarId = useId();
  const locationControl = useRef<HTMLButtonElement>(null);
  const [locationsOpen, setLocationsOpen] = useState(false);
  const [path, setPath] = useState<Item[]>([]);
  const [section, setSection] = useState("all");
  const [query, setQuery] = useState("");
  const [recentFilter, setRecentFilter] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [scope, setScope] = useState("all");
  const [navigationError, setNavigationError] = useState("");
  const [grid, setGrid] = useState(false);
  const current = path.at(-1);
  const searching = section === "all" && !!submitted;
  const { page, setPage } = usePage([sessionId, section, current?.path, submitted, scope]);
  const requestKey = JSON.stringify([sessionId, section, current?.path, submitted, scope, page, recentFilter]);
  const roots = useResource(async () => {
    if (!connected || api.nasSession !== sessionId) return { items: [] } as Collection;
    const result = normalizeCollection(await api.read("files.roots", {}));
    if (api.nasSession !== sessionId) throw new Error("会话已变更，请重新打开文件");
    return result;
  }, [sessionId, connected]);
  const pools = accessiblePools(roots.data?.items || []);
  const previousPools = useRef<Item[]>([]);
  const overview = section === "all" && !current && !searching;
  const content = useResource(async () => {
    if (!connected || overview || api.nasSession !== sessionId) return undefined;
    const baseRequest = searching
      ? { operation: "files.search", params: { name: submitted, ...(scope === "current" && current?.path ? { path: current.path } : {}) } }
      : fileRequest(section === "recent" ? "files.recent" : "files.list", current);
    const r = pagedRequest(baseRequest, page);
    const result = normalizeCollection(await api.read(r.operation, r.params));
    if (api.nasSession !== sessionId) throw new Error("会话已变更，请重新打开文件");
    return result;
  }, [sessionId, connected, section, current?.path, submitted, scope, page]);
  const resource = overview ? roots : content;
  useEffect(() => {
    if (!roots.data) return;
    const prior = poolForPath(previousPools.current, current?.path);
    if (prior && !pools.some(pool => pool.id === prior.id && pool.path === prior.path)) navigate([]);
    else setPath(previous => previous.map(item => pools.find(pool => pool.id === item.id && pool.path === item.path) || item));
    previousPools.current = pools;
  }, [roots.data]);
  const [selection, setSelection] = useState<{ item: Item; key: string; data?: Collection }>();
  // 多选（Finder/资源管理器式）：⌘/Ctrl 点选切换，Shift 连选，Esc 清空
  const [picked, setPicked] = useState<string[]>([]);
  const anchor = useRef<number | null>(null);
  const [batch, setBatch] = useState("");
  // 传输控制器（FileDownloadActions 用的是同一个），批量下载复用它
  const transfers = useFileTransfers();
  const useTransfersRef = useRef(transfers);
  useTransfersRef.current = transfers;
  // 排序偏好记在本地：官方客户端也记（_sortByMode / _showHiddenFile）
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>(() => {
    try {
      const raw = localStorage.getItem("space-desktop:file-sort");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (["name", "size", "time"].includes(parsed?.key) && ["asc", "desc"].includes(parsed?.dir))
          return { key: parsed.key, dir: parsed.dir };
      }
    } catch {
      /* 读不到就用默认 */
    }
    return { key: "name", dir: "asc" };
  });
  useEffect(() => {
    try {
      localStorage.setItem("space-desktop:file-sort", JSON.stringify(sort));
    } catch {
      /* 存不了不影响使用 */
    }
  }, [sort]);
  const items = sortItems(
    dedupeByPath(
      (resource.data?.items || []).filter(
        (item) => section === "recent" ? item.name.toLowerCase().includes(recentFilter.toLowerCase()) : true,
      ),
    ),
    sort.key,
    sort.dir,
  );

  const keyOf = (item: Item) => item.path || item.id;
  function togglePick(item: Item) {
    const key = keyOf(item);
    setPicked((list) => (list.includes(key) ? list.filter((entry) => entry !== key) : [...list, key]));
  }
  function pickRange(to: number, from: number) {
    const [start, end] = from <= to ? [from, to] : [to, from];
    setPicked(items.slice(start, end + 1).map(keyOf));
  }
  const pickedItems = items.filter((item) => picked.includes(keyOf(item)));
  const pickedSize = pickedItems.reduce((total, item) => {
    const size = Number(item.size);
    return total + (Number.isFinite(size) && size > 0 ? size : 0);
  }, 0);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && picked.length) setPicked([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picked.length]);
  /** 批量下载：逐个走既有下载管线（任务中心里能看到每个任务），避免并发弹一堆下载 */
  async function downloadPicked() {
    const controller = useTransfersRef.current;
    const targets = pickedItems.filter((item) => item.path && !["folder", "directory", "root"].includes(item.kind || ""));
    if (!controller || !targets.length) {
      setBatch(targets.length ? "所选项目没有可下载的文件" : "请先选择文件（文件夹需要逐个打开）");
      return;
    }
    let done = 0;
    for (const item of targets) {
      setBatch(`正在下载 ${done + 1} / ${targets.length}：${item.name}`);
      try {
        await controller.download(item, "auto");
      } catch {
        /* 单个失败不打断整批，任务中心里有该任务的失败状态 */
      }
      done += 1;
    }
    setBatch(`已提交 ${done} 个下载任务，可在任务中心查看进度`);
  }
  const selected = api.nasSession === sessionId && selection?.key === requestKey && selection.data === resource.data ? selection.item : undefined;
  useEffect(() => {
    // A row may be clicked after this collection commits but before this effect
    // flushes. Clear old selections without erasing that new matching click.
    setSelection(previous => previous?.key === requestKey && previous.data === resource.data ? previous : undefined);
  }, [requestKey, resource.data]);
  const info = useResource(async () => {
    if (!selected || !connected || api.nasSession !== sessionId) return null;
    const r = fileRequest("files.info", selected);
    const result = await api.read(r.operation, r.params);
    return api.nasSession === sessionId ? result : null;
  }, [sessionId, selected?.id, selected?.path]);
  function navigate(next: Item[] | Item) {
    // Use committed/queued state and the actual returned path so a second
    // activation before directory readback cannot append the current row again.
    if (!connected || api.nasSession !== sessionId) return;
    setPath(previous => Array.isArray(next) ? next
      : previous.at(-1)?.path === next.path ? previous : [...previous, next]);
    if (locationsOpen) locationControl.current?.focus();
    setLocationsOpen(false);
    setSection("all");
    setSubmitted("");
    setQuery("");
    setRecentFilter("");
    setScope((Array.isArray(next) ? next.at(-1)?.path : next.path) ? "current" : "all");
    setSelection(undefined);
    setNavigationError("");
  }
  function clearSearch() {
    setSubmitted("");
    setQuery("");
    setSelection(undefined);
  }
  return (
    <div className={`module-split files-module ${locationsOpen ? "locations-expanded" : ""}`}>
      <button ref={locationControl} className="file-locations-control secondary" aria-label="文件位置"
        aria-expanded={locationsOpen} aria-controls={sidebarId} onClick={() => setLocationsOpen(!locationsOpen)}>
        <HardDrives />文件位置
      </button>
      <nav id={sidebarId} className="module-sidebar" aria-label="文件位置" onKeyDown={event => {
        if (event.key === "Escape" && locationsOpen) { setLocationsOpen(false); locationControl.current?.focus(); }
      }}>
        <p>个人空间</p>
        {sections.map(({ key, label, icon: SectionIcon }) => (
          <button
            key={key}
            className={section === key && !current ? "selected" : ""}
            aria-current={section === key && !current ? "page" : undefined}
            onClick={() => {
              if (!connected || api.nasSession !== sessionId) return;
              navigate([]);
              setSection(key);
            }}
          >
            <SectionIcon weight="duotone" />
            {label}
          </button>
        ))}
        <FilePoolSidebar pools={pools} currentPath={section === "all" ? current?.path : undefined}
          connected={connected} loading={roots.loading} error={roots.error} reload={roots.reload} onOpen={pool => navigate([pool])} />
        <div className="sidebar-bottom">
          <HardDrives />
          <span>
            {connected ? "设备已连接" : "未连接设备"}
            <small>私人文件，随时访问</small>
          </span>
        </div>
      </nav>
      <div className="module-main">
        <div className="toolbar">
          <button
            className="icon-button files-tool-button"
            aria-label="返回上一级"
            disabled={!path.length}
            onClick={() => navigate(path.slice(0, -1))}
          >
            <ArrowLeft />
          </button>
          <button
            className="icon-button files-tool-button"
            aria-label="刷新文件"
            onClick={resource.reload}
          >
            <ArrowClockwise />
          </button>
          <div className="file-path-trail">
            <button className="breadcrumb" onClick={() => navigate([])}>
              我的文件
            </button>
            {path.map((p, index) => (
              <span className="crumb" key={p.id}>
                <CaretRight />
                <button onClick={() => navigate(path.slice(0, index + 1))}>
                  {p.name}
                </button>
              </span>
            ))}
          </div>
          <span className="spacer" />
          <div className="file-sort" role="group" aria-label="排序方式">
            {(["name", "size", "time"] as SortKey[]).map((key) => (
              <button
                key={key}
                className={sort.key === key ? "active" : ""}
                aria-pressed={sort.key === key}
                onClick={() => setSort((current) => nextSort(current, key))}
                title={`按${sortLabel(key)}排序，再点一次切换方向`}
              >
                {sortLabel(key)}
                {sort.key === key && <span aria-hidden="true">{sort.dir === "asc" ? "↑" : "↓"}</span>}
              </button>
            ))}
          </div>
          {section === "all" && <form className="file-search-form" aria-label="文件名称搜索" onSubmit={(event) => {
            event.preventDefault();
            const name = query.trim();
            if (!name || !connected || api.nasSession !== sessionId) return;
            if (name === submitted && page === 1) resource.reload();
            setSubmitted(name);
            setPage(1);
            setSelection(undefined);
            setNavigationError("");
          }}>
            <Search value={query} onChange={setQuery} placeholder="搜索文件名称" />
            <select aria-label="搜索范围" value={scope} onChange={(event) => {
              setScope(event.target.value);
              setSelection(undefined);
            }}>
              <option value="all">全部可访问文件</option>
              {!!current?.path && <option value="current">当前文件夹</option>}
            </select>
            <button className="secondary" type="submit" disabled={!connected || !query.trim()}>搜索</button>
            {searching && <button className="secondary" type="button" onClick={clearSearch}>清除搜索</button>}
          </form>}
        </div>
        {section === "all" ? <div className="file-search-panel">
          {searching && <p className="file-search-summary" role="status">{scope === "current" ? `当前文件夹：${current?.name}` : "全部可访问文件"} · 搜索“{submitted}”</p>}
          <p className="file-search-note">仅搜索 NAS 已建立索引的文件名称；不包含外接设备、回收站和快照的慢速搜索。</p>
        </div> : <p className="file-search-note recent-filter-note">仅筛选最近访问的当前页，不搜索其他文件。</p>}
        <div className="content-heading">
          <div>
            <h1>
              {current?.name ||
                (section === "recent" ? "最近访问" : "我的文件")}
            </h1>
            <p>
              {resource.data
                ? `${resource.data.total ?? resource.data.items.length} 个项目`
                : "浏览存储空间中的文件"}
            </p>
          </div>
          {section === "recent" && <Search value={recentFilter} onChange={setRecentFilter} placeholder="筛选本页名称" />}
          <button
            className="icon-button files-tool-button"
            aria-label={grid ? "列表视图" : "网格视图"}
            onClick={() => setGrid(!grid)}
          >
            {grid ? <List /> : <GridFour />}
          </button>
        </div>
        {navigationError && <p className="file-search-error" role="alert">{navigationError}</p>}
        <div className="file-actions">
          <DirectoryCreate key={JSON.stringify([sessionId, section, current?.path, connected])}
            parent={current} section={section} connected={connected} sessionId={sessionId} onRefresh={resource.reload} />
          <FileDownloadActions item={selected} connected={connected} />
        </div>
        <Status
          {...resource}
          connected={connected}
          empty={!!resource.data && !items.length}
          retry={resource.reload}
        />
        {!resource.loading && !resource.error && items.length > 0 && (
          <div className={`file-content ${selected ? "with-preview" : ""}`}>
            <div className={grid ? "file-grid" : "file-list"}>
              {!picked.length && !grid && (
                <p className="file-select-hint">
                  ⌘/Ctrl 点选、Shift 连选，Esc 取消；选中后可一次下载多个文件
                </p>
              )}
              {!grid && (
                <div className="file-table-heading">
                  <span>名称</span>
                  <span>类型</span>
                  <span>大小</span>
                </div>
              )}
                  {!!picked.length && (
                <div className="file-selection-bar" role="status">
                  <strong>已选 {pickedItems.length} 项</strong>
                  <span>{pickedSize > 0 ? `合计 ${formatBytes(pickedSize)}` : "合计大小未知"}</span>
                  <button className="secondary" onClick={() => void downloadPicked()}>
                    <DownloadSimple /> 下载所选
                  </button>
                  <button className="secondary" onClick={() => setPicked([])}>
                    清除选择
                  </button>
                  {batch && <small>{batch}</small>}
                </div>
              )}
              {items.map((item, index) => (
                <button
                  className={`file-row ${selected?.id === item.id ? "selected" : ""}${picked.includes(keyOf(item)) ? " picked" : ""}`}
                  key={item.id}
                  aria-pressed={picked.includes(keyOf(item))}
                  onClick={(event) => {
                    if (!connected || api.nasSession !== sessionId) return;
                    // 修饰键 = 选择而不是打开；这是桌面文件管理器的通用习惯
                    if (event.metaKey || event.ctrlKey) {
                      // 锚点跟着最后一次点击走（Finder 的行为），否则 Shift 连选会从错误的位置开始
                      anchor.current = index;
                      togglePick(item);
                      return;
                    }
                    if (event.shiftKey && anchor.current !== null) {
                      pickRange(index, anchor.current);
                      return;
                    }
                    anchor.current = index;
                    setPicked([]);
                    if (
                      ["folder", "directory", "root"].includes(item.kind || "")
                    ) {
                      if (!item.path) {
                        setNavigationError("设备未返回文件夹路径，暂不能打开该项目");
                        return;
                      }
                      // Search results need not be children of the browsing scope.
                      navigate(searching ? [item] : item);
                    } else setSelection({ item, key: requestKey, data: resource.data });
                  }}
                >
                  <span className="file-name">
                    {["folder", "directory", "root"].includes(
                      item.kind || "",
                    ) ? (
                      <Folder className="folder" weight="duotone" />
                    ) : (
                      (() => {
                        const RowIcon = fileIconFor(item.name);
                        return <RowIcon className="document" weight="duotone" />;
                      })()
                    )}
                    {item.name}
                  </span>
                  <span>{fileKindLabel(item.kind)}</span>
                  <span>{formatBytes(item.size)}</span>
                </button>
              ))}
            </div>
            {selected && (
              <aside className="file-preview">
                {supportsImagePreview(selected) ? (
                  <ImagePreview item={selected} />
                ) : safeMediaUrl(selected.thumbnail) ? (
                  // 非图片但有缩略图（影视/音乐服务会给）：显示封面而不是干放一个图标
                  <img
                    className="file-preview-art"
                    referrerPolicy="no-referrer"
                    src={safeMediaUrl(selected.thumbnail)}
                    alt={selected.name}
                  />
                ) : (
                  <FileText size={72} weight="duotone" />
                )}
                <h3>{selected.name}</h3>
                <p>{formatBytes(selected.size)}</p>
                <Status loading={info.loading} error={info.error} />
                {info.data != null && <FileInfo data={info.data} />}
                <button
                  className="secondary"
                  onClick={() => setSelection(undefined)}
                >
                  收起详情
                </button>
              </aside>
            )}
          </div>
        )}
        {resource.data && (searching || !!current || section === "recent") && (
          <Pagination
            page={page}
            total={resource.data.total}
            count={resource.data.items.length}
            onPage={(value) => {
              setSelection(undefined);
              setPage(value);
            }}
            loading={resource.loading}
          />
        )}
      </div>
    </div>
  );
}

/**
 * 同一路径只保留第一行。
 * 极空间的列表偶尔会把同一个文件夹返回两次（新建之后立刻刷新时最容易遇到），
 * 路径在文件树里是唯一身份，所以按路径去重既安全又不会吞掉真实条目。
 */
export function dedupeByPath(rows: Item[]): Item[] {
  const seen = new Set<string>();
  return rows.filter((item: Item) => {
    const key = item.path || item.id;
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
