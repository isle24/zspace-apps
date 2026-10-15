import { useRef, type PointerEvent, type ReactNode } from "react";
import {
  ArrowLeft,
  CaretDown,
  CornersIn,
  CornersOut,
  Minus,
  Square,
  X,
} from "@phosphor-icons/react";
import { api, message } from "../api/client";
import { AppIcon, apps } from "./apps";
import { viewport, type Action, type DesktopWindow } from "./state";

/**
 * 应用窗口外壳：标题栏、拖动、右下角缩放、双击最大化、最小化/最大化/关闭。
 *
 * 从 App.tsx 搬出来的（那边 950 多行），**只搬不改**。
 * 拖动用 pointer capture，所以鼠标移出窗口也照样跟手；
 * 位置/尺寸一律走 reducer 的 bounded() 夹取，保证窗口不会被拖没。
 */
export function WindowFrame({
  window: w,
  dispatch,
  onClose,
  mobile,
  active,
  title,
  children,
}: {
  window: DesktopWindow;
  dispatch: React.Dispatch<Action>;
  onClose: () => void;
  mobile: boolean;
  active: boolean;
  title: string;
  children: React.ReactNode;
}) {
  const drag = useRef<{
    x: number;
    y: number;
    rect: DesktopWindow["rect"];
    mode: "move" | "resize";
  } | null>(null);
  const app = apps.find((a) => a.id === w.appId);
  function start(e: PointerEvent<HTMLElement>, mode: "move" | "resize") {
    if (mobile || w.maximized || (e.target as HTMLElement).closest("button"))
      return;
    e.preventDefault();
    dispatch({ type: "focus", id: w.id });
    drag.current = { x: e.clientX, y: e.clientY, rect: w.rect, mode };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent<HTMLElement>) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x,
      dy = e.clientY - d.y;
    dispatch({
      type: "rect",
      id: w.id,
      rect:
        d.mode === "move"
          ? { ...d.rect, x: d.rect.x + dx, y: d.rect.y + dy }
          : { ...d.rect, width: d.rect.width + dx, height: d.rect.height + dy },
      viewport: viewport(),
    });
  }
  function end() {
    drag.current = null;
  }
  return (
    <section
      role="region"
      aria-label={`${title}窗口`}
      data-window-app={w.appId}
      data-own-title={
        ["store", "photos", "video", "music"].includes(w.appId)
          ? "true"
          : undefined
      }
      className={`app-window ${active ? "focused" : ""} ${w.maximized ? "maximized" : ""} ${w.minimized || (mobile && !active) ? "window-hidden" : ""}`}
      style={
        mobile
          ? { zIndex: w.z }
          : {
              left: w.rect.x,
              top: w.rect.y,
              width: w.rect.width,
              height: w.rect.height,
              zIndex: w.z,
            }
      }
      onPointerDown={() => {
        if (!active) dispatch({ type: "focus", id: w.id });
      }}
    >
      <header
        className="window-titlebar"
        onPointerDown={(e) => start(e, "move")}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={(e) => {
          if (!(e.target as HTMLElement).closest("button") && !mobile)
            dispatch({ type: "maximize", id: w.id, viewport: viewport() });
        }}
      >
        <button
          className="mobile-back"
          aria-label="返回桌面"
          onClick={() => dispatch({ type: "minimize", id: w.id })}
        >
          <ArrowLeft />
        </button>
        {app && <AppIcon app={app} small />}
        <strong>{title}</strong>
        <span className="titlebar-hint">
          {api.nasSession ? "我的 NAS" : "未连接 NAS"}
        </span>
        {/* 飞牛窗口按钮顺序：最小化 − / 最大化 □ / 关闭 ×，紧贴右上角 */}
        <div className="window-controls">
          <button
            className="minimize"
            aria-label={`最小化${title}`}
            onClick={() => dispatch({ type: "minimize", id: w.id })}
          >
            <Minus />
          </button>
          <button
            className="maximize"
            aria-label={`${w.maximized ? "还原" : "最大化"}${title}`}
            onClick={() =>
              dispatch({ type: "maximize", id: w.id, viewport: viewport() })
            }
          >
            <Square />
          </button>
          <button
            className="close"
            aria-label={`关闭${title}`}
            onClick={onClose}
          >
            <X />
          </button>
        </div>
      </header>
      <div className="window-content">{children}</div>
      <div
        className="resize-handle"
        role="separator"
        aria-label={`调整${title}窗口大小`}
        tabIndex={0}
        onPointerDown={(e) => start(e, "resize")}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={(e) => {
          if (e.key.startsWith("Arrow")) {
            e.preventDefault();
            dispatch({
              type: "rect",
              id: w.id,
              rect: {
                ...w.rect,
                width:
                  w.rect.width +
                  (e.key === "ArrowRight"
                    ? 20
                    : e.key === "ArrowLeft"
                      ? -20
                      : 0),
                height:
                  w.rect.height +
                  (e.key === "ArrowDown" ? 20 : e.key === "ArrowUp" ? -20 : 0),
              },
              viewport: viewport(),
            });
          }
        }}
      />
    </section>
  );
}
