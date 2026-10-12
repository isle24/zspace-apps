/*
 * 视频播放器外壳（对齐 VidHub / HOSPlayer 的成熟做法）
 *
 * 浏览器原生 controls 在桌面端太"网页"：没有倍速记忆、没有选集面板、
 * 不会自动隐藏、也不能续播。这里自绘一套：
 * - 底部渐变控制条：进度（含缓冲与拖拽）、±10 秒、音量、倍速、PiP、全屏
 * - 顶部标题条 + 关闭；2.5 秒无操作自动隐藏，同时隐藏鼠标指针
 * - 点击画面播放/暂停，双击全屏，滚轮调音量
 * - 键盘：空格/K 播放暂停、←/→ ±10s、↑/↓ 音量、M 静音、F 全屏、
 *   [ / ] 调速、Esc 退出全屏或关闭
 * - 右侧「选集」抽屉复用当前媒体列表，可切换文件/分集
 * - 记忆播放进度：按条目路径存 localStorage，下次打开自动续播
 */
import { useEffect, useRef, useState } from "react";
import {
  ArrowsOut,
  CaretLeft,
  CaretRight,
  ListBullets,
  Pause,
  PictureInPicture,
  Play,
  SpeakerHigh,
  SpeakerSlash,
  X,
  SkipBack,
  SkipForward,
} from "@phosphor-icons/react";
import type { Item } from "../api/client";
import { clock } from "./Player";

const RESUME_PREFIX = "space-desktop:resume:";

export function resumeKey(item: Item): string {
  return `${RESUME_PREFIX}${item.path || item.id}`;
}

