/*
 * 设备返回值的解析小工具。
 *
 * 这些函数原本在 4 个系统视图里各写了一份（逐字相同的实现）：
 * SystemNetwork / SystemOverview / RemoteAccess / DeviceTasks。
 * 收敛到一处，改行为时不用再四处找。
 *
 * 只收**确认逐字相同**的：`formatBytes` 看着也是重复，其实要求不同 ——
 * 资源挂件要 TB、两位小数，列表要 MB 一位小数，合并会改变界面上的数字。
 * 那种"看起来像重复"的地方不动。
 */

/** 对象且不是数组才算 record；其余（含 null/数组）返回 undefined。 */
export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** 去掉首尾空白的非空字符串；空串/非字符串返回 undefined（界面显示 "—"）。 */
export const asText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * 和 `asText` **看着一样、其实不同**：字符串之外还接受有限数字。
 *
 * 我在合并时就是在这里栽的 —— 四个文件里的 `text()` 前两行完全一样，
 * 第三行 `SystemNetwork` / `RemoteAccess` 多了一句 `String(number)`。
 * 合并成一份之后，设置页里本该显示 "1" 的项变成了"开启"（数字被当成 undefined
 * 走了另一条格式化分支），被单测当场抓住。所以两个变体都留着，名字区分清楚。
 */
export const asLooseText = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
};

/** 数字或可转成有限数字的字符串；否则 undefined。 */
export const asNumber = (value: unknown): number | undefined => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};
