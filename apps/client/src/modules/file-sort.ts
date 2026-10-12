/*
 * 文件列表排序（纯客户端）
 *
 * 实测（2026-10-12）：设备不排序。`/v2/file/list` 试过 sort / sort_type / order /
 * sortby（官方前端用的就是这个）以及 name_asc / size_desc / mtime_desc 等写法，
 * 返回顺序完全不变 —— 官方前端的排序因此也是本地做的。
 *
 * 我们一次只拿一页，所以排序范围就是**当前页**；界面里如实写成"本页排序"，
 * 不让用户以为它排的是整个目录。
 */
import type { Item } from "../api/client";

export type SortKey = "name" | "size" | "time";
export type SortDir = "asc" | "desc";

const nameOf = (item: Item) => item.name || "";
const sizeOf = (item: Item): number | undefined => {
  const size = Number(item.size);
  return Number.isFinite(size) && size >= 0 ? size : undefined;
};
const timeOf = (item: Item): number | undefined => {
  const meta = item.metadata || {};
  const raw = meta.modify_time ?? meta.mtime ?? meta.ctime ?? meta.date ?? meta.taken_at;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return undefined;
};

/**
 * 排序规则：
 * - 名字用中文排序（localeCompare zh）而不是码点，否则"张"会排在"李"前面；
 * - 缺值（没有 size / 没有时间）**永远沉底**，不参与方向翻转 —— 说没有就是没有。
 */
export function sortItems(items: Item[], key: SortKey, dir: SortDir): Item[] {
  const factor = dir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    if (key === "name") {
      const order = nameOf(a).localeCompare(nameOf(b), "zh-Hans-CN", { numeric: true, sensitivity: "base" });
      return order * factor;
    }
    const left = key === "size" ? sizeOf(a) : timeOf(a);
    const right = key === "size" ? sizeOf(b) : timeOf(b);
    if (left === undefined && right === undefined) return 0;
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return (left - right) * factor;
  });
}

/** 点击同一列切换方向；换列时给一个合理的默认方向（大小/时间默认从大到新） */
export function nextSort(current: { key: SortKey; dir: SortDir }, key: SortKey): { key: SortKey; dir: SortDir } {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: key === "name" ? "asc" : "desc" };
}

export const sortLabel = (key: SortKey): string => ({ name: "名称", size: "大小", time: "时间" })[key];
