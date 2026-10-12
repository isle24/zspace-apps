import { describe, expect, it } from "vitest";
import { windowReducer, visibleWindows, type DesktopWindow } from "./state";
const viewport = { width: 900, height: 650 };
const opened = (): DesktopWindow[] =>
  windowReducer([], {
    type: "open",
    appId: "files",
    scope: "device-a/user-a",
    viewport,
  });
describe("desktop windows", () => {
  it("opens bounded windows and restores after minimizing", () => {
    let ws = opened();
    expect(ws).toHaveLength(1);
    const id = ws[0].id;
    ws = windowReducer(ws, { type: "minimize", id });
    expect(visibleWindows(ws, "device-a/user-a")).toHaveLength(0);
    ws = windowReducer(ws, { type: "focus", id });
    expect(visibleWindows(ws, "device-a/user-a")).toHaveLength(1);
  });
  it("restores original geometry after maximize", () => {
    const ws = opened(),
      before = ws[0];
    const max = windowReducer(ws, {
      type: "maximize",
      id: before.id,
      viewport,
    });
    /*
     * 飞牛外壳在宽屏下保留左侧 66px 应用栏；顶部内缩 62px 是因为系统栏
     * 实际占到 y=62（`SHELL_INSET.top` 的解释里有实测数据）——
     * 原来这里是 y: 0，窗口标题栏正好压在系统栏底下，关闭按钮点不到。
     */
    expect(max[0].rect).toEqual({ x: 66, y: 62, width: 834, height: 588 });
    expect(
      windowReducer(max, { type: "maximize", id: before.id, viewport })[0].rect,
    ).toEqual(before.rect);
  });
  it("keeps windows reachable on a smaller display", () => {
    const ws = windowReducer(opened(), {
      type: "viewport",
      viewport: { width: 390, height: 500 },
    });
    expect(ws[0].rect.x).toBeGreaterThanOrEqual(0);
    expect(ws[0].rect.x + ws[0].rect.width).toBeLessThanOrEqual(390);
  });
  it("fills the whole viewport when maximized on a narrow display", () => {
    const ws = opened();
    const max = windowReducer(ws, {
      type: "maximize",
      id: ws[0].id,
      viewport: { width: 390, height: 500 },
    });
    // 窄屏没有左侧应用栏，最大化必须铺满，不能留下无法解释的空白。
    expect(max[0].rect).toEqual({ x: 0, y: 0, width: 390, height: 500 });
  });
  it("isolates device and user windows", () => {
    expect(visibleWindows(opened(), "device-b/user-a")).toEqual([]);
  });
  it("closing only removes the UI window", () => {
    const ws = opened();
    expect(windowReducer(ws, { type: "close", id: ws[0].id })).toEqual([]);
  });
});
it("opens desktop windows over LAN HTTP without randomUUID", () => {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  Object.defineProperty(crypto, "randomUUID", {
    value: undefined,
    configurable: true,
  });
  try {
    expect(opened()[0].id).toMatch(/^[0-9a-f-]{36}$/);
  } finally {
    if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor);
    else delete (crypto as any).randomUUID;
  }
});

describe("窗口拖动的边界（用户反馈：不能往下拖）", () => {
  /*
   * 之前 `bounded` 要求整扇窗口都在可用区内（y ≤ v.height - height），
   * 结果 1100×640 的窗口在 697 高的区域里只能下移 28px：
   * 实测拖 300px 只动了 28px。现在只要求标题栏留在可视区内。
   */
  const viewport = { width: 1280, height: 697 };
  const opened = windowReducer([], {
    type: "open",
    appId: "files",
    scope: "s",
    viewport,
  });
  it("可以一直往下拖，直到只剩标题栏", () => {
    const dragged = windowReducer(opened, {
      type: "rect",
      id: opened[0].id,
      rect: { ...opened[0].rect, y: opened[0].rect.y + 300 },
      viewport,
    });
    expect(dragged[0].rect.y).toBeGreaterThan(opened[0].rect.y + 200);
    expect(dragged[0].rect.y).toBeLessThanOrEqual(viewport.height - 48);
  });
  it("标题栏不会被拖出可视区上方", () => {
    const up = windowReducer(opened, {
      type: "rect",
      id: opened[0].id,
      rect: { ...opened[0].rect, y: -200 },
      viewport,
    });
    expect(up[0].rect.y).toBe(0);
  });
});
