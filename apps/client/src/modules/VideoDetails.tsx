import { useState } from "react";
import {
  ArrowClockwise,
  ArrowLeft,
  CaretRight,
  Check,
  FilmSlate,
  Folder,
  Heart,
  Play,
} from "@phosphor-icons/react";
import { api, normalizeCollection, safeMediaUrl, type Item } from "../api/client";
import type { MediaSelection } from "./NasModule";
import { formatBytes, Status, useResource } from "./common";

type Props = {
  collection: Item;
  classificationId?: string;
  connected: boolean;
  onClose: () => void;
  onPlay: (selection: MediaSelection) => void;
};
const identifier = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() :
    typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
const isDirectory = (item: Item) => ["directory", "folder", "root"].includes(item.kind || "");
const hasPath = (item: Item) => typeof item.path === "string" && !!item.path.trim();
const text = (value: unknown) => typeof value === "string" ? value : undefined;
const positiveIndex = (value: unknown) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
};

export function VideoDetails(props: Props) {
  const collectionId = identifier(props.collection.metadata?.collection_id) || identifier(props.collection.id);
  const classificationId = identifier(props.collection.metadata?.classification_id) || identifier(props.classificationId);
  if (!collectionId || !classificationId) return (
    <section className="video-details" aria-label="影片详情">
      <button className="secondary" onClick={props.onClose}><ArrowLeft />返回影片列表</button>
      <Status error="设备未返回有效的影片或媒体库标识，暂不能读取详情。" />
    </section>
  );
  // Remount the navigation and its resources when their owner changes. A path or
  // session change must never reuse a previous collection's visible files.
  return <CollectionDetails key={JSON.stringify([api.nasSession, collectionId, classificationId, props.collection.path])} {...props} collectionId={collectionId} classificationId={classificationId} />;
}