export function readResume(item: Item): number {
  try {
    const raw = localStorage.getItem(resumeKey(item));
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function writeResume(item: Item, seconds: number): void {
  try {
    // 结束前 15 秒内不记，避免下次一打开就跳到最后
    localStorage.setItem(resumeKey(item), String(Math.max(0, Math.floor(seconds))));
  } catch {
    /* 存不了就算了，不阻塞播放 */
  }
}

type Props = {
  title: string;
  item: Item;
  items: Item[];
  index: number;
  media: React.RefObject<HTMLMediaElement | null>;
  playing: boolean;
  time: number;
  duration: number;
  buffered: number;
  speed: number;
  speeds: number[];
  panelOpen: boolean;
  onTogglePanel: () => void;
  onSelect: (index: number) => void;
  onTogglePlay: () => void;
  onSpeed: (value: number) => void;
  onClose: () => void;
  onSeek: (seconds: number) => void;
  children: React.ReactNode;
};

export function VideoChrome(props: Props) {
  const {
    title, item, items, index, media, playing, time, duration, buffered, speed, speeds,
    panelOpen, onTogglePanel, onSelect, onTogglePlay, onSpeed, onClose, onSeek, children,
  } = props;
  const [visible, setVisible] = useState(true);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | undefined>(undefined);

  // 2.5 秒无操作就收起控制条与鼠标指针
  function wake() {
    setVisible(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setVisible(false), 2500);
  }
  useEffect(() => {
    wake();
    return () => window.clearTimeout(hideTimer.current);
  }, [item.id]);

  const shown = scrub ?? time;
  const percent = duration > 0 ? Math.min(100, (shown / duration) * 100) : 0;
  const bufferedPercent = duration > 0 ? Math.min(100, (buffered / duration) * 100) : 0;

  function toggleFullscreen() {
    const node = stage.current;
    if (!node) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void node.requestFullscreen?.().catch(() => {});
  }

  return (
    <div
      ref={stage}
      className={`video-stage${visible ? "" : " idle"}${playing ? "" : " paused"}`}
      onMouseMove={wake}
      onMouseLeave={() => setVisible(false)}
    >
      {children}

      {/* 暂停时给一个居中的大播放按钮（VidHub/HOSPlayer 都是这个反馈） */}
      {!playing && (
        <button className="video-bigplay" aria-label="播放" onClick={onTogglePlay}>
          <Play weight="fill" />
        </button>
      )}

      <div className="video-top">
        <button className="video-close" aria-label="关闭播放器" onClick={onClose}>
          <X />
        </button>
        <strong>{title}</strong>
        <span>
          {index + 1} / {items.length}
        </span>
      </div>

      <div className="video-controls">
        {/* 时间码在进度条两端（绿联就是这么排的） */}
        <div className="video-timeline">
        <span className="video-time video-time-current">{clock(shown)}</span>
        <div className="video-progress">
          <span className="video-track" />
          <span className="video-buffered" style={{ width: `${bufferedPercent}%` }} />
          <span className="video-played" style={{ width: `${percent}%` }} />
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.5}
            value={shown}
            aria-label="播放进度"
            onChange={(event) => setScrub(Number(event.target.value))}
            onMouseUp={() => {
              if (scrub !== null) onSeek(scrub);
              setScrub(null);
            }}
            onKeyUp={() => {
              if (scrub !== null) onSeek(scrub);
              setScrub(null);
            }}
          />
        </div>
        <span className="video-time video-time-duration">{duration ? clock(duration) : "--:--"}</span>
        </div>
        <div className="video-row">
          {/* 绿联最左是上一集 / 下一集；我们的 items 就是可播放文件列表，语义一致 */}
          <button
            aria-label="上一集"
            disabled={index <= 0}
            onClick={() => index > 0 && onSelect(index - 1)}
          >
            <SkipBack weight="fill" />
          </button>
          <button aria-label={playing ? "暂停" : "播放"} onClick={onTogglePlay}>
            {playing ? <Pause weight="fill" /> : <Play weight="fill" />}
          </button>
          <button aria-label="后退 15 秒" onClick={() => onSeek(Math.max(0, time - 15))}>
            <CaretLeft weight="fill" />
            <em>15</em>
          </button>
          <button aria-label="前进 15 秒" onClick={() => onSeek(Math.min(duration || time + 15, time + 15))}>
            <CaretRight weight="fill" />
            <em>15</em>
          </button>
          <button
            aria-label="下一集"
            disabled={index >= items.length - 1}
            onClick={() => index < items.length - 1 && onSelect(index + 1)}
          >
            <SkipForward weight="fill" />
          </button>
          <button
            aria-label={muted ? "取消静音" : "静音"}
            onClick={() => {
              const el = media.current;
              if (!el) return;
              el.muted = !el.muted;
              setMuted(el.muted);
            }}
          >
            {muted ? <SpeakerSlash weight="fill" /> : <SpeakerHigh weight="fill" />}
          </button>
          <input
            className="video-volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            aria-label="音量"
            onChange={(event) => {
              const el = media.current;
              const next = Number(event.target.value);
              setVolume(next);
              setMuted(next === 0);
              if (el) {
                el.volume = next;
                el.muted = next === 0;
              }
            }}
          />
          <span className="spacer" />
          <button
            className={panelOpen ? "on" : ""}
            aria-label="选集与文件"
            aria-pressed={panelOpen}
            onClick={onTogglePanel}
          >
            <ListBullets />
          </button>
          {/*
           * 倍速：绿联是一个显示当前值的按钮（`1.0x`），点一下换下一档。
           * 保持 aria-label「播放速度」不变（既有契约），但不再是五个按钮。
           */}
          <button
            className="video-speed"
            aria-label="播放速度"
            title={`当前 ${speed}×，点击切换`}
            onClick={() => {
              const at = speeds.indexOf(speed);
              onSpeed(speeds[(at + 1) % speeds.length] ?? speeds[0]);
            }}
          >
            {speed.toFixed(1)}×
          </button>
          <button
            aria-label="画中画"
            onClick={() => {
              const el = media.current;
              if (!el) return;
              const video = el as HTMLVideoElement;
              if (document.pictureInPictureElement) void document.exitPictureInPicture();
              else void video.requestPictureInPicture?.().catch(() => {});
            }}
          >
            <PictureInPicture />
          </button>
          <button aria-label="全屏" onClick={toggleFullscreen}>
            <ArrowsOut />
          </button>
        </div>
      </div>

      {panelOpen && (
        <aside className="video-panel" aria-label="选集与文件">
          <header>
            <strong>选集与文件</strong>
            <button className="icon-button" aria-label="关闭选集" onClick={onTogglePanel}>
              <X />
            </button>
          </header>
          <ol>
            {items.map((entry, i) => (
              <li key={`${entry.id}:${entry.path}`}>
                <button
                  className={i === index ? "active" : ""}
                  onClick={() => onSelect(i)}
                  title={entry.path || entry.name}
                >
                  <span>{entry.name}</span>
                  <small>{String(entry.metadata?.duration || entry.metadata?.file_size || "")}</small>
                </button>
              </li>
            ))}
          </ol>
        </aside>
      )}
    </div>
  );
}
