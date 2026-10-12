import {
  useEffect,
  useReducer,
  useState,
  useRef,
  type FormEvent,
  type PointerEvent,
} from "react";
import {
  SquaresFour,
  ChartLine,
  Gear,
  HardDrives,
  CloudCheck,
  CloudSlash,
  Cpu,
  Memory,
  Bell,
  MagnifyingGlass,
  UserCircle,
  CaretDown,
  ArrowLeft,
  X,
  Minus,
  CornersOut,
  CornersIn,
  Square,
  Moon,
  Sun,
  Planet,
  Eye,
  EyeSlash,
  SignOut,
  ArrowSquareOut,
  Cube,
  Play,
  Stop,
} from "@phosphor-icons/react";
import { api, isNative, message, type NasSession, vault } from "./api/client";
import {
  restoreCredentials,
  saveLoginPreference,
  type SavedCredentials,
} from "./api/credentials";
import { ExternalLink } from "./modules/ExternalLink";
import { InstanceWindow } from "./modules/InstanceWindow";
import { LoginScreen } from "./modules/LoginScreen";
import { loadRuntimeConfig, originFacts, resolveNasOrigin, type RuntimeConfig } from "./api/same-origin";
import { clearSessionCookie, cookieFacts } from "./api/session-cookie";
import { apps, AppIcon } from "./desktop/apps";
import { WindowFrame } from "./desktop/WindowFrame";
import {
  viewport,
  windowReducer,
  type DesktopWindow,
  type Action,
} from "./desktop/state";
import { FileTransfersProvider, FileTransferTasks, useFileTransfers } from "./modules/FileTransfers";
import { NasModule, type MediaSelection } from "./modules/NasModule";
import type { Instance } from "./modules/Store";
import { StoreWindow } from "./modules/StoreWindow";
import { shortcutLetter } from "./modules/shortcuts";
import { SpaceStoreWindow } from "./modules/SpaceStoreWindow";
import { AppArtwork } from "./modules/AppArtwork";
import { Player } from "./modules/Player";
import { useResource } from "./modules/common";
import {
  ResourceWidget,
  readMonitor,
  sumServiceIo,
  type MonitorSample,
  type WidgetPool,
} from "./modules/ResourceWidget";
/** 会话恢复失败：把这组 cookie 清掉，避免每次刷新都重试。 */
function clearStoredSession(baseUrl: string) {
  try {
    clearSessionCookie(cookieFacts(baseUrl, false));
  } catch {
    /* 清理失败不影响登录页 */
  }
}

/** 焦点交还：优先还给打开者；打开者是 body（例如用 ⌘K 打开）时退回到明确入口。 */
function restoreFocus(target: HTMLElement | null, fallbackSelector: string) {
  const usable =
    target && target !== document.body && document.contains(target) ? target : null;
  const next = usable ?? document.querySelector<HTMLElement>(fallbackSelector);
  requestAnimationFrame(() => next?.focus());
}

