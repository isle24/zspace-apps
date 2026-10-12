/*
 * 相册大图查看器
 *
 * 之前的查看器只能"点开一张、看完关掉"：没有上一张/下一张、不能缩放、键盘也没用。
 * 这里补齐成熟看图应用该有的操作：
 * - ← / →（或按钮）翻页，Esc 关闭，+ / - 缩放，0 复原，双击切换放大
 * - 滚轮缩放（以光标位置为中心），放大后按住拖动平移
 * - 顶部显示文件名与第几张 / 共几张；底部显示设备返回的拍摄信息
 * 图片本身仍走 ImagePreview（那里有完整的 MIME 嗅探、大小上限与整段校验），
 * 这里只负责"怎么看"，不重复实现取图逻辑。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CaretLeft, CaretRight, MagnifyingGlassMinus, MagnifyingGlassPlus, ArrowsOutSimple, X } from "@phosphor-icons/react";
import type { Item } from "../api/client";
import { ImagePreview } from "./ImagePreview";
import { safeMediaUrl } from "../api/client";

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));
}

/** 设备返回的拍摄信息：只显示真实存在的字段 */
export function photoFacts(item: Item): string[] {
  const meta = item.metadata || {};
  const facts: string[] = [];
  const when = String(meta.date || meta.modify_time || meta.taken_at || "").trim();
  if (when) facts.push(when.slice(0, 19).replace("T", " "));
  const width = Number(meta.width ?? meta.image_width);
  const height = Number(meta.height ?? meta.image_height);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)
    facts.push(`${width} × ${height}`);
  const size = Number(item.size);
  if (Number.isFinite(size) && size > 0)
    facts.push(size > 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`);
  return facts;
}

export function PhotoViewer({
  items,
  index,
  onIndex,
  onClose,
  preferOriginal = false,
}: {
  items: Item[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  preferOriginal?: boolean;
}) {
  const photo = items[index];
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const stage = useRef<HTMLDivElement>(null);

  const reset = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);
  const go = useCallback(
    (delta: number) => {
      const next = index + delta;
      if (next < 0 || next >= items.length) return;
      reset();
      onIndex(next);
    },
    [index, items.length, onIndex, reset],
  );

  // 换图就复位缩放，避免带着上一张的位移
  useEffect(() => {
    reset();
  }, [photo?.id, photo?.path, reset]);

  // 预取相邻缩略图：翻页时先看到模糊图也不会白屏（缩略图很小，不占内存）
  useEffect(() => {
    for (const offset of [1, -1]) {
      const neighbour = items[index + offset];
      const thumb = neighbour && safeMediaUrl(neighbour.thumbnail);
      if (thumb) {
        const image = new Image();
        image.src = thumb;
      }
    }
  }, [index, items]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /input|textarea|select/i.test(target.tagName)) return;
      switch (event.key) {
        case "ArrowLeft":
          event.preventDefault();
          go(-1);
          break;
        case "ArrowRight":
          event.preventDefault();
          go(1);
          break;
        case "Escape":
          event.preventDefault();
          onClose();
          break;
        case "+":
        case "=":
          setZoom((value) => clampZoom(value + 0.5));
          break;
        case "-":
        case "_":
          setZoom((value) => clampZoom(value - 0.5));
          break;
        case "0":
          reset();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose, reset]);

  if (!photo) return null;
  const facts = photoFacts(photo);
  return (
    <div className="photo-viewer" role="dialog" aria-label={photo.name}>
      <div className="photo-viewer-bar">
        <button className="secondary" onClick={onClose}>
          返回相册
        </button>
        <h3 title={photo.name}>{photo.name}</h3>
        <span className="photo-counter">
          {index + 1} / {items.length}
        </span>
        <span className="spacer" />
        <button className="icon-button" aria-label="缩小" onClick={() => setZoom((v) => clampZoom(v - 0.5))}>
          <MagnifyingGlassMinus />
        </button>
        <span className="photo-zoom">{Math.round(zoom * 100)}%</span>
        <button className="icon-button" aria-label="放大" onClick={() => setZoom((v) => clampZoom(v + 0.5))}>
          <MagnifyingGlassPlus />
        </button>
        <button className="icon-button" aria-label="适应窗口" onClick={reset}>
          <ArrowsOutSimple />
        </button>
        <button className="icon-button" aria-label="上一张" disabled={index === 0} onClick={() => go(-1)}>
          <CaretLeft />
        </button>
        <button className="icon-button" aria-label="下一张" disabled={index >= items.length - 1} onClick={() => go(1)}>
          <CaretRight />
        </button>
        <button className="icon-button" aria-label="关闭图片" onClick={onClose}>
          <X />
        </button>
      </div>
      <div
        ref={stage}
        className={`photo-stage${zoom > 1 ? " zoomed" : ""}${dragging ? " dragging" : ""}`}
        style={
          {
            "--zoom": zoom,
            "--pan-x": `${pan.x}px`,
            "--pan-y": `${pan.y}px`,
          } as React.CSSProperties
        }
        onWheel={(event) => {
          // 以光标为中心缩放：先算光标相对舞台中心的位置，再按缩放差补偿平移
          const box = stage.current?.getBoundingClientRect();
          const next = clampZoom(zoom + (event.deltaY < 0 ? 0.25 : -0.25));
          if (box && next !== zoom) {
            const cx = event.clientX - (box.left + box.width / 2);
            const cy = event.clientY - (box.top + box.height / 2);
            const ratio = 1 - next / zoom;
            setPan((p) => ({ x: p.x + (cx - p.x) * ratio, y: p.y + (cy - p.y) * ratio }));
          }
          setZoom(next);
          if (next === 1) setPan({ x: 0, y: 0 });
        }}
        onDoubleClick={() => (zoom > 1 ? reset() : setZoom(2))}
        onPointerDown={(event) => {
          if (zoom <= 1) return;
          drag.current = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y };
          setDragging(true);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start) return;
          setPan({ x: start.px + (event.clientX - start.x), y: start.py + (event.clientY - start.y) });
        }}
        onPointerUp={(event) => {
          drag.current = null;
          setDragging(false);
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
        }}
      >
        <ImagePreview item={photo} preferOriginal={preferOriginal} />
      </div>
      <div className="photo-viewer-foot">
        {facts.length ? facts.map((fact) => <span key={fact}>{fact}</span>) : <span>设备未返回拍摄信息</span>}
        <span className="photo-hint">← → 翻页 · 滚轮或双击缩放 · 拖动平移 · Esc 关闭</span>
      </div>
    </div>
  );
}
