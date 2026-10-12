import { createId } from "../api/id";
export type Viewport = { width: number; height: number };

/**
 * 窗口可用区域。
 *
 * 高度减 132：底部要留出系统区域（实测窗口夹取上限就是按这个算的）。
 * 原先定义在 App.tsx，窗口外壳组件也用它，抽出来两边共用。
 */
export function viewport(): Viewport {
  return {
    width: window.innerWidth,
    height: Math.max(260, window.innerHeight - 132),
  };
}
export type Rect = { x: number; y: number; width: number; height: number };
export type DesktopWindow = {
  id: string;
  appId: string;
  scope: string;
  rect: Rect;
  restore?: Rect;
  minimized: boolean;
  maximized: boolean;
  z: number;
};
export type Action =
  | { type: "open"; appId: string; scope: string; viewport: Viewport }
  | { type: "focus" | "minimize" | "close"; id: string }
  | { type: "maximize"; id: string; viewport: Viewport }
  | { type: "rect"; id: string; rect: Rect; viewport: Viewport }
  | { type: "viewport"; viewport: Viewport };
/**
 * 拖动/缩放时的约束。
 *
 * 原来要求**整扇窗口**都在可用区域内（`y ≤ v.height - height`）。这让"往下拖"
 * 几乎没有空间：1100×640 的窗口在 697 高的区域里只能下移 28px —— 实测拖 300px
 * 只动了 28px，用户反馈"所有弹窗的应用不能往下拖动"就是这个。
 *
 * 现在按真实桌面窗口的规则：**标题栏必须留在可视区内**，窗口下部可以超出。
 * 宽度方向同理，至少留一块能抓标题栏的宽度。
 */
const TITLEBAR_KEEP = 48;
function bounded(r: Rect, v: Viewport): Rect {
  const width = Math.min(Math.max(320, r.width), v.width),
    height = Math.min(Math.max(260, r.height), v.height);
  // 宽度方向仍要求整扇可见（横向拖动本来就不缺空间，不必放宽）
  const maxY = Math.max(0, v.height - TITLEBAR_KEEP);
  return {
    width,
    height,
    x: Math.max(0, Math.min(r.x, v.width - width)),
    y: Math.max(0, Math.min(r.y, maxY)),
  };
}
/**
 * 飞牛式外壳内缩：左侧应用栏与顶部系统区不参与窗口最大化区域，
 * 窗口默认也落在该区域中央，避免初始窗口压住应用栏。
 *
 * `top` 必须等于顶部系统栏的高度：实测 `.system-bar` 在 y=10、高 52
 * （即占到 62）、z-index 10000，而窗口从 y=29 开始 —— 标题栏有一半压在系统栏
 * 底下，右上角的关闭按钮点不到（用户反馈"上面被遮挡不能关闭"）。
 */
export const SHELL_INSET = { left: 66, top: 62 };
const OPEN_SIZE = { width: 1100, height: 640 };
function shellArea(v: Viewport): Rect {
  const left = v.width > 700 ? SHELL_INSET.left : 0;
  const top = v.width > 700 ? SHELL_INSET.top : 0;
  return {
    x: left,
    y: top,
    width: Math.max(320, v.width - left),
    height: Math.max(260, v.height - top),
  };
}
export function windowReducer(
  windows: DesktopWindow[],
  a: Action,
): DesktopWindow[] {
  const top = Math.max(0, ...windows.map((w) => w.z)) + 1;
  if (a.type === "open") {
    const found = windows.find(
      (w) => w.appId === a.appId && w.scope === a.scope,
    );
    if (found) return windowReducer(windows, { type: "focus", id: found.id });
    const area = shellArea(a.viewport);
    /*
     * 顶部内缩变大（62）之后，如果仍按 `area.height - 48` 算默认高度，
     * 窗口会比以前矮 50 多像素、内容区明显变挤。窗口下部现在允许超出可视区，
     * 所以默认高度直接用可用高度即可，落点从内缩线开始。
     */
    const width = Math.min(OPEN_SIZE.width, area.width - 48);
    const height = Math.min(OPEN_SIZE.height, area.height);
    return [
      ...windows,
      {
        id: createId(),
        appId: a.appId,
        scope: a.scope,
        rect: bounded(
          {
            x: area.x + Math.round((area.width - width) / 2) + windows.length * 28,
            /*
             * 层叠偏移保持 20px：改小到 12px 时，下层窗口露出的标题栏太窄，
             * 真机巡检里"点下层窗口把它提到最前"就点不中了（窗口交互那项红）。
             */
            y: area.y + Math.round(Math.max(0, (area.height - height) / 2)) + windows.length * 20,
            width,
            height,
          },
          a.viewport,
        ),
        minimized: false,
        maximized: false,
        z: top,
      },
    ];
  }
  if (a.type === "viewport")
    return windows.map((w) => ({
      ...w,
      rect: w.maximized ? shellArea(a.viewport) : bounded(w.rect, a.viewport),
    }));
  if (a.type === "close") return windows.filter((w) => w.id !== a.id);
  return windows.map((w) => {
    if (w.id !== a.id) return w;
    switch (a.type) {
      case "focus":
        return { ...w, z: top, minimized: false };
      case "minimize":
        return { ...w, minimized: true };
      case "rect":
        return w.maximized ? w : { ...w, rect: bounded(a.rect, a.viewport) };
      case "maximize":
        return {
          ...w,
          maximized: !w.maximized,
          restore: w.maximized ? undefined : w.rect,
          rect: w.maximized
            ? bounded(w.restore || w.rect, a.viewport)
            : shellArea(a.viewport),
          z: top,
        };
    }
    return w;
  });
}
export function visibleWindows(w: DesktopWindow[], scope: string) {
  return w.filter((w) => w.scope === scope && !w.minimized);
}
