import { Fragment, Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowClockwise,
  CaretRight,
  ClockCounterClockwise,
  FilmReel,
  FilmSlate,
  House,
  ImageSquare,
  Images,
  MusicNote,
  MusicNotes,
  Play,
  Queue,
  Rows,
  SortAscending,
  Sparkle,
  SquaresFour,
  VinylRecord,
  Warning,
} from "@phosphor-icons/react";
import { api, normalizeCollection, type Item, safeMediaUrl } from "../api/client";
import { aggregateVideoList, mediaRequest } from "../api/operations";
import { AppIcon, apps } from "../desktop/apps";
import { Pagination, pagedRequest, usePage, canPage, PAGE_SIZE } from "./Pagination";
import { Search, Status, useResource } from "./common";
import type { Instance } from "./Store";
import { VideoWindowBackdrop } from "./VideoWindowBackdrop";

/**
 * 媒体窗口（相册 / 影视 / 音乐共用的外壳）。
 *
 * 从 NasModule.tsx 拆出来的（那边 700 多行），**只搬不改**。
 * 分类栏的计数来自设备真实返回值；设备给多少显示多少，不给就显示 "—"。
 */
export type MediaSelection = {
  items: Item[];
  index: number;
  kind: "video" | "music";
};

/**
 * 相册时间线按天分组。
 *
 * 设备给的是 `cdate`（形如 20261007 的整数）与 `crtime`（秒级时间戳）；
 * 取不到就归到「日期未知」，而不是拿文件名里的数字去猜（那是编造）。
 */
function photoDay(item: Item): { key: string; label: string } {
  const meta = (item.metadata ?? {}) as Record<string, unknown>;
  const raw = meta.cdate;
  if (typeof raw === "number" && raw >= 19000101 && raw <= 29991231) {
    const text = String(raw);
    const year = text.slice(0, 4), month = Number(text.slice(4, 6)), day = Number(text.slice(6, 8));
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31)
      return { key: text, label: `${year} 年 ${month} 月 ${day} 日` };
  }
  const crtime = meta.crtime;
  if (typeof crtime === "number" && crtime > 0) {
    const date = new Date(crtime * 1000);
    if (!Number.isNaN(date.getTime())) {
      const key = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
      return { key, label: `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日` };
    }
  }
  return { key: "unknown", label: "日期未知" };
}

const PhotoViewer=lazy(()=>import("./PhotoViewer").then(m=>({default:m.PhotoViewer})));
const VideoDetails=lazy(()=>import("./VideoDetails").then(m=>({default:m.VideoDetails})));
const PhotosWindow=lazy(()=>import("./PhotosWindow").then(m=>({default:m.PhotosWindow})));
const MusicWindow=lazy(()=>import("./MusicWindow").then(m=>({default:m.MusicWindow})));
export function MediaWindow(props:{id:string;connected:boolean;onPlay:(s:MediaSelection)=>void}){return <Suspense fallback={<p role="status">正在打开媒体库…</p>}>{props.id==="photos"?<PhotosWindow connected={props.connected}/>:props.id==="music"?<MusicWindow connected={props.connected} onPlay={props.onPlay}/> :<GenericMediaWindow {...props}/>}</Suspense>}

