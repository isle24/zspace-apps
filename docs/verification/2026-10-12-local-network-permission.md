# Mac 客户端缺了「本地网络」权限声明

## 问题

客户端要连局域网里的 NAS（`http://192.168.3.56:5055`）。macOS 15 起，
访问局域网需要用户授权 —— 而打包出来的 `Info.plist` 里**没有** `NSLocalNetworkUsageDescription`：

```
$ plutil -p "Space Desktop.app/Contents/Info.plist" | grep -i usage
（空）
```

不声明这条，用户看不到明确的授权理由，某些情况下会被**静默拒绝** ——
表现为"能打开界面，但连不上 NAS"，而且没有任何提示。

## 这不是理论风险，本机就有证据

同一天为了验 Mac 客户端的渲染，我用 Playwright 的 WebKit（同款引擎）访问过 NAS：

```
http://192.168.3.56:18436/   -> 失败: The Internet connection appears to be offline
http://192.168.3.1/          -> 200（能通）
http://127.0.0.1:9455/       -> 200（能通）
```

同一台机器、同一时刻，**只有局域网目标被拦**，而且报的是"看起来像断网"的错误 ——
正是本地网络权限机制在起作用。

## 修法

Tauri 会把 `src-tauri/Info.plist` 合并进 bundle，于是新增：

```xml
<key>NSLocalNetworkUsageDescription</key>
<string>空间桌面需要访问本地网络，才能连接你家 NAS 上的极空间服务（例如 192.168.3.56:5055）。</string>
```

## 验证（打包产物里核对，不靠"应该会生效"）

```
$ plutil -p "Space Desktop.app/Contents/Info.plist" | grep -i LocalNetwork
"NSLocalNetworkUsageDescription" => "空间桌面需要访问本地网络，才能连接你家 NAS 上的极空间服务（例如 192.168.3.56:5055）。"
```

重新打包后：配置核对通过（`nasOrigin` 仍是 NAS 地址）、`codesign --verify --deep --strict` 通过、
应用启动成功、内置 sidecar `/health` 返回 200。

## 你第一次打开时应该会看到什么

系统会弹一次「"空间桌面"想访问本地网络」的授权框，里面有上面那句话。**允许**之后才能连上 NAS。

> 附注：ad-hoc 签名每次重新打包身份都会变，所以**重新打包后可能再问一次**。
> 自用无所谓；要是觉得烦，就得用固定证书签名。
