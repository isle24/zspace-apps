import { useEffect, useRef, useState } from "react";
import { api, message } from "../api/client";
import { createId } from "../api/id";
import { operationLabel, safeAppURL, type RuntimePlan, type RuntimeJob } from "./runtime-types";
export function RuntimePlanReview({
  plans,
  onClose,
  onSubmitted,
  onJobSubmitted,
}: {
  plans: RuntimePlan[];
  onClose: () => void;
  onSubmitted: () => void;
  onJobSubmitted?: (job: RuntimeJob) => void;
}) {
  const [reviewed, setReviewed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [now, setNow] = useState(Date.now());
  const [scope] = useState(() => ({
      session: api.storeSession,
      address: api.storeAddress,
    })),
    [requestId] = useState(createId);
  const alive = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    alive.current = true;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, []);
  const current = () =>
    alive.current &&
    !!scope.session &&
    api.storeSession === scope.session &&
    api.storeAddress === scope.address;
  const expired = plans.some(
    (plan) =>
      !Number.isFinite(Date.parse(plan.expiresAt)) ||
      Date.parse(plan.expiresAt) <= now,
  );
  async function execute() {
    if (!reviewed || expired || pending.current || !current()) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const ids = plans.map((plan) => plan.id);
      if (ids.some((id) => !id) || new Set(ids).size !== ids.length)
        throw new Error("计划标识无效，请重新生成");
      const result = await api.store(
        plans.length > 1 ? "v2/batches" : "v2/execute",
        plans.length > 1
          ? { planIds: ids, requestId }
          : { planId: ids[0], requestId },
      );
      if (!current()) return;
      if (!result || !(result.id || result.items || result.jobs))
        throw new Error("已提交，但服务未返回完整任务标识，请在任务中心检查");
      if (result.id) onJobSubmitted?.(result as RuntimeJob);
      onSubmitted();
    } catch (e) {
      if (current()) setError(message(e));
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }
  return (
    <div className="wizard-backdrop">
      <section
        className="install-wizard runtime-review"
        role="dialog"
        aria-modal="true"
        aria-label="确认操作计划"
      >
        <header>
          <h2>{plans.length > 1 ? "批量操作确认" : "核对操作计划"}</h2>
          <button disabled={busy} onClick={onClose}>
            关闭计划
          </button>
        </header>
        <div className="wizard-body">
          {plans.map((plan) => (
            <article key={plan.id}>
              <h3>
                {plan.recipe.name || plan.appId} · {operationLabel[plan.kind]}
              </h3>
              {!!plan.secretParameterNames?.length && <p className="notice">私密配置已填写：{plan.secretParameterNames.join('、')}。仅在当前 NAS 保存和使用，计划中不显示具体值。</p>}
              <dl className="data-values">
                {Object.entries({
                  ...(plan.retryOfJobId ? {
                    失败任务: plan.retryOfJobId,
                    失败计划: plan.retryOfPlanId || "未提供",
                  } : {}),
                  计划标识: plan.id,
                  [plan.kind === "install" ? "新实例" : "原实例"]: plan.instanceId || "新实例",
                  旧版本: plan.sourceVersion || "不适用",
                  目标版本: plan.targetVersion,
                  原代次: plan.sourceGenerationId || "不适用",
                  新代次: plan.generationId || "由计划锁定",
                  计划停止范围:
                    plan.stopServices?.join("、") || "服务端未声明停止服务",
                  私有快照:
                    plan.snapshotId ||
                    (plan.snapshotRequired ? "执行时创建" : "不需要"),
                  恢复来源: plan.sourceSnapshotId || "不适用",
                  新数据副本: plan.newDataCopy
                    ? "是，保留原数据"
                    : "以计划目录为准",
                  数据目录: plan.dataPath,
                  数据根目录: plan.rootPath || "—",
                  快照根目录: plan.snapshotRootPath || "—",
                  只读媒体: plan.mediaPath || "不挂载",
                  访问端口: plan.hostPort,
                  访问地址: safeAppURL(plan.accessUrl || "") || "暂无安全地址",
                  同步端口: plan.peerPort || "不发布",
                  发现端口: plan.discoveryPort || "不发布",
                  计划有效期: plan.expiresAt,
                }).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{String(value)}</dd>
                  </div>
                ))}
              </dl>
              <h4>已核验的镜像来源</h4>
              {(plan.images || []).map((image) => (
                <dl className="data-values" key={image.serviceId}>
                  {Object.entries({
                    服务: image.serviceId,
                    发布者: image.publisher,
                    摘要: image.digest,
                    架构: image.platform,
                    来源: image.deliverySource,
                    固定镜像: image.reference,
                  }).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              ))}
              {plan.retryOfJobId && (
                <p className="notice">失败任务的数据、容器和记录均保留；本次使用新计划，请重新核对数据目录与执行范围。</p>
              )}
              <p className="hint">
                旧数据、容器与快照均保留。执行结果以任务记录和实际健康检查为准。
              </p>
            </article>
          ))}
          <label className="check-field">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(e) => setReviewed(e.target.checked)}
            />
            我已核对以上每个不可变计划，确认执行
          </label>
          {expired && <p role="alert">计划已过期，请关闭并重新生成。</p>}
          {error && <p role="alert">{error}</p>}
        </div>
        <footer>
          <span>{plans.length} 个计划</span>
          <button
            className="primary"
            disabled={!reviewed || busy || expired}
            onClick={execute}
          >
            {busy ? "提交中…" : "确认执行"}
          </button>
        </footer>
      </section>
    </div>
  );
}
