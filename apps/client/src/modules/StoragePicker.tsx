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
      });
      if (!root.id || !allowedStorage(root.storage))
        throw new Error("登记目录的磁盘状态未验证，暂不可安装");
      onRegistered();
      onSelect(root.id);
      setRegistered(`已登记 ${root.path}`);
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
      <details className="storage-register" open={!roots.length}>
        <summary>选择 SSD / 数据盘，或登记已有专用目录</summary>
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
                setPath("");
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
                <small>
                  {disk.reason ||
                    (disk.verifiedDataPool ? "已验证数据池" : "身份待验证")}
                </small>
              </span>
              {disk.systemDisk ? <WarningCircle /> : <ShieldCheck />}
            </button>
          ))}
        </div>
        {candidate && (
          <p className="hint">
            已选择 {volumeLabel(candidate.volumeType)}：{candidate.mountPoint}
            。请填写此数据盘上已经存在的应用专用目录。
          </p>
        )}
        <label className="field">
          已有专用目录的绝对路径
          <input
            value={path}
            placeholder="填写 NAS 上已存在的专用目录"
            onChange={(e) => setPath(e.target.value)}
          />
          <small>
            登记不会创建目录。系统盘、eMMC 和未验证位置由服务端拒绝。
          </small>
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
          {busy ? "验证并登记…" : "登记已有目录"}
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
            "正在检查存储安全状态"}
        </p>
        {!discovery.data?.dockerStorageSafe && (
          <p className="error-text">
            镜像位置未通过检查，安装已禁用。请先将 Docker
            数据迁移至已验证的数据盘。
          </p>
        )}
      </section>
    </div>
  );
}
