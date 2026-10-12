import { useEffect, useState } from "react";
import { ArrowSquareOut, Play, Stop } from "@phosphor-icons/react";
import { api, message } from "../api/client";
import { ExternalLink } from "./ExternalLink";
import type { Instance } from "./Store";
import { AppArtwork } from "./AppArtwork";

/**
 * 空间商店里某个已安装应用的窗口。
 *
 * 从 App.tsx 搬出来的，**只搬不改**。
 * 这里刻意**动态**加载商店模块取 safeAppUrl：静态 import 会把整个商店
 * （465 KB / gzip 138 KB）拖进首屏，而这里只是给"打开 / 首次配置"算一个安全 URL。
 */
export function InstanceWindow({ instance }: { instance?: Instance }) {
  /*
   * safeAppUrl 住在商店模块里；静态 import 它会把整个商店（465 KB / gzip 138 KB）
   * 拖进首屏，而这里只是给"打开 / 首次配置"算一个安全 URL。
   * 所以进到这个窗口（说明真有实例要看）才 import。
   */
  const [safeHref, setSafeHref] = useState<string | null>(null);
  useEffect(() => {
    if (!instance) return;
    let alive = true;
    void import("./Store").then(({ safeAppUrl }) => {
      if (alive) setSafeHref(safeAppUrl(instance.accessUrl) || null);
    });
    return () => {
      alive = false;
    };
  }, [instance?.accessUrl, instance]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [state, setState] = useState(instance?.state);
  async function action(verb: "start" | "stop") {
    if (!instance) return;
    setBusy(true);
    setError("");
    try {
      await api.store(
        `instances/${encodeURIComponent(instance.id)}/${verb}`,
        {},
      );
      const result = await api.store<{ items: Instance[] }>("instances");
      setState(result.items.find((i) => i.id === instance.id)?.state);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="padded-module instance-landing">
      <span className="app-icon purple">
        <AppArtwork appId={instance?.appId || ""} />
      </span>
      <h1>{instance?.appId || "应用入口"}</h1>
      <p>运行状态：{state || "待验证"}</p>
      <p>健康状态：{instance?.health || "待验证"}</p>
      <p>原生接入：{instance?.nativeIntegration?.status || "unknown"}</p>
      <p className="muted">
        应用在独立页面中打开，首次使用请完成应用自身的管理员设置。
      </p>
      {instance && (
        <div className="instance-actions">
          <button
            className="secondary"
            disabled={busy || !api.storeSession}
            onClick={() => action("start")}
          >
            <Play />
            启动
          </button>
          <button
            className="secondary"
            disabled={busy || !api.storeSession}
            onClick={() => action("stop")}
          >
            <Stop />
            停止
          </button>
          {safeHref && (
            <ExternalLink
              className="primary"
              href={safeHref}
            >
              打开 / 首次配置
              <ArrowSquareOut />
            </ExternalLink>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </div>
  );
}