export default function App() {
  return <FileTransfersProvider><Desktop /></FileTransfersProvider>;
}
function Desktop() {
  const transfers = useFileTransfers();
  const [session, setSession] = useState<NasSession>();

  const [savedCredentials, setSavedCredentials] = useState<SavedCredentials>();
  const [restoreError, setRestoreError] = useState("");
  const [preview, setPreview] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [windows, dispatch] = useReducer(windowReducer, []);
  const [icons, setIcons] = useState(apps);
  const remoteEntries = useResource(async () => ({
    sessionId: session?.sessionId,
    entries: session ? await api.remoteEntries() : [],
  }), [session?.sessionId]);
  const shortcutIcons = remoteEntries.data?.sessionId === session?.sessionId
    ? (remoteEntries.data?.entries ?? []).filter(row => row.desktopVisible && row.url) : [];
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [accountOpen, setAccountOpen] = useState(false);
  const [instances, setInstances] = useState<Instance[]>([]);

  const [media, setMedia] = useState<MediaSelection>();
  // 飞牛主题挂在根元素的 data-theme 上（深色只在显式选择时启用）
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      return localStorage.getItem("space-desktop:theme") === "dark"
        ? "dark"
        : "light";
    } catch {
      return "light";
    }
  });
  const [toast, setToast] = useState("");
  const [mobile, setMobile] = useState(window.innerWidth <= 700);
  const scope = session
    ? `${session.baseUrl}/${String(session.user?.id || session.user?.username || "user")}`
    : "preview";
  useEffect(() => { transfers?.syncSession(); }, [transfers, session?.sessionId]);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.dataset.theme = "dark";
    else delete root.dataset.theme;
    try {
      localStorage.setItem("space-desktop:theme", theme);
    } catch {
      /* 隐私模式下无法持久化主题，不阻塞界面 */
    }
  }, [theme]);
  const sessionInfo = useResource(
    () => (session ? api.read("system.overview") : Promise.resolve(null)),
    [session?.sessionId],
  );
  const values = (sessionInfo.data as any)?.values;
  // 资源挂件：只用真实返回值。uptime 来自 /system/polling2 的 uptime_abs（官方前端同名字段），
  // 存储空间来自 system.storage 的池列表；未连接或字段缺失时挂件显示 “—”。
  const rootsResource = useResource(
    () => (session ? api.read("files.roots") : Promise.resolve(null)),
    [session?.sessionId],
  );
  const storageResource = useResource(
    () => (session ? api.read("system.storage") : Promise.resolve(null)),
    [session?.sessionId],
  );
  // 资源监控：连接后每 3 秒取一次官方 monitor 接口（/system/recent），断开即停止
  const [monitorSample, setMonitorSample] = useState<MonitorSample>();
  useEffect(() => {
    if (!session) {
      setMonitorSample(undefined);
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const raw = await api.read("system.monitor");
        if (alive) setMonitorSample(readMonitor(raw));
      } catch {
        if (alive) setMonitorSample(undefined);
      }
    };
    void tick();
    const timer = window.setInterval(tick, 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [session?.sessionId]);
  // 设备读写：与官方监控页相同，对 /manager/services 的服务级 io 求和；无权限时保持 “—”
  const [serviceIo, setServiceIo] = useState<{ read: number | null; write: number | null }>();
  useEffect(() => {
    if (!session) {
      setServiceIo(undefined);
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const raw = await api.read("system.services");
        if (alive) setServiceIo(sumServiceIo(raw));
      } catch {
        if (alive) setServiceIo(undefined);
      }
    };
    void tick();
    const timer = window.setInterval(tick, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [session?.sessionId]);
  // 刷新后免登录：官方网页版把会话放在 cookie 里，我们读回来并**验证一次**再采用；
  // 验证失败就清掉这组 cookie，绝不把没验证过的 token 当成已登录。
  const [restoreBase, setRestoreBase] = useState("");
  useEffect(() => {
    if (session || preview || isNative()) return;
    if (typeof document === "undefined") return;
    let alive = true;
    const facts = originFacts();
    const candidates = [resolveNasOrigin(null, false, facts), restoreBase].filter(Boolean);
    const read = (name: string) => {
      const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
      return match ? decodeURIComponent(match[1]) : "";
    };
    const token = read("token");
    if (!token) return;   // 没有 cookie 时交给原有的凭据自动登录流程
    const attempt = async (base: string) => {
      if (!base) throw new Error("没有可用的设备地址");
      return api.restoreNasSession(base, token, {
        username: read("username"),
        name: read("nickname") || read("qcname") || read("username"),
      });
    };
    (async () => {
      // 先用当前 origin，再加配置里的地址（若两者不同），都不行才认为 cookie 失效
      for (const base of [...new Set(candidates)]) {
        try {
          const restored = await attempt(base);
          if (!alive) return;
          setSession(restored);
          return;
        } catch {
          /* 试下一个来源 */
        }
      }
      if (alive) clearStoredSession(candidates[0] ?? "");
    })();
    return () => {
      alive = false;
    };
  }, [session, preview, restoreBase]);

  const uptimeSeconds = (() => {
    // /system/recent 实测直接带 uptime（秒，字符串），优先用它；否则回退到 polling2 的字段
    if (monitorSample?.uptimeSeconds != null) return monitorSample.uptimeSeconds;
    const raw = (rootsResource.data as any)?.uptime_abs ?? (rootsResource.data as any)?.uptime;
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  })();
  const storagePools: WidgetPool[] = (() => {
    const raw = (storageResource.data as any)?.values;
    const pools = Array.isArray(raw?.pools) ? raw.pools : Array.isArray(raw) ? raw : [];
    return pools.map((pool: any, index: number) => ({
      id: String(pool?.id ?? pool?.name ?? index),
      name: String(pool?.name ?? pool?.pool_name ?? `存储空间${index + 1}`),
      used: typeof pool?.used === "number" ? pool.used : undefined,
      total: typeof pool?.total === "number" ? pool.total : undefined,
    }));
  })();
  useEffect(() => {
    let alive = true;
    async function restore() {
      try {
        const saved = await vault("read", "nas:credentials");
        if (saved) {
          const result = await restoreCredentials(
            saved,
            (baseUrl, username, password) =>
              api.login(baseUrl, username, password),
          );
          if (alive) {
            setSavedCredentials(result.credentials);
            if (result.session) setSession(result.session);
            if (result.error) setRestoreError(result.error);
          }
        }
      } catch {
        api.logoutNas();
        await vault("delete", "nas:credentials").catch(() => {});
      } finally {
        if (alive) setRestoring(false);
      }
    }
    void restore();
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    const resize = () => {
      setMobile(innerWidth <= 700);
      dispatch({ type: "viewport", viewport: viewport() });
    };
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  // 键盘可达性：覆盖层关闭后把焦点还给打开它的元素，避免焦点掉到 body
  const searchOpener = useRef<HTMLElement | null>(null);
  const accountOpener = useRef<HTMLElement | null>(null);
  const closeSearch = () => {
    setSearchOpen(false);
    restoreFocus(searchOpener.current, '[aria-label="显示全部应用"]');
    searchOpener.current = null;
  };
  const closeAccount = () => {
    setAccountOpen(false);
    restoreFocus(accountOpener.current, '[aria-label="账号菜单"]');
    accountOpener.current = null;
  };
  // 依赖 searchOpen/accountOpen 重新订阅：闭包里读到的是当前状态，
  // 也不在 setState 更新函数里做副作用（StrictMode 会重复调用更新函数）。
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        if (searchOpen) closeSearch();
        else {
          searchOpener.current = document.activeElement as HTMLElement | null;
          setSearchOpen(true);
        }
      }
      /*
       * ⌘W 关闭 / ⌘M 最小化最前窗口 —— 桌面客户端的通用习惯。
       * 注意：浏览器里 ⌘W 是**浏览器自己的**关闭标签页快捷键，preventDefault 拦不住，
       * 所以网页版会先关标签页；到原生客户端（Tauri 无浏览器 chrome）才真正生效。
       * ⌘M 两边都能用。
       */
      if ((e.metaKey || e.ctrlKey) && (e.key === "w" || e.key === "m")) {
        // 就地算出最前窗口：`top` 在下面才声明，这里引用会踩 TDZ
        const front = windows
          .filter((w) => w.scope === scope && !w.minimized)
          .sort((a, b) => b.z - a.z)[0];
        if (front) {
          e.preventDefault();
          dispatch({ type: e.key === "w" ? "close" : "minimize", id: front.id });
        }
        return;
      }
      if (e.key === "Escape") {
        if (searchOpen) closeSearch();
        else if (accountOpen) closeAccount();
        else {
          setSearchOpen(false);
          setAccountOpen(false);
        }
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [searchOpen, accountOpen, windows, scope]);
  useEffect(() => {
    const expired = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.scope !== "nas") return;
      api.logoutNas();
      transfers?.syncSession();
      setSession(undefined);
      setPreview(false);
      setMedia(undefined);
      setRestoreError("NAS 登录已失效，请重新登录。");
    };
    window.addEventListener("space-session-expired", expired);
    return () => window.removeEventListener("space-session-expired", expired);
  }, []);
  function open(appId: string) {
    dispatch({ type: "open", appId, scope, viewport: viewport() });
    setSearchOpen(false);
    setSearch("");
  }
  async function logout() {
    api.logoutNas();
    transfers?.syncSession();
    let warning = "";
    try {
      await vault("delete", "nas:credentials");
    } catch {
      warning += " 保存的凭据清除失败，请在系统凭据保险库中移除。";
    }
    setSession(undefined);
    setSavedCredentials(undefined);
    setRestoreError(warning);
    setPreview(false);
    setMedia(undefined);
    setInstances([]);
    setAccountOpen(false);
  }
  // 关闭窗口后把焦点交还给应用栏入口：等 windows 数组真正变化后再执行，
  // 这样焦点不会落在已被移除的元素上（也不会被浏览器的默认失焦行为覆盖）。
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const selector = pendingFocus.current;
    if (!selector) return;
    pendingFocus.current = null;
    restoreFocus(document.querySelector<HTMLElement>(selector), '[aria-label="显示全部应用"]');
  }, [windows]);
  const current = windows.filter((w) => w.scope === scope);
  const top = current.filter((w) => !w.minimized).sort((a, b) => b.z - a.z)[0];
  if (restoring)
    return (
      <main className="login-screen">
        <span className="spinner" />
        <p>正在打开空间桌面…</p>
      </main>
    );
  if (!session && !preview)
    return (
      <LoginScreen
        saved={savedCredentials}
        initialError={restoreError}
        onLogin={(s, warning) => {
          setSession(s);
          setPreview(false);
          setSavedCredentials(undefined);
          if (warning) setToast(warning);
        }}
        onPreview={() => setPreview(true)}
        onStore={() => {
          setPreview(true);
          open("store");
        }}
      />
    );
  return (
    <main className={`desktop ${mobile ? "mobile" : ""}`}>
      <header className="system-bar">
        <div className="system-brand">
          <SquaresFour weight="fill" />
          <strong>空间桌面</strong>
        </div>
        <ResourceWidget
          connected={!!session}
          values={values as Record<string, unknown> | undefined}
          monitor={monitorSample}
          io={serviceIo}
          pools={storagePools}
          hostName={
            session
              ? String(session.user?.name || session.user?.username || "我的 NAS")
              : undefined
          }
          uptimeSeconds={uptimeSeconds}
        />
      </header>
      {accountOpen && (
        <div className="account-menu">
          <strong>{session ? "设备已连接" : "桌面体验模式"}</strong>
          <small>{session?.baseUrl || "未连接 NAS，不会显示示例数据"}</small>
          <button
            aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
            aria-pressed={theme === "dark"}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <Sun /> : <Moon />}
            {theme === "dark" ? "浅色外观" : "深色外观"}
          </button>
          <button onClick={() => { closeAccount(); setSearchOpen(true); }}>
            <MagnifyingGlass />
            搜索应用
          </button>
          <button onClick={() => void logout()}>
            <SignOut />
            {session ? "退出并切换设备" : "连接 NAS"}
          </button>
        </div>
      )}
      <div className="mobile-intro">
        <span className="eyebrow">YOUR PERSONAL SPACE</span>
        <h1>空间桌面</h1>
        <p>
          {session ? String(session.user?.name || "我的 NAS") : "尚未连接设备"}{" "}
          <span>· {session ? "已连接" : "桌面体验"}</span>
        </p>
      </div>
      <section className="desktop-icons" aria-label="桌面应用">
        {icons.map((app) => (
          <button
            key={app.id}
            className="desktop-app"
            data-app-id={app.id}
            draggable={!mobile}
            onDragStart={(e) => e.dataTransfer.setData("text/plain", app.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const source = e.dataTransfer.getData("text/plain");
              setIcons((list) => {
                const from = list.findIndex((a) => a.id === source),
                  to = list.findIndex((a) => a.id === app.id);
                if (from < 0) return list;
                const next = [...list];
                [next[from], next[to]] = [next[to], next[from]];
                return next;
              });
            }}
            onClick={() => open(app.id)}
          >
            <AppIcon app={app} />
            <span>{app.name}</span>
          </button>
        ))}
        {shortcutIcons.map((row) => (
          <ExternalLink
            key={row.id}
            className="desktop-app desktop-shortcut"
            href={row.url!}
          >
            <span className="app-icon" aria-hidden="true" style={{ background: row.color }}>
              {shortcutLetter(row.name)}
            </span>
            <span>{row.name}</span>
          </ExternalLink>
        ))}
        {instances.map((instance) => (
          <button
            key={instance.id}
            className="desktop-app"
            data-app-id={`instance:${instance.id}`}
            onClick={() => open(`instance:${instance.id}`)}
          >
            <span className="app-icon purple">
              <AppArtwork appId={instance.appId} />
            </span>
            <span>{instance.appId}</span>
            <small>{instance.state}</small>
          </button>
        ))}
      </section>
      <div className="desktop-caption">
        <span className={`status-dot ${session ? "online" : ""}`} />
        {session ? "私人空间 · 已连接 NAS" : "桌面体验 · 未连接 NAS"}
        <span className="desktop-tip">点击图标打开应用 · ⌘ / Ctrl K 搜索</span>
      </div>
      <div className="window-area">
        {current.map((w) => (
          <WindowFrame
            key={w.id}
            window={w}
            dispatch={dispatch}
            onClose={() => {
              pendingFocus.current = `.desktop-app[data-app-id="${CSS.escape(w.appId)}"]`;
              dispatch({ type: "close", id: w.id });
            }}
            mobile={mobile}
            active={top?.id === w.id}
            title={
              apps.find((a) => a.id === w.appId)?.name ||
              instances.find((i) => `instance:${i.id}` === w.appId)?.appId ||
              "应用"
            }
          >
            {w.appId === "tasks" ? (
              <FileTransferTasks onInstances={setInstances} />
            ) : w.appId === "store" ? (
              <StoreWindow onInstances={setInstances} />
            ) : w.appId === "space-store" ? (
              <SpaceStoreWindow onInstances={setInstances} />
            ) : w.appId.startsWith("instance:") ? (
              <InstanceWindow
                instance={instances.find((i) => `instance:${i.id}` === w.appId)}
              />
            ) : (
              <NasModule id={w.appId} connected={!!session} onPlay={setMedia} />
            )}
          </WindowFrame>
        ))}
      </div>
      <nav className="dock" aria-label="应用 Dock">
        {/* 飞牛三段式应用栏：顶部分组（桌面/全部应用）+ 分隔线 + 应用图标 + 底部分组 */}
        <div className="dock-top">
          <button
            aria-label="回到桌面"
            onClick={() =>
              current.forEach((w) => dispatch({ type: "minimize", id: w.id }))
            }
          >
            <img src="/app-icons/rail-desktop.png" alt="" draggable={false} />
          </button>
          <button
            aria-label="显示全部应用"
            className={searchOpen ? "running" : ""}
            onClick={() => {
              current.forEach((w) => dispatch({ type: "minimize", id: w.id }));
              if (searchOpen) closeSearch();
              else {
                searchOpener.current = document.activeElement as HTMLElement | null;
                setSearchOpen(true);
              }
            }}
          >
            <img src="/app-icons/rail-launchpad.png" alt="" draggable={false} />
          </button>
        </div>
        <span className="dock-separator" />
        <div className="dock-apps">
          {current.filter((entry) => !["storage", "tasks", "settings"].includes(entry.appId)).map((entry) => {
            const app = apps.find((a) => a.id === entry.appId);
            const instance = instances.find((row) => `instance:${row.id}` === entry.appId);
            const name = app?.name || instance?.appId || "应用";
            return (
              <button
                className="running"
                key={entry.id}
                onClick={() => open(entry.appId)}
                aria-label={`打开${name}`}
              >
                {app ? <AppIcon app={app} small /> : <span className="app-icon purple small"><AppArtwork appId={instance?.appId || entry.appId} /></span>}
                <span>{app?.short || name}</span>
                <i />
              </button>
            );
          })}
        </div>
        <div className="dock-bottom">
          <button aria-label="资源管理" onClick={() => open("storage")}>
            <ChartLine />
          </button>
          <button
            aria-label="打开任务中心"
            onClick={() => open("tasks")}
            className={current.some((w) => w.appId === "tasks") ? "running" : ""}
          >
            <Bell />
          </button>
          <button
            aria-label="打开账号面板"
            onClick={(e) => {
              if (accountOpen) closeAccount();
              else {
                accountOpener.current = e.currentTarget;
                setAccountOpen(true);
              }
            }}
          >
            <UserCircle />
          </button>
          <button
            aria-label="打开控制面板"
            className={current.some((w) => w.appId === "settings") ? "running" : ""}
            onClick={() => open("settings")}
          >
            <Gear />
          </button>
        </div>
      </nav>
      <div className="mobile-bottom">
        <div>
          <HardDrives />
          <span>
            存储 <strong>—</strong>
          </span>
          <button onClick={() => open("tasks")}>查看任务</button>
        </div>
        <button onClick={() => setSearchOpen(true)}>
          <MagnifyingGlass />
          搜索应用
        </button>
        <button onClick={() => setAccountOpen(true)}>
          <HardDrives />
          {session ? "切换设备" : "连接设备"}
        </button>
      </div>
      {searchOpen && (
        <div className="search-backdrop" onClick={closeSearch}>
          {/* 飞牛启动台：全屏磨砂覆盖层 + 居中搜索胶囊 + 六列应用网格 */}
          <div
            className="launchpad"
            role="dialog"
            aria-modal="true"
            aria-label="全部应用"
          >
            <label className="launchpad-search">
              <MagnifyingGlass />
              <input
                autoFocus
                placeholder="搜索"
                aria-label="搜索应用名称"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <div className="launchpad-grid">
              {apps
                .filter((a) =>
                  a.name.toLowerCase().includes(search.trim().toLowerCase()),
                )
                .map((app) => (
                  <button key={app.id} onClick={() => open(app.id)}>
                    <AppIcon app={app} />
                    <span>{app.name}</span>
                  </button>
                ))}
            </div>
          </div>
        </div>
      )}
      {media && (
        <Player
          selection={media}
          onChange={setMedia}
          onClose={() => setMedia(undefined)}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </main>
  );
}
function metric(value: unknown) {
  return typeof value === "number" ? `${Math.round(value)}%` : "—";
}
