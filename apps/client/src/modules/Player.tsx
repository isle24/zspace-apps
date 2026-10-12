import { MusicArtwork } from "./MusicArtwork";
import { useEffect, useRef, useState } from "react";
import {
  X,
  SkipBack,
  SkipForward,
  MusicNote,
  FilmSlate,
  Notebook,
  Pause,
  Play,
  SpeakerHigh,
  Queue,
} from "@phosphor-icons/react";
import { api, safeMediaUrl } from "../api/client";
import type { MediaSelection } from "./NasModule";
import { playRequest } from "../api/operations";
import { VideoChrome, readResume, writeResume } from "./VideoChrome";
import { LyricsPanel } from "./Lyrics";
import { Status, useResource } from "./common";
/**
 * 播放地址形态判定（实测结论）。
 * 极空间 `/transcode/play` 返回的是 **HLS**：`data.uri` 形如 `/play/m3u8/strm/<hash>`，
 * 服务端配置里 `play_base_addr_hls=/splay/m3u8` 也印证了这一点。
 *
 * 选路规则必须是「hls.js 能用就用 hls.js」，**不能**用 canPlayType 判断：
 * macOS Chrome 对 `application/vnd.apple.mpegurl` 会回答 "maybe"（实测），
 * 但它其实放不了 HLS —— 只信 canPlayType 会导致视频卡在 readyState 0。
 * 反过来 Safari 的 `Hls.isSupported()` 是 false（没有 MSE+HLS），这时用原生 src。
 */
/** 秒 → m:ss / h:mm:ss（音乐条显示时长） */
export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function isHlsSource(url?: string): boolean {
  if (!url) return false;
  return /\.m3u8(\?|$)/i.test(url) || /\/m3u8(\/|$)/i.test(url);
}

/**
 * 浏览器是否声明支持原生 HLS。**仅供诊断**：实测 Chrome 会假阳性回答 "maybe"，
 * 所以它不参与选路（选路只看 Hls.isSupported()）。
 */
/**
 * hls.js **按需加载**。
 *
 * 它一直是静态 import，于是 942 KB 的主包里约 150 KB 是给"看视频"准备的 ——
 * 只看照片、只放音乐的用户白下载。改成用到才 import，主包体积立刻下来。
 *
 * 代价是"能不能用 hls.js"这个判断变成异步的。原先 hlsHandled 直接决定要不要写 src，
 * 异步之后不能再用它，所以换成一个三态：
 *   pending -> 还没结论，先不写 src（避免浏览器用原生方式去啃 m3u8 报一次解码错）
 *   hls     -> hls.js 接管，src 留空
 *   native  -> 交给浏览器（Safari 原生 HLS / 不是 HLS 的地址）
 *
 * 注意：**不要**自己再写一个"有没有 MSE"的同步判断来提前短路 —— 那等于把
 * hls.js 的 isSupported() 复制一份，两边迟早会不一致。就让 hls.js 自己回答。
 */
type HlsMode = "pending" | "hls" | "native";

export function canPlayHlsNatively(): boolean {
  if (typeof document === "undefined") return false;
  const probe = document.createElement("video");
  return !!probe.canPlayType("application/vnd.apple.mpegurl");
}

