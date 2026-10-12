import { useEffect, useState, useRef } from "react";
import { api } from "../api/client";
import {
  StoragePicker,
  allowedStorage,
  type StorageRoot,
} from "./StoragePicker";
import { MediaRootPicker, mediaPathAllowed } from "./MediaRootPicker";
import { Status, useResource } from "./common";
import type { PlanRequest, RuntimeApp, RuntimeSettings } from "./runtime-types";
export function RuntimeInstall({
  app,
  busy,
  onPlan,
  onClose,
}: {
  app: RuntimeApp;
  busy: boolean;
  onPlan: (request: PlanRequest) => void;
  onClose: () => void;
}) {
  const [scope] = useState(() => api.captureStoreScope());
  const current = () => {
    const now = api.captureStoreScope();
    return (
      now.generation === scope.generation &&
      now.storeAddress === scope.storeAddress
    );
  };
  const roots = useResource(async () => {
    const result = await api.store<{ items: StorageRoot[] }>("roots");
    if (!current()) throw new Error("商店服务或会话已改变，请重新选择目录");
    return result;
  }, []);
  const preference = useResource(async () => {
    const result = await api.store<RuntimeSettings>("v2/settings");
    if (!current()) throw new Error("商店服务或会话已改变，请重新读取设置");
    return result;
  }, []);
  const selectedByUser = useRef(false);
  const [rootId, setRootId] = useState(""),
    [safe, setSafe] = useState(false),
    [directory, setDirectory] = useState(app.id),
    [port, setPort] = useState(app.defaultPort),
    [peerPort, setPeerPort] = useState(22000),
    [discoveryPort, setDiscoveryPort] = useState(21027),
    [version, setVersion] = useState(app.version),
    [mediaRootId, setMediaRootId] = useState(""),
    [mediaPath, setMediaPath] = useState("");
  useEffect(() => {
    if (selectedByUser.current || !current() || !roots.data || !preference.data)
      return;
    const id = preference.data.defaultRootId;
    const root = roots.data.items.find(
      (item) =>
        item.id === id &&
        item.roles.includes("data") &&
        allowedStorage(item.storage),
    );
    setRootId(root?.id || "");
  }, [roots.data, preference.data]);
  const directories = useResource(
    () =>
      rootId
        ? api.store<{ items: string[] }>(
            `v2/roots/${encodeURIComponent(rootId)}/directories`,
          )
        : Promise.resolve({ items: [] }),
    [rootId],
  );
  const mediaDirectories = useResource(
    () =>
      mediaRootId
        ? api.store<{ items: string[] }>(
            `v2/roots/${encodeURIComponent(mediaRootId)}/directories`,
          )
        : Promise.resolve({ items: [] }),
    [mediaRootId],
  );
  const syncthing = app.id === "syncthing";
  const ports = syncthing ? [port, peerPort, discoveryPort] : [port];
  const validPorts = ports.every(value => Number.isInteger(value) && value >= 1024 && value <= 65535)
    && new Set(ports).size === ports.length;
  const valid =
    safe &&
    allowedStorage(
      roots.data?.items.find((root) => root.id === rootId)?.storage,
    ) &&
    /^[A-Za-z0-9_-]+$/.test(directory) &&
    validPorts &&
    (!app.requiresMedia ||
      mediaPathAllowed(
        roots.data?.items.find((root) => root.id === mediaRootId),
        mediaPath,
      ));
  return (
    <div className="wizard-backdrop">
      <section
        className="install-wizard"
        role="dialog"
        aria-modal="true"
        aria-label={`安装 ${app.name}`}
      >
        <header>
          <h2>安装 {app.name}</h2>
          <button disabled={busy} onClick={onClose}>
            关闭安装
          </button>
        </header>
        <div className="wizard-body">
          <Status {...roots} retry={roots.reload} />
          <Status error={preference.error} retry={preference.reload} />
          <StoragePicker
            roots={roots.data?.items || []}
            rootId={rootId}
            onSelect={(id) => {
              selectedByUser.current = true;
              setRootId(id);
            }}
            onRegistered={roots.reload}
            onSafety={setSafe}
          />
          <label className="field">
            已登记目录（只读查看）
            <select
              aria-label="已登记目录"
              disabled={directories.loading || !!directories.error}
            >
              <option value="">新实例始终使用新目录</option>
              {directories.data?.items.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
          </label>
          <Status error={directories.error} retry={directories.reload} />
          <label className="field">
            新实例目录名
            <input
              value={directory}
              onChange={(e) => setDirectory(e.target.value)}
              pattern="[A-Za-z0-9_-]+"
            />
            <small>在选中的已验证根目录下创建，原目录保留。</small>
          </label>
          <label className="field">
            已审查版本
            <select
              value={version}
              onChange={(e) => setVersion(e.target.value)}
            >
              {(app.availableVersions?.length
                ? app.availableVersions
                : [app.version]
              ).map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="field">
            应用访问端口
            <input
              type="number"
              min={1024}
              max={65535}
              step={1}
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
            />
          </label>
          {syncthing && <>
            <label className="field">
              同步端口（TCP/UDP）
              <input type="number" min={1024} max={65535} step={1} value={peerPort}
                onChange={e => setPeerPort(Number(e.target.value))} />
            </label>
            <label className="field">
              发现端口（UDP）
              <input type="number" min={1024} max={65535} step={1} value={discoveryPort}
                onChange={e => setDiscoveryPort(Number(e.target.value))} />
            </label>
          </>}
          {!validPorts && <p role="alert" className="inline-error">端口须为 1024 至 65535 的整数，且互不重复。</p>}
          {app.requiresMedia && (
            <MediaRootPicker
              roots={roots.data?.items || []}
              rootId={mediaRootId}
              mediaPath={mediaPath}
              onChange={(id, path) => {
                setMediaRootId(id);
                setMediaPath(path);
              }}
              onRegistered={roots.reload}
            />
          )}
          {app.requiresMedia && mediaRootId && (
            <>
              <label className="field">
                选择媒体子目录
                <select
                  value={mediaPath}
                  disabled={
                    mediaDirectories.loading || !!mediaDirectories.error
                  }
                  onChange={(e) => setMediaPath(e.target.value)}
                >
                  <option
                    value={
                      roots.data?.items.find((root) => root.id === mediaRootId)
                        ?.path
                    }
                  >
                    使用选中的媒体根目录
                  </option>
                  {mediaDirectories.data?.items
                    .filter((path) =>
                      mediaPathAllowed(
                        roots.data?.items.find(
                          (root) => root.id === mediaRootId,
                        ),
                        path,
                      ),
                    )
                    .map((path) => (
                      <option key={path} value={path}>
                        {path}
                      </option>
                    ))}
                </select>
              </label>
              <Status
                error={mediaDirectories.error}
                retry={mediaDirectories.reload}
              />
            </>
          )}
          <p className="hint">
            服务端将检查镜像、架构、存储身份和端口；下一步核对完整计划。
          </p>
        </div>
        <footer>
          <span />
          <button
            className="primary"
            disabled={!valid || busy}
            onClick={() => {
              if (!current() || !valid || busy) return;
              onPlan({
                kind: "install",
                appId: app.id,
                rootId,
                directory,
                hostPort: port,
                ...(syncthing ? { peerPort, discoveryPort } : {}),
                targetVersion: version,
                ...(app.requiresMedia ? { mediaRootId, mediaPath } : {}),
              });
            }}
          >
            {busy ? "检查中…" : "生成安装计划"}
          </button>
        </footer>
      </section>
    </div>
  );
}
