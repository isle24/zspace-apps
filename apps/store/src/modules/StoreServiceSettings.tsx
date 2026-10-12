import { useState, useEffect } from "react";
import { Gear } from "@phosphor-icons/react";
import { api, message } from "../api/client";
export function StoreServiceSettings() {
  const [value, setValue] = useState(api.storeAddress);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const update = () => {
      setValue(api.storeAddress);
      setSaved(false);
    };
    window.addEventListener("space-store-address", update);
    return () => window.removeEventListener("space-store-address", update);
  }, []);
  async function save() {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await api.setStoreAddress(value);
      setValue(api.storeAddress);
      setSaved(true);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="store-service-settings">
      <summary>
        <Gear aria-hidden="true" />
        商店服务地址与安装目标
      </summary>
      <p>这是独立的第三方商店服务，安装目标由此服务配置。</p>
      <label className="field">
        独立商店服务地址
        <input
          type="url"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
          }}
          placeholder="留空使用当前网页同源商店服务"
        />
        <small>
          只保存服务地址，不保存商店密码或登录令牌。切换服务会退出当前商店账号。
        </small>
      </label>
      <button className="secondary" disabled={busy} onClick={save}>
        {busy ? "切换中…" : "应用服务地址"}
      </button>
      {saved && (
        <p role="status" className="storage-success">
          服务地址已应用，请核对执行设备并登录独立商店账号。
        </p>
      )}
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
    </details>
  );
}
