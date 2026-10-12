/*
 * 网络连接与系统设置：把设备返回的 JSON 变成能读的界面。
 *
 * 实测字段（2026-10-12，真机 /network-settings/v1/interface/list）：
 *   name / link_name / mtu / duplex / speed(Mbps) / type / mac / status(up|down) /
 *   ipv4_method / ipv4_address / ipv4_netmask / ipv4_gateway / ipv4_dns1 / ipv4_dns2 /
 *   ipv6_addresses / ipv6_gateway / metric
 * 系统设置（/setting/load）返回 file / boot / desktop / fs_evt_monitor / wall_papers 等分组。
 *
 * 原则不变：设备没给的字段留空或显示"—"，不猜、不用示例数据填充。
 */
import { Globe, ArrowsLeftRight, CheckCircle, XCircle } from "@phosphor-icons/react";
import { asLooseText as asText, asNumber, asRecord } from "../modules/values";
import { useEffect, useState } from "react";
import { api, message, normalizeCollection } from "../api/client";
import { Status, useResource } from "./common";
import type { PersonalSettingKey } from "../api/official-nas";

const text = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
};
const bool = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : value === 1 || value === "1" ? true : value === 0 || value === "0" ? false : undefined;

/** 速率：设备给的是 Mbps，换成人类可读的 10 Gbps / 1000 Mbps */
export function linkSpeed(mbps?: number): string | undefined {
  if (!mbps || !Number.isFinite(mbps)) return undefined;
  if (mbps >= 1000) return `${Number((mbps / 1000).toFixed(mbps % 1000 === 0 ? 0 : 1))} Gbps`;
  return `${mbps} Mbps`;
}

const typeLabel = (type?: string): string | undefined => {
  if (!type) return undefined;
  const map: Record<string, string> = {
    bridge: "网桥",
    ethernet: "以太网",
    bond: "链路聚合",
    vlan: "VLAN",
    wifi: "无线",
    virtual: "虚拟网卡",
  };
  return map[type.toLowerCase()] || type;
};

const methodLabel = (method?: string): string | undefined => {
  if (!method) return undefined;
  return method.toLowerCase() === "static" ? "静态" : method.toLowerCase() === "dhcp" ? "自动 (DHCP)" : method;
};

type InterfaceCard = {
  id: string;
  name: string;
  type?: string;
  status?: string;
  speed?: string;
  mac?: string;
  mtu?: number;
  metric?: number;
  ipv4: string[];
  dns: string[];
  ipv6: string[];
};

/** 解析接口列表：兼容 list 直接是数组或包在 data 里两种形态。 */
export function readInterfaces(response: unknown): InterfaceCard[] {
  const values = asRecord(asRecord(response)?.values) ?? asRecord(response);
  const data = asRecord(values?.data) ?? values;
  const list = Array.isArray(data?.list)
    ? data?.list
    : Array.isArray(data?.interface_list)
      ? data?.interface_list
      : [];
  return list.map((raw, index): InterfaceCard => {
    const row = asRecord(raw) ?? {};
    const address = asText(row.ipv4_address);
    const netmask = asText(row.ipv4_netmask);
    const gateway = asText(row.ipv4_gateway);
    const method = methodLabel(asText(row.ipv4_method));
    const ipv4: string[] = [];
    if (address) ipv4.push(netmask ? `${address} / ${netmask}` : address);
    if (method) ipv4.push(`获取方式：${method}`);
    if (gateway) ipv4.push(`网关：${gateway}`);
    const dns = [asText(row.ipv4_dns1), asText(row.ipv4_dns2)].filter(Boolean) as string[];
    if (asText(row.ipv4_dns_method) === "dhcp") dns.push("由 DHCP 下发");
    const ipv6List = Array.isArray(row.ipv6_addresses)
      ? (row.ipv6_addresses.map((entry) => asText(asRecord(entry)?.address) || asText(entry)).filter(Boolean) as string[])
      : [];
    const ipv6Gateway = asText(row.ipv6_gateway);
    if (ipv6Gateway) ipv6List.push(`网关：${ipv6Gateway}`);
    return {
      id: `${asText(row.name) || "if"}${index}`,
      name: asText(row.name) || `接口 ${index + 1}`,
      type: typeLabel(asText(row.type)),
      status: asText(row.status),
      speed: linkSpeed(Number(row.speed)),
      mac: asText(row.mac),
      mtu: Number.isFinite(Number(row.mtu)) ? Number(row.mtu) : undefined,
      metric: Number.isFinite(Number(row.metric)) ? Number(row.metric) : undefined,
      ipv4,
      dns,
      ipv6: ipv6List,
    };
  });
}

