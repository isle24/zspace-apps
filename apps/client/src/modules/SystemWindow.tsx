import { useState } from "react";
import { ArrowClockwise, Gear, Globe, HardDrives, Cube, SquaresFour } from "@phosphor-icons/react";
import { StorageView, SystemOverview } from "./SystemOverview";
import { NetworkView, SettingsView } from "./SystemNetwork";
import { DockerView } from "./DockerView";
import { OfficialStore } from "./OfficialStore";
const panels = [
  { id: "overview", label: "系统概览", icon: SquaresFour, detail: "查看设备信息、运行状态与资源用量" },
  { id: "storage", label: "存储空间", icon: HardDrives, detail: "查看存储池、容量和硬盘状态" },
  { id: "network", label: "网络连接", icon: Globe, detail: "查看网卡、IP 地址、网关与 DNS" },
  { id: "settings", label: "系统设置", icon: Gear, detail: "修改文件显示、传输校验和统计偏好" },
  { id: "apps", label: "设备应用", icon: Cube, detail: "浏览官方应用、查看安装状态和管理服务" },
];
export function SystemWindow({ id, connected }: { id: string; connected: boolean }) {
  if (id === "containers") return <div className="module-main padded-module"><DockerView connected={connected} /></div>;
  return <ControlPanel id={id} connected={connected} />;
}
function ControlPanel({ id, connected }: { id: string; connected: boolean }) {
  const [tab,setTab] = useState(id === "storage" ? "storage" : "home"), [revision,setRevision] = useState(0);
  const active = panels.find(p => p.id === tab);
  return <div className="module-split control-panel"><nav className="module-sidebar"><p>设备与系统</p><button className={tab === "home" ? "selected" : ""} onClick={() => setTab("home")}><SquaresFour />控制面板</button>{panels.map(p => <button key={p.id} className={tab === p.id ? "selected" : ""} onClick={() => setTab(p.id)}><p.icon />{p.label}</button>)}</nav>
  <div className="module-main padded-module"><div className="content-heading"><div><h1>{active?.label || "控制面板"}</h1><p>{active?.detail || "选择一个模块，查看或管理你的设备"}</p></div>{tab !== "home" && tab !== "settings" && <button className="icon-button" aria-label="刷新系统信息" onClick={() => setRevision(r => r+1)}><ArrowClockwise /></button>}</div>
  {tab === "home" ? <><div className="control-panel-grid">{panels.map(p => <button key={p.id} onClick={() => setTab(p.id)}><p.icon weight="duotone" /><strong>{p.label}</strong><small>{p.detail}</small></button>)}</div><button className="secondary" onClick={() => setTab("settings")}>文件与存储偏好</button></> : <div key={`${tab}:${revision}`}>
  {tab === "overview" ? <SystemOverview connected={connected} /> : tab === "storage" ? <StorageView connected={connected} /> : tab === "network" ? <NetworkView connected={connected} /> : tab === "settings" ? <SettingsView connected={connected} /> : <OfficialStore />}
  </div>}</div></div>;
}
export function HelpWindow() {
  return (
    <div className="padded-module help">
      <span className="eyebrow">WELCOME TO SPACE</span>
      <h1>你的 NAS，新的打开方式</h1>
      <p>
        从桌面进入文件、媒体和应用。手机上应用以全屏打开，点击左上角即可返回桌面。
      </p>
      <div className="settings-card">
        <h3>左侧应用栏</h3>
        <p>
          顶部两个入口是「回到桌面」和「全部应用」；中间是常用应用，运行中的应用左侧有蓝色竖条；底部四个图标依次是资源管理、任务与通知、账号和控制面板。图标悬停或键盘聚焦时会显示名称。
        </p>
        <h3>全部应用与搜索</h3>
        <p>
          点击应用栏的「全部应用」或按 ⌘/Ctrl + K 打开启动台，输入名称可筛选；按 Esc 关闭并回到原来的位置。
        </p>
        <h3>桌面窗口</h3>
        <p>
          拖动标题栏移动窗口，拖动右下角调整大小（聚焦后也可用方向键）。右上角三个按钮依次是最小化、最大化/还原、关闭；关闭窗口会把焦点交还给应用栏对应入口，不会停止设备应用或下载任务。
        </p>
        <h3>资源挂件</h3>
        <p>
          右上角胶囊显示读写、网络与 CPU/内存，点击展开为运行状态、网络、存储读写和存储空间四张卡。接口未返回的指标显示「—」，不显示推测值。
        </p>
        <h3>连接设备</h3>
        <p>
          从 NAS 打开本页面时地址即为当前访问地址，登录只需账号和密码；本地开发和桌面客户端需要显式填写设备地址。登录失败时会保留错误原因，不会显示示例内容。
        </p>
        <h3>主题</h3>
        <p>
          系统栏右侧的月亮/太阳图标切换深色与浅色，选择保存在本机。切换后外壳与全部应用窗口一起变化。
        </p>
        <h3>安装应用</h3>
        <p>
          应用商店需要独立的管理员登录。选择应用与已登记的目录后，查看服务端生成的安装计划，确认后才开始安装；执行引擎未配置时商店会如实说明，不会伪造可用状态。
        </p>
        <h3>桌面整理</h3>
        <p>
          拖动桌面图标交换位置，仅调整本机界面。
        </p>
      </div>
    </div>
  );
}
