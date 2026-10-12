import { useState } from "react";
import { api, message } from "../api/client";
import { type StorageRoot } from "./StoragePicker";
export const mediaRootAllowed = (root: StorageRoot | undefined) =>
  !!root &&
  root.roles.includes("mediaReadOnly") &&
  root.storage?.mediaReadAllowed === true &&
  !root.storage.systemDisk;
export function mediaPathAllowed(
  root: StorageRoot | undefined,
  path: string,
): boolean {
  if (
    !root ||
    !root.roles.includes("mediaReadOnly") ||
    !mediaRootAllowed(root) ||
    !path.startsWith("/") ||
    path.split("/").some((part) => part === ".." || part === ".") ||
    /[\\\u0000]/.test(path)
  )
    return false;
  const base = root.path.replace(/\/+$/, "");
  return path === base || path.startsWith(base + "/");
}
export function MediaRootPicker({
  roots,
  rootId,
  mediaPath,
  onChange,
  onRegistered,
}: {
  roots: StorageRoot[];
  rootId: string;
  mediaPath: string;
  onChange: (rootId: string, path: string) => void;
  onRegistered: () => void;
}) {
  const [registerPath, setRegisterPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [registered, setRegistered] = useState("");
  const root = roots.find((r) => r.id === rootId);
  async function register() {
    setBusy(true);
    setError("");
    setRegistered("");
    try {
      const result = await api.store<StorageRoot>("roots", {
        path: registerPath.trim(),
        name: "音乐媒体库",
      });
      if (!result.id || !mediaPathAllowed(result, result.path))
        throw new Error("媒体根目录未通过存储检查，暂不可挂载");
      onRegistered();
      onChange(result.id, result.path);
      setRegistered(`已登记媒体根目录 ${result.path}`);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="media-root-picker">
      <h3>音乐媒体库 · 只读挂载</h3>
      <p className="hint">
        音乐库可以位于另一块数据盘；这不会改变上方的应用数据位置。
      </p>
      <label className="field">
        媒体根目录（只读，必选）
        <select
          value={rootId}
          onChange={(e) => {
            const selected = roots.find((r) => r.id === e.target.value);
            onChange(e.target.value, selected?.path || "");
          }}
        >
          <option value="">请选择已登记的媒体根目录</option>
          {roots
            .filter((r) => r.roles.includes("mediaReadOnly"))
            .map((r) => (
              <option key={r.id} value={r.id} disabled={!mediaRootAllowed(r)}>
                {r.name} · {r.path}
                {mediaRootAllowed(r) ? "" : " · 未通过检查"}
              </option>
            ))}
        </select>
      </label>
      <label className="field">
        音乐库路径
        <input
          value={mediaPath}
          disabled={!rootId}
          placeholder={root?.path || "先选择媒体根目录"}
          onChange={(e) => onChange(rootId, e.target.value)}
        />
        <small>
          使用选中根目录本身或其内部目录。服务器会再次验证实际路径与磁盘身份。
        </small>
      </label>
      {!!mediaPath && !mediaPathAllowed(root, mediaPath) && (
        <p className="inline-error" role="alert">
          音乐库路径必须位于选中的已登记媒体根目录内。
        </p>
      )}
      <details
        className="storage-register"
        open={!roots.some((r) => r.roles.includes("mediaReadOnly"))}
      >
        <summary>登记另一块数据盘上的现有音乐库</summary>
        <label className="field">
          已有音乐库根目录
          <input
            value={registerPath}
            onChange={(e) => setRegisterPath(e.target.value)}
            placeholder="填写 NAS 上现有音乐库的绝对路径"
          />
        </label>
        <p className="hint">
          仅登记并验证现有目录，不创建目录、不移动音乐文件。
        </p>
        <button
          className="secondary"
          disabled={busy || !registerPath.trim().startsWith("/")}
          onClick={register}
        >
          {busy ? "验证并登记…" : "登记媒体根目录"}
        </button>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {registered && (
          <p className="storage-success" role="status">
            {registered}
          </p>
        )}
      </details>
    </section>
  );
}
