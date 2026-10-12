/*
 * 远程访问的快捷方式（对齐极空间「远程访问」的做法）。
 *
 * 极空间那个界面管的是**局域网服务的入口**：路由器、EMBY、qb、IYUU… 每条记录
 * 有名称、备注、颜色、地址，还能「发送快捷方式到桌面」。它不是设备状态面板 ——
 * 这是我第一版理解错的地方（做成了 zrps 中转测速，用户截图纠正）。
 *
 * 数据存在**本机**（localStorage）：这些是你自己的入口清单，不写进 NAS，
 * 换设备不会带着走，也不影响设备任何配置。键名带版本，将来结构变了可以迁移。
 */
export type Shortcut = {
  id: string;
  name: string;
  note: string;
  /** 完整地址，已含协议 */
  url: string;
  /** 磁贴底色（取自极空间那几个色块） */
  color: string;
  /** 代理模式：打开时经由本机同源地址跳转，而不是直连 */
  proxy: boolean;
  /** 是否在桌面显示图标 */
  onDesktop: boolean;
};

export const SHORTCUT_COLORS = [
  "#3f7f5f", // 路由器那种墨绿
  "#b07d3a", // 橙
  "#2f6bff", // 蓝
  "#6fbf73", // 浅绿
  "#7d5bd6", // 紫
  "#8a7f3c", // 橄榄
  "#b05a8a", // 玫瑰
  "#4a90a4", // 青灰
];

const KEY = "space-desktop:shortcuts:v1";

/** 名称首字：中文取第一个字，英文取首字母大写（截图里就是 D / E / M / 路 / 小） */
export function shortcutLetter(name: string): string {
  const clean = name.trim();
  if (!clean) return "?";
  const first = clean[0];
  return /[a-z]/i.test(first) ? first.toUpperCase() : first;
}

export function parseAddress(input: string): { url?: string; error?: string } {
  const raw = input.trim();
  if (!raw) return { error: "请输入地址" };
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname) return { error: "地址里没有主机名" };
    return { url: url.toString().replace(/\/$/, "") };
  } catch {
    return { error: "地址格式不正确" };
  }
}

export function readShortcuts(): Shortcut[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
      .map((row, index) => ({
        id: String(row.id || `shortcut-${index}`),
        name: String(row.name || "").trim() || "未命名",
        note: String(row.note || ""),
        url: String(row.url || ""),
        color: String(row.color || SHORTCUT_COLORS[0]),
        proxy: row.proxy === true,
        onDesktop: row.onDesktop === true,
      }))
      .filter((row) => row.url);
  } catch {
    /* 隐私模式下读不到就当作没有，不阻塞界面 */
    return [];
  }
}

const EVENT = "space-desktop:shortcuts-changed";

export function writeShortcuts(rows: Shortcut[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(rows));
  } catch {
    /* 写不进去（隐私模式）不影响本次会话内的使用 */
  }
  /*
   * 通知桌面把图标同步过去。
   *
   * 「发送快捷方式到桌面」是极空间那个界面上的选项，含义就是桌面上出现一个入口。
   * 桌面（App.tsx）与窗口（RemoteShortcuts）是两个组件，用事件广播比把状态提到顶层更省事，
   * 也顺带覆盖了多标签页的情况（storage 事件）。
   */
  try {
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* 事件发不出去也不影响本窗口 */
  }
}

/** 订阅快捷方式变化（本窗口写入 + 其它标签页写入） */
export function subscribeShortcuts(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) listener();
  };
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function newShortcutId(): string {
  return `sc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/*
 * 打开地址。
 *
 * 极空间有个「代理模式」开关 —— 那是它自己的中转服务在替客户端发请求。
 * **我们没有这个东西**：这个客户端是纯前端 + 设备接口，没有任何服务端代理能力。
 * 所以一律直连；编辑器里那个开关保持禁用并写明原因，不留一个点了不知道发生什么的勾。
 */
export function shortcutTarget(row: Shortcut): string {
  return row.url;
}
