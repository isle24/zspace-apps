import { useMemo } from "react";
import { asNumber, asRecord as sharedAsRecord, asText } from "../modules/values";
import {
  ArrowClockwise, Cpu as CpuIcon, HardDrives, Memory, Fan, ThermometerSimple, Clock, Users,
} from "@phosphor-icons/react";
import { api } from "../api/client";
import { Status, formatBytes, useResource } from "./common";
import { readMonitor } from "./ResourceWidget";

/**
 * 控制面板 / 存储空间。
 *
 * 字段全部来自 2026-10-11 在极空间 Z425 上的实测抓包：
 * - `/system/recent` → `data.list[0]`：basic.name、hard.*、cpu.{name,used,temp}、
 *   memory.{total,used}、cpu_fan.speed / fan.speed、uptime、disks[].{dev,temp,state,total,used}
 * - `/system/home`  → total / used / myused / user_cnt / product
 * - `/system/storage`（v1/v2 走 /storagepool/info2，v3 走 /zspool/info）→ pool_list
 *
 * 之前的实现把这些对象直接摊平成 key/value 列表（用户反馈"还是官方 JSON"），
 * 这里改成按语义取值并给出可读的卡片与进度条。
 */

type Record_ = Record<string, any>;

/*
 * 本文件里字段访问比较随意（历史原因，`Record_` 是 any），所以保留一个宽松包装。
 * 解析逻辑本身仍走共享实现 —— 避免"两份 asRecord 行为悄悄不一样"。
 */
const asRecord = (value: unknown): Record_ | undefined =>
  sharedAsRecord(value) as Record_ | undefined;



/** 挂件用的解析器同样吃 `{items,total,values}` 包装，这里直接复用。 */
const rootValues = (data: unknown): Record_ | undefined => asRecord(asRecord(data)?.values) ?? asRecord(data);

