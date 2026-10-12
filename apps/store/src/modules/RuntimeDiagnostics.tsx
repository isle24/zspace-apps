import { api } from "../api/client";
import { Status, useResource } from "./common";
import type { StorageCandidate } from "./StoragePicker";
type Diagnostics = {
  storeId: string;
  engineMode: string;
  version: string;
  retention: string;
  runtimeSupported: boolean;
  facts?: {
    platform: string;
    dockerRoot: string;
    dockerVersion: string;
    composeVersion: string;
    userId: number;
    groupId: number;
    cpus: number;
    memoryBytes: number;
  };
  factsError?: string;
  source?: { policy: string; publishers: string[] };
  storage?: {
    dockerStorageSafe: boolean;
    dockerStorage: StorageCandidate | null;
    message: string;
  };
};
export function RuntimeDiagnostics() {
  const resource = useResource(
    () => api.store<Diagnostics>("v2/diagnostics"),
    [],
  );
  const data = resource.data;
  const engineLabels: Record<string, string> = {
    sshbind: "SSH 远程设备",
    local: "本机 Docker",
    disabled: "未启用",
  };
  const display = (value: unknown) =>
    value === undefined || value === null || value === ""
      ? "未提供"
      : String(value);
  return (
    <section
      className="runtime-card"
      aria-labelledby="runtime-diagnostics-title"
    >
      <h3 id="runtime-diagnostics-title">来源与运行诊断</h3>
      <Status {...resource} retry={resource.reload} />
      {data && (
        <>
          <dl className="data-values">
            {Object.entries({
              服务地址: api.storeAddress || "当前页面服务",
              商店标识: data.storeId,
              接口版本: data.version,
              部署执行方式: engineLabels[data.engineMode] || data.engineMode,
              运行接口能力:
                typeof data.runtimeSupported === "boolean"
                  ? data.runtimeSupported
                    ? "支持运行接口"
                    : "不支持运行接口"
                  : "未提供",
              镜像来源策略: data.source?.policy,
              已审查发布者: data.source?.publishers?.join("、"),
              资源保留策略:
                data.retention ===
                "all generations, snapshots and failed resources retained"
                  ? "保留全部代次、快照与失败资源"
                  : data.retention,
            }).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{display(value)}</dd>
              </div>
            ))}
          </dl>
          <p className="hint">
            接口能力仅表示服务支持；部署与应用健康仍需分别验收。
          </p>
          <h4>主机事实</h4>
          {data.factsError && <p role="alert">{data.factsError}</p>}
          {data.facts ? (
            <dl className="data-values">
              {Object.entries({
                平台: data.facts.platform,
                "Docker 目录": data.facts.dockerRoot,
                "Docker 版本": data.facts.dockerVersion,
                "Compose 版本": data.facts.composeVersion,
                "CPU 数量": data.facts.cpus,
                内存:
                  typeof data.facts.memoryBytes === "number"
                    ? `${data.facts.memoryBytes / 1073741824} GiB`
                    : undefined,
                "主机用户 ID": data.facts.userId,
                "主机组 ID": data.facts.groupId,
              }).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{display(value)}</dd>
                </div>
              ))}
            </dl>
          ) : (
            !data.factsError && <p>服务尚未提供主机事实。</p>
          )}
          <h4>Docker 存储检查</h4>
          {data.storage ? (
            <>
              <p>
                {data.storage.dockerStorageSafe === true
                  ? "通过安装存储检查"
                  : "未通过安装存储检查"}
              </p>
              <p>{data.storage.message || "服务未提供检查说明"}</p>
              {data.storage.dockerStorage && (
                <dl className="data-values">
                  <div>
                    <dt>镜像盘路径</dt>
                    <dd>{data.storage.dockerStorage.path}</dd>
                  </div>
                  <div>
                    <dt>镜像盘身份</dt>
                    <dd>{data.storage.dockerStorage.identity}</dd>
                  </div>
                </dl>
              )}
            </>
          ) : (
            <p>服务尚未提供存储检查结果。</p>
          )}
        </>
      )}
    </section>
  );
}