export function NetworkView({ connected }: { connected: boolean }) {
  const resource = useResource(
    async () => normalizeCollection(await api.read("system.network")),
    [api.nasSession, connected],
  );
  const cards = readInterfaces(resource.data);
  return (
    <div className="network-view">
      <Status {...resource} connected={connected} retry={resource.reload} />
      {!resource.loading && !resource.error && !cards.length && (
        <p className="settings-empty">设备没有返回任何网络接口。</p>
      )}
      <div className="network-grid">
        {cards.map((card) => {
          const up = card.status?.toLowerCase() === "up";
          return (
            <article className="network-card" key={card.id}>
              <header>
                <span className={`net-dot${up ? " up" : ""}`} aria-hidden="true" />
                <strong>{card.name}</strong>
                {card.type && <span className="net-tag">{card.type}</span>}
                <span className="spacer" />
                {up ? <CheckCircle weight="fill" /> : <XCircle weight="fill" />}
                <span className="net-status">{up ? "已连接" : card.status === "down" ? "未连接" : (card.status ?? "状态未知")}</span>
              </header>
              <dl>
                {card.speed && (
                  <div>
                    <dt>
                      <ArrowsLeftRight /> 速率
                    </dt>
                    <dd>{card.speed}</dd>
                  </div>
                )}
                {card.mac && (
                  <div>
                    <dt>MAC</dt>
                    <dd className="mono">{card.mac}</dd>
                  </div>
                )}
                {card.mtu !== undefined && (
                  <div>
                    <dt>MTU</dt>
                    <dd>{card.mtu}</dd>
                  </div>
                )}
                {card.ipv4.map((line) => (
                  <div key={line}>
                    <dt>
                      <Globe /> IPv4
                    </dt>
                    <dd>{line}</dd>
                  </div>
                ))}
                {card.dns.map((line) => (
                  <div key={line}>
                    <dt>DNS</dt>
                    <dd className="mono">{line}</dd>
                  </div>
                ))}
                {card.ipv6.map((line) => (
                  <div key={line}>
                    <dt>IPv6</dt>
                    <dd className="mono">{line}</dd>
                  </div>
                ))}
              </dl>
            </article>
          );
        })}
      </div>
    </div>
  );
}

/** 已知的设置分组给出中文说明；未知分组照样显示，但用设备自己的键名，不编造含义。 */
/**
 * 把嵌套设置拍平成 `键路径 = 值` 的行。
 * 设备的设置是嵌套结构（share.number / flash.expire …），直接甩 JSON 没人看得懂；
 * 拍平后既保留设备自己的键名，又能一行一行读。深度限制 3 层，再深就如实说"未展开"。
 */