function GenericMediaWindow({
  id,
  connected,
  onPlay,
}: {
  id: string;
  connected: boolean;
  onPlay: (s: MediaSelection) => void;
}) {
  const [tab, setTab] = useState(
    id === "photos" ? "timeline" : id === "video" ? "libraries" : "songs",
  );
  const [parent, setParent] = useState<Item>();
  const [query, setQuery] = useState("");
  const [photo, setPhoto] = useState<Item>();
  const [videoCollection, setVideoCollection] = useState<{ item: Item; session: string }>();
  /*
   * 影视工具条（对齐绿联右上角那排按钮里**有数据支撑**的两个）：
   * 网格/列表视图、排序。绿联还有「+ 新建」与「筛选」，我们这边：
   *   - 新建媒体库是设备侧的事，客户端没有对应接口 → 不做（不摆假按钮）；
   *   - 筛选需要拿全量再本地过滤，代价大 → 暂不做，搜索框已经能筛当前页。
   * 排序是**本地**排序：设备忽略排序参数（实测 /v2/file/list 与 zvideo 列表都忽略），
   * 所以只排当前这一页，并如实标注。
   */
  const [videoView, setVideoView] = useState<"grid" | "list">("grid");
  const [videoSort, setVideoSort] = useState<"default" | "name" | "score" | "year">("default");
  /*
   * 封面加载失败的条目。
   *
   * 这台设备的音乐封面地址（/zmusic_static/...）**对 API 自己返回的路径一律 404**
   * （实测 6 首全 404，直连 5055 也一样），视频/相册里也会零星有几张读不出来。
   * 之前失败就让浏览器画一个破图图标 —— 用户看到的是"封面全没显示"，
   * 而且那个灰框紧挨着标题，看起来像"字体被遮挡"。
   * 现在失败就换成图标占位，和"本来就没有封面"完全一致。
   */
  const [failedArt, setFailedArt] = useState<Record<string, boolean>>({});
  const { page, setPage } = usePage([
    api.nasSession,
    id,
    tab,
    parent?.id,
    query,
  ]);
  const tabs =
    id === "photos"
      ? [
          ["timeline", "时间线"],
          ["albums", "相簿"],
          ["feeds", "动态"],
        ]
      : id === "video"
        ? [
            ["libraries", "媒体库"],
            ["list", "全部影片"],
          ]
        : [
            ["songs", "歌曲"],
            ["albums", "专辑"],
            ["playlists", "歌单"],
          ];
  const aggregated = id === "video" && tab === "list" && !parent;
  const resource = useResource(async () => {
    if (aggregated) {
      // 影视「全部影片」：官方接口强制要求 classification_id，因此按库逐个取再合并
      return aggregateVideoList(
        async (operation, params) =>
          normalizeCollection(
            await api.read(operation, params),
          ),
        page,
        PAGE_SIZE,
      );
    }
    const r = pagedRequest(mediaRequest(id, tab, parent), page);
    return normalizeCollection(await api.read(r.operation, r.params));
  }, [api.nasSession, id, tab, parent?.id, page, aggregated]);

  /** 「全部影片」里读取失败的媒体库：要在界面上说清楚，而不是让片子悄悄变少 */
  const failedLibraries =
    aggregated && resource.data && "failedLibraries" in resource.data
      ? ((resource.data as { failedLibraries?: string[] }).failedLibraries ?? [])
      : [];
  // 影视左栏的「分类」= NAS 的真实媒体库列表（飞牛同样是左栏列分类、右侧显示数量）
  const libraries = useResource(
    // 只有影视需要左栏分类；音乐/相册不发这个请求
    () => (id === "video" ? api.read("video.libraries") : Promise.resolve({ items: [] })),
    [api.nasSession, id],
  );
  // 只认 SDK 标记为 library 的条目（同一份 mock/接口里可能混入别的行）
  const libraryItems =
    id === "video"
      ? (libraries.data?.items || []).filter((item) => item.kind === "library")
      : [];
  const items = (resource.data?.items || []).filter((i) =>
    i.name.toLowerCase().includes(query.toLowerCase()),
  );

  // 首页使用设备返回的横版背景图；列表未带背景时读取同一影片的详情。
  // 缺少背景保留中性底色，不把竖版海报放大成横幅。
  const hero = useResource(
    async () => {
      if (!connected || id !== "video" || tab !== "libraries" || parent) return [] as Item[];
      const target = libraryItems.find((entry) => Number((entry.metadata as any)?.collection_count) > 0)
        ?? libraryItems[0];
      if (!target) return [] as Item[];
      const data = normalizeCollection(
        await api.read("video.list", { classification_id: target.id, page: 1, page_size: 5 }),
      );
      return Promise.all((data.items || []).slice(0, 5).map(async entry => {
        const backdrop = safeMediaUrl(entry.backdrop);
        const collectionId = String(entry.metadata?.collection_id ?? entry.id);
        const classificationId = String(entry.metadata?.classification_id ?? target.id);
        const candidate: Item = { ...entry, metadata: { ...entry.metadata, collection_id: collectionId, classification_id: classificationId } };
        if (backdrop) return { ...candidate, backdrop };
        try {
          const detail = normalizeCollection(await api.read("video.info", {
            collection_id: collectionId, classification_id: classificationId,
          }));
          return { ...candidate, backdrop: safeMediaUrl(detail.values?.backdrop) };
        } catch {
          return { ...candidate, backdrop: undefined };
        }
      }));
    },
    [api.nasSession, connected, id, tab, parent?.id, libraryItems.map((entry) => entry.id).join(",")],
  );
  const [heroIndex, setHeroIndex] = useState(0);
  const heroItems = hero.data ?? [];
  const heroItem = heroItems[Math.min(heroIndex, Math.max(0, heroItems.length - 1))];
  const immersiveHome = id === "video" && tab === "libraries" && !parent;
  const backdrop = immersiveHome ? safeMediaUrl(heroItem?.backdrop) : undefined;
  const [backdropFailed, setBackdropFailed] = useState(false);
  useLayoutEffect(() => setBackdropFailed(false), [api.nasSession, heroItem?.id, backdrop]);
  const [heroBusy, setHeroBusy] = useState(false);
  const [heroError, setHeroError] = useState("");
  const heroRequest = useRef(0);
  // Establish the request owner before the new hero can receive a click.
  useLayoutEffect(() => {
    heroRequest.current++;
    setHeroBusy(false);
    setHeroError("");
    return () => { heroRequest.current++; };
  }, [api.nasSession, heroItem?.id]);
  async function playHero() {
    if (!heroItem || heroBusy) return;
    const session = api.nasSession;
    const request = ++heroRequest.current;
    const current = () => request === heroRequest.current && session === api.nasSession;
    setHeroBusy(true);
    setHeroError("");
    try {
      const files = normalizeCollection(await api.read("video.files", {
        collection_id: String(heroItem.metadata?.collection_id ?? heroItem.id),
        classification_id: String(heroItem.metadata?.classification_id),
      }));
      if (!current()) return;
      const playable = files.items.filter(entry => !["directory", "folder", "root"].includes(entry.kind ?? "") && typeof entry.path === "string" && !!entry.path.trim());
      if (!playable.length) { setHeroError("设备未返回可播放的视频文件"); return; }
      onPlay({ items: playable, index: 0, kind: "video" });
    } catch {
      if (current()) setHeroError("暂时无法读取影片文件，请重试");
    } finally {
      if (current()) setHeroBusy(false);
    }
  }

  /*
   * 影视首页的媒体库卡片没有封面。
   *
   * 设备的分类接口（/zvideo/classification/list）**根本不返回封面字段** ——
   * 只有 id / 名称 / 数量。实测过原始响应，没有任何图片字段可用。
   * 所以这里给每个库取前几张影片的海报，拼成 2×2 当封面（海报墙本身是好的，
   * /zvideo_static/..._cover.jpg 能正常加载）。
   *
   * 只在影视首页取，一次并发拿完；某张取不到就少一格，不编造。
   */
  const libraryPosters = useResource(
    async () => {
      const out: Record<string, string[]> = {};
      if (id !== "video" || tab !== "libraries" || !libraryItems.length) return out;
      await Promise.all(
        libraryItems.slice(0, 8).map(async (library) => {
          try {
            const data = normalizeCollection(
              await api.read("video.list", {
                classification_id: library.id,
                page: 1,
                page_size: 4,
              }),
            );
            out[library.id] = (data.items || [])
              .map((entry) => safeMediaUrl(entry.thumbnail))
              .filter((src): src is string => Boolean(src))
              .slice(0, 4);
          } catch {
            out[library.id] = [];
          }
        }),
      );
      return out;
    },
    [api.nasSession, id, tab, libraryItems.map((entry) => entry.id).join(",")],
  );

  const Icon =
    id === "photos" ? ImageSquare : id === "video" ? FilmSlate : MusicNote;
  // 外壳标题栏不再显示应用图标与名称（见 fnos-shell.css），应用自带标题区：
  // 这里给出飞牛式的 应用名 + 页面标题 + 说明 三行，图标用飞牛真实应用图标。
  const appName = id === "photos" ? "相册" : id === "video" ? "影视中心" : "音乐";
  const app = apps.find((entry) => entry.id === id);
  function choose(item: Item, index: number) {
    if (
      ["album", "library", "playlist"].includes(item.kind || "") ||
      (!parent && ["albums", "libraries", "playlists"].includes(tab))
    ) {
      setParent(item);
      return;
    }
    if (id === "video") {
      setVideoCollection({ item, session: api.nasSession });
      return;
    }
    if (id === "photos") setPhoto(item);
    else onPlay({ items, index, kind: id as "video" | "music" });
  }
  if (id === "video" && videoCollection?.session === api.nasSession) return (
    <VideoDetails
      collection={videoCollection.item}
      classificationId={parent ? String(parent.metadata?.classification_id ?? parent.id) : undefined}
      connected={connected}
      onClose={() => setVideoCollection(undefined)}
      onPlay={onPlay}
    />
  );
  // 卡片副标题：优先真实元数据（艺人 / 年份·评分 / 时长），没有就留空
  // —— 以前这里会回落到 item.kind（"library"/"photo" 这类原始英文），看起来像半成品。
  const itemSubtitle = (entry: Item, moduleId: string): string => {
    const meta = entry.metadata || {};
    if (moduleId === "music")
      return String(meta.artist || meta.album || "").trim();
    if (moduleId === "video") {
      /*
       * 元信息行照绿联的写法：`年份 · 类型 · 类型 · 类型`。
       * 设备的 genres 是「剧情 / 喜剧 / 动作」这样的字符串（实测），
       * 直接拆开取前三段；regions 有值时补一段。**不编造**没有的字段。
       */
      const parts: string[] = [];
      const year = Number(meta.release_year);
      if (Number.isFinite(year) && year > 1900) parts.push(String(year));
      const genres = String(meta.genres || "")
        .split("/")
        .map((part) => part.trim())
        .filter(Boolean)
        .slice(0, 3);
      parts.push(...genres);
      const region = String(meta.regions || "")
        .split("/")
        .map((part) => part.trim())
        .filter(Boolean)[0];
      if (!genres.length && region) parts.push(region);
      return parts.join(" · ");
    }
    const date = String(meta.date || meta.modify_time || "").slice(0, 10);
    return date;
  };
  // 飞牛影视 / 飞牛音乐都是“左侧栏 + 内容区”的应用外壳（见 docs/design-assets/fnos-reference）。
  // 相册保持原有版式，所以这里只对影视与音乐加壳，且保留全部既有 className 与文案。
  /*
   * 三个媒体模块都用「左侧栏 + 内容区」外壳。
   *
   * 相册以前不用外壳（.app-rail / .app-content 都是 display:contents），于是
   * 它的标题条、工具栏、网格直接成了外层 flex 的行内子项 —— 标题条被压到 47px
   * 而内容是 62px，**副标题溢出到工具栏上面**，看起来就是"字体被遮挡"。
   * 用同一套外壳后标题条恢复自然高度，同时左栏也正好放时间线/相簿/动态。
   */
  const shell = true;
  /*
   * 面包屑原本对三个模块共用一套文案，相册窗口里于是出现了「音乐 › 歌曲」——
   * 实测在相册窗口的文本里能直接搜到「音乐歌曲」，用户看到的就是这句。
   * 现在按模块取名：相册用「相册 › 当前标签」，影视/音乐保持原样。
   */
  const tabLabel = tabs.find(([key]) => key === tab)?.[1] ?? "";
  const rootLabel = id === "video" ? "影视中心" : id === "music" ? "音乐" : "相册";
  const heading =
    parent?.name || (id === "video" ? tab === "libraries" ? "首页" : "全部影片" : id === "photos" ? tabLabel : "歌曲");
  return (
    <div className={`media-module ${id}${shell ? " fnos-app" : ""}${immersiveHome ? " video-immersive-home" : ""}`}>
      {immersiveHome && <VideoWindowBackdrop key={`${api.nasSession}:${heroItem?.id}:${backdrop ?? ""}`} source={backdrop} onFailure={() => setBackdropFailed(true)} />}
      <aside className="app-rail">
      <div className="media-hero">
        {app ? <AppIcon app={app} /> : <Icon weight="duotone" />}
        <div className="media-hero-text">
          <span className="media-hero-app">{appName}</span>
          <span className="eyebrow">YOUR PERSONAL COLLECTION</span>
          <h1>
            {parent?.name ||
              (id === "photos"
                ? "把美好时光，留在身边"
                : id === "video"
                  ? "私享你的家庭影院"
                  : "每一首，都是你的旋律")}
          </h1>
          <p>
            {id === "photos"
              ? "照片与回忆，汇集于此"
              : id === "video"
                ? "从自己的媒体库，开启一段新旅程"
                : "收藏你的声音，随时畅听"}
          </p>
        </div>
      </div>
      <nav className="toolbar">
        {/* 返回入口只在内容区面包屑旁保留一个（同一意图不重复出现） */}
        <div className="tabs">
          {tabs.map(([key, label]) => (
            <button
              className={tab === key ? "active" : ""}
              key={key}
              onClick={() => {
                setTab(key);
                setParent(undefined);
              }}
            >
              {/* 绿联的侧栏每项都带图标；按模块给对应图标 */}
              {id === "video" ? (
                key === "libraries" ? (
                  <House />
                ) : (
                  <SquaresFour />
                )
              ) : id === "music" ? (
                key === "songs" ? (
                  <MusicNotes />
                ) : key === "albums" ? (
                  <VinylRecord />
                ) : (
                  <Queue />
                )
              ) : key === "timeline" ? (
                <ClockCounterClockwise />
              ) : key === "albums" ? (
                <Images />
              ) : (
                <Sparkle />
              )}
              {label}
            </button>
          ))}
        </div>
        {id === "video" && (
          <>
            <p className="rail-section">媒体库</p>
            <div className="rail-list">
              {libraryItems.map((library) => (
                <button
                  key={library.id}
                  className={parent?.id === library.id ? "active" : ""}
                  onClick={() => {
                    setTab("list");
                    setParent(library);
                    setPage(1);
                  }}
                >
                  <FilmReel weight="duotone" />
                  <span className="rail-name">{library.name}</span>
                  {/* 数量来自 NAS 的 collection_count / series_count，没有就留空，不编造 */}
                  {typeof library.metadata?.count === "number" && (
                    <span className="rail-count">{library.metadata.count}</span>
                  )}
                </button>
              ))}
            </div>
          </>
        )}
        <span className="spacer" />
      </nav>
      </aside>
      <section className={`app-content${id === "video" && tab === "libraries" && !parent ? " video-home" : ""}`}>
      <header className="app-head">
        {parent && (
          <button
            className="icon-button app-round"
            aria-label="返回媒体库"
            onClick={() => { setParent(undefined); setTab(tabs[0][0]); setPage(1); }}
          >
            <ArrowLeft />
          </button>
        )}
        <nav className="app-crumbs" aria-label="位置">
          <button onClick={() => { setParent(undefined); setTab(tabs[0][0]); setPage(1); }}>
            {rootLabel}
          </button>
          <CaretRight />
          <span aria-current="page">{heading}</span>
        </nav>
        <span className="spacer" />
        {id === "video" && (
          <div className="media-tools">
            <button
              className="tool-button"
              aria-label="排序"
              onClick={() =>
                setVideoSort((current) =>
                  current === "default"
                    ? "name"
                    : current === "name"
                      ? "score"
                      : current === "score"
                        ? "year"
                        : "default",
                )
              }
              title="在名称 / 评分 / 年份之间切换（只对本页排序，设备忽略排序参数）"
            >
              <SortAscending />
              {videoSort === "default"
                ? "排序"
                : videoSort === "name"
                  ? "按名称"
                  : videoSort === "score"
                    ? "按评分"
                    : "按年份"}
            </button>
            <button
              className={`tool-button${videoView === "grid" ? " active" : ""}`}
              aria-label="网格视图"
              aria-pressed={videoView === "grid"}
              onClick={() => setVideoView("grid")}
            >
              <SquaresFour />
            </button>
            <button
              className={`tool-button${videoView === "list" ? " active" : ""}`}
              aria-label="列表视图"
              aria-pressed={videoView === "list"}
              onClick={() => setVideoView("list")}
            >
              <Rows />
            </button>
          </div>
        )}
        <Search value={query} onChange={setQuery} placeholder="筛选本页名称" />
        <button
          className="icon-button app-round"
          aria-label="刷新媒体"
          onClick={resource.reload}
        >
          <ArrowClockwise />
        </button>
      </header>
      {heroItem && tab === "libraries" && !parent && (
        <section
          className="video-hero"
          aria-label="首页推荐影片"
        >
          {(!backdrop || backdropFailed) && <span className="hero-art-unavailable">{backdropFailed ? "横版背景图暂不可用" : "设备未提供横版背景图"}</span>}
          <div className="hero-text">
            <h1>{heroItem.name}</h1>
            <p className="hero-meta">{itemSubtitle(heroItem, "video")}</p>
            {String(heroItem.metadata?.storyline || "").trim() && (
              <p className="hero-story">{String(heroItem.metadata?.storyline)}</p>
            )}
            <button
              className="hero-play"
              disabled={heroBusy}
              onClick={() => void playHero()}
            >
              <Play weight="fill" />
              {heroBusy ? "正在读取影片…" : "播放"}
            </button>
            {heroError && <p role="alert" className="hero-error">{heroError}</p>}
          </div>
          {heroItems.length > 1 && (
            <div className="hero-dots" role="tablist" aria-label="首页推荐">
              {heroItems.map((entry, index) => (
                <button
                  key={entry.id}
                  role="tab"
                  aria-selected={index === heroIndex}
                  aria-label={entry.name}
                  className={index === heroIndex ? "active" : ""}
                  onClick={() => setHeroIndex(index)}
                />
              ))}
            </div>
          )}
        </section>
      )}
      {resource.loading && !resource.data ? (
        <div
          className={id === "music" && tab === "songs" ? "song-list skeleton-list" : "media-grid skeleton-grid"}
          aria-busy="true"
          aria-label="正在读取媒体"
        >
          {Array.from({ length: id === "music" && tab === "songs" ? 10 : 12 }).map((_, index) => (
            <span className="skeleton-card" key={index}>
              <span className="skeleton-art" />
              <span className="skeleton-line" />
              <span className="skeleton-line short" />
            </span>
          ))}
        </div>
      ) : resource.error || !items.length ? (
        <div className="media-stage">
          {/* 部分媒体库读取失败时如实说明：否则用户只看到"片子变少了" */}
          {failedLibraries.length > 0 && (
            <p className="media-partial" role="status">
              <Warning weight="duotone" aria-hidden="true" />
              {failedLibraries.length} 个媒体库这次没读出来：{failedLibraries.join("、")}
            </p>
          )}
          <Status
            {...resource}
            connected={connected}
            empty={!!resource.data && !items.length}
            retry={resource.reload}
          />
          {!resource.loading && (!connected || !resource.error) && (
            <button
              className="primary media-stage-action"
              onClick={resource.reload}
            >
              <ArrowClockwise />
              重新读取
            </button>
          )}
        </div>
      ) : (
        <div
          className={
            id === "music" && tab === "songs"
              ? "song-list"
              : id === "photos" && tab === "timeline"
                ? "media-grid photo-timeline"
                : id === "video" && videoView === "list"
                  ? "media-grid video-list"
                  : "media-grid"
          }
        >
          {items.map((item, index) => {
            const day = id === "photos" ? photoDay(item).key : "";
            return (
            <Fragment key={item.id}>
              {/* 时间线：换天就插一个日期小标题（绿联/飞牛相册都是这个结构） */}
              {/* 第一张也要标题 —— 原来的判断用 items[index-1] ?? item，index 0 时自己和自己相等，
                  于是首组永远没有日期（实测标题被推到 20 张之后） */}
              {id === "photos" &&
                tab === "timeline" &&
                (index === 0 || day !== photoDay(items[index - 1]).key) && (
                <h3 className="timeline-day">{photoDay(item).label}</h3>
              )}
            <button
              className={`media-card${item.metadata?.is_seen ? " seen" : ""}`}
              onClick={() => choose(item, index)}
              title={item.name}
            >
              <span className="media-art">
                {!safeMediaUrl(item.thumbnail) &&
                id === "video" &&
                (libraryPosters.data?.[item.id]?.length ?? 0) > 0 ? (
                  /* 媒体库封面：用库里前几张海报拼 2×2 */
                  <span className="art-collage" aria-hidden="true">
                    {libraryPosters.data![item.id].slice(0, 3).map((src) => (
                      <img key={src} src={src} alt="" referrerPolicy="no-referrer" loading="lazy" />
                    ))}
                  </span>
                ) : safeMediaUrl(item.thumbnail) && !failedArt[item.id] ? (
                  <img
                    referrerPolicy="no-referrer"
                    src={safeMediaUrl(item.thumbnail)}
                    alt={item.name}
                    loading="lazy"
                    onError={() =>
                      setFailedArt((prev) =>
                        prev[item.id] ? prev : { ...prev, [item.id]: true },
                      )
                    }
                  />
                ) : (
                  <Icon weight="duotone" />
                )}
                {id !== "photos" && (
                  <span className="play-overlay" aria-hidden="true">
                    <Play weight="fill" />
                  </span>
                )}
                {id === "video" && item.metadata?.is_seen ? (
                  <span className="art-badge">已看</span>
                ) : null}
                {/* 评分角标：绿联海报右下角的橙色数字 */}
                {id === "video" &&
                  Number(item.metadata?.score) > 0 && (
                    <span className="art-score">
                      {Number(item.metadata?.score).toFixed(1)}
                    </span>
                  )}
              </span>
              {/* 相册时间线不显示任何文字：绿联与飞牛的相册都只有画面 + 日期小标题，
                  文件名挂满每张图是"很难看"的主要来源（名字在查看器里才出现）。
                  保留 title 属性，悬停仍能看到文件名。 */}
              <span className="media-caption" hidden={id === "photos"}>
                <strong>{item.name}</strong>
                {/* 只显示设备真实返回的字段；没有就留空，不写 kind 之类的原始英文 */}
                {/* 相册不显示副标题：时间线里每张图下面挂一行文件名，是"很难看"的主要来源
                    （绿联/飞牛的相册时间线都只有画面，名字在查看器里才出现） */}
                {id !== "photos" && <small>{itemSubtitle(item, id)}</small>}
                {/* 列表视图补上简介（绿联的列表里标题下面就是简介） */}
                {id === "video" &&
                  videoView === "list" &&
                  String(item.metadata?.storyline || "").trim() && (
                    <small className="list-story">
                      {String(item.metadata?.storyline ?? "")}
                    </small>
                  )}
              </span>
              {id === "music" && <Play />}
            </button>
            </Fragment>
            );
          })}
        </div>
      )}
      {resource.data && canPage(mediaRequest(id, tab, parent).operation) && (
        <Pagination
          page={page}
          total={resource.data.total}
          totalPages={aggregated && 'totalPages' in resource.data ? resource.data.totalPages : undefined}
          count={resource.data.items.length}
          onPage={setPage}
          loading={resource.loading}
        />
      )}
      </section>
      {photo && (
        /* 大图查看器：翻页 / 缩放 / 键盘都由 PhotoViewer 负责，这里只给列表与当前位置 */
        <PhotoViewer
          items={items}
          index={Math.max(0, items.findIndex((entry) => entry.id === photo.id && entry.path === photo.path))}
          onIndex={(next) => setPhoto(items[next])}
          onClose={() => setPhoto(undefined)}
        />
      )}
    </div>
  );
}
