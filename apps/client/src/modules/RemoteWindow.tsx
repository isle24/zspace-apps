/*
 * 远程访问窗口。
 *
 * 以前它挂在控制面板里（appId `remote` 会渲染 SystemWindow，侧栏停在「网络连接」），
 * 点桌面上的「远程访问」图标却看到一整套控制面板导航 —— 用户反馈
 * "远程访问应该独立出来"就是这个。现在它是自己的窗口，只有自己的内容。
 *
 * 内容仍是 RemoteView（读取设备真实的 zrps 中转状态），只搬不改。
 */
import { OfficialRemoteEntries } from "./OfficialRemoteEntries";

export function RemoteWindow({ connected }: { connected: boolean }) {
  return (
    <div className="padded-module remote-window">
      <div className="content-heading">
        <div>
          <h1>远程访问</h1>
          <p>读取当前账号在 NAS 上的远程服务入口</p>
        </div>
      </div>
      <OfficialRemoteEntries connected={connected} />
    </div>
  );
}