const uptimeText = (seconds?: number): string => {
  if (seconds === undefined || seconds < 0) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分`;
};

const percent = (used?: number, total?: number): number | undefined => {
  if (used === undefined || total === undefined || total <= 0) return undefined;
  return Math.min(100, Math.max(0, (used / total) * 100));
};

function Meter({ value }: { value?: number }) {
  if (value === undefined) return <span className="sys-meter" aria-hidden="true" />;
  const tone = value >= 90 ? "danger" : value >= 75 ? "warn" : "ok";
  return (
    <span className={`sys-meter ${tone}`} role="img" aria-label={`已使用 ${value.toFixed(0)}%`}>
      <span style={{ width: `${value}%` }} />
    </span>
  );
}

function Fact({ icon, label, value, hint }: {
  icon: React.ReactNode; label: string; value: string; hint?: string;
}) {
  return (
    <div className="sys-fact">
      <span className="sys-fact-icon" aria-hidden="true">{icon}</span>
      <div>
        <span className="sys-fact-label">{label}</span>
        <strong>{value}</strong>
        {hint ? <small>{hint}</small> : null}
      </div>
    </div>
  );
}

/** 系统概览：设备、实时负载、容量、磁盘温度。 */
export function SystemOverview({ connected }: { connected: boolean }) {
  const hardware = useResource(() => api.read("system.monitor"), [api.nasSession]);
  const space = useResource(() => api.read("system.overview"), [api.nasSession]);

  const monitor = useMemo(() => readMonitor(hardware.data), [hardware.data]);
  const recent = useMemo(() => {
    const list = rootValues(hardware.data)?.list;
    return Array.isArray(list) ? asRecord(list[0]) : undefined;
  }, [hardware.data]);
  const home = useMemo(() => rootValues(space.data), [space.data]);

  const device = recent?.basic;
  const hard = recent?.hard;
  const cpu = recent?.cpu;
  const memory = recent?.memory;
  const disks: Record_[] = Array.isArray(recent?.disks) ? recent.disks : [];
  const capacityUsed = asNumber(home?.used);
  const capacityTotal = asNumber(home?.total);
  const myUsed = asNumber(home?.myused);
  const users = asNumber(home?.user_cnt);
  const fanSpeed = asNumber(recent?.cpu_fan?.speed) ?? asNumber(recent?.fan?.speed);

  const loading = hardware.loading || space.loading;
  const error = hardware.error || space.error;
  // 只有当我们真的认出字段时才算有数据：接口有响应但字段不认识时，宁可如实说明，
  // 也不要把一屏「—」当成设备信息展示（更不该回退成原始 JSON）。
  const recognised =
    !!recent || [home?.product, home?.total, home?.used, home?.user_cnt].some((v) => v !== undefined && v !== null);
  const empty = !loading && !error && !recognised;

  if (!connected) return <Status connected={false} empty={false} />;
  if (error) return <Status connected error={error} empty={false} retry={() => { hardware.reload(); space.reload(); }} />;
  if (loading) return <Status connected loading empty={false} />;
  if (empty) {
    return (
      <div className="state-panel">
        <h3>设备没有返回可识别的概览数据</h3>
        <p>接口有响应，但没有本机已适配的字段（basic / cpu / memory / disks）。</p>
        <button className="primary" onClick={() => { hardware.reload(); space.reload(); }}>
          <ArrowClockwise />
          重新读取
        </button>
      </div>
    );
  }

  return (
    <div className="sys-module">
      <section className="sys-card sys-device">
        <header>
          <span className="sys-device-icon" aria-hidden="true"><HardDrives weight="duotone" /></span>
          <div>
            <h2>{asText(device?.name) ?? asText(home?.product) ?? "NAS"}</h2>
            <p>
              {[asText(hard?.model), asText(device?.nasid)].filter(Boolean).join(" · ") || "设备信息"}
            </p>
          </div>
          <button className="icon-button" aria-label="刷新系统信息" onClick={() => { hardware.reload(); space.reload(); }}>
            <ArrowClockwise />
          </button>
        </header>
        <div className="sys-facts">
          <Fact
            icon={<CpuIcon weight="duotone" />}
            label="CPU"
            value={monitor.cpu === null ? "—" : `${monitor.cpu.toFixed(0)}%`}
            hint={[asText(cpu?.name), asNumber(cpu?.temp) !== undefined ? `${asNumber(cpu?.temp)}°C` : undefined].filter(Boolean).join(" · ")}
          />
          <Fact
            icon={<Memory weight="duotone" />}
            label="内存"
            value={monitor.memory === null ? "—" : `${monitor.memory.toFixed(0)}%`}
            hint={
              asNumber(memory?.total) !== undefined && asNumber(memory?.used) !== undefined
                ? `${formatBytes(asNumber(memory?.total)! * asNumber(memory?.used)!)} / ${formatBytes(asNumber(memory?.total))}`
                : undefined
            }
          />
          <Fact
            icon={<Fan weight="duotone" />}
            label="风扇"
            value={fanSpeed !== undefined ? `${fanSpeed} rpm` : "—"}
          />
          <Fact
            icon={<Clock weight="duotone" />}
            label="运行时间"
            value={uptimeText(monitor.uptimeSeconds ?? asNumber(recent?.uptime))}
          />
        </div>
      </section>

      <section className="sys-card">
        <h3>容量</h3>
        <div className="sys-capacity">
          <div>
            <span>总容量</span>
            <strong>{formatBytes(capacityTotal)}</strong>
          </div>
          <div>
            <span>已使用</span>
            <strong>{formatBytes(capacityUsed)}</strong>
          </div>
          <div>
            <span>我的空间</span>
            <strong>{formatBytes(myUsed)}</strong>
          </div>
          <div>
            <span>用户</span>
            <strong>{users !== undefined ? `${users} 个` : "—"}</strong>
          </div>
        </div>
        <Meter value={percent(capacityUsed, capacityTotal)} />
      </section>

      <section className="sys-card">
        <h3>磁盘（{disks.length}）</h3>
        {disks.length === 0 ? (
          <p className="muted">设备未返回磁盘列表。</p>
        ) : (
          <ul className="sys-disks">
            {disks.map((disk) => {
              const used = asNumber(disk.used);
              const total = asNumber(disk.total);
              return (
                <li key={String(disk.dev ?? disk.id ?? Math.random())}>
                  <span className="sys-disk-name">{asText(disk.dev) ?? "磁盘"}</span>
                  <Meter value={percent(used, total)} />
                  <span className="sys-disk-figure">
                    {total !== undefined ? `${formatBytes(used)} / ${formatBytes(total)}` : "—"}
                  </span>
                  <span className="sys-disk-temp">
                    <ThermometerSimple weight="duotone" aria-hidden="true" />
                    {asNumber(disk.temp) !== undefined ? `${asNumber(disk.temp)}°C` : "—"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {users !== undefined && (
        <p className="hint">
          <Users weight="duotone" aria-hidden="true" /> 此处为设备真实读数；设置修改、远程接入与容器管理尚未开放。
        </p>
      )}
    </div>
  );
}

/** 存储池协议/类型的中文说明；认不出来就原样显示，不编造。 */
const poolTypeLabel = (value?: string): string | undefined => {
  if (!value) return undefined;
  const map: Record<string, string> = {
    single: "单盘", SINGLE: "单盘", RAID0: "RAID 0", RAID1: "RAID 1",
    RAID5: "RAID 5", RAID6: "RAID 6", RAID10: "RAID 10", ZDR: "ZDR",
  };
  return map[value] ?? value;
};

const protocolLabel = (value?: string): string | undefined => {
  if (!value) return undefined;
  const lower = value.toLowerCase();
  if (lower.includes("nvme")) return "NVMe";
  if (lower.includes("sata")) return "SATA";
  if (lower.includes("usb")) return "USB";
  return value;
};

const diskTypeLabel = (value?: string): string => {
  const upper = (value ?? "").toUpperCase();
  if (upper.includes("NVME")) return "M.2 NVMe";
  if (upper.includes("SSD")) return "SSD";
  if (upper.includes("SATA")) return "SATA";
  return value ?? "磁盘";
};

/**
 * 存储空间。数据来自 `system.storage`：
 * - v3 → `/zspool/info` 的 `pool_list[]`（id/name/protocol/pool_type/status/total_size/disk_list[]）
 * - v1/v2 → `/storagepool/info2` 的 `system.{sata_group,ssd_group}`
 * 之前这里同样是原始 JSON 摊平，现在按池与磁盘渲染。
 */
export function StorageView({ connected }: { connected: boolean }) {
  const storage = useResource(() => api.read("system.storage"), [api.nasSession]);
  const pools = useMemo(() => {
    const collection = storage.data as { items?: unknown[] } | undefined;
    return Array.isArray(collection?.items) ? collection.items : [];
  }, [storage.data]);
  const values = useMemo(() => rootValues(storage.data), [storage.data]);
  const spVer = asText(values?.sp_ver);

  if (!connected) return <Status connected={false} empty={false} />;
  if (storage.error) return <Status connected error={storage.error} empty={false} retry={storage.reload} />;
  if (storage.loading) return <Status connected loading empty={false} />;
  if (pools.length === 0)
    return (
      <div className="state-panel">
        <h3>没有读到存储池</h3>
        <p>
          设备返回的存储结构{spVer ? `（版本 ${spVer}）` : ""}里没有本机已适配的池信息。
        </p>
        <button className="primary" onClick={storage.reload}>
          <ArrowClockwise />
          重新读取
        </button>
      </div>
    );

  return (
    <div className="sys-module">
      {pools.map((raw) => {
        const pool = (asRecord(asRecord(raw)?.metadata) ?? asRecord(raw)) as Record_;
        const id = asText(pool.id) ?? asText(asRecord(raw)?.id) ?? "";
        const name = asText(pool.name) ?? asText(asRecord(raw)?.name) ?? "存储池";
        const total = asNumber(pool.total_size) ?? asNumber(asRecord(raw)?.size);
        const free = asNumber(pool.free_size) ?? asNumber(pool.available_size);
        const used = asNumber(pool.used_size) ?? asNumber(pool.usage_size) ??
          (total !== undefined && free !== undefined ? total - free : undefined);
        const disks: Record_[] = Array.isArray(pool.disk_list) ? pool.disk_list
          : Array.isArray(pool.disks) ? pool.disks : [];
        const status = asText(pool.status);
        return (
          <section className="sys-card" key={id || name}>
            <header className="sys-pool-head">
              <span className="sys-device-icon" aria-hidden="true"><HardDrives weight="duotone" /></span>
              <div>
                <h2>{name}</h2>
                <p>
                  {[poolTypeLabel(asText(pool.pool_type)), protocolLabel(asText(pool.protocol)),
                    status && status !== "ok" ? `状态 ${status}` : undefined].filter(Boolean).join(" · ") || "存储池"}
                </p>
              </div>
              <span className="sys-pool-size">{formatBytes(total)}</span>
            </header>
            <Meter value={percent(used, total)} />
            <div className="sys-capacity">
              <div><span>已使用</span><strong>{formatBytes(used)}</strong></div>
              <div><span>可用</span><strong>{formatBytes(free)}</strong></div>
              <div><span>磁盘</span><strong>{disks.length ? `${disks.length} 块` : "—"}</strong></div>
            </div>
            {disks.length > 0 && (
              <ul className="sys-disks">
                {disks.map((disk, index) => (
                  <li key={String(disk.sn ?? disk.dev ?? index)}>
                    <span className="sys-disk-name">{diskTypeLabel(asText(disk.dev_type) ?? asText(disk.type))}</span>
                    <Meter value={undefined} />
                    <span className="sys-disk-figure">
                      {asNumber(disk.pos) !== undefined ? `位置 ${asNumber(disk.pos)}` : ""}
                      {asNumber(disk.total_size) !== undefined ? ` · ${formatBytes(asNumber(disk.total_size))}` : ""}
                    </span>
                    <span className="sys-disk-temp">—</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