export function flattenSettings(
  value: unknown,
  prefix = "",
  depth = 0,
): Array<{ key: string; value: string; raw: unknown }> {
  const record = asRecord(value);
  if (record && depth < 3) {
    const rows: Array<{ key: string; value: string; raw: unknown }> = [];
    for (const [key, child] of Object.entries(record)) {
      rows.push(...flattenSettings(child, prefix ? `${prefix}.${key}` : key, depth + 1));
    }
    return rows;
  }
  if (Array.isArray(value)) {
    if (!value.length) return [{ key: prefix, value: "空", raw: value }];
    if (depth < 3) {
      return value.flatMap((entry, index) => flattenSettings(entry, `${prefix}[${index}]`, depth + 1));
    }
    return [{ key: prefix, value: `${value.length} 项`, raw: value }];
  }
  if (record) return [{ key: prefix, value: "层级过深，未展开", raw: value }];
  return [{ key: prefix, value: valueText(value), raw: value }];
}

/*
 * 设置项的中文名。
 *
 * 以前右侧直接把设备的键名摊开（show_hidden / share.number / sata.show…），
 * 看着就是一堆参数 —— 用户反馈"系统设置里还是参数"。这里只翻译**确认过含义**的键，
 * 没确认的保持原样显示（宁可不译，也不编）。
 */
const settingLabels: Record<string, string> = {
  show_hidden: "显示隐藏文件",
  "share.number": "分享数量上限",
  "share.expire": "分享有效期",
  "share.has_pass": "分享需要密码",
  "share.can_share": "可分享给",
  "share.disable": "停用分享",
  "share.advanced_mode": "高级分享模式",
  "flash.number": "移动存储分享上限",
  "flash.expire": "移动存储分享有效期",
  "flash.has_pass": "移动存储分享需要密码",
  "flash.can_share": "移动存储可分享给",
  "flash.disable": "停用移动存储分享",
  "flash.advanced_mode": "移动存储高级模式",
  "usb.show": "USB 设备显示",
  "smb.show": "SMB 共享显示",
  "sata.show": "SATA 硬盘显示",
  "esata.show": "eSATA 硬盘显示",
};

/** 取值范围的中文说法（设备用 all/owner/master 这类词） */
const scopeText: Record<string, string> = {
  all: "全部用户",
  owner: "仅所有者",
  master: "管理员",
  none: "不显示",
  admin: "管理员",
};

/** 键 → 值的友好说法。只处理确认过语义的键，其余原样显示。 */
function settingValueText(key: string, value: unknown): string {
  const raw = valueText(value);
  if (typeof value === "number") {
    if (/(has_pass|disable|show_hidden|advanced_mode)$/.test(key))
      return value === 1 ? "开启" : "关闭";
    if (/expire$/.test(key)) {
      if (value === 0) return "永不过期";
      const days = value / 86400;
      return days >= 1 && Number.isInteger(days)
        ? `${days} 天（${value} 秒）`
        : `${value} 秒`;
    }
  }
  const scope = typeof raw === "string" ? scopeText[raw] : undefined;
  return scope ?? raw;
}

const sectionLabels: Record<string, string> = {
  file: "文件服务",
  boot: "启动与开机",
  desktop: "桌面与显示",
  fs_evt_monitor: "文件变更监控",
  wall_papers: "壁纸",
  disk_stats_sec: "磁盘统计频率",
};

const valueText = (value: unknown): string => {
  const direct = asText(value);
  if (direct !== undefined) return direct;
  const flag = bool(value);
  if (flag !== undefined) return flag ? "开启" : "关闭";
  if (Array.isArray(value)) return value.length ? `${value.length} 项` : "空";
  const record = asRecord(value);
  if (record) return `${Object.keys(record).length} 项设置`;
  return "—";
};