export function Player(props: {
  selection: MediaSelection;
  onChange: (s: MediaSelection) => void;
  onClose: () => void;
}) {
  const item = props.selection.items[props.selection.index];
  // 队列/歌词面板的开合属于"播放器"而不是"当前这首歌"，所以放在不重挂载的外层
  const [queue, setQueue] = useState(false);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  return (
    <PlayerContent
      key={JSON.stringify([api.nasSession, props.selection.kind, item.id, item.path])}
      {...props}
      queue={queue}
      setQueue={setQueue}
      lyricsOpen={lyricsOpen}
      setLyricsOpen={setLyricsOpen}
    />
  );
}
function PlayerContent({
  selection,
  onChange,
  onClose,
  queue,
  setQueue,
  lyricsOpen,
  setLyricsOpen,
}: {
  selection: MediaSelection;
  queue: boolean;
  setQueue: (open: boolean) => void;
  lyricsOpen: boolean;
  setLyricsOpen: (open: boolean) => void;
  onChange: (s: MediaSelection) => void;
  onClose: () => void;
}) {
  const item = selection.items[selection.index];
  // 面板开关由外层 Player 持有：换歌时 PlayerContent 会按 key 重挂载，
  // 状态放这里的话每切一首歌队列/歌词都会被关掉。

  const [playError, setPlayError] = useState("");
  const [speed, setSpeed] = useState(1);
  // 音乐用飞牛那样的底部播放条：需要自绘播放/暂停与进度，所以自己跟踪状态
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState({ current: 0, duration: 0 });
  // 视频：选集面板、缓冲进度、播放中状态
  const [panelOpen, setPanelOpen] = useState(false);
  const queueList = useRef<HTMLOListElement | null>(null);
  const [buffered, setBuffered] = useState(0);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const stage = useRef<HTMLDivElement | null>(null);
  const media = useRef<HTMLMediaElement | null>(null);
  // 倍速：0.5 / 1 / 1.25 / 1.5 / 2（Safari/WKWebView 原生控件没有倍速入口，所以自己做）
  const speeds = [0.5, 1, 1.25, 1.5, 2];
  useEffect(() => {
    const el = media.current;
    if (!el) return;
    el.playbackRate = speed;
    // 保持音调，避免倍速后声音发尖
    el.preservesPitch = true;
  }, [speed, item.id, item.path]);
  const resource = useResource(async () => {
    const r = playRequest(selection.kind, item);
    return api.read(r.operation, r.params);
  }, [api.nasSession, item.id, item.path, selection.kind]);
  const data = resource.data as any;
  /**
   * 播放地址字段：官方前端调用 `GET /transcode/play`（getVideoPlayUrlV2），
   * 从响应的 `data.uri` 取地址（`l.data.uri`，见官方 bundle）。
   * 之前只读 stream/url，导致拿到地址为空 —— 这就是"能打开窗口但放不出画面"的原因。
   * 这里保留 stream/url 作为兼容回退。
   */
  const values = data?.values;
  const url = !resource.loading && !resource.error ? safeMediaUrl(
    values?.uri ||
      data?.uri ||
      data?.stream ||
      data?.url ||
      values?.stream ||
      values?.url ||
      data?.items?.[0]?.stream ||
      data?.items?.[0]?.uri,
  ) : undefined;
  // 交给 hls.js 的地址不要同时写进 src，否则 Chrome 会先报一次解码错误
  /**
   * STRM 影片不是 HLS：`/transcode/play` 返回 `strm: true` 与一个 `/play/m3u8/strm/<hash>`
   * 跳转入口，请求它会 302 到 .strm 里写的真实地址（实测是 https://cms.…/*.mp4）。
   * 所以这种地址直接交给浏览器跟随跳转，**不能**因为路径里带 m3u8 就交给 hls.js。
   */
  const strmPlayback = data?.strm === true || values?.strm === true;
  const hlsCandidate = !!url && !strmPlayback && isHlsSource(url);
  const [hlsMode, setHlsMode] = useState<HlsMode>("pending");
  const hlsHandled = hlsMode === "hls";
  const [retried, setRetried] = useState(false);
  useEffect(() => {
    if (!hlsCandidate || !url) {
      setHlsMode("native");
      return;
    }
    let cancelled = false;
    // 用 import() 的返回类型，别手写结构化类型 —— hls.js 的 on() 是泛型重载，手写对不上
    let hls: import("hls.js").default | null = null;
    setHlsMode("pending");
    void import("hls.js")
      .then(({ default: Hls }) => {
        if (cancelled) return;
        if (!Hls.isSupported()) {
          setHlsMode("native");
          return;
        }
        const el = media.current;
        if (!el) return;
        const instance = new Hls({ enableWorker: true, lowLatencyMode: false });
        hls = instance;
        let fatal = false;
        instance.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal || fatal) return;
          fatal = true;
          onPlaybackError();
        });
        instance.loadSource(url);
        instance.attachMedia(el);
        setHlsMode("hls");
      })
      .catch(() => {
        // 加载失败就退回原生：至少 Safari 还能放
        if (!cancelled) setHlsMode("native");
      });
    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [url, item.id, item.path, hlsCandidate]);

  useEffect(() => {
    setPlayError("");
    setRetried(false);
  }, [item.id, item.path, selection.kind]);
  /**
   * 浏览器报错时不要自己换 JS 播放器：让 NAS 重新判定是否需要转码
   * （与 Emby/Jellyfin 的 Direct Play → Transcode 同思路）。只重试一次，失败就如实报错。
   */
  function onPlaybackError() {
    if (!retried) {
      setRetried(true);
      resource.reload();
      return;
    }
    /**
     * 实测：极空间音乐只提供"无损原流"（play_format_list 只有 `OP:无损原流`），不做音频转码。
     * 于是把 WMA/APE 这类文件命名成 .mp3 的曲目，浏览器根本解不了
     * （真机样本：ID3 标签之后直接是 ASF GUID `3026b275…`，即 WMA）。
     * 这种情况要如实说清原因，而不是甩一句"播放失败"。
     */
    const code = media.current?.error?.code;
    if (code === 4) {
      setPlayError(
        "浏览器无法解码这个文件的音频编码（常见于把 WMA/APE 之类的文件命名为 .mp3）。" +
          "设备对音乐只提供原始流、不做转码，所以这一首放不了；换一首或改用官方桌面端。",
      );
      return;
    }
    setPlayError("播放失败：设备未提供浏览器可直接解码的流，且转码重试后仍不可用。");
  }
  function seekTo(seconds: number) {
    const el = media.current;
    if (!el || !Number.isFinite(seconds)) return;
    el.currentTime = Math.max(0, Math.min(seconds, el.duration || seconds));
  }
  function togglePlay() {
    const el = media.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  }
  /**
   * 续播：打开时若上次看到 10 秒以上、且距结尾还早，就跳回去。
   * 每 5 秒记一次进度；条目的路径是身份，换片不会串。
   */
  useEffect(() => {
    if (selection.kind !== "video") return;
    const el = media.current;
    if (!el) return;
    const key = item.path || item.id;
    let restored = false;
    const onMeta = () => {
      if (restored) return;
      restored = true;
      const saved = readResume(item);
      if (saved > 10 && (!el.duration || saved < el.duration - 15)) el.currentTime = saved;
    };
    let last = 0;
    const onTime = () => {
      const now = el.currentTime;
      if (Math.abs(now - last) >= 5) {
        last = now;
        if (el.duration && now < el.duration - 15) writeResume(item, now);
        else writeResume(item, 0);
      }
    };
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("timeupdate", onTime);
    return () => {
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("timeupdate", onTime);
      if (el.currentTime > 0) writeResume(item, el.currentTime);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.kind, item.path, item.id]);

  // 键盘快捷键（播放器打开时生效；输入框里不抢键）
  useEffect(() => {
    if (selection.kind !== "video") return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /input|textarea|select/i.test(target.tagName)) return;
      const el = media.current;
      if (!el) return;
      // 与按钮一致：15 秒（绿联也是 15），按住 Shift 30 秒
      const step = event.shiftKey ? 30 : 15;
      switch (event.key) {
        case " ":
        case "k":
          event.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          event.preventDefault();
          seekTo(el.currentTime - step);
          break;
        case "ArrowRight":
          event.preventDefault();
          seekTo(el.currentTime + step);
          break;
        case "ArrowUp":
          event.preventDefault();
          el.muted = false;
          el.volume = Math.min(1, el.volume + 0.05);
          break;
        case "ArrowDown":
          event.preventDefault();
          el.volume = Math.max(0, el.volume - 0.05);
          break;
        case "m":
          el.muted = !el.muted;
          break;
        case "f":
          if (document.fullscreenElement) void document.exitFullscreen();
          else void stage.current?.requestFullscreen?.().catch(() => undefined);
          break;
        case "Escape":
          if (!document.fullscreenElement) onClose();
          break;
        case "[":
          setSpeed((value) => Math.max(0.5, Number((value - 0.25).toFixed(2))));
          break;
        case "]":
          setSpeed((value) => Math.min(3, Number((value + 0.25).toFixed(2))));
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.kind, item.path, item.id]);

  // 切歌后把当前曲滚进可视区（队列可能很长）
  useEffect(() => {
    const node = queueList.current?.querySelector<HTMLElement>(".queue-row.active");
    // 老 webview / jsdom 里没有 scrollIntoView，缺了也不该让播放器崩
    if (typeof node?.scrollIntoView === "function")
      node.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selection.index, queue]);

  function move(delta: number) {
    const index = selection.index + delta;
    if (index >= 0 && index < selection.items.length)
      onChange({ ...selection, index });
  }
  return (
    <section
      className={`global-player ${selection.kind}`}
      aria-label="媒体播放器"
    >
      <header>
        {selection.kind === "video" ? (
          <FilmSlate weight="duotone" />
        ) : <MusicArtwork key={item.id} item={item} className="player-album-cover"/>}
        <strong>{item.name}</strong>
        {selection.kind === "music" && String(item.metadata?.artist || "").trim() && (
          <span className="music-artist">{String(item.metadata?.artist)}</span>
        )}
        {selection.kind === "music" && (
          <button
            className={`icon-button${lyricsOpen ? " on" : ""}`}
            aria-label={lyricsOpen ? "关闭歌词" : "显示歌词"}
            aria-pressed={lyricsOpen}
            onClick={() => setLyricsOpen(!lyricsOpen)}
          >
            <Notebook />
          </button>
        )}
        <button
          className="icon-button"
          aria-label="播放队列"
          onClick={() => setQueue(!queue)}
        >
          <Queue />
        </button>
        <button
          className="icon-button"
          aria-label="关闭播放器"
          onClick={onClose}
        >
          <X />
        </button>
      </header>
      {selection.kind==="music"&&<div className="qq-now-playing"><MusicArtwork key={item.id} item={item}/><div><small>正在播放</small><h2>{item.name}</h2><p>{String(item.metadata?.artist??"未知歌手")}</p><span>{String(item.metadata?.album??"")}</span></div></div>}
      <Status loading={resource.loading} error={resource.error || playError} />
      {!resource.loading && !resource.error && !url && (
        <p role="alert">设备未返回可用的鉴权播放地址，无法开始播放。</p>
      )}
      {playError && selection.items.length > 1 && (
        <button className="skip-track" onClick={() => move(1)} disabled={selection.index >= selection.items.length - 1}>
          跳过这一首
        </button>
      )}
      {url &&
        (selection.kind === "video" ? (
          <VideoChrome
            title={item.name}
            item={item}
            items={selection.items}
            index={selection.index}
            media={media}
            playing={videoPlaying}
            time={progress.current}
            duration={progress.duration}
            buffered={buffered}
            speed={speed}
            speeds={speeds}
            panelOpen={panelOpen}
            onTogglePanel={() => setPanelOpen((open) => !open)}
            onSelect={(next) => onChange({ ...selection, index: next })}
            onTogglePlay={togglePlay}
            onSpeed={setSpeed}
            onClose={onClose}
            onSeek={seekTo}
          >
            <video
              ref={(el) => {
                media.current = el;
              }}
              src={hlsHandled ? undefined : url}
              autoPlay
              playsInline
              onClick={togglePlay}
              onDoubleClick={() => {
                if (document.fullscreenElement) void document.exitFullscreen();
                else void stage.current?.requestFullscreen?.().catch(() => undefined);
              }}
              onWheel={(event) => {
                const el = media.current;
                if (!el) return;
                el.volume = Math.max(0, Math.min(1, el.volume + (event.deltaY < 0 ? 0.05 : -0.05)));
              }}
              onPlay={() => setVideoPlaying(true)}
              onPause={() => setVideoPlaying(false)}
              onTimeUpdate={(event) =>
                setProgress({
                  current: event.currentTarget.currentTime,
                  duration: Number.isFinite(event.currentTarget.duration)
                    ? event.currentTarget.duration
                    : 0,
                })
              }
              onLoadedMetadata={(event) =>
                setProgress({
                  current: event.currentTarget.currentTime,
                  duration: Number.isFinite(event.currentTarget.duration)
                    ? event.currentTarget.duration
                    : 0,
                })
              }
              onProgress={(event) => {
                const el = event.currentTarget;
                if (el.buffered.length) setBuffered(el.buffered.end(el.buffered.length - 1));
              }}
              onEnded={() => move(1)}
              onError={onPlaybackError}
            />
          </VideoChrome>
        ) : (
          <audio
            ref={(el) => {
              media.current = el;
            }}
            src={hlsHandled ? undefined : url}
            autoPlay
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(event) =>
              setProgress({
                current: event.currentTarget.currentTime,
                duration: Number.isFinite(event.currentTarget.duration)
                  ? event.currentTarget.duration
                  : 0,
              })
            }
            onLoadedMetadata={(event) =>
              setProgress({
                current: event.currentTarget.currentTime,
                duration: Number.isFinite(event.currentTarget.duration)
                  ? event.currentTarget.duration
                  : 0,
              })
            }
            onEnded={() => move(1)}
            onError={onPlaybackError}
          />
        ))}
      {selection.kind === "music" && lyricsOpen && (
        <LyricsPanel
          songId={String(item.id)}
          title={item.name}
          current={progress.current}
          onSeek={(seconds) => {
            const el = media.current;
            if (el) el.currentTime = seconds;
          }}
          onClose={() => setLyricsOpen(false)}
        />
      )}
      {selection.kind === "music" && url && (
        <div className="music-transport">
          <button
            className="icon-button"
            aria-label={playing ? "暂停" : "播放"}
            onClick={() => {
              const el = media.current;
              if (!el) return;
              if (el.paused) void el.play().catch(() => setPlayError("播放失败：设备未提供浏览器可直接解码的流。"));
              else el.pause();
            }}
          >
            {playing ? <Pause weight="fill" /> : <Play weight="fill" />}
          </button>
          <input
            className="music-progress"
            type="range"
            min={0}
            max={progress.duration || 0}
            step={1}
            value={progress.current}
            aria-label="播放进度"
            onChange={(event) => {
              const el = media.current;
              const next = Number(event.target.value);
              setProgress((p) => ({ ...p, current: next }));
              if (el) el.currentTime = next;
            }}
          />
          <span className="music-time">
            {clock(progress.current)} / {clock(progress.duration)}
          </span>
          <span className="music-volume">
            <SpeakerHigh aria-hidden="true" />
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              defaultValue={1}
              aria-label="音量"
              onChange={(event) => {
                const el = media.current;
                if (el) el.volume = Number(event.target.value);
              }}
            />
          </span>
        </div>
      )}
      <footer>
        <button
          className="icon-button"
          aria-label={selection.kind === "video" ? "上一集" : "上一首"}
          disabled={selection.index === 0}
          onClick={() => move(-1)}
        >
          <SkipBack />
        </button>
        <span>
          {selection.index + 1} / {selection.items.length}
        </span>
        <button
          className="icon-button"
          aria-label={selection.kind === "video" ? "下一集" : "下一首"}
          disabled={selection.index === selection.items.length - 1}
          onClick={() => move(1)}
        >
          <SkipForward />
        </button>
      </footer>
      {/* 视频的倍速在自绘控制条里；这里只保留音乐的（音乐条是胶囊版式） */}
      {url && selection.kind === "music" && (
        <div className="player-speeds" role="group" aria-label="播放速度">
          {speeds.map((value) => (
            <button
              key={value}
              className={speed === value ? "active" : ""}
              aria-pressed={speed === value}
              onClick={() => setSpeed(value)}
            >
              {value}×
            </button>
          ))}
        </div>
      )}
      {queue && (
        /* 播放队列：QQ 音乐式的右侧列表面板——当前曲高亮、显示序号与艺人、点一下切歌 */
        <aside className="queue-panel" role="region" aria-label="播放队列">
          <header>
            <strong>播放队列</strong>
            <small>
              {selection.index + 1} / {selection.items.length}
            </small>
            <span className="spacer" />
            <button className="icon-button" aria-label="关闭队列" onClick={() => setQueue(false)}>
              <X />
            </button>
          </header>
          <ol className="queue-list" ref={queueList}>
            {selection.items.map((song, index) => {
              const playing = index === selection.index;
              return (
                <li key={`${song.id}:${song.path}`}>
                  <button
                    className={`queue-row${playing ? " active" : ""}`}
                    aria-current={playing ? "true" : undefined}
                    onClick={() => onChange({ ...selection, index })}
                    title={song.name}
                  >
                    <span className="queue-index">
                      {playing ? <SpeakerHigh weight="fill" /> : index + 1}
                    </span>
                    <span className="queue-text">
                      <strong>{song.name}</strong>
                      <small>{String(song.metadata?.artist || song.metadata?.album || "")}</small>
                    </span>
                    {playing && <span className="queue-now">正在播放</span>}
                  </button>
                </li>
              );
            })}
          </ol>
        </aside>
      )}
    </section>
  );
}
