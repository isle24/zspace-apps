import { formatBytes } from "./common";

export function fileKindLabel(kind?: string) {
  return kind && Object.hasOwn(kinds, kind) ? kinds[kind] : "其他";
}
const kinds: Record<string, string> = { folder: "文件夹", directory: "文件夹", root: "存储空间", file: "文件", photo: "图片", image: "图片", video: "视频", music: "音乐" };

/** File details have their own labels; device settings retain DataValues. */
export function FileInfo({ data }: { data: unknown }) {
  const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const root = object(data);
  const values = object(root?.values) || root;
  // Match the SDK's existing nonempty-list, info-object, direct-row priority.
  const row = Array.isArray(values?.list) && values.list.length
    ? object(values.list[0])
    : object(values?.info) || values;
  const entries = row && Object.entries(row).flatMap(([key, value]) => {
    const label = Object.hasOwn(labels, key) ? labels[key] : undefined;
    if (!label || value === null || value === undefined || typeof value === "object") return [];
    let display = String(value);
    if (["size", "file_size", "s"].includes(key)) {
      const size = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
      display = Number.isFinite(size) && size >= 0 ? formatBytes(size) : "—";
    } else if (["is_dir", "di"].includes(key)) {
      display = value === true || String(value) === "1" ? "文件夹" : value === false || String(value) === "0" ? "文件" : "—";
    } else if (key === "kind") display = fileKindLabel(String(value));
    return [{ key, label, display }];
  });
  if (!entries?.length) return <p className="muted">设备尚未返回可识别的文件详情。</p>;
  return <dl className="data-values">{entries.map(({ key, label, display }) => <div key={key}><dt>{label}</dt><dd>{display}</dd></div>)}</dl>;
}

const labels: Record<string, string> = {
  name: "文件名称", file_name: "文件名称", n: "文件名称",
  path: "文件路径", file_path: "文件路径",
  size: "文件大小", file_size: "文件大小", s: "文件大小",
  is_dir: "类型", di: "类型", kind: "类型",
  file_count: "文件数量", directory_count: "文件夹数量",
  created_at: "创建时间", updated_at: "修改时间", mime_type: "文件格式",
};