type Settings = Partial<Record<PersonalSettingKey, string | number>>;
const settingsFields: Array<{ key: PersonalSettingKey; title: string; help: string; options?: Array<[string | number, string]> }> = [
  { key: "show_hidden", title: "显示隐藏文件", help: "在设备文件浏览中显示以点开头的隐藏文件。" },
  { key: "file_hash_check", title: "文件传输校验", help: "复制和传输时校验文件完整性。" },
  { key: "file_hash_check_option", title: "校验方式", help: "完整校验更严格，也需要更多处理时间。", options: [["simple", "快速校验"], ["complete", "完整校验"]] },
  { key: "fs_evt_monitor", title: "监控文件变更", help: "让文件服务及时感知新增和修改。" },
  { key: "disk_stats_sec", title: "统计存储用量的间隔", help: "较短的间隔会更频繁地扫描存储。", options: [[3600,"1 小时"],[7200,"2 小时"],[21600,"6 小时"],[43200,"12 小时"],[86400,"1 天"],[259200,"3 天"],[604800,"7 天"]] },
];
function personalSettings(response: unknown): Settings {
  const values = asRecord(asRecord(response)?.values) ?? asRecord(response);
  const data = asRecord(values?.data) ?? values, file = asRecord(data?.file);
  const candidates: Settings = { show_hidden: file?.show_hidden as number, file_hash_check: file?.hash_check as number, file_hash_check_option: file?.hash_check_option as string, fs_evt_monitor: data?.fs_evt_monitor as number, disk_stats_sec: data?.disk_stats_sec as number };
  return Object.fromEntries(Object.entries(candidates).filter(([, v]) => v !== undefined)) as Settings;
}
export function SettingsView({ connected }: { connected: boolean }) {
  const resource = useResource(async () => connected ? normalizeCollection(await api.read("system.settings")) : undefined, [api.nasSession, connected]);
  const [draft, setDraft] = useState<Settings>({}), [saved, setSaved] = useState<Settings>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  useEffect(() => { const settings = personalSettings(resource.data); setDraft(settings); setSaved(settings); }, [resource.data]);
  const dirty = settingsFields.filter(f => draft[f.key] !== saved[f.key]);
  async function save() {
    setBusy(true); setError(""); setNotice("");
    const session = api.nasSession;
    try {
      for (const field of dirty) { if (session !== api.nasSession) throw new Error("NAS 会话已改变"); await api.saveSetting(field.key, draft[field.key]!); }
      if (session !== api.nasSession) return;
      setSaved({ ...draft }); setNotice("设置已保存，并已从设备确认。");
    } catch (e) { if (session === api.nasSession) setError(message(e)); }
    finally { if (session === api.nasSession) setBusy(false); }
  }
  return <div className="settings-view"><Status {...resource} connected={connected} retry={resource.reload} />
    {resource.data && !resource.error && <form className="settings-form" onSubmit={e => { e.preventDefault(); void save(); }}>
      <div className="sys-card"><h3>文件与存储偏好</h3><p className="hint">修改会保存到当前 NAS 账号，保存后会向设备核对结果。</p>
      {settingsFields.map(field => draft[field.key] !== undefined && <label className="setting-control" key={field.key}><span><strong>{field.title}</strong><small>{field.help}</small></span>
        {field.options ? <select aria-label={field.title} value={draft[field.key]} disabled={busy} onChange={e => setDraft(d => ({...d,[field.key]:field.key === "disk_stats_sec" ? Number(e.target.value) : e.target.value}))}>{field.options.map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select>
         : <input type="checkbox" aria-label={field.title} disabled={busy} checked={Number(draft[field.key]) === 1} onChange={e => setDraft(d => ({...d,[field.key]:e.target.checked ? 1 : 0}))} />}
      </label>)}
      {!Object.keys(draft).length && <p>设备没有提供可编辑的设置。</p>}</div>
      <div className="management-actions"><button type="submit" className="primary" disabled={busy || !dirty.length}>{busy ? "正在保存并确认…" : "保存设置"}</button><button type="button" className="secondary" disabled={busy || !dirty.length} onClick={() => { setDraft({...saved}); setError(""); }}>放弃修改</button><button type="button" className="secondary" disabled={busy || !!dirty.length} onClick={resource.reload}>重新读取</button></div>
    </form>}{error && <p role="alert" className="error-text">{error}</p>}{notice && <p role="status">{notice}</p>}
  </div>;
}
