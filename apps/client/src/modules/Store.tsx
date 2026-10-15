import { StoreServiceSettings } from "./StoreServiceSettings";
import { MediaRootPicker, mediaPathAllowed } from "./MediaRootPicker";
import { createId } from "../api/id";
import {
  useState,
  type FormEvent,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import {
  ShoppingBag,
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  Check,
  ClockCounterClockwise,
  Cube,
  Play,
  SquaresFour,
  Stop,
  ArrowSquareOut,
  ShieldCheck,
  FolderOpen,
  WarningCircle,
} from "@phosphor-icons/react";
import { api, confirmInstallation, GatewayError, message } from "../api/client";
import { Search, Status, useResource, DataValues } from "./common";
import { ExternalLink } from "./ExternalLink";
import { AppArtwork } from "./AppArtwork";
import {
  StoragePicker,
  allowedStorage,
  type StorageRoot,
} from "./StoragePicker";
export type StoreApp = {
  id: string;
  name: string;
  category: string;
  description: string;
  version: string;
  image: string;
  sourceUrl?: string;
  installable: boolean;
  defaultPort: number;
  requiresMedia: boolean;
  icon?: string;
  recipeStatus?: string;
  manifestVerification?: unknown;
};
type Root = StorageRoot;
export type Instance = {
  id: string;
  appId: string;
  containerName: string;
  image?: string;
  containerId?: string;
  dataPath: string;
  hostPort: number;
  accessUrl: string;
  state: string;
  health: string;
  initialization: string;
  nativeIntegration?: { status: string; configUrl?: string; reason?: string };
};
type Job = {
  id: string;
  appId?: string;
  instanceId: string;
  status: string;
  stage: string;
  error?: string;
  stages?: unknown;
};
type SubmittedInstallation = {
  jobId: string;
  instanceId: string;
  appId: string;
  appName: string;
  session: string;
  serviceAddress: string;
};
type InitializationPrompt = SubmittedInstallation & { instance: Instance };
type Plan = {
  id: string;
  instanceId?: string;
  containerName?: string;
  retryOfPlanId?: string;
  retryOfJobId?: string;
  appId: string;
  rootId: string;
  rootPath?: string;
  storageIdentity?: string;
  dockerStorageIdentity?: string;
  dataPath: string;
  mediaPath?: string;
  mediaRootId?: string;
  mediaRootPath?: string;
  mediaStorageIdentity?: string;
  hostPort: number;
  image: string;
  previousImage?: string;
  accessUrl: string;
  mounts: unknown;
  expiresAt: string;
  nativeIntegration: unknown;
};
type StoreStatus = {
  configured: boolean;
  engineMode: string;
  engineReady: boolean;
  engineMessage: string;
  nativeIntegration: string;
  authMode?: string;
  nasAuth?: { enabled?: boolean };
  setupRequiresLoopback?: boolean;
};
const retryHubImage = "louislam/uptime-kuma:2.5.6";
const retryGhcrImage = "ghcr.io/louislam/uptime-kuma:2.5.6";
function supportsRetrySource(instance: Instance) {
  return (
    instance.appId === "uptime-kuma" &&
    instance.image === retryHubImage &&
    !instance.containerId
  );
}
export function Store({
  embedded = false,
  initialTab = "catalog",
  onInstances,
}: {
  embedded?: boolean;
  initialTab?: string;
  onInstances: (items: Instance[]) => void;
}) {
  const [tab, setTab] = useState(initialTab);
  const [category, setCategory] = useState("全部");
  const [query, setQuery] = useState("");
  const [session, setSession] = useState(api.storeSession);
  const [retry, setRetry] = useState<{ instance: Instance; plan: Plan }>();
  const [retrySources, setRetrySources] = useState<
    Record<string, { imageSource: "ghcr"; jobId: string }>
  >({});
  const retryGeneration = useRef(0);
  const retryRequestPending = useRef(false);
  const [serviceAddress, setServiceAddress] = useState(api.storeAddress);
  const [pendingInitialization, setPendingInitialization] = useState<
    SubmittedInstallation[]
  >([]);
  const [initializationPrompt, setInitializationPrompt] =
    useState<InitializationPrompt>();
  useEffect(() => {
    const update = () => {
      setServiceAddress(api.storeAddress);
      setSelected(undefined);
      retryGeneration.current++;
      retryRequestPending.current = false;
      setRetry(undefined);
      setRetrySources({});
      setBusy("");
      setPendingInitialization([]);
      setInitializationPrompt(undefined);
      onInstances([]);
    };
    window.addEventListener("space-store-address", update);
    return () => window.removeEventListener("space-store-address", update);
  }, []);
  useEffect(() => {
    const update = () => {
      setSession(api.storeSession);
      setNasPaused(api.storeNasAutoLoginPaused);
      setSelected(undefined);
      retryGeneration.current++;
      retryRequestPending.current = false;
      setRetry(undefined);
      setRetrySources({});
      setBusy("");
      setPendingInitialization([]);
      setInitializationPrompt(undefined);
    };
    window.addEventListener("space-store-session", update);
    return () => window.removeEventListener("space-store-session", update);
  }, []);
  const [selected, setSelected] = useState<StoreApp>();
  const [auth, setAuth] = useState(false);
  const status = useResource(
    () => api.store<StoreStatus>(session ? "status" : "bootstrap", undefined, !session),
    [serviceAddress, session],
  );
  const [nasRevision, setNasRevision] = useState(0);
  const [pairRevision, setPairRevision] = useState(0);
  const [nasPaused, setNasPaused] = useState(api.storeNasAutoLoginPaused);
  const [nasBinding, setNasBinding] = useState<Awaited<ReturnType<typeof api.getStoreNasBinding>>>();
  const [nasAuthBusy, setNasAuthBusy] = useState(false);
  const [nasAuthError, setNasAuthError] = useState("");
  const [independentLogin, setIndependentLogin] = useState(false);
  useEffect(() => {
    if (!embedded) return;
    const changed = () => { setNasRevision(n => n + 1); setNasPaused(false); };
    window.addEventListener("space-nas-session", changed);
    window.addEventListener("space-store-address", changed);
    return () => { window.removeEventListener("space-nas-session", changed); window.removeEventListener("space-store-address", changed); };
  }, [embedded]);
  useEffect(() => {
    if (!embedded) return;
    setNasBinding(undefined);
    setNasAuthBusy(false);
    setNasAuthError("");
    setIndependentLogin(false);
    if (!api.nasSession || session || nasPaused) return;
    let alive = true;
    const controller = new AbortController();
    setNasAuthBusy(true);
    void (async () => {
      const binding = await api.getStoreNasBinding();
      if (!alive) return;
      setNasBinding(binding);
      if (api.isStoreNasTrusted(binding)) await api.connectStoreWithNas({ signal: controller.signal });
    })().catch(error => {
      if (!alive) return;
      if (error instanceof GatewayError && error.code === "STORE_NAS_DISABLED") setIndependentLogin(true);
      else setNasAuthError(message(error));
    }).finally(() => { if (alive) setNasAuthBusy(false); });
    return () => { alive = false; controller.abort(); };
  }, [embedded, serviceAddress, session, nasRevision, pairRevision, nasPaused]);
  useEffect(() => {
    if (!embedded || !session || api.storeAuthSource !== "nas" || !status.data) return;
    let alive = true;
    void api.getStoreNasBinding().catch(error => { if (alive) setNasAuthError(message(error)); });
    return () => { alive = false; };
  }, [embedded, session, status.data]);
  function trustNasShop() {
    if (!nasBinding) return;
    try { api.trustStoreNasBinding(nasBinding); setPairRevision(n => n + 1); }
    catch (error) { setNasAuthError(message(error)); }
  }
  const catalog = useResource(
    () => session ? api.store<{ items: StoreApp[] }>("catalog") : Promise.resolve({items: []}),
    [serviceAddress, session],
  );
  const [revision, setRevision] = useState(0);
  const instances = useResource(
    () =>
      session
        ? api.store<{ items: Instance[] }>("instances")
        : Promise.resolve({ items: [] }),
    [session, serviceAddress, revision],
  );
  const jobs = useResource(
    () =>
      session
        ? api.store<{ items: Job[] }>("jobs")
        : Promise.resolve({ items: [] }),
    [session, serviceAddress, revision],
  );
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState("");
  useEffect(
    () => () => {
      retryGeneration.current++;
    },
    [],
  );
  const activeJob = (instanceId: string) =>
    jobs.data?.items.some(
      (job) =>
        job.instanceId === instanceId &&
        ["queued", "running"].includes(job.status),
    ) || false;
  const retryStateReady =
    !!session &&
    !!jobs.data &&
    !jobs.loading &&
    !jobs.error &&
    !!instances.data &&
    !instances.loading &&
    !instances.error;
  const retryAvailable = (instanceId: string) => {
    // The API returns newest jobs first; reconciled container state is independent
    // of whether its latest installation job needs recovery.
    const latest = jobs.data?.items.find(
      (job) => job.instanceId === instanceId,
    );
    return (
      retryStateReady &&
      !!latest &&
      ["failed", "needs_attention"].includes(latest.status) &&
      !activeJob(instanceId)
    );
  };
  const selectedRetrySource = (instance: Instance) => {
    const choice = retrySources[instance.id];
    const latest = jobs.data?.items.find((job) => job.instanceId === instance.id);
    return choice?.jobId === latest?.id
      ? choice?.imageSource || ""
      : "";
  };
  const applicationName = (appId?: string) =>
    catalog.data?.items.find((app) => app.id === appId)?.name || "应用安装";
  function installationSubmitted(
    job: { id: string; instanceId: string },
    appId: string,
    appName: string,
  ) {
    if (session !== api.storeSession || serviceAddress !== api.storeAddress)
      return;
    setPendingInitialization((list) =>
      list.some((item) => item.jobId === job.id)
        ? list
        : [
            ...list,
            {
              jobId: job.id,
              instanceId: job.instanceId,
              appId,
              appName,
              session,
              serviceAddress,
            },
          ],
    );
    setSelected(undefined);
    setRetry(undefined);
    setRetrySources({});
    setTab("jobs");
    setRevision((n) => n + 1);
  }
  async function generateRetry(instance: Instance) {
    if (
      !retryAvailable(instance.id) ||
      retry ||
      busy ||
      retryRequestPending.current ||
      activeJob(instance.id)
    )
      return;
    const imageSource = selectedRetrySource(instance);
    if (imageSource && !supportsRetrySource(instance)) {
      setActionError("当前实例不支持所选镜像来源，请刷新后重试。");
      return;
    }
    const generation = ++retryGeneration.current;
    retryRequestPending.current = true;
    setBusy(instance.id);
    setActionError("");
    try {
      const plan = await api.store<Plan>(
        `instances/${encodeURIComponent(instance.id)}/retry-plan`,
        imageSource ? { imageSource } : {},
      );
      if (
        generation !== retryGeneration.current ||
        session !== api.storeSession ||
        serviceAddress !== api.storeAddress
      )
        return;
      if (
        !plan.id ||
        plan.appId !== instance.appId ||
        plan.instanceId !== instance.id
      )
        throw new Error("重试计划与原实例不一致，请刷新后重试。");
      if (
        imageSource === "ghcr"
          ? plan.previousImage !== instance.image || plan.image !== retryGhcrImage
          : !!plan.previousImage ||
            (!!instance.image && plan.image !== instance.image)
      )
        throw new Error("重试计划未匹配所选镜像来源，请重新生成计划。");
      setRetry({ instance, plan });
    } catch (e) {
      if (generation === retryGeneration.current) setActionError(message(e));
    } finally {
      if (generation === retryGeneration.current) {
        retryRequestPending.current = false;
        setBusy("");
      }
    }
  }
  useEffect(() => {
    if (
      !session ||
      jobs.loading ||
      instances.loading ||
      jobs.error ||
      instances.error ||
      !jobs.data ||
      !instances.data
    )
      return;
    const currentJob = (submitted: SubmittedInstallation) =>
      jobs.data!.items.find(
        (job) =>
          job.id === submitted.jobId && job.instanceId === submitted.instanceId,
      );
    const currentInstance = (submitted: SubmittedInstallation) =>
      instances.data!.items.find(
        (instance) =>
          instance.id === submitted.instanceId &&
          instance.appId === submitted.appId,
      );
    const ready = (submitted: SubmittedInstallation) =>
      currentJob(submitted)?.status === "completed" &&
      currentInstance(submitted)?.state === "running" &&
      currentInstance(submitted)?.health === "healthy";
    const remaining = pendingInitialization.filter(
      (submitted) =>
        submitted.session === session &&
        submitted.serviceAddress === serviceAddress &&
        !["failed", "needs_attention", "cancelled"].includes(
          currentJob(submitted)?.status || "",
        ),
    );
    if (remaining.length !== pendingInitialization.length)
      setPendingInitialization(remaining);
    if (initializationPrompt) {
      if (
        initializationPrompt.session !== session ||
        initializationPrompt.serviceAddress !== serviceAddress ||
        !ready(initializationPrompt)
      )
        setInitializationPrompt(undefined);
      return;
    }
    const submitted = remaining.find(ready);
    if (!submitted) return;
    const instance = currentInstance(submitted)!;
    setPendingInitialization((list) =>
      list.filter((item) => item.jobId !== submitted.jobId),
    );
    if (!safeAppUrl(instance.accessUrl)) {
      setActionError(
        `${submitted.appName} 已安装，但服务未返回可用的应用访问地址，请在已安装应用中检查。`,
      );
      return;
    }
    setInitializationPrompt({ ...submitted, instance });
  }, [
    pendingInitialization,
    initializationPrompt,
    jobs.data,
    instances.data,
    jobs.loading,
    instances.loading,
    jobs.error,
    instances.error,
    session,
    serviceAddress,
  ]);
  useEffect(() => {
    const expired = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.scope !== "store") return;
      setAuth(true);
      setActionError(
        "商店登录已失效，请重新登录。" + String(detail.message || ""),
      );
      onInstances([]);
    };
    window.addEventListener("space-session-expired", expired);
    return () => window.removeEventListener("space-session-expired", expired);
  }, []);

  useEffect(() => {
    if (instances.data) onInstances(instances.data.items);
  }, [instances.data]);
  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => setRevision((n) => n + 1), 8000);
    return () => clearInterval(timer);
  }, [session]);
  function refresh() {
    setRevision((n) => n + 1);
    status.reload();
    catalog.reload();
  }
  async function action(instance: Instance, verb: "start" | "stop") {
    setBusy(instance.id);
    setActionError("");
    try {
      await api.store(
        `instances/${encodeURIComponent(instance.id)}/${verb}`,
        {},
      );
      setRevision((n) => n + 1);
    } catch (e) {
      setActionError(message(e));
    } finally {
      setBusy("");
    }
  }
  const categories = [
    "全部",
    ...new Set((catalog.data?.items || []).map((a) => a.category)),
  ];
  const listed = (catalog.data?.items || []).filter(
    (a) =>
      (category === "全部" || a.category === category) &&
      `${a.name} ${a.description}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="store-module">
      <div className="store-header">
        <div>
          <ShoppingBag weight="duotone" />
          <span>
            <strong>空间商店</strong>
            <small>为你的空间，增添更多可能</small>
          </span>
        </div>
        <div className="store-header-actions">
          <button className="icon-button" aria-label="刷新商店" onClick={refresh}>
            <ArrowClockwise />
          </button>
          <button
            className={session ? "secondary" : "primary"}
            onClick={() => { setAuth(!auth); if (!session) setNasPaused(true); }}
          >
            <ShieldCheck />
            {session ? "管理员已登录" : "管理员登录"}
          </button>
        </div>
      </div>
      <div className="store-layout">
        <div className="store-sidebar">
          {tab === "catalog" && (
            <div className="store-sidebar-search">
              <Search value={query} onChange={setQuery} placeholder="搜索应用" />
            </div>
          )}
          <div className="store-navigation">
            <div className="tabs">
              {([
                ["catalog", "发现", SquaresFour],
                ["installed", "已安装", Cube],
                ["jobs", "安装任务", ClockCounterClockwise],
              ] as const).map(([key, label, Glyph]) => (
                <button
                  className={tab === key ? "active" : ""}
                  key={key}
                  onClick={() => setTab(key)}
                >
                  <Glyph aria-hidden="true" />
                  {label}
                  {key === "jobs" && !!jobs.data?.items.length && (
                    <span className="count">{jobs.data.items.length}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
          {tab === "catalog" && (
            <div className="store-filters">
              <p className="store-sidebar-heading">分类</p>
              <div className="chips">
                {categories.map((c) => (
                  <button
                    key={c}
                    className={c === category ? "active" : ""}
                    onClick={() => setCategory(c)}
                  >
                    <SquaresFour aria-hidden="true" />
                    {categoryLabel(c)}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="store-sidebar-footer">
            <StoreServiceSettings embedded={embedded} />
          </div>
        </div>
        <div className="store-main">
        {embedded && !session && nasPaused && api.nasSession && (
          <div className="auth-box">{status.data?.nasAuth?.enabled === true ? <><p>已退出商店，当前 NAS 会话不会自动重新登录。</p><button className="secondary" onClick={() => { api.resumeStoreNasAutoLogin(); setNasPaused(false); }}>使用当前 NAS 管理员登录商店</button></> : <p>已退出商店，请使用商店管理员账号重新登录。</p>}</div>
        )}
        {embedded && !session && !nasPaused && (
          <div className="auth-box">
            {nasAuthBusy && <p role="status">正在验证 NAS 商店授权…</p>}
            {independentLogin && <p>使用独立商店管理员账号登录，此账号与 NAS 账号分别管理。</p>}
            {nasBinding && !api.isStoreNasTrusted(nasBinding) && (
              <div>
                <h3>使用当前 NAS 管理员登录商店</h3>
                <p>确认后将当前 NAS 会话发送到下列商店以验证管理员权限。此绑定以后自动复用，无需再次输入密码。</p>
                <dl><dt>NAS</dt><dd>{nasBinding.providerId}</dd><dt>商店</dt><dd>{nasBinding.storeBase}</dd><dt>商店实例</dt><dd>{nasBinding.storeId}</dd></dl>
                <button className="primary" disabled={nasAuthBusy} onClick={trustNasShop}>信任此商店并使用 NAS 登录</button>
              </div>
            )}
            {nasAuthError && <p className="error-text" role="alert">{nasAuthError}</p>}
          </div>
        )}
        {status.data && (
          <p className="store-target">
            独立商店 · 执行模式：
            {(
              {
                sshbind: "SSH 远程设备",
                local: "本机 Docker",
                disabled: "未启用",
              } as Record<string, string>
            )[status.data.engineMode] ||
              status.data.engineMode ||
              "待验证"}{" "}
            · {status.data.engineReady ? "引擎可用" : "引擎未就绪"}
            。安装目标以此服务登记的存储目录为准。
          </p>
        )}
        {auth && (
          <StoreAuth
            configured={status.data?.configured}
            nasOnly={status.data?.authMode === "nas-admin-only"}
            embedded={embedded}
            setupRequiresLoopback={status.data?.setupRequiresLoopback}
            onReload={status.reload}
            onDone={() => {
              setSession(api.storeSession);
              setAuth(false);
              status.reload();
            }}
            onLogout={async () => {
              setNasPaused(true);
              const logoutAddress = api.storeAddress;
              const locallyLoggedOut = () =>
                api.storeAddress === logoutAddress && !api.storeSession;
              try {
                await api.logoutStore();
              } catch (e) {
                if (locallyLoggedOut())
                  setActionError("本地已退出，但服务端注销失败：" + message(e));
              } finally {
                // The SDK may have retained a replacement session while this old
                // request was pending. Its event already synchronized that scope.
                if (locallyLoggedOut()) {
                  setSession("");
                  onInstances([]);
                }
              }
            }}
          />
        )}
        {status.error && (
          <div className="inline-error" role="alert">
            {status.error}
          </div>
        )}
        {session && status.data && !status.data.engineReady && (
          <div className="notice">
            <WarningCircle />
            <span>
              {status.data.engineMessage || "容器引擎尚未就绪"} ·
              安装前将由服务端重新检查
            </span>
          </div>
        )}
        {status.data?.engineMode === "disabled" && (
          <details className="engine-guidance">
            <summary>配置应用商店的执行设备</summary>
            <p>
              {embedded
                ? "商店安装引擎尚未启用。NAS 管理员登录可授权商店管理，但安装执行设备与存储目录仍由商店服务配置，请单独核对。"
                : "商店安装引擎尚未启用。NAS 网页登录仅用于读取文件和媒体，不会自动把商店安装目标绑定到当前 NAS。"}
            </p>
            <p>
              原生客户端请在 gateway.json 中配置 engine 为
              sshbind，并选择已经可用的 SSH
              别名；由服务器管理员在目标设备准备好数据专用目录，再重新启动客户端。H5
              使用独立商店服务实际配置的执行设备。
            </p>
            <p>
              重新连接后在安装向导核对 SSD／数据盘身份、Docker
              镜像位置和独立媒体根目录，再生成安装计划。
            </p>
          </details>
        )}
        {actionError && (
          <div className="inline-error" role="alert">
            {actionError}
          </div>
        )}
        {tab === "catalog" && (
          <>
            <div className="store-banner">
              <span className="eyebrow">A LITTLE MORE POSSIBILITY</span>
              <h1>发现适合你的应用</h1>
              <p>{catalog.data?.items.length || 0} 款应用 · 影音、阅读与实用工具</p>
              <div className="banner-orbit">
                <Cube weight="duotone" />
              </div>
            </div>
            <Status
              {...catalog}
              empty={!!catalog.data && !listed.length}
              retry={catalog.reload}
            />
            <div className="catalog-grid">
              {listed.map((app) => (
                <article className="catalog-card" key={app.id}>
                  <span className={`store-app-icon app-${app.id}`}>
                    <AppArtwork appId={app.id} icon={app.icon} />
                  </span>
                  <div>
                    <h3>{app.name}</h3>
                    <small>
                      {categoryLabel(app.category)} · {app.version}
                    </small>
                    <p>{app.description}</p>
                    <span className="tag">
                      {app.installable ? "可安装" : "配方待验证"}
                    </span>
                  </div>
                  <button className="secondary" onClick={() => setSelected(app)}>
                    查看
                  </button>
                </article>
              ))}
            </div>
          </>
        )}
        {tab === "installed" && (
          <div className="padded-module">
            <h1>已安装应用</h1>
            <p className="muted">实例运行状态与桌面入口</p>
            <Status
              loading={instances.loading}
              error={instances.error}
              connected={!!session}
              disconnected={{ title: "请先登录商店管理员", detail: embedded ? "确认信任绑定后可使用 NAS 管理员授权，或使用独立商店账号登录，以查看安装任务和已安装应用。" : "商店会话独立于 NAS，登录后可查看安装任务和已安装应用。" }}
              empty={!!session && instances.data?.items.length === 0}
              retry={instances.reload}
            />
            <div className="instance-list">
              {instances.data?.items.map((instance) => (
                <article className="instance-card" key={instance.id}>
                  <span className="store-app-icon">
                    <AppArtwork
                      appId={instance.appId}
                      icon={
                        catalog.data?.items.find((a) => a.id === instance.appId)
                          ?.icon
                      }
                    />
                  </span>
                  <div className="instance-info">
                    <h3>
                      {catalog.data?.items.find((a) => a.id === instance.appId)
                        ?.name || instance.appId}
                    </h3>
                    <p>
                      运行：{instanceStateLabel(instance.state)} · 健康：
                      {healthLabel(instance.health)}
                    </p>
                    <p>
                      原生接入：{instance.nativeIntegration?.status || "unknown"}{" "}
                      · 初始化：{instance.initialization || "待确认"}
                    </p>
                    <small>
                      {instance.nativeIntegration?.reason ||
                        "应用容器健康与原生接入分别验证"}
                    </small>
                    {retryAvailable(instance.id) && supportsRetrySource(instance) && (
                      <label className="field">
                        重试镜像来源
                        <select
                          value={selectedRetrySource(instance)}
                          disabled={!!retry || !!busy || !retryStateReady}
                          onChange={(event) =>
                            setRetrySources((sources) => {
                              const next = { ...sources };
                              if (event.target.value === "ghcr") {
                                next[instance.id] = {
                                  imageSource: "ghcr",
                                  jobId:
                                    jobs.data?.items.find(
                                      (job) => job.instanceId === instance.id,
                                    )?.id || "",
                                };
                              } else delete next[instance.id];
                              return next;
                            })
                          }
                        >
                          <option value="">保持原镜像（Docker Hub 2.5.6）</option>
                          <option value="ghcr">官方 GHCR（同版本 2.5.6）</option>
                        </select>
                      </label>
                    )}
                    <div className="instance-actions">
                      {retryAvailable(instance.id) && (
                        <button
                          className="primary"
                          disabled={
                            !!retry ||
                            !!busy ||
                            !retryStateReady ||
                            activeJob(instance.id)
                          }
                          onClick={() => generateRetry(instance)}
                        >
                          <ArrowClockwise />
                          {busy === instance.id
                            ? "检查重试范围中…"
                            : "生成重试计划"}
                        </button>
                      )}
                      <button
                        className="secondary"
                        disabled={!!busy}
                        onClick={() => action(instance, "start")}
                      >
                        <Play />
                        启动
                      </button>
                      <button
                        className="secondary"
                        disabled={!!busy}
                        onClick={() => action(instance, "stop")}
                      >
                        <Stop />
                        停止
                      </button>
                      {safeAppUrl(instance.accessUrl) && (
                        <ExternalLink
                          className="secondary"
                          href={safeAppUrl(instance.accessUrl)!}
                        >
                          <ArrowSquareOut />
                          打开应用
                        </ExternalLink>
                      )}
                      {safeAppUrl(
                        instance.nativeIntegration?.configUrl ||
                          instance.accessUrl,
                      ) && (
                        <ExternalLink
                          className="secondary"
                          href={safeAppUrl(
                            instance.nativeIntegration?.configUrl ||
                              instance.accessUrl,
                          )!}
                        >
                          首次配置
                        </ExternalLink>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </div>
        )}
        {tab === "jobs" && (
          <div className="padded-module">
            <h1>安装任务</h1>
            <p className="muted">任务在服务端运行，关闭窗口不会中断安装。</p>
            <Status
              loading={jobs.loading}
              error={jobs.error}
              connected={!!session}
              disconnected={{ title: "请先登录商店管理员", detail: embedded ? "确认信任绑定后可使用 NAS 管理员授权，或使用独立商店账号登录，以查看安装任务和已安装应用。" : "商店会话独立于 NAS，登录后可查看安装任务和已安装应用。" }}
              empty={!!session && jobs.data?.items.length === 0}
              retry={jobs.reload}
            />
            <div className="job-list">
              {jobs.data?.items.map((job) => (
                <article key={job.id}>
                  <Cube size={30} />
                  <div>
                    <strong>
                      {applicationName(
                        instances.data?.items.find(
                          (instance) => instance.id === job.instanceId,
                        )?.appId ||
                          job.appId ||
                          pendingInitialization.find(
                            (item) => item.jobId === job.id,
                          )?.appId,
                      )}
                    </strong>
                    <p>
                      {jobStageLabel(job.stage)} · {jobStatusLabel(job.status)}
                    </p>
                    <details>
                      <summary>任务详情</summary>
                      <dl className="data-values">
                        <div>
                          <dt>任务标识</dt>
                          <dd>{job.id}</dd>
                        </div>
                        <div>
                          <dt>实例标识</dt>
                          <dd>{job.instanceId}</dd>
                        </div>
                        <div>
                          <dt>原始阶段 / 状态</dt>
                          <dd>
                            {job.stage} / {job.status}
                          </dd>
                        </div>
                      </dl>
                    </details>
                    {job.error && (
                      <p role="alert" className="error-text">
                        {job.error}
                      </p>
                    )}
                  </div>
                  <span className="tag">{jobStatusLabel(job.status)}</span>
                </article>
              ))}
            </div>
          </div>
        )}
        </div>
      </div>
      {selected && (
        <InstallWizard
          app={selected}
          authenticated={!!session}
          onLogin={() => {
            setSelected(undefined);
            setAuth(true);
          }}
          onClose={() => setSelected(undefined)}
          onInstalled={(job) =>
            installationSubmitted(job, selected.id, selected.name)
          }
        />
      )}
      {retry && (
        <RetryReview
          plan={retry.plan}
          instance={retry.instance}
          appName={applicationName(retry.instance.appId)}
          blocked={
            !retryAvailable(retry.instance.id) ||
            jobs.data?.items.find((job) => job.instanceId === retry.instance.id)?.id !==
              retry.plan.retryOfJobId ||
            (!!retry.plan.previousImage &&
              !instances.data?.items.some(
                (instance) =>
                  instance.id === retry.instance.id &&
                  supportsRetrySource(instance),
              ))
          }
          active={activeJob(retry.instance.id)}
          onClose={() => {
            setRetry(undefined);
            setRetrySources({});
          }}
          onInstalled={(job) =>
            installationSubmitted(
              job,
              retry.instance.appId,
              applicationName(retry.instance.appId),
            )
          }
        />
      )}
      {initializationPrompt && (
        <InitializationDialog
          prompt={initializationPrompt}
          onClose={() => setInitializationPrompt(undefined)}
        />
      )}
    </div>
  );
}
function InitializationDialog({
  prompt,
  onClose,
}: {
  prompt: InitializationPrompt;
  onClose: () => void;
}) {
  const [showInstructions, setShowInstructions] = useState(false);
  const accessUrl = safeAppUrl(prompt.instance.accessUrl)!;
  const officialUrl = safeAppUrl(prompt.instance.nativeIntegration?.configUrl);
  const integration = prompt.instance.nativeIntegration;
  return (
    <div className="wizard-backdrop initialization-backdrop">
      <section
        className="install-wizard initialization-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${prompt.appName} 已就绪`}
      >
        <header>
          <h2>{prompt.appName} 已就绪</h2>
          <button className="secondary" onClick={onClose}>
            稍后配置
          </button>
        </header>
        <div className="wizard-body">
          <div className="initialization-ready">
            <ShieldCheck weight="duotone" />
            <div>
              <h3>安装完成，应用运行健康</h3>
              <p>接下来完成应用自己的首次设置。</p>
            </div>
          </div>
          <dl className="data-values">
            <div>
              <dt>应用地址</dt>
              <dd>{accessUrl}</dd>
            </div>
            <div>
              <dt>初始化状态</dt>
              <dd>{prompt.instance.initialization || "待确认"}</dd>
            </div>
          </dl>
          <ExternalLink
            className="primary initialization-open"
            href={accessUrl}
          >
            打开应用初始化
            <ArrowSquareOut />
          </ExternalLink>
          <p className="hint">
            点击后在独立页面打开。完成应用设置后，可从桌面入口或“已安装”继续访问。
          </p>
          <section className="initialization-handoff">
            <h3>官方远程与桌面入口</h3>
            <p>接入状态：{integration?.status || "unknown"}</p>
            <p>
              {integration?.reason ||
                "服务尚未确认官方入口配置能力，请保留手工配置。"}
            </p>
            {officialUrl ? (
              <ExternalLink className="secondary" href={officialUrl}>
                配置官方远程 / 桌面入口
                <ArrowSquareOut />
              </ExternalLink>
            ) : (
              <>
                <button
                  className="secondary"
                  onClick={() => setShowInstructions((value) => !value)}
                >
                  {showInstructions
                    ? "收起官方入口配置说明"
                    : "查看官方入口配置说明"}
                </button>
                {showInstructions && (
                  <p className="hint">
                    官方配置页面地址尚未确认。请在 NAS
                    官方界面的应用入口设置中手动添加上方应用地址；容器健康不代表官方远程或桌面入口已配置。
                  </p>
                )}
              </>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}
export function safeAppUrl(value: unknown) {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    )
      return url.href;
  } catch {
    return;
  }
}
function StoreAuth({
  configured,
  nasOnly = false,
  embedded = false,
  setupRequiresLoopback = true,
  onReload,
  onDone,
  onLogout,
}: {
  configured?: boolean;
  nasOnly?: boolean;
  embedded?: boolean;
  setupRequiresLoopback?: boolean;
  onReload: () => void;
  onDone: () => void;
  onLogout: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [setupDone, setSetupDone] = useState(false);
  const setup = configured === false && !setupDone;
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (setup) {
        await api.store("setup", { username, password }, true);
        setSetupDone(true);
      }
      const data = await api.store<{ sessionId: string }>(
        "login",
        { username, password },
        true,
      );
      if (!data.sessionId) throw new Error("商店登录响应缺少会话");
      api.storeSession = data.sessionId;
      setPassword("");
      onDone();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  if (nasOnly) return <div className="store-auth"><p>此商店沿用 NAS 管理员身份。请在客户端登录 NAS 后，从“空间商店”入口连接。</p></div>;
  if (setup && embedded) return <div className="auth-box"><h3>首次使用空间商店</h3><p>请先直接打开独立商店页面创建管理员，再回到这里登录。独立商店地址请查看部署配置。</p><button className="secondary" onClick={onReload}>已创建管理员，重新读取</button></div>;
  if (api.storeSession)
    return (
      <div className="auth-box">
        <ShieldCheck />
        <p>{api.storeAuthSource === "nas" ? "已通过当前 NAS 管理员授权；切换或退出 NAS 后需重新验证。" : "商店会话独立于 NAS 会话，仅保存在当前应用内存。"}</p>
        <button className="secondary" onClick={onLogout}>
          退出商店账号
        </button>
      </div>
    );
  return (
    <form className="auth-box" onSubmit={submit}>
      <div>
        <h3>{setup ? "创建商店管理员" : "商店管理员登录"}</h3>
        <p>
          {setup
            ? (setupRequiresLoopback ? "通过服务主机本地连接或 SSH 转发设置。创建后自动登录。" : "首次使用，请在当前页面创建自己的商店管理员账号。")
            : "使用商店账号授权安装与实例管理。"}
        </p>
      </div>
      <label>
        管理员账号
        <input
          required
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </label>
      <label>
        密码
        <input
          required
          minLength={setup ? 12 : 1}
          type="password"
          autoComplete={setup ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <button className="primary" disabled={busy || configured === undefined}>
        {busy ? "正在验证…" : setup ? "创建并登录" : "登录商店"}
      </button>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
function InstallWizard({
  app,
  authenticated,
  onLogin,
  onClose,
  onInstalled,
}: {
  app: StoreApp;
  authenticated: boolean;
  onLogin: () => void;
  onClose: () => void;
  onInstalled: (job: { id: string; instanceId: string }) => void;
}) {
  const [step, setStep] = useState(0);
  const [rootId, setRootId] = useState("");
  const [storageSafe, setStorageSafe] = useState(false);
  const [directory, setDirectory] = useState(app.id);
  const [hostPort, setHostPort] = useState(app.defaultPort);
  const [mediaPath, setMediaPath] = useState("");
  const [mediaRootId, setMediaRootId] = useState("");
  const [plan, setPlan] = useState<Plan>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const roots = useResource(
    () =>
      authenticated
        ? api.store<{ items: Root[] }>("roots")
        : Promise.resolve({ items: [] }),
    [authenticated],
  );
  useEffect(() => {
    if (!rootId) {
      const first = roots.data?.items.find(
        (r) => r.roles.includes("data") && allowedStorage(r.storage),
      );
      if (first) setRootId(first.id);
    }
  }, [roots.data]);
  async function makePlan() {
    if (
      !storageSafe ||
      !allowedStorage(
        roots.data?.items.find((r) => r.id === rootId)?.storage,
      ) ||
      (app.requiresMedia &&
        !mediaPathAllowed(
          roots.data?.items.find((r) => r.id === mediaRootId),
          mediaPath,
        ))
    ) {
      setError(
        "请先选择通过检查的数据目录和必需的媒体目录，并确认 Docker 位于安全数据盘。",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const generated = await api.store<Plan>("plans", {
        appId: app.id,
        rootId,
        directory,
        hostPort: Number(hostPort),
        ...(app.requiresMedia ? { mediaRootId, mediaPath } : {}),
      });
      if (!generated.id) throw new Error("服务端未返回安装计划");
      setPlan(generated);
      setStep(3);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const steps = ["应用详情", "存储目录", "端口与检查", "确认安装"];
  return (
    <div className="wizard-backdrop">
      <section
        className="install-wizard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wizard-title"
      >
        <header>
          <h2 id="wizard-title">安装 {app.name}</h2>
          <button className="secondary" onClick={onClose} disabled={busy}>
            关闭
          </button>
        </header>
        <ol className="wizard-steps">
          {steps.map((label, index) => (
            <li
              key={label}
              className={index === step ? "active" : index < step ? "done" : ""}
            >
              <span>{index < step ? <Check /> : index + 1}</span>
              {label}
            </li>
          ))}
        </ol>
        {step !== 3 && (
          <div className="wizard-body">
            {step === 0 && (
              <>
                <div className="app-detail">
                  <span className="store-app-icon">
                    <AppArtwork appId={app.id} icon={app.icon} />
                  </span>
                  <div>
                    <h1>{app.name}</h1>
                    <p>
                      {categoryLabel(app.category)} · {app.version}
                    </p>
                  </div>
                </div>
                <p>{app.description}</p>
                <dl className="data-values">
                  <div>
                    <dt>容器镜像</dt>
                    <dd>{app.image}</dd>
                  </div>
                  <div>
                    <dt>配方状态</dt>
                    <dd>{app.recipeStatus || "待验证"}</dd>
                  </div>
                  <div>
                    <dt>安装能力</dt>
                    <dd>{app.installable ? "可安装" : "暂未开放"}</dd>
                  </div>
                </dl>
                <p className="hint">
                  安装会创建独立的数据目录。媒体目录只读挂载，原有资料保留。
                </p>
                {!authenticated && (
                  <div className="notice">
                    登录商店管理员后才能生成安装计划。
                  </div>
                )}
              </>
            )}
            {step === 1 && (
              <>
                <Status {...roots} retry={roots.reload} />
                <StoragePicker
                  roots={roots.data?.items || []}
                  rootId={rootId}
                  onSelect={(id) => {
                    setRootId(id);
                    setPlan(undefined);
                  }}
                  onRegistered={roots.reload}
                  onSafety={setStorageSafe}
                />
                <label className="field">
                  新实例目录名
                  <input
                    value={directory}
                    pattern="[A-Za-z0-9_-]+"
                    onChange={(e) => {
                      setDirectory(e.target.value);
                      setPlan(undefined);
                    }}
                  />
                  <small>
                    仅英文、数字、下划线或短横线；服务端检查目录是否已存在。
                  </small>
                </label>
                {app.requiresMedia && (
                  <MediaRootPicker
                    roots={roots.data?.items || []}
                    rootId={mediaRootId}
                    mediaPath={mediaPath}
                    onChange={(id, path) => {
                      setMediaRootId(id);
                      setMediaPath(path);
                      setPlan(undefined);
                    }}
                    onRegistered={roots.reload}
                  />
                )}
              </>
            )}
            {step === 2 && (
              <>
                <h3>访问端口与安装检查</h3>
                <label className="field">
                  应用访问端口
                  <input
                    type="number"
                    min={1024}
                    max={65535}
                    value={hostPort}
                    onChange={(e) => setHostPort(Number(e.target.value))}
                  />
                </label>
                <div className="check-list">
                  <p>
                    <FolderOpen />
                    应用数据写入新目录
                  </p>
                  <p>
                    <ShieldCheck />
                    媒体只读挂载
                  </p>
                  <p>
                    <Cube />
                    镜像、端口和目录由服务端检查
                  </p>
                </div>
                <p className="hint">
                  点击生成安装计划不会执行安装。下一步会展示最终路径、镜像与访问地址。
                </p>
              </>
            )}
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
        {step === 3 && plan && (
          <PlanReview
            key={plan.id}
            plan={plan}
            onInstalled={onInstalled}
            onBusyChange={setBusy}
            secondaryAction={
              <button
                className="secondary"
                disabled={busy}
                onClick={() => setStep(2)}
              >
                <ArrowLeft />
                上一步
              </button>
            }
          />
        )}
        {step !== 3 && (
          <footer>
            <button
              className="secondary"
              disabled={step === 0 || busy}
              onClick={() => {
                setStep(step - 1);
              }}
            >
              <ArrowLeft />
              上一步
            </button>
            {!authenticated ? (
              <button className="primary" onClick={onLogin}>
                登录管理员
              </button>
            ) : step < 2 ? (
              <button
                className="primary"
                disabled={
                  !app.installable ||
                  (step === 1 &&
                    (!rootId ||
                      !storageSafe ||
                      !allowedStorage(
                        roots.data?.items.find((r) => r.id === rootId)?.storage,
                      ) ||
                      (app.requiresMedia &&
                        !mediaPathAllowed(
                          roots.data?.items.find((r) => r.id === mediaRootId),
                          mediaPath,
                        )) ||
                      !/^[A-Za-z0-9_-]+$/.test(directory)))
                }
                onClick={() => setStep(step + 1)}
              >
                下一步
                <ArrowRight />
              </button>
            ) : step === 2 ? (
              <button
                className="primary"
                disabled={
                  busy ||
                  !storageSafe ||
                  (app.requiresMedia &&
                    !mediaPathAllowed(
                      roots.data?.items.find((r) => r.id === mediaRootId),
                      mediaPath,
                    )) ||
                  hostPort < 1024 ||
                  hostPort > 65535
                }
                onClick={makePlan}
              >
                {busy ? "检查中…" : "生成安装计划"}
                <ArrowRight />
              </button>
            ) : null}
          </footer>
        )}
      </section>
    </div>
  );
}

function RetryReview({
  plan,
  instance,
  appName,
  blocked,
  active,
  onClose,
  onInstalled,
}: {
  plan: Plan;
  instance: Instance;
  appName: string;
  blocked: boolean;
  active: boolean;
  onClose: () => void;
  onInstalled: (job: { id: string; instanceId: string }) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="wizard-backdrop">
      <section
        className="install-wizard"
        role="dialog"
        aria-modal="true"
        aria-label={`重试 ${appName}`}
      >
        <header>
          <h2>重试 {appName}</h2>
          <button className="secondary" disabled={busy} onClick={onClose}>
            关闭
          </button>
        </header>
        <PlanReview
          key={plan.id}
          plan={plan}
          retryInstance={instance}
          blocked={blocked}
          active={active}
          onInstalled={onInstalled}
          onBusyChange={setBusy}
        />
      </section>
    </div>
  );
}
function PlanReview({
  plan,
  retryInstance,
  blocked = false,
  active = false,
  secondaryAction,
  onBusyChange,
  onInstalled,
}: {
  plan: Plan;
  retryInstance?: Instance;
  blocked?: boolean;
  active?: boolean;
  secondaryAction?: ReactNode;
  onBusyChange: (busy: boolean) => void;
  onInstalled: (job: { id: string; instanceId: string }) => void;
}) {
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [requestId] = useState(() => createId());
  const [scope] = useState(() => ({
    session: api.storeSession,
    address: api.storeAddress,
  }));
  const submitting = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const scopeCurrent = () =>
    alive.current &&
    !!scope.session &&
    scope.session === api.storeSession &&
    scope.address === api.storeAddress;
  async function install() {
    if (!reviewed || blocked || submitting.current || !scopeCurrent()) return;
    submitting.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      const job = await confirmInstallation(api, plan, plan.id, requestId);
      if (!scopeCurrent()) return;
      if (
        typeof job?.id !== "string" ||
        !job.id ||
        typeof job?.instanceId !== "string" ||
        !job.instanceId
      )
        throw new Error("安装任务已提交，但返回标识不完整，请在任务中心检查。");
      if (retryInstance && job.instanceId !== retryInstance.id)
        throw new Error("重试任务返回的实例不一致，请在任务中心检查。");
      onInstalled({ id: job.id, instanceId: job.instanceId });
    } catch (e) {
      if (scopeCurrent()) setError(message(e));
    } finally {
      submitting.current = false;
      if (alive.current) {
        setBusy(false);
        onBusyChange(false);
      }
    }
  }
  return (
    <>
      <div className="wizard-body">
        <h3>请核对服务端安装计划</h3>
        {retryInstance && (
          <p className="notice">
            重试保留原实例、应用数据目录与访问端口，原任务记录继续保留。
          </p>
        )}
        <dl className="data-values">
          <div>
            <dt>计划标识</dt>
            <dd>{plan.id}</dd>
          </div>
          {retryInstance && (
            <div>
              <dt>原实例标识</dt>
              <dd>{retryInstance.id}</dd>
            </div>
          )}
          {plan.containerName && (
            <div>
              <dt>容器名称</dt>
              <dd>{plan.containerName}</dd>
            </div>
          )}
          {plan.previousImage && (
            <div>
              <dt>原镜像</dt>
              <dd>{plan.previousImage}</dd>
            </div>
          )}
          <div>
            <dt>{plan.previousImage ? "重试镜像" : "镜像"}</dt>
            <dd>{plan.image}</dd>
          </div>
          <div>
            <dt>数据目录</dt>
            <dd>{plan.dataPath}</dd>
          </div>
          <div>
            <dt>存储根目录</dt>
            <dd>{plan.rootPath || "—"}</dd>
          </div>
          <div>
            <dt>数据盘标识</dt>
            <dd>{plan.storageIdentity || "—"}</dd>
          </div>
          <div>
            <dt>镜像盘标识</dt>
            <dd>{plan.dockerStorageIdentity || "—"}</dd>
          </div>
          <div>
            <dt>媒体目录</dt>
            <dd>{plan.mediaPath || "不挂载"}</dd>
          </div>
          {plan.mediaRootId && (
            <>
              <div>
                <dt>媒体根目录</dt>
                <dd>{plan.mediaRootPath || "—"}</dd>
              </div>
              <div>
                <dt>媒体盘标识</dt>
                <dd>{plan.mediaStorageIdentity || "—"}</dd>
              </div>
            </>
          )}
          <div>
            <dt>访问端口</dt>
            <dd>{plan.hostPort}</dd>
          </div>
          <div>
            <dt>访问地址</dt>
            <dd>{plan.accessUrl}</dd>
          </div>
          <div>
            <dt>过期时间</dt>
            <dd>{plan.expiresAt}</dd>
          </div>
        </dl>
        <details>
          <summary>查看挂载与原生接入计划</summary>
          <DataValues
            data={{
              mounts: plan.mounts,
              nativeIntegration: plan.nativeIntegration,
            }}
          />
        </details>
        <label className="check-field">
          <input
            type="checkbox"
            checked={reviewed}
            onChange={(e) => setReviewed(e.target.checked)}
          />
          {retryInstance
            ? "我已核对以上计划，确认保留原实例与数据进行重试"
            : "我已核对以上计划，确认创建独立应用实例"}
        </label>

        {active && (
          <p className="notice">
            此实例已有活动安装任务，请等待任务结束后再重试。
          </p>
        )}
        {blocked && !active && (
          <p className="hint">正在核对实例与安装任务状态，暂时无法提交。</p>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer>
        {secondaryAction || <span />}
        <button
          className="primary"
          disabled={busy || !reviewed || blocked}
          onClick={install}
        >
          {busy ? "提交中…" : "确认并开始安装"}
        </button>
      </footer>
    </>
  );
}
function jobStatusLabel(status: string) {
  return (
    (
      {
        queued: "排队中",
        running: "执行中",
        completed: "已完成",
        failed: "失败",
        needs_attention: "需处理",
        cancelled: "已取消",
      } as Record<string, string>
    )[status] || "未知状态"
  );
}
function jobStageLabel(stage: string) {
  return (
    (
      {
        queued: "等待执行",
        preflight: "安装预检",
        pull: "拉取镜像",
        start: "启动容器",
        health: "健康检查",
        initialization: "准备首次配置",
        "native-entry": "配置原生入口",
        completed: "安装完成",
        failed: "安装失败",
        needs_attention: "需要检查",
      } as Record<string, string>
    )[stage] || "等待任务状态"
  );
}
function instanceStateLabel(state: string) {
  return (
    (
      {
        running: "运行中",
        stopped: "已停止",
        exited: "已停止",
        missing: "容器缺失",
        ownership_mismatch: "容器归属不一致",
        path_identity_mismatch: "数据目录身份不一致",
        installing: "安装中",
        queued: "排队中",
        failed: "安装失败",
        needs_attention: "需处理",
      } as Record<string, string>
    )[state] || "未知"
  );
}
function healthLabel(health: string) {
  return (
    (
      {
        healthy: "健康",
        starting: "检查中",
        unhealthy: "异常",
        unknown: "待检查",
      } as Record<string, string>
    )[health] || "待检查"
  );
}

function categoryLabel(value: string) {
  return (
    (
      {
        media: "影音",
        reading: "阅读",
        tools: "工具",
        utility: "工具",
        music: "音乐",
        video: "影视",
        monitoring: "监控",
        photos: "相册",
        files: "文件",
        全部: "全部",
      } as Record<string, string>
    )[value] || value
  );
}
