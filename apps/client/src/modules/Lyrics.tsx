/*
 * 歌词面板（QQ 音乐式）：解析 LRC、跟随播放高亮、点一行跳过去
 *
 * 实测端点（2026-10-12，真机）：
 *   GET /zmusic/api/v2/song/info/lyrics?song_id=… → { song_lyrics: "[00:29.078] When I see you with her\n…" }
 * 注意：另一个 /zmusic/api/v2/file/info/lyrics 只有 POST 能用，且对纯音乐返回空串。
 *
 * LRC 里除了时间行还有 [ti:]/[ar:] 这类元信息，以及一行多个时间戳的情况，都要处理；
 * 识别不了的行原样保留文字，不猜时间。
 */
import { useEffect, useMemo, useRef } from "react";
import { api } from "../api/client";
import { Status, useResource } from "./common";

export type LyricLine = { time: number; text: string };
export type Lyric = { lines: LyricLine[]; meta: Record<string, string>; raw: string };

const timePattern = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const metaPattern = /^\[([a-zA-Z#]+):(.*)\]$/;

/** "01:02.34" / "1:02" / "01:02:345" → 秒 */
export function lrcTime(minutes: string, seconds: string, fraction?: string): number {
  const m = Number(minutes);
  const s = Number(seconds);
  if (!Number.isFinite(m) || !Number.isFinite(s)) return 0;
  let frac = 0;
  if (fraction) frac = Number(`0.${fraction}`);
  return m * 60 + s + (Number.isFinite(frac) ? frac : 0);
}

export function parseLrc(raw?: string): Lyric {
  const text = typeof raw === "string" ? raw : "";
  const lines: LyricLine[] = [];
  const meta: Record<string, string> = {};
  for (const source of text.split(/\r?\n/)) {
    const line = source.trim();
    if (!line) continue;
    const metaMatch = metaPattern.exec(line);
    if (metaMatch && !/^\d+$/.test(metaMatch[1])) {
      meta[metaMatch[1].toLowerCase()] = metaMatch[2].trim();
      continue;
    }
    timePattern.lastIndex = 0;
    const stamps: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = timePattern.exec(line))) stamps.push(lrcTime(match[1], match[2], match[3]));
    const content = line.replace(timePattern, "").trim();
    if (!stamps.length) {
      // 没有时间戳的行（例如"此歌曲为没有填词的纯音乐"）放在最前，跟着播放走
      if (content) lines.push({ time: -1, text: content });
      continue;
    }
    for (const time of stamps) lines.push({ time, text: content });
  }
  lines.sort((a, b) => a.time - b.time);
  return { lines, meta, raw: text };
}

/** 当前该亮哪一行：最后一条 time <= 进度；都还没到就是第一行 */
export function activeLine(lines: LyricLine[], seconds: number): number {
  if (!lines.length) return -1;
  let index = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].time <= seconds) index = i;
    else break;
  }
  return index < 0 ? 0 : index;
}

export function readLyrics(response: unknown): string {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  const values = record(response);
  const payload = record(values?.values) ?? values;
  const data = record(payload?.data) ?? payload;
  const text = data?.song_lyrics;
  return typeof text === "string" ? text : "";
}

export function LyricsPanel({
  songId,
  title,
  current,
  onSeek,
  onClose,
}: {
  songId: string;
  title: string;
  current: number;
  onSeek: (seconds: number) => void;
  onClose: () => void;
}) {
  const resource = useResource(
    () => (songId ? api.read("music.lyrics", { song_id: songId }) : Promise.resolve({ items: [] })),
    [api.nasSession, songId],
  );
  const lyric = useMemo(() => parseLrc(readLyrics(resource.data)), [resource.data]);
  const index = activeLine(lyric.lines, current);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const node = list.current?.querySelector<HTMLElement>(".lyric-line.active");
    if (typeof node?.scrollIntoView === "function")
      node.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [index]);
  const hasTimed = lyric.lines.some((line) => line.time >= 0);
  return (
    <aside className="lyrics-panel" aria-label={`${title} 的歌词`}>
      <header>
        <strong>{title}</strong>
        {lyric.meta.ti && <small>{lyric.meta.ti}</small>}
        <span className="spacer" />
        <button className="icon-button" aria-label="关闭歌词" onClick={onClose}>
          ×
        </button>
      </header>
      <Status {...resource} connected retry={resource.reload} />
      {!resource.loading && !lyric.lines.length && (
        <p className="lyrics-empty">设备没有返回这首歌的歌词。</p>
      )}
      {!!lyric.lines.length && (
        <ol ref={list}>
          {lyric.lines.map((line, i) => (
            <li key={`${line.time}-${i}`}>
              <button
                className={`lyric-line${i === index ? " active" : ""}`}
                onClick={() => line.time >= 0 && onSeek(line.time)}
                disabled={line.time < 0}
              >
                {line.text || "♪"}
              </button>
            </li>
          ))}
        </ol>
      )}
      {!!lyric.lines.length && !hasTimed && (
        <p className="lyrics-note">这首歌没有带时间轴的歌词，只显示文字。</p>
      )}
    </aside>
  );
}