function CollectionDetails({ collection, collectionId, classificationId, connected, onClose, onPlay }: Props & { collectionId: string; classificationId: string }) {
  const [directories, setDirectories] = useState<Item[]>([]);
  const directory = directories.at(-1);
  const params = { collection_id: collectionId, classification_id: classificationId };
  const info = useResource(async () => connected ? normalizeCollection(await api.read("video.info", params)) : { items: [] }, [api.nasSession, connected, collectionId, classificationId, collection.path]);
  const files = useResource(async () => connected ? normalizeCollection(await api.read("video.files", { ...params, ...(directory ? { file_path: directory.path } : {}) })) : { items: [] }, [api.nasSession, connected, collectionId, classificationId, collection.path, directory?.id, directory?.path]);
  const items = files.data?.items || [];
  const playable = items.filter((item) => !isDirectory(item) && hasPath(item));
  const hasEpisodes = playable.some(item => positiveIndex(item.metadata?.episode) !== undefined);
  const firstEpisode = positiveIndex(playable[0]?.metadata?.episode);
  const values = info.data?.values;
  const title = text(values?.title) || collection.name;
  const storyline = text(values?.storyline);
  const poster = safeMediaUrl(collection.thumbnail);
  /*
   * 详情接口（/zvideo/collection/info）实测有：title / score / release_year /
   * genres / regions / mins / storyline；但**没有演员**（actors=0）。
   * 演员在**列表行**里（点进来时那行数据就在 collection.metadata 上），所以从这里取。
   * 头像图设备不给 —— 用姓名首字画圆形占位，不假装有头像。
   */
  const fromList = (collection.metadata ?? {}) as Record<string, unknown>;
  const meta = (key: string) => values?.[key] ?? fromList[key];
  const score = Number(meta("score"));
  const year = Number(meta("release_year"));
  const regions = String(meta("regions") || "").split("/").map((part) => part.trim()).filter(Boolean);
  const genres = String(meta("genres") || "").split("/").map((part) => part.trim()).filter(Boolean);
  const minutes = Number(meta("mins"));
  const people = [
    ...(Array.isArray(meta("directors")) ? (meta("directors") as Array<{ name?: string }>) : []).map((person) => ({ name: String(person?.name || ""), role: "导演" })),
    ...(Array.isArray(meta("actors")) ? (meta("actors") as Array<{ name?: string }>).slice(0, 10).map((person) => ({ name: String(person?.name || ""), role: "演员" })) : []),
  ].filter((person) => person.name);
  return (
    <section className="video-details" aria-label="影片详情">
      <div className="toolbar">
        <button className="secondary" onClick={onClose}><ArrowLeft />返回影片列表</button>
        <span className="spacer" />
        <button className="icon-button" aria-label="刷新影片详情" onClick={() => { info.reload(); files.reload(); }}><ArrowClockwise /></button>
      </div>
      {/* 详情头：版式照绿联（背景大图 + 海报 + 标题 + 元信息 + 蓝色播放胶囊 + 圆形操作按钮） */}
      <div className="video-detail-hero" style={poster ? { backgroundImage: `url(${poster})` } : undefined}>
        <div className="hero-shade" />
        <div className="video-detail-poster">{poster ? <img src={poster} alt="" referrerPolicy="no-referrer" /> : <FilmSlate weight="duotone" />}</div>
        <div className="video-detail-copy">
          <h1>{title}</h1>
          <p className="video-detail-meta">
            {Number.isFinite(score) && score > 0 && <span className="detail-score">★ {score.toFixed(1)}</span>}
            {Number.isFinite(year) && year > 1900 && <span>{year}{regions.length ? `（${regions.join(" / ")}）` : ""}</span>}
            {Number.isFinite(minutes) && minutes > 0 && <span>{minutes} 分钟</span>}
            {genres.length > 0 && <span>{genres.slice(0, 3).join(" / ")}</span>}
            <span>{playable.length} 个可播放文件</span>
          </p>
          <div className="video-detail-actions">
            <button
              className="detail-play"
              disabled={!playable.length}
              onClick={() => playable.length && onPlay({ items: playable, index: 0, kind: "video" })}
            >
              <Play weight="fill" />
              {hasEpisodes && firstEpisode ? `播放第 ${firstEpisode} 集` : "播放"}
            </button>
            {/* 圆形的状态按钮：设备返回了 is_seen / is_fav，客户端**没有写接口**，
                所以按只读状态展示（不摆能点但点不动的假按钮）。 */}
            <span className={`detail-round${fromList.is_seen ? " on" : ""}`} title={fromList.is_seen ? "已观看（设备状态，只读）" : "未观看（设备状态，只读）"}>
              <Check weight="bold" />
            </span>
            <span className={`detail-round${fromList.is_fav ? " on" : ""}`} title={fromList.is_fav ? "已收藏（设备状态，只读）" : "未收藏（设备状态，只读）"}>
              <Heart weight="bold" />
            </span>
            <button className="detail-round" aria-label="刷新影片详情" onClick={() => { info.reload(); files.reload(); }}>
              <ArrowClockwise />
            </button>
          </div>
        </div>
      </div>
      {storyline && <p className="video-detail-story">{storyline}</p>}
      <Status {...info} connected={connected} retry={info.reload} />
      {connected && <>
        <div className="video-file-heading"><h2>{hasEpisodes ? "选集与文件" : "版本与文件"}</h2><span>{files.data ? `${playable.length} 个可播放文件` : "选择设备上的实际视频文件"}</span></div>
        {directories.length > 0 && <nav className="toolbar video-directory-nav" aria-label="影片目录">
          <button className="icon-button" aria-label="返回上一级目录" onClick={() => setDirectories((path) => path.slice(0, -1))}><ArrowLeft /></button>
          <button className="breadcrumb" onClick={() => setDirectories([])}>全部文件</button>
          {directories.map((item, index) => <span className="crumb" key={`${item.id}:${item.path}`}><CaretRight /><button onClick={() => setDirectories(directories.slice(0, index + 1))}>{item.name}</button></span>)}
        </nav>}
        <Status {...files} empty={!!files.data && !items.length} retry={files.reload} />
        {!files.loading && !files.error && directories.length === 0 && playable.length > 1 && hasEpisodes && (
          /* 只有设备返回真实正集数时显示选集，电影版本不伪装成剧集。
             使用设备集数，并保留具体文件名以区分同一集的不同版本。 */
          <div className="video-episode-grid" aria-label="选集">
            {playable.map((item, index) => (
              <button
                key={`${item.id}:${item.path}`}
                className="video-episode-chip"
                title={item.name}
                onClick={() => onPlay({ items: playable, index, kind: "video" })}
              >
                {positiveIndex(item.metadata?.episode) ?? index + 1}
              </button>
            ))}
          </div>
        )}
        {!files.loading && !files.error && <div className="video-episode-list">
          {items.map((item) => {
            const directoryItem = isDirectory(item);
            const metadata = item.metadata || {};
            const season = positiveIndex(metadata.season), episode = positiveIndex(metadata.episode);
            const details = [metadata.version, metadata.version_name, metadata.resolution, season ? `第 ${season} 季` : undefined, episode ? `第 ${episode} 集` : undefined].filter((value) => typeof value === "string" || typeof value === "number").join(" · ");
            return <button className="video-episode" key={`${item.id}:${item.path}`} disabled={!hasPath(item)} onClick={() => directoryItem ? setDirectories((path) => [...path, item]) : onPlay({ items: playable, index: playable.indexOf(item), kind: "video" })}>
              {directoryItem ? <Folder weight="duotone" /> : <Play weight="fill" />}
              <span><strong>{item.name}</strong>{details && <small>{details}</small>}<small>{hasPath(item) ? item.path : "设备未返回文件路径，暂不能打开或播放"}</small></span>
              <span className="video-file-size">{directoryItem ? "打开目录" : formatBytes(item.size)}</span>
            </button>;
          })}
        </div>}
        {people.length > 0 && (
          <section className="video-cast" aria-label="演职人员信息">
            <h2>演职人员信息</h2>
            <ul>
              {people.map((person, index) => (
                <li key={`${person.role}:${person.name}:${index}`}>
                  {/* 设备不提供头像，用姓名首字画圆形占位 —— 不假装有头像 */}
                  <span className="cast-avatar" aria-hidden="true">{person.name.slice(0, 1)}</span>
                  <strong>{person.name}</strong>
                  <small>{person.role}</small>
                </li>
              ))}
            </ul>
          </section>
        )}
      </>}
    </section>
  );
}
