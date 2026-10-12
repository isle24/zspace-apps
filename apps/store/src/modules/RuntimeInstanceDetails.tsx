import { useEffect, useState } from "react";
import { api } from "../api/client";
import { Status, useResource } from "./common";
import type { RuntimeGeneration, RuntimeInstance } from "./runtime-types";
import "./RuntimeInstanceDetails.css";

export function useInstanceGenerations(instance: RuntimeInstance) {
  const [scope] = useState(() => api.captureStoreScope());
  const [valid, setValid] = useState(() => !!api.storeSession);
  const current = () => {
    const now = api.captureStoreScope();
    return !!api.storeSession && now.generation === scope.generation && now.storeAddress === scope.storeAddress;
  };
  useEffect(() => {
    const changed = () => setValid(false);
    window.addEventListener("space-store-session", changed);
    window.addEventListener("space-store-address", changed);
    return () => {
      window.removeEventListener("space-store-session", changed);
      window.removeEventListener("space-store-address", changed);
    };
  }, []);
  const resource = useResource(async () => {
    if (!valid || !current()) return { items: [] as RuntimeGeneration[] };
    const result = await api.store<{ items: RuntimeGeneration[] }>("v2/generations");
    if (!current()) throw new Error("商店服务或会话已改变，请重新打开详情");
    return result;
  }, [instance.id, instance.appId, instance.activeGenerationId, valid]);
  const items = resource.data?.items.filter(g => g.instanceId === instance.id && g.appId === instance.appId) || [];
  return { resource, valid, current, items, active: items.find(g => g.id === instance.activeGenerationId) };
}

export function RuntimeInstanceDetails({ instance }: { instance: RuntimeInstance }) {
  const [open, setOpen] = useState(false);
  return <div className="runtime-instance-details">
    <button aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? "关闭代次详情" : "查看代次详情"}</button>
    {open && <GenerationDetails instance={instance} />}
  </div>;
}

function GenerationDetails({ instance }: { instance: RuntimeInstance }) {
  const { resource, valid, items, active } = useInstanceGenerations(instance);
  if (!valid) return <p className="notice">商店服务或会话已改变，请重新打开详情。</p>;
  return <section aria-label={`${instance.name || instance.appId} 的代次详情`}>
    <Status {...resource} retry={resource.reload} />
    {resource.data && !items.length && <p>尚无本实例的运行代次资料，请核对运行状态。</p>}
    {resource.data && !!items.length && !active && <p className="notice">当前代次记录尚未返回，请核对运行状态。</p>}
    {!!items.length && <p className="hint">以下为已记录的代次信息；暂无实时 CPU 和内存用量。</p>}
    {[...(active ? [active] : []), ...items.filter(g => g.id !== instance.activeGenerationId)].map(g =>
      <article key={g.id}>
        <h4>{g.id === instance.activeGenerationId ? "当前代次" : "保留代次"} {g.id}</h4>
        <p>版本：{g.version} · 配方：{g.recipeRevision} · 状态：{g.state}</p>
        <dl className="data-values">
          <div><dt>应用数据</dt><dd>{g.dataPath || "未返回"}</dd></div>
          <div><dt>存储根</dt><dd>{g.rootPath || "未返回"}</dd></div>
          {g.mediaPath && <div><dt>只读媒体</dt><dd>{g.mediaPath}</dd></div>}
          {g.networkId && <div><dt>专用网络</dt><dd>{g.networkId}</dd></div>}
        </dl>
        <p>应用访问端口：{g.hostPort || "未返回"} / TCP</p>
        {g.appId === "syncthing" && <>
          <p>同步端口：{g.peerPort || "未返回"} / TCP、UDP</p>
          <p>发现端口：{g.discoveryPort || "未返回"} / UDP</p>
        </>}
        <h5>声明服务与挂载</h5>
        {!g.recipe?.services?.length && <p>服务声明未返回。</p>}
        {g.recipe?.services?.map(service => <div key={service.id}>
          <p>{service.id} · {service.entry ? "对外入口" : "内部服务"} · 依赖：{service.dependsOn?.join("、") || "无"} · 用户：{service.userMode || "未返回"}</p>
          {!!service.containerPort && <p>容器端口：{service.containerPort} / TCP</p>}
          {service.volumes?.map(volume => {
            const readonly = ["media", "media-readonly"].includes(volume.role);
            const source = readonly ? g.mediaPath : g.dataPath ? `${g.dataPath.replace(/\/$/, "")}/${volume.name}` : undefined;
            return <p className="runtime-digest" key={`${volume.name}-${volume.target}`}>挂载：{source || "宿主路径未返回"} → {volume.target} · {readonly ? "只读" : "可写"} · {volume.role}</p>;
          })}
        </div>)}
        <h5>已记录容器</h5>
        {!g.containers?.length && <p>尚无容器记录。</p>}
        {g.containers?.map(container => <p className="runtime-digest" key={container.id}>{container.serviceId} · {container.name} · {container.id} · {container.state} · 镜像：{container.image}</p>)}
        <h5>固定镜像身份</h5>
        {!g.images?.length && <p>尚无镜像身份记录。</p>}
        {g.images?.map(image => <p className="runtime-digest" key={image.serviceId}>{image.serviceId} · {image.reference} · {image.digest} · {image.platform} · 发布者：{image.publisher} · 交付来源：{image.deliverySource}</p>)}
      </article>,
    )}
  </section>;
}
