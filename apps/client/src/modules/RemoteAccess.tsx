/*
 * 远程访问：极空间自己的中转服务（zrps）。
 *
 * 实测（2026-10-12，真机）：
 *   - nginx 把 /zrps/api/ 转到 127.0.0.1:22345（auth_master.lua 鉴权），服务在跑。
 *   - `GET /zrps/api/speed/query` 返回最近一次中转测速状态：
 *       { saddr: 180.119.170.156, ip: 171.222.188.41, isp: "ctcc", snode: "yz-cu-dev",
 *         finish: "true", direction: "" }
 *   - POST 同名接口返回空体；`/speed/progress` 返回 null。所以只读这里能拿到的。
 *
 * 说明：测速本身由官方 App 触发（会占带宽），这个窗口只显示最近一次结果，不擅自发起。
 */
import { Globe, ArrowsLeftRight, CheckCircle, XCircle, Question } from "@phosphor-icons/react";
import { asLooseText as asText, asNumber, asRecord } from "../modules/values";
import { Status, useResource } from "./common";
import { api, normalizeCollection } from "../api/client";

const text = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
};

/** 运营商代码 → 中文名（设备给的是 ctcc/cucc/cmcc 这类缩写） */
export function ispLabel(code?: string): string | undefined {
  if (!code) return undefined;
  const map: Record<string, string> = {
    ctcc: "中国电信",
    cucc: "中国联通",
    cmcc: "中国移动",
    cbn: "中国广电",
  };
  return map[code.toLowerCase()] || code;
}

/** 中转节点名 yz-cu-dev → 更可读的写法；不认识的照原样显示，不编地区 */
export function nodeLabel(node?: string): string | undefined {
  if (!node) return undefined;
  const match = /^([a-z]{2})-([a-z]{2})(?:-(dev|test|prod))?$/i.exec(node);
  if (!match) return node;
  const region: Record<string, string> = {
    yz: "扬州", bj: "北京", sh: "上海", gz: "广州", sz: "深圳", cd: "成都", hz: "杭州",
  };
  const isp: Record<string, string> = { cu: "联通", ct: "电信", cm: "移动" };
  const parts = [region[match[1].toLowerCase()], isp[match[2].toLowerCase()]].filter(Boolean);
  return parts.length ? parts.join(" · ") : node;
}

export type RemoteSpeed = {
  publicAddress?: string;
  clientAddress?: string;
  isp?: string;
  node?: string;
  finished?: boolean;
  direction?: string;
};

export function readSpeed(response: unknown): RemoteSpeed {
  const values = asRecord(asRecord(response)?.values) ?? asRecord(response);
  const data = asRecord(values?.data) ?? values ?? {};
  const finish = asText(data.finish);
  return {
    publicAddress: asText(data.saddr),
    clientAddress: asText(data.ip),
    isp: ispLabel(asText(data.isp)),
    node: nodeLabel(asText(data.snode)),
    finished: finish === undefined ? undefined : finish === "true" || finish === "1",
    direction: asText(data.direction),
  };
}

/**
 * 设备中转状态（原来的 RemoteView）。
 *
 * 这是我们自己抓到的**设备真实数据**（zrps 最近一次中转测速），
 * 但用户截图说明：极空间的「远程访问」主体是**入口列表**，不是这个。
 * 所以它退到入口列表下方一张折叠卡片里 —— 数据留着，不抢主位。
 */
export function RemoteRelayCard({ connected = true }: { connected?: boolean }) {
  return (
    <details className="remote-relay">
      <summary>设备中转状态（只读）</summary>
      <RemoteView connected={connected} />
    </details>
  );
}

export function RemoteView({ connected }: { connected: boolean }) {
  const resource = useResource(
    async () => normalizeCollection(await api.read("remote.speed")),
    [api.nasSession, connected],
  );
  const speed = readSpeed(resource.data);
  return (
    <div className="remote-view">
      <Status {...resource} connected={connected} retry={resource.reload} />
      {!resource.loading && !resource.error && !speed.publicAddress && !speed.clientAddress && (
        <p className="settings-empty">设备没有返回远程访问状态。</p>
      )}
      {(speed.publicAddress || speed.clientAddress) && (
        <>
          <div className="remote-grid">
            <article className="remote-card">
              <Globe weight="duotone" />
              <div>
                <span>设备公网地址</span>
                <strong>{speed.publicAddress || "—"}</strong>
                <small>中转服务解析到的出口地址</small>
              </div>
            </article>
            <article className="remote-card">
              <ArrowsLeftRight weight="duotone" />
              <div>
                <span>当前访问者</span>
                <strong>{speed.clientAddress || "—"}</strong>
                <small>{speed.isp || "运营商未知"}</small>
              </div>
            </article>
            <article className="remote-card">
              {speed.finished === undefined ? (
                <Question weight="duotone" />
              ) : speed.finished ? (
                <CheckCircle weight="duotone" />
              ) : (
                <XCircle weight="duotone" />
              )}
              <div>
                <span>最近一次中转测速</span>
                <strong>
                  {speed.finished === undefined ? "设备未返回" : speed.finished ? "已完成" : "未完成"}
                </strong>
                <small>{speed.node ? `节点：${speed.node}` : "节点未知"}</small>
              </div>
            </article>
          </div>
          <p className="remote-note">
            远程访问由极空间自己的中转服务提供；测速会占用带宽，所以由官方 App 触发，这里只显示最近一次结果。
            {speed.direction ? ` 本次方向：${speed.direction}。` : ""}
          </p>
        </>
      )}
    </div>
  );
}
