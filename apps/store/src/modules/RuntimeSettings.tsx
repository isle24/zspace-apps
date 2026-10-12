import { allowedStorage, type StorageRoot } from "./StoragePicker";
import { RuntimeMaintenance } from "./RuntimeMaintenance";
import { RuntimeDiagnostics } from "./RuntimeDiagnostics";
import { useEffect, useState } from "react";
import { api, message } from "../api/client";
import { Status, useResource } from "./common";
import { StoreServiceSettings } from "./StoreServiceSettings";
import type { RuntimeSettings as Settings } from "./runtime-types";
export function RuntimeSettings() {
  const [scope] = useState(() => api.captureStoreScope());
  const current = () => {
    const now = api.captureStoreScope();
    return (
      now.generation === scope.generation &&
      now.storeAddress === scope.storeAddress
    );
  };
  const resource = useResource(async () => {
      const result = await api.store<Settings>("v2/settings");
      if (!current()) throw new Error("商店服务或会话已改变，请重新读取设置");
      return result;
    }, []),
    [settings, setSettings] = useState<Settings>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  const roots = useResource(async () => {
    const result = await api.store<{ items: StorageRoot[] }>("roots");
    if (!current()) throw new Error("商店服务或会话已改变，请重新读取目录");
    return result;
  }, []);
  const eligible = (roots.data?.items || []).filter(
    (root) => root.roles.includes("data") && allowedStorage(root.storage),
  );
  useEffect(() => {
    if (resource.data)
      setSettings({
        ...resource.data,
        defaultRootId: resource.data.defaultRootId || "",
      });
  }, [resource.data]);
  useEffect(() => {
    if (
      roots.data &&
      settings?.defaultRootId &&
      !eligible.some((root) => root.id === settings.defaultRootId)
    )
      setSettings((value) => (value ? { ...value, defaultRootId: "" } : value));
  }, [roots.data, settings?.defaultRootId]);
  useTheme(settings);
  async function save() {
    if (!settings || busy || !current()) return;
    if (
      roots.data &&
      settings.defaultRootId &&
      !eligible.some((root) => root.id === settings.defaultRootId)
    ) {
      setError("默认目录已失效，请选择已验证的数据目录或手动选择");
      return;
    }
    const session = api.storeSession,
      address = api.storeAddress;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const { defaultRootId, ...unrelated } = settings;
      await api.store("v2/settings", roots.data ? settings : unrelated);
      if (
        current() &&
        session === api.storeSession &&
        address === api.storeAddress
      )
        setSaved(true);
    } catch (e) {
      if (
        current() &&
        session === api.storeSession &&
        address === api.storeAddress
      )
        setError(message(e));
    } finally {
      if (
        current() &&
        session === api.storeSession &&
        address === api.storeAddress
      )
        setBusy(false);
    }
  }
  return (
    <section>
      <h2>商店设置</h2>
      <StoreServiceSettings />
      <RuntimeDiagnostics />
      <RuntimeMaintenance />
      <Status {...resource} retry={resource.reload} />
      {settings && (
        <form
          className="runtime-settings"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="field">
            默认应用数据位置
            <select
              aria-label="默认应用数据位置"
              value={settings.defaultRootId || ""}
              disabled={roots.loading || !!roots.error}
              onChange={(event) => {
                setSaved(false);
                setSettings({ ...settings, defaultRootId: event.target.value });
              }}
            >
              <option value="">每次安装时手动选择</option>
              {!roots.data && settings.defaultRootId && (
                <option value={settings.defaultRootId} disabled>
                  已保存目录（待重新核验）
                </option>
              )}
              {eligible.map((root) => (
                <option value={root.id} key={root.id}>
                  {root.name} · {root.path}
                </option>
              ))}
            </select>
            <small>
              只预填已登记且通过检查的数据目录；保存时服务端会再次核验当前磁盘。未设置或目录失效时由你手动选择。
            </small>
          </label>
          <Status error={roots.error} retry={roots.reload} />
          <label className="field">
            外观
            <select
              value={settings.theme}
              onChange={(e) => {
                setSaved(false);
                setSettings({
                  ...settings,
                  theme: e.target.value as Settings["theme"],
                });
              }}
            >
              <option value="light">浅色</option>
              <option value="dark">深色</option>
              <option value="system">跟随系统</option>
            </select>
          </label>
          <label className="check-field">
            <input
              type="checkbox"
              checked={settings.updateCheckEnabled}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  updateCheckEnabled: e.target.checked,
                })
              }
            />
            定期检查官方版本
          </label>
          <label className="field">
            检查间隔（小时）
            <input
              type="number"
              min={1}
              max={168}
              value={settings.updateCheckHours}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  updateCheckHours: Number(e.target.value),
                })
              }
            />
          </label>
          <button
            className="primary"
            disabled={
              busy ||
              settings.updateCheckHours < 1 ||
              settings.updateCheckHours > 168
            }
          >
            {busy ? "保存中…" : "保存设置"}
          </button>
          {saved && <p role="status">设置已保存</p>}
          {error && <p role="alert">{error}</p>}
          <p className="hint">
            官方版本信息用于提示；未审查的版本不会自动安装。
          </p>
        </form>
      )}
    </section>
  );
}

function useTheme(settings: Settings | undefined) {
  useEffect(() => {
    if (!settings || !["light", "dark", "system"].includes(settings.theme))
      return;
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const apply = () =>
      (document.documentElement.dataset.theme =
        settings.theme === "system"
          ? media?.matches
            ? "dark"
            : "light"
          : settings.theme);
    apply();
    media?.addEventListener?.("change", apply);
    return () => media?.removeEventListener?.("change", apply);
  }, [settings?.theme]);
}
export function RuntimeTheme() {
  const settings = useResource(() => api.store<Settings>("v2/settings"), []);
  useTheme(settings.data);
  return null;
}
