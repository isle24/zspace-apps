import { useEffect, useState } from "react";
import {
  HardDrives,
  ArrowClockwise,
  ShieldCheck,
  WarningCircle,
} from "@phosphor-icons/react";
import { api, message } from "../api/client";
import { formatBytes, Status, useResource } from "./common";
export type StorageCandidate = {
  path: string;
  mountPoint: string;
  source: string;
  filesystem: string;
  identity: string;
  volumeType: "ssd" | "hdd" | "virtual" | "unknown";
  freeBytes: number;
  totalBytes: number;
  systemDisk: boolean;
  verifiedDataPool: boolean;
  installAllowed: boolean;
  mediaReadAllowed?: boolean;
  reason: string;
};
export type StorageRoot = {
  id: string;
  name: string;
  path: string;
  roles: string[];
  storage?: StorageCandidate;
};
export type StorageDiscovery = {
  items: StorageCandidate[];
  dockerStorage: StorageCandidate | null;
  dockerStorageSafe: boolean;
  message: string;
};
export const allowedStorage = (storage?: StorageCandidate) =>
  storage?.installAllowed === true && storage.systemDisk === false;
const volumeLabel = (type: StorageCandidate["volumeType"]) =>
  ({
    ssd: "SSD",
    hdd: "机械硬盘",
    virtual: "虚拟存储池",
    unknown: "介质待验证",
  })[type] || "介质待验证";
export function StoragePicker({
  roots,
  rootId,
  onSelect,
  onRegistered,
  onSafety,
}: {
  roots: StorageRoot[];
  rootId: string;
  onSelect: (id: string) => void;
  onRegistered: () => void;
  onSafety: (safe: boolean) => void;
}) {
  const discovery = useResource(
    () => api.store<StorageDiscovery>("storage"),
    [api.storeSession],
  );
  const [candidate, setCandidate] = useState<StorageCandidate>();
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [create, setCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [registered, setRegistered] = useState("");
  useEffect(() => {
    onSafety(discovery.data?.dockerStorageSafe === true);
  }, [discovery.data?.dockerStorageSafe]);
  async function register() {
    setBusy(true);
    setError("");
    setRegistered("");
    try {
      const root = await api.store<StorageRoot>("roots", {
        path: path.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(create ? {create:true} : {}),
      });
      if (!root.id || !allowedStorage(root.storage))
        throw new Error("登记目录的磁盘状态未验证，暂不可安装");
      onRegistered();
      onSelect(root.id);
      setRegistered(`已添加 ${root.path}`);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="storage-picker">
      <div className="storage-section-title">
        <h3>应用数据位置</h3>
        <button
          className="icon-button"
          aria-label="重新检测存储设备"
          onClick={discovery.reload}
        >
          <ArrowClockwise />
        </button>
      </div>
      <label className="field">
        存储空间
        <select value={rootId} onChange={(e) => onSelect(e.target.value)}>
          <option value="">选择已登记的专用目录</option>
          {roots
            .filter((r) => r.roles.includes("data"))
            .map((root) => (
              <option
                key={root.id}
                value={root.id}
                disabled={!allowedStorage(root.storage)}
              >
                {root.name} · {root.path}
                {allowedStorage(root.storage) ? "" : " · 禁止或待验证"}
              </option>
            ))}
        </select>
      </label>
      <details className="storage-register" open={!roots.some(root=>allowedStorage(root.storage))}>
        <summary>添加安装目录：选择数据位置或手动填写</summary>
        <Status
          loading={discovery.loading}
          error={discovery.error}
          retry={discovery.reload}
        />
        <div className="storage-candidates">
          {discovery.data?.items.map((disk, index) => (
            <button
              key={`${disk.path}-${index}`}
              className={`storage-disk ${candidate?.path === disk.path ? "selected" : ""}`}
              disabled={!allowedStorage(disk)}
              onClick={() => {
                setCandidate(disk);
                setPath(disk.path);
                setCreate(false);
                setRegistered("");
                setError("");
              }}
            >
              <HardDrives weight="duotone" />
              <span>
                <strong>
                  {volumeLabel(disk.volumeType)} ·{" "}
                  {disk.mountPoint || disk.path}
                </strong>
                <small>
                  {formatBytes(disk.freeBytes)} 可用 /{" "}
                  {formatBytes(disk.totalBytes)}
                </small>
                <small>
                  {disk.source} · {disk.filesystem}
                </small>
                <small>{disk.path}</small>
                <small>
                  {disk.reason || (allowedStorage(disk) ? "可用应用目录" : "身份待验证")}
                </small>
              </span>
              {disk.systemDisk ? <WarningCircle /> : <ShieldCheck />}
            </button>
          ))}
        </div>
        {candidate && (
          <p className="hint">
            已选择 {volumeLabel(candidate.volumeType)}：{candidate.mountPoint}
            。可直接添加所选目录，或在它下面创建新的专用目录。
          </p>
        )}
        <label className="field">
          应用专用目录的绝对路径
          <input
            value={path}
            placeholder="选择上方路径，或填写已映射数据位置内的绝对路径"
            onChange={(e) => setPath(e.target.value)}
          />
          <small>
            默认添加已有目录。新目录需勾选下方选项，父目录须已存在。
          </small>
        </label>
        <label className="check-field">
          <input type="checkbox" checked={create} onChange={event=>setCreate(event.target.checked)}/>
          创建新的专用目录并添加
        </label>
        <label className="field">
          目录显示名称（可选）
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：SSD 应用空间"
          />
        </label>
        <button
          className="secondary"
          disabled={busy || !path.trim().startsWith("/")}
          onClick={register}
        >
          {busy ? "正在添加…" : create ? "创建并添加目录" : "添加已有目录"}
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
      <section
        className={`docker-storage ${discovery.data?.dockerStorageSafe ? "safe" : "unsafe"}`}
        aria-label="Docker 镜像存储位置"
      >
        <h3>Docker 镜像存储位置</h3>
        {discovery.data?.dockerStorage ? (
          <>
            <strong>{discovery.data.dockerStorage.path}</strong>
            <p>
              {volumeLabel(discovery.data.dockerStorage.volumeType)} ·{" "}
              {formatBytes(discovery.data.dockerStorage.freeBytes)} 可用
            </p>
          </>
        ) : (
          <p>尚未验证 Docker 镜像存储位置</p>
        )}
        <p>
          {discovery.data?.message ||
            discovery.data?.dockerStorage?.reason ||
            (discovery.loading ? "正在检查存储安全状态" : discovery.error ? "检测未完成，请核对上方错误后重新检测。" : "尚未确认 Docker 存储，请重新检测。")}
        </p>
        {!discovery.loading && !discovery.data?.dockerStorageSafe && (
          <p className="error-text">
            {discovery.data?.dockerStorage ? "镜像位置未通过检查，请核对检测原因及 Docker 数据位置。" : "存储检测尚未成功，安装会在核验通过后开放。手动填写目录仍可使用。"}
          </p>
        )}
      </section>
    </div>
  );
}
