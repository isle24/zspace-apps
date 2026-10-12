import display from "../catalog-display.json";
import { RuntimeDesktop, RuntimeLogs, RuntimeSnapshots } from "./RuntimeAssets";
import { useEffect, useRef, useState } from "react";
import { api, message } from "../api/client";
import { AppArtwork } from "./AppArtwork";
import { ExternalLink } from "./ExternalLink";
import { Search, Status, useResource } from "./common";
import { RuntimePlanReview } from "./RuntimePlanReview";
import { RuntimeInstall } from "./RuntimeInstall";
import { RuntimeJobs } from "./RuntimeJobs";
import { RuntimeInstanceDetails } from "./RuntimeInstanceDetails";
import { RuntimeSettings, RuntimeTheme } from "./RuntimeSettings";
import { CloudAccountPanel } from "./CloudAccountPanel";
import {trackCloudInstallHistory} from '../api/cloud-history';
import {
  initializationLabel,
  operationLabel,
  safeAppURL,
  type PlanRequest,
  type RuntimeApp,
  type RuntimeInstance,
  type RuntimeJob,
  type RuntimePlan,
} from "./runtime-types";
const tabs = [
  ["catalog", "发现应用"],
  ["cloud", "心愿与应用历史"],
  ["instances", "我的应用"],
  ["updates", "更新"],
  ["jobs", "任务中心"],
  ["snapshots", "备份与恢复"],
  ["desktop", "应用桌面"],
  ["settings", "设置"],
] as const;
type Catalog = { items: RuntimeApp[]; categories: { id: string; name: string }[] };
function reviewedUpgrade(instance: RuntimeInstance, app?: RuntimeApp): PlanRequest | undefined {
  // The catalog's availableVersions contains the current reviewed recipe and
  // its reviewed compatible source versions. upgradeAllowed describes latestVersion.
  if (instance.legacy || instance.archived || !app?.version || !instance.version ||
    instance.version === app.version || instance.ignoredVersion === app.version || !app.availableVersions?.includes(app.version) ||
    !app.availableVersions.includes(instance.version)) return;
  return { kind: "update", instanceId: instance.id, targetVersion: app.version };
}
function SourceFacts({ app }: { app?: RuntimeApp }) {
  return <div className="runtime-source-facts">
    <p>最新已审查版本：{app?.version || "尚未读取"}</p>
    <p>上游发现版本：{app?.latestVersion || "尚未检查"}</p>
    <p>上游版本审核：{app?.upgradeAllowed === false ? "待审查，不能生成该上游版本的更新计划" : app?.upgradeAllowed === true ? "已审查" : "尚未返回审核结果"}</p>
    <p>来源检查：{app?.sourceStatus === "ok" ? "成功" : app?.sourceStatus === "error" ? "失败" : "尚未完成"} · 检查时间：{app?.checkedAt || "尚未检查"}</p>
    {app?.sourceError && <p className="inline-error">{app.sourceError}</p>}
  </div>;
}
export function RuntimeStore({ refreshKey = 0 }: { refreshKey?: number }) {
  const [tab, setTab] = useState<string>("catalog"),
    [revision, setRevision] = useState(0),
    [detail, setDetail] = useState<RuntimeApp>(),
    [install, setInstall] = useState<RuntimeApp>(),
    [plans, setPlans] = useState<RuntimePlan[]>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [category, setCategory] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [checkedCatalog, setCheckedCatalog] = useState<Catalog>(),
    [checkStatus, setCheckStatus] = useState("");
  const [scope, setScope] = useState(() => ({
    session: api.storeSession,
    address: api.storeAddress,
    generation: 0,
  }));
  const generation = useRef(0),
    alive = useRef(true),
    pending = useRef(false),
    checkController = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    alive.current = true;
    const change = () => {
      checkController.current?.abort();
      generation.current++;
      pending.current = false;
      setScope((previous) => ({
        session: api.storeSession,
        address: api.storeAddress,
        generation: previous.generation + 1,
      }));
      setPlans(undefined);
      setDetail(undefined);
      setInstall(undefined);
      setSelected([]);
      setBusy(false);
      setError("");
      setCheckStatus("");
      setCheckedCatalog(undefined);
    };
    window.addEventListener("space-store-session", change);
    window.addEventListener("space-store-address", change);
    return () => {
      alive.current = false;
      generation.current++;
      checkController.current?.abort();
      window.removeEventListener("space-store-session", change);
      window.removeEventListener("space-store-address", change);
    };
  }, []);
  const catalog = useResource(
    () =>
      scope.session
        ? api.store<Catalog>("v2/catalog")
        : Promise.resolve({ items: [], categories: [] }),
    [scope, revision],
  );
  useEffect(() => setCheckedCatalog(undefined), [scope, revision]);
  const catalogData = checkedCatalog || catalog.data;
  const appFor = (instance: RuntimeInstance) => catalogData?.items.find(app => app.id === instance.appId);
  const updateFor = (instance: RuntimeInstance) => reviewedUpgrade(instance, appFor(instance));
  const ignoreVersionFor = (instance: RuntimeInstance) => appFor(instance)?.latestVersion || appFor(instance)?.version;
  const instances = useResource(
    () =>
      scope.session
        ? api.store<{ items: RuntimeInstance[] }>("v2/instances")
        : Promise.resolve({ items: [] }),
    [scope, revision],
  );
  const lastRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (lastRefreshKey.current === refreshKey) return;
    lastRefreshKey.current = refreshKey;
    if (checkController.current) {
      checkController.current.abort();
      pending.current = false;
      setBusy(false);
      setCheckStatus("已停止等待本次版本检查，正在重新读取商店数据。");
    }
    setCheckedCatalog(undefined);
    catalog.reload();
    instances.reload();
  }, [refreshKey]);
  const current = (id: number) =>
    alive.current &&
    id === generation.current &&
    scope.session === api.storeSession &&
    scope.address === api.storeAddress;
  async function generate(requests: PlanRequest[]) {
    if (pending.current || !scope.session) return;
    const boundRequests: PlanRequest[] = [];
    for (const request of requests) {
      if (request.kind !== "update") { boundRequests.push(request); continue; }
      const instance = instances.data?.items.find(item => item.id === request.instanceId);
      const reviewed = instance && updateFor(instance);
      if (!reviewed || (request.targetVersion && request.targetVersion !== reviewed.targetVersion)) {
        setError("没有可确认的已审查升级路径，请重新读取应用目录；未审查上游版本不能更新");
        return;
      }
      boundRequests.push(reviewed);
    }
    if (!boundRequests.length) return;
    pending.current = true;
    const id = ++generation.current;
    setBusy(true);
    setError("");
    setPlans(undefined);
    try {
      const result: RuntimePlan[] = [];
      for (const request of boundRequests) {
        const plan = await api.store<RuntimePlan>("v2/plans", request);
        if (!current(id)) return;
        if (
          !plan.id ||
          plan.kind !== request.kind ||
          (request.instanceId && plan.instanceId !== request.instanceId) ||
          (request.appId && plan.appId !== request.appId) ||
          (request.targetVersion &&
            plan.targetVersion !== request.targetVersion)
        )
          throw new Error("服务端计划与所选应用、实例或版本不一致");
        result.push(plan);
      }
      if (current(id)) {
        setInstall(undefined);
        setPlans(result);
      }
    } catch (e) {
      if (current(id)) setError(message(e));
    } finally {
      if (current(id)) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  async function retry(job: RuntimeJob) {
    if (
      pending.current || busy || !scope.session || job.status !== "failed" ||
      !job.id || !job.planId || !job.appId || !job.instanceId || !job.kind ||
      !Object.hasOwn(operationLabel, job.kind)
    ) return;
    pending.current = true;
    const id = ++generation.current;
    setBusy(true);
    setError("");
    setPlans(undefined);
    try {
      const plan = await api.store<RuntimePlan>(
        `v2/jobs/${encodeURIComponent(job.id)}/retry-plan`,
        {},
      );
      if (!current(id)) return;
      if (
        !plan?.id || plan.id === job.planId ||
        plan.retryOfJobId !== job.id || plan.retryOfPlanId !== job.planId ||
        plan.kind !== job.kind || plan.appId !== job.appId ||
        !plan.instanceId || (job.kind === "install"
          ? plan.instanceId === job.instanceId
          : plan.instanceId !== job.instanceId)
      )
        throw new Error("服务端重试计划与所选失败任务、计划、应用或实例不一致");
      setInstall(undefined);
      setPlans([plan]);
    } catch (e) {
      if (current(id)) setError(message(e));
    } finally {
      if (current(id)) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  async function refresh() {
    if (busy || pending.current || !scope.session || !catalogData?.items.length) return;
    const baseline = new Map(catalogData.items.map(app => [app.id, app.checkedAt]));
    const id = ++generation.current;
    const controller = new AbortController();
    checkController.current = controller;
    const checking = () => current(id) && !controller.signal.aborted;
    pending.current = true;
    setBusy(true);
    setError("");
    setCheckStatus("正在请求版本检查…");
    const timeout = setTimeout(() => {
      if (!checking()) return;
      setCheckStatus("版本检查超时，尚未取得全部应用的新结果，请稍后重新检查。");
      pending.current = false;
      setBusy(false);
      controller.abort();
    }, 120000);
    controller.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });
    try {
      const queued = await api.store<{ status: string }>("v2/catalog/refresh", {});
      if (!checking()) return;
      if (queued.status !== "queued") throw new Error("服务端未确认版本检查已排队");
      setCheckStatus("版本检查已排队，等待来源检查结果…");
      while (checking()) {
        const result = await api.store<Catalog>("v2/catalog");
        if (!checking()) return;
        setCheckedCatalog(result);
        const completed = [...baseline.keys()].flatMap(appId => {
          const app = result.items.find(item => item.id === appId);
          return app?.checkedAt && app.checkedAt !== baseline.get(appId) &&
            ["ok", "error"].includes(app.sourceStatus || "") ? [app] : [];
        });
        if (completed.length === baseline.size) {
          const failed = completed.filter(app => app.sourceStatus === "error").length;
          setCheckStatus(failed ? `版本检查完成：${failed} 个来源失败，请查看各应用的来源错误。` : "版本检查完成，所有应用来源检查成功。");
          instances.reload();
          return;
        }
        setCheckStatus(`版本检查中：${completed.length} / ${baseline.size} 个应用已返回新结果。`);
        // Await the preceding read before scheduling another; cancellation also
        // resolves this delay so changing scope never leaves a polling loop alive.
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", finish); resolve(); };
          const timer = setTimeout(finish, 2000);
          controller.signal.addEventListener("abort", finish, { once: true });
        });
      }
    } catch (e) {
      if (checking()) {
        setError(message(e));
        setCheckStatus("版本检查失败，请重新检查。");
      }
    } finally {
      clearTimeout(timeout);
      if (checking()) { pending.current = false; setBusy(false); }
      if (checkController.current === controller) checkController.current = undefined;
    }
  }
  const listed = (catalogData?.items || []).map(app=>{
   const presentation=(display as Record<string,{description:string;documentation:string}>)[app.id];return presentation?{...app,...presentation}:app;
  }).filter(
    (app) =>
      (!category || app.category === category) &&
      `${app.name} ${app.description}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const instanceItems = instances.data?.items || [],
    updates = instanceItems.filter(
      (item) => !item.archived && !item.legacy && (updateFor(item) || item.updateAvailable),
    ),
    selectedUpdates = updates.filter(item => selected.includes(item.id) && updateFor(item));
  const activeTab = (value: string) => {
    setTab(value);
    setError("");
    setSelected([]);
    if (value === "instances" || value === "updates") instances.reload();
  };
  if (!scope.session) return <p>请先登录商店管理员</p>;
  return (
    <div className="runtime-store">
      <RuntimeTheme key={scope.generation} />
      <nav className="runtime-tabs" aria-label="完整应用管理">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            className={tab === key ? "active" : ""}
            onClick={() => activeTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {checkStatus && <p role="status">{checkStatus}</p>}
      {tab === "cloud" && <CloudAccountPanel onCuratedInstall={id=>{const app=catalogData?.items.find(item=>item.id===id);if(app)setInstall(app);else setError('当前 NAS 尚未提供此应用的安装配方，请刷新目录')}}/>}
      {tab === "catalog" && (
        <section>
          <div className="runtime-heading">
            <div>
              <h2>发现应用</h2>
              <p>经过审查的应用配方，为你的空间增添可能</p>
            </div>
            <button disabled={busy || !catalogData?.items.length} onClick={refresh}>
              {busy ? "检查中…" : "检查官方版本"}
            </button>
          </div>
          <Search
            value={query}
            onChange={setQuery}
            placeholder="搜索完整应用目录"
          />
          <div className="chips">
            <button
              className={!category ? "active" : ""}
              onClick={() => setCategory("")}
            >
              全部应用
            </button>
            {catalogData?.categories?.map((item) => (
              <button
                className={category === item.id ? "active" : ""}
                key={item.id}
                onClick={() => setCategory(item.id)}
              >
                {item.name}
              </button>
            ))}
          </div>
          <Status
            {...catalog}
            retry={catalog.reload}
            empty={!!catalog.data && !listed.length}
          />
          <div className="runtime-grid">
            {listed.map((app) => (
              <article className="runtime-card" key={app.id}>
                <span className="store-app-icon">
                  <AppArtwork appId={app.id} icon={app.icon} />
                </span>
                <h3>{app.name}</h3>
                <p>{app.description}</p>
                <small>
                  {app.version} · {app.recipeRevision || "配方版本待返回"}
                </small>
                <SourceFacts app={app} />
                <div className="runtime-actions">
                  <button
                    aria-label={`查看 ${app.name}`}
                    onClick={() => setDetail(app)}
                  >
                    详情
                  </button>
                  <button
                    className="primary"
                    disabled={!app.installable || busy}
                    onClick={() => setInstall(app)}
                  >
                    {app.installable ? "安装" : "请在 NAS 商店安装"}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
      {(tab === "instances" || tab === "updates") && (
        <section>
          <h2>{tab === "updates" ? "应用更新" : "我的应用"}</h2>
          <button
            disabled={busy}
            onClick={async () => {
              const id = ++generation.current;
              setBusy(true);
              try {
                await api.store("v2/instances/reconcile", {});
                if (current(id)) setRevision((n) => n + 1);
              } catch (e) {
                if (current(id)) setError(message(e));
              } finally {
                if (current(id)) setBusy(false);
              }
            }}
          >
            核对运行状态
          </button>
          <Status
            {...instances}
            retry={instances.reload}
            empty={
              !!instances.data &&
              !(tab === "updates" ? updates : instanceItems).length
            }
          />
          {tab === "updates" && updates.length > 0 && (
            <div className="runtime-batch">
              <button
                disabled={busy}
                onClick={() => setSelected(updates.filter(item => updateFor(item)).map((item) => item.id))}
              >
                全选可更新应用
              </button>
              <button
                className="primary"
                disabled={!selectedUpdates.length || busy}
                onClick={() =>
                  void generate(
                    selectedUpdates
                      .map((item) => updateFor(item))
                      .filter((request): request is PlanRequest => !!request),
                  )
                }
              >
                生成批量更新计划（{selectedUpdates.length}）
              </button>
            </div>
          )}
          {(tab === "updates" ? updates : instanceItems).map((instance) => (
            <article className="runtime-card" key={instance.id}>
              {tab === "updates" && (
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={!!updateFor(instance) && selected.includes(instance.id)}
                    disabled={busy || !updateFor(instance)}
                    onChange={(e) =>
                      setSelected((list) =>
                        e.target.checked
                          ? [...list, instance.id]
                          : list.filter((id) => id !== instance.id),
                      )
                    }
                  />
                  选择 {instance.name || instance.appId}
                </label>
              )}
              <h3>{instance.name || instance.appId}</h3>
              <p>
                已安装版本：{instance.version || "未返回"} ·{" "}
                {instance.archived ? "已归档" : instance.state} · 健康检查：
                {instance.health || "待核对"}
              </p>
              <p>
                首次配置：
                {initializationLabel(instance.initialization)}
              </p>
              <small>{instance.dataPath}</small>
              {!instance.legacy && <>
                <SourceFacts app={appFor(instance)} />
                {instance.ignoredVersion && <p className="notice">{instance.ignoredVersion === appFor(instance)?.version
                  ? `已忽略已审查目标：${instance.ignoredVersion}${instance.ignoredVersion === appFor(instance)?.latestVersion ? "（也是当前上游版本）" : ""}`
                  : instance.ignoredVersion === appFor(instance)?.latestVersion
                    ? `已忽略上游版本：${instance.ignoredVersion}；其他已审查升级目标仍单独判断。`
                    : `已忽略版本：${instance.ignoredVersion}`}</p>}
                {(updateFor(instance) || instance.updateAvailable) && <p className="notice">{updateFor(instance)
                  ? `可更新到已审查版本 ${updateFor(instance)!.targetVersion}，下一步审核完整计划。`
                  : instance.ignoredVersion === appFor(instance)?.version
                    ? "已按版本选择忽略这个已审查升级目标。"
                    : appFor(instance)?.version === instance.version
                      ? "当前已是最新已审查版本；上游新版本须等待审查。"
                      : "尚未读取可确认的已审查升级路径，请重新读取目录。"}</p>}
              </>}
              {instance.legacy ? (
                <p className="notice">
                  旧版部署没有运行代次资料；原有应用记录保留，请在“原有应用”入口查看部署详情并管理。
                </p>
              ) : (
                <div className="runtime-actions">
                  {(tab === "updates"
                    ? ["update"]
                    : instance.archived
                      ? ["reactivate"]
                      : [
                          instance.state === "running" ? "stop" : "start",
                          "restart",
                          "backup",
                          "archive",
                          ...(updateFor(instance) || instance.updateAvailable ? ["update"] : []),
                        ]
                  ).map((kind) => (
                    <button
                      disabled={busy || (kind === "update" && !updateFor(instance))}
                      key={kind}
                      onClick={() =>
                        void generate([
                          {
                            kind: kind as PlanRequest["kind"],
                            instanceId: instance.id,
                          },
                        ])
                      }
                    >
                      生成{operationLabel[kind as PlanRequest["kind"]]}计划
                    </button>
                  ))}
                  {(updateFor(instance) || instance.updateAvailable) && ignoreVersionFor(instance) &&
                    instance.ignoredVersion !== ignoreVersionFor(instance) && (
                    <button
                      disabled={busy}
                      onClick={async () => {
                        const id = ++generation.current;
                        setBusy(true);
                        try {
                          const version = ignoreVersionFor(instance);
                          if (!version)
                            throw new Error(
                              "最新版本尚未读取，请先刷新应用目录",
                            );
                          await api.store(
                            `v2/instances/${encodeURIComponent(instance.id)}/ignore-update`,
                            { version },
                          );
                          if (current(id)) setRevision((n) => n + 1);
                        } catch (e) {
                          if (current(id)) setError(message(e));
                        } finally {
                          if (current(id)) setBusy(false);
                        }
                      }}
                    >
                      {appFor(instance)?.latestVersion ? "忽略上游版本" : "忽略已审查版本"} {ignoreVersionFor(instance)}
                    </button>
                  )}
                  <button onClick={() => setTab("snapshots")}>查看备份</button>
                  <RuntimeInstanceDetails key={`details-${scope.generation}`} instance={instance} />
                  <RuntimeLogs key={`logs-${scope.generation}`} instance={instance} />
                  {safeAppURL(instance.accessUrl) && !instance.archived && (
                    <ExternalLink href={safeAppURL(instance.accessUrl)}>
                      打开应用 / 首次配置
                    </ExternalLink>
                  )}
                </div>
              )}
            </article>
          ))}
        </section>
      )}
      {tab === "jobs" && (
        <RuntimeJobs
          key={`${scope.generation}-${revision}`}
          busy={busy}
          onRetry={(job) => void retry(job)}
          onInspect={() => activeTab("instances")}
        />
      )}
      {tab === "snapshots" && (
        <RuntimeSnapshots
          key={scope.generation}
          busy={busy}
          onPlan={(request) => void generate([request])}
        />
      )}
      {tab === "desktop" && (
        <RuntimeDesktop key={`${scope.generation}-${revision}`} />
      )}
      {tab === "settings" && <RuntimeSettings key={scope.generation} />}
      {detail && (
        <div className="wizard-backdrop">
          <section
            className="install-wizard"
            role="dialog"
            aria-modal="true"
            aria-label={`${detail.name} 详情`}
          >
            <header>
              <h2>{detail.name}</h2>
              <button onClick={() => setDetail(undefined)}>关闭详情</button>
            </header>
            <div className="wizard-body">
              <p>{detail.description}</p>
              <SourceFacts app={catalogData?.items.find(app => app.id === detail.id) || detail} />
              <p>架构：{detail.platforms?.join("、") || "服务端尚未返回"}</p>
              <p>
                版本：{detail.availableVersions?.join("、") || detail.version}
              </p>
              <dl className="data-values">
                <div>
                  <dt>许可证</dt>
                  <dd>{detail.license || "配方未提供"}</dd>
                </div>
                <div>
                  <dt>最低内存</dt>
                  <dd>
                    {typeof detail.minimumMemoryBytes === "number" &&
                    detail.minimumMemoryBytes > 0
                      ? `${detail.minimumMemoryBytes / 1073741824} GiB`
                      : "配方未声明最低要求"}
                  </dd>
                </div>
                {detail.migrationStrategy && (
                  <div>
                    <dt>数据迁移方式</dt>
                    <dd>{detail.migrationStrategy==="snapshot-copy-switch"?"先备份数据，再切换新版应用":detail.migrationStrategy}</dd>
                  </div>
                )}
              </dl>
              <h3>服务与依赖</h3>
              {detail.services?.map((service) => (
                <div key={service.id}>
                  <p>
                    {service.id} · 依赖：{service.dependsOn?.join("、") || "无"}{" "}
                    · {service.entry ? "对外入口" : "内部服务"}
                  </p>
                  <p>运行用户：{({host:"与 NAS 账号一致","host-env":"与 NAS 账号一致","image-default":"应用默认账号"} as Record<string,string>)[service.userMode||""] || "安装时确认"}</p>
                  {service.image && (
                    <p className="runtime-digest">
                      固定镜像来源：{service.image}
                    </p>
                  )}
                  {service.volumes?.map((volume) => (
                    <p key={`${volume.name}-${volume.target}`}>
                      {volume.name} · {volume.target} ·{" "}
                      {(
                        {
                          "media-readonly": "现有媒体，只读",
                          data: "独立应用数据，可写",
                          config: "独立配置，可写",
                          cache: "独立缓存，可写",
                          "sync-write": "新建专用同步目录，可写",
                        } as Record<string, string>
                      )[volume.role] || volume.role}
                    </p>
                  ))}
                </div>
              ))}
              {detail.sourceUrl && safeAppURL(detail.sourceUrl) && (
                <ExternalLink href={safeAppURL(detail.sourceUrl)}>
                  官方项目来源
                </ExternalLink>
              )}
              {detail.documentation && safeAppURL(detail.documentation) && <ExternalLink href={safeAppURL(detail.documentation)}>应用使用说明（GitHub）</ExternalLink>}
              <p className="hint">
                镜像摘要、发布者和实际端口在不可变操作计划中展示。
              </p>
            </div>
          </section>
        </div>
      )}
      {install && (
        <RuntimeInstall
          app={install}
          busy={busy}
          onClose={() => setInstall(undefined)}
          onPlan={(request) => void generate([request])}
        />
      )}{" "}
      {plans && (
        <RuntimePlanReview
          key={plans.map((plan) => plan.id).join(":")}
          plans={plans}
          onClose={() => setPlans(undefined)}
          onSubmitted={() => {
            trackCloudInstallHistory(plans);
            setPlans(undefined);
            setTab("jobs");
            setRevision((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
