import { useEffect, useRef, useState } from "react";
import { ArrowUp, ArrowDown, CaretDoubleDown, CaretDoubleUp, Cube, DotsSix } from "@phosphor-icons/react";

/**
 * 飞牛 fnOS 右上角资源挂件。
 *
 * 收起态：R/W + 网络 ↑↓ + CPU/RAM 胶囊（266×36，白色玻璃、双行数值）；
 * 展开态：运行状态 / 网络 / 存储读写 / 存储空间 四张白卡。
 *
 * 数据诚实性：只渲染真实接口返回的字段；缺失一律显示 “—”，
 * 计算得出的速率需要至少两个采样点，采样不足时图表留空而不画假数据。
 */
export type WidgetValues = Record<string, unknown>;

export type WidgetPool = {
  id: string;
  name: string;
  used?: number;
  total?: number;
};

export type WidgetSample = {
  at: number;
  read: number | null;
  write: number | null;
  up: number | null;
  down: number | null;
};

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** 从接口对象里按候选字段名取第一个可用数值；不猜测单位，只认已确认的名字。 */
export function pick(record: WidgetValues | undefined, names: string[]): number | null {
  if (!record) return null;
  for (const name of names) {
    const found = numeric(record[name]);
    if (found !== null) return found;
  }
  return null;
}

export function formatRate(value: number | null): { value: string; unit: string } {
  if (value === null || value < 0) return { value: "—", unit: "" };
  const bytes = value;
  if (bytes >= 1024 ** 3) return { value: (bytes / 1024 ** 3).toFixed(1), unit: "GB/s" };
  if (bytes >= 1024 ** 2) return { value: (bytes / 1024 ** 2).toFixed(1), unit: "MB/s" };
  if (bytes >= 1024) return { value: (bytes / 1024).toFixed(1), unit: "KB/s" };
  return { value: String(Math.round(bytes)), unit: "B/s" };
}

export function formatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`;
}

export function formatBytes(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(2)} TB`;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(value)} B`;
}

export function formatUptime(seconds: number | null): string {
  if (seconds === null || seconds < 0) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${days} 天 ${hours} 时 ${minutes} 分 ${secs} 秒`;
}

/** 迷你面积/折线图：只用真实采样点，样本不足两个时返回 null。 */
function Spark({ values, tone = "primary" }: { values: (number | null)[]; tone?: "primary" | "success" }) {
  const points = values.filter((v): v is number => v !== null);
  if (points.length < 2) return <div className="widget-spark widget-spark-empty" aria-hidden="true" />;
  const max = Math.max(...points, 1);
  const width = 100;
  const height = 30;
  const step = width / (points.length - 1);
  const line = points.map((v, i) => `${(i * step).toFixed(2)},${(height - (v / max) * height).toFixed(2)}`).join(" ");
  const stroke = tone === "success" ? "var(--fn-success)" : "var(--fn-primary)";
  return (
    <svg className="widget-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={`0,${height} ${line} ${width},${height}`} fill={stroke} opacity="0.12" stroke="none" />
      <polyline points={line} fill="none" stroke={stroke} strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Row({
  label,
  labelTone,
  value,
  unit,
  icon,
}: {
  label: string;
  labelTone?: "primary" | "success" | "muted";
  value: string;
  unit?: string;
  icon?: "up" | "down";
}) {
  return (
    <span className="widget-row">
      {icon === "up" && <ArrowUp weight="bold" className="widget-arrow up" />}
      {icon === "down" && <ArrowDown weight="bold" className="widget-arrow down" />}
      <b className={labelTone ? `widget-label widget-label-${labelTone}` : "widget-label"}>{label}</b>
      <i className="widget-value">{value}</i>
      {unit !== undefined && <em className="widget-unit">{unit}</em>}
    </span>
  );
}

/**
 * 真实取数形状（2026-10-11 在极空间 Z425 / 固件实测抓包确认）：
 *
 *   POST /system/recent  →  { code, ts, msg, data: { list: [ {
 *        cpu:    { name, temp, used },              // used 是 0..1 比例
 *        memory: { total, used },                   // used 是 0..1 比例
 *        net_speed: { download1s, upload1s },        // 字节/秒
 *        speeds: [{ name, iface, download1s, upload1s }],   // 逐网卡
 *        disks:  [{ dev, rps, wps, ioutil, temp, state }],  // rps/wps 字节/秒
 *        fan / cpu_fan: { state, ctr, speed },
 *        uptime: "1562379",                          // 秒（字符串）
 *   } ] } }
 *
 * 注意：SDK 的 `api.read()` 返回的是 `{ items, total, values }`（values 是清洗后的原始报文），
 * 不是裸报文，所以这里必须先看 `values.list`，再兼容直接传入裸报文的场景。
 */
export type MonitorSample = {
  cpu: number | null;
  memory: number | null;
  up: number | null;
  down: number | null;
  read: number | null;
  write: number | null;
  uptimeSeconds: number | null;
};

const monitorList = (response: unknown): Record<string, any>[] | null => {
  const root = response as Record<string, any> | null | undefined;
  for (const candidate of [root?.values?.list, root?.list, root?.data?.list]) {
    if (Array.isArray(candidate)) return candidate as Record<string, any>[];
  }
  return null;
};

export function readMonitor(response: unknown): MonitorSample {
  const empty: MonitorSample = {
    cpu: null, memory: null, up: null, down: null, read: null, write: null, uptimeSeconds: null,
  };
  const list = monitorList(response);
  if (!list || list.length === 0) return empty;
  const first = list[0] ?? {};
  const ratio = (value: unknown): number | null => {
    const n = numeric(value);
    if (n === null || n < 0) return null;
    return n <= 1 ? n * 100 : n; // 官方是 0..1 比例，容忍已经是百分数的实现
  };
  let up = numeric(first?.net_speed?.upload1s);
  let down = numeric(first?.net_speed?.download1s);
  // 多网卡时逐口求和，覆盖 net_speed 的单口值
  if (Array.isArray(first?.speeds) && first.speeds.length > 0) {
    let sumUp = 0;
    let sumDown = 0;
    let seen = false;
    for (const entry of first.speeds) {
      const u = numeric(entry?.upload1s);
      const d = numeric(entry?.download1s);
      if (u !== null) { sumUp += u; seen = true; }
      if (d !== null) { sumDown += d; seen = true; }
    }
    if (seen) {
      up = sumUp;
      down = sumDown;
    }
  }
  // 设备读写：官方在 /system/recent 的 disks[] 里逐个磁盘给出 rps/wps（字节/秒）
  let read: number | null = null;
  let write: number | null = null;
  if (Array.isArray(first?.disks) && first.disks.length > 0) {
    let sumRead = 0;
    let sumWrite = 0;
    let seen = false;
    for (const disk of first.disks) {
      const r = numeric(disk?.rps);
      const w = numeric(disk?.wps);
      if (r !== null) { sumRead += r; seen = true; }
      if (w !== null) { sumWrite += w; seen = true; }
    }
    if (seen) {
      read = sumRead;
      write = sumWrite;
    }
  }
  const uptime = numeric(first?.uptime);
  return {
    cpu: ratio(first?.cpu?.used),
    memory: ratio(first?.memory?.used),
    up,
    down,
    read,
    write,
    uptimeSeconds: uptime !== null && uptime >= 0 ? uptime : null,
  };
}

export function sumServiceIo(response: unknown): { read: number | null; write: number | null } {
  const record = response as Record<string, any> | null | undefined;
  const list = [record?.values?.list, record?.list, record?.data?.list].find(Array.isArray) ?? null;
  if (!list || list.length === 0) return { read: null, write: null };
  let read = 0;
  let write = 0;
  let seen = false;
  for (const entry of list) {
    const r = numeric(entry?.io?.read_ps) ?? numeric(entry?.ior);
    const w = numeric(entry?.io?.write_ps) ?? numeric(entry?.iow);
    if (r !== null) { read += r; seen = true; }
    if (w !== null) { write += w; seen = true; }
  }
  return seen ? { read, write } : { read: null, write: null };
}

export function ResourceWidget({
  values,
  monitor,
  io,
  pools,
  hostName,
  uptimeSeconds,
  connected,
}: {
  values?: WidgetValues;
  /** /system/recent 的解析结果（CPU/内存/网络速率） */
  monitor?: MonitorSample;
  /** /manager/services 求和得到的设备读写速率 */
  io?: { read: number | null; write: number | null };
  pools?: WidgetPool[];
  hostName?: string;
  uptimeSeconds?: number | null;
  connected: boolean;
}) {
  const [open, setOpen] = useState(false);
  const constrain = (x:number,y:number) => ({x:Math.max(8,Math.min(x,window.innerWidth-Math.min(380,window.innerWidth-16)-8)),y:Math.max(8,Math.min(y,window.innerHeight-60))});
  const [position,setPosition] = useState(()=>{
    try {const saved=JSON.parse(localStorage.getItem("space-resource-position")||"null");if(saved&&Number.isFinite(saved.x)&&Number.isFinite(saved.y))return constrain(saved.x,saved.y)} catch {}
    return constrain(window.innerWidth-400,14);
  });
  const drag=useRef<{id:number;x:number;y:number;left:number;top:number}|undefined>(undefined);
  const persist=(next:{x:number;y:number})=>{setPosition(next);try{localStorage.setItem("space-resource-position",JSON.stringify(next))}catch{}};
  useEffect(()=>{const resize=()=>setPosition(p=>constrain(p.x,p.y));window.addEventListener("resize",resize);return()=>window.removeEventListener("resize",resize)},[]);
  const [samples, setSamples] = useState<WidgetSample[]>([]);
  const latest = useRef<WidgetSample | null>(null);

  // 磁盘读写：先用 /system/recent 的 disks[].rps/wps（实测字段），
  // 缺失时退回 /manager/services 的服务级 io 求和（官方监控页同算法）
  const read = connected
    ? (monitor?.read ?? io?.read ?? pick(values, ["read_speed", "readSpeed", "sys_read", "disk_read"]))
    : null;
  const write = connected
    ? (monitor?.write ?? io?.write ?? pick(values, ["write_speed", "writeSpeed", "sys_write", "disk_write"]))
    : null;
  // 网络速率：优先用官方 monitor（/system/recent）的 net_speed.*1s
  const up = connected
    ? (monitor?.up ?? pick(values, ["net_up", "netUp", "up_speed", "upload_speed", "net_upload"]))
    : null;
  const down = connected
    ? (monitor?.down ?? pick(values, ["net_down", "netDown", "down_speed", "download_speed", "net_download"]))
    : null;

  useEffect(() => {
    latest.current = { at: Date.now(), read, write, up, down };
    if (read === null && write === null && up === null && down === null) return;
    setSamples((list) => [...list.slice(-59), latest.current!]);
  }, [read, write, up, down]);

  const readRate = formatRate(read);
  const writeRate = formatRate(write);
  const upRate = formatRate(up);
  const downRate = formatRate(down);
  const cpu = connected
    ? (monitor?.cpu ?? pick(values, ["cpu", "cpu_usage", "cpuUsage"]))
    : null;
  const memory = connected
    ? (monitor?.memory ?? pick(values, ["memory", "mem", "memory_usage", "memoryUsage"]))
    : null;
  const storage = pools?.filter((p) => p.total) ?? [];

  return (
    <div className={`resource-widget ${open ? "expanded" : ""} ${position.y>window.innerHeight/2?"panel-above":""}`} style={{position:"fixed",left:position.x,top:position.y}}>
      <button className="widget-drag" aria-label="拖动资源监控" title="拖动调整位置；方向键移动，Home 回到右上角" onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();drag.current={id:e.pointerId,x:e.clientX,y:e.clientY,left:position.x,top:position.y};e.currentTarget.setPointerCapture?.(e.pointerId)}} onPointerMove={e=>{const d=drag.current;if(d&&d.id===e.pointerId)setPosition(constrain(d.left+e.clientX-d.x,d.top+e.clientY-d.y))}} onPointerUp={()=>{if(drag.current){drag.current=undefined;persist(position)}}} onPointerCancel={()=>{drag.current=undefined}} onKeyDown={e=>{const step=e.shiftKey?20:5;const offsets:Record<string,[number,number]>={ArrowLeft:[-step,0],ArrowRight:[step,0],ArrowUp:[0,-step],ArrowDown:[0,step]};if(e.key==="Home"){e.preventDefault();persist(constrain(window.innerWidth-400,14))}else if(offsets[e.key]){e.preventDefault();persist(constrain(position.x+offsets[e.key][0],position.y+offsets[e.key][1]))}}}><DotsSix/></button>
      <button
        className="widget-pill"
        aria-label={open ? "收起资源监控" : "展开资源监控"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="widget-group rw">
          <Row label="R" labelTone="primary" value={readRate.value} unit={readRate.unit} />
          <Row label="W" labelTone="success" value={writeRate.value} unit={writeRate.unit} />
        </span>
        <span className="widget-group net">
          <Row label="" icon="up" value={upRate.value} unit={upRate.unit} />
          <Row label="" icon="down" value={downRate.value} unit={downRate.unit} />
        </span>
        <span className="widget-group sys">
          <Row label="CPU" labelTone="muted" value={formatPercent(cpu)} />
          <Row label="RAM" labelTone="muted" value={formatPercent(memory)} />
        </span>
        <span className="widget-chevron" aria-hidden="true">
          {open ? <CaretDoubleUp weight="bold" /> : <CaretDoubleDown weight="bold" />}
        </span>
      </button>

      {open && (
        <div className="widget-panel" role="region" aria-label="资源监控详情">
          <section className="widget-card">
            <h3>运行状态</h3>
            <div className="widget-status">
              <span className="widget-host">{connected ? hostName || "—" : "未连接"}</span>
              <div className="widget-rings">
                <div className="widget-ring">
                  <span>CPU</span>
                  <strong>{formatPercent(cpu)}</strong>
                </div>
                <div className="widget-ring">
                  <span>内存</span>
                  <strong>{formatPercent(memory)}</strong>
                </div>
              </div>
            </div>
            <p className="widget-meta">
              本次运行
              <strong>{formatUptime(connected ? (uptimeSeconds ?? null) : null)}</strong>
            </p>
          </section>

          <section className="widget-card">
            <header>
              <h3>网络</h3>
              <span className="widget-kv">
                <span className="widget-kv-up">
                  <ArrowUp weight="bold" /> {upRate.value} {upRate.unit}
                </span>
                <span className="widget-kv-down">
                  <ArrowDown weight="bold" /> {downRate.value} {downRate.unit}
                </span>
              </span>
            </header>
            <Spark values={samples.map((s) => s.down)} />
          </section>

          <section className="widget-card">
            <header>
              <h3>存储读写</h3>
              <span className="widget-kv">
                <span className="widget-kv-read">
                  R {readRate.value} {readRate.unit}
                </span>
                <span className="widget-kv-write">
                  W {writeRate.value} {writeRate.unit}
                </span>
              </span>
            </header>
            <Spark values={samples.map((s) => s.write)} tone="success" />
          </section>

          <section className="widget-card">
            <header>
              <h3>存储空间</h3>
            </header>
            {storage.length === 0 && <p className="widget-meta">尚未读取到存储空间</p>}
            {storage.map((pool) => (
              <div className="widget-pool" key={pool.id}>
                <Cube weight="duotone" />
                <span className="widget-pool-name">{pool.name}</span>
                <span className="widget-pool-size">
                  {formatBytes(pool.used ?? null)} / {formatBytes(pool.total ?? null)}
                </span>
                <span className="widget-pool-track">
                  <i
                    style={{
                      width: `${Math.min(100, Math.round(((pool.used ?? 0) / (pool.total || 1)) * 100))}%`,
                    }}
                  />
                </span>
              </div>
            ))}
          </section>
        </div>
      )}
    </div>
  );
}
