# macOS 客户端：怎么用、东西存在哪、怎么重打包

产物路径：

```
apps/client/src-tauri/target/release/bundle/macos/Space Desktop.app
```

## 第一次打开

1. **双击打开**。包是 ad-hoc 签名的（自用够，省掉 99 美元年费）。若 Gatekeeper 拦，
   右键 →「打开」一次即可；之后不再拦。
2. **会弹一次系统权限**：「"空间桌面"想访问本地网络」→ 必须**允许**，否则连不上 NAS。
   这句文案来自 `src-tauri/Info.plist` 里的 `NSLocalNetworkUsageDescription`
   （见 `docs/verification/2026-10-12-local-network-permission.md`）。
3. 登录页会**自动填好 NAS 地址**（打包时写进 `runtime-config.json`），只差账号密码。
   想换设备：卡片底部「更改设备地址」。

## 客户端里和网页版不一样的地方

| 行为 | 客户端 | 网页版 |
| --- | --- | --- |
| 「保持登录」 | **可以勾**（凭据存系统钥匙串） | 置灰（并写明原因） |
| 「启动时自动登录」 | 有 | 无 |
| ⌘W / ⌘M | 关闭 / 最小化**最前那个窗口** | ⌘W 归浏览器（关标签页） |
| 菜单栏 | 只有 应用 / 编辑 / 显示（**故意去掉 File 与 Window**） | 无 |
| 下载 | 系统保存对话框，流式落盘（可断点续传） | 浏览器下载 |
| 大文件上传/下载 | 由 Rust 侧读写，不经浏览器内存 | 浏览器内存 |

> 去菜单：Tauri 默认菜单里的 `File → Close Window`(⌘W) 会**抢走**应用内快捷键，
> 按下去关掉整个应用。这是实测后改的，见 `docs/verification/2026-10-12-macos-integration.md`。

## 数据存在哪

| 内容 | 位置 |
| --- | --- |
| 登录凭据（勾了「保持登录」才有） | **系统钥匙串**（service `com.isle.space-desktop`） |
| 网页数据（cookie、localStorage） | `~/Library/WebKit/com.isle.space-desktop/` |
| 商店 sidecar 数据 | `~/Library/Application Support/com.isle.space-desktop/store` |
| 崩溃报告（如果有） | `~/Library/Logs/DiagnosticReports/` |

卸载 = 删掉 `.app` + 上面两三个目录；钥匙串条目在「钥匙串访问」里搜 `space-desktop` 删。

## 客户端里能做什么

与网页版**同一套代码**：11 个窗口（文件、相册、影视、音乐、下载、商店、控制面板、
存储、任务、Docker、远程访问）。播放走原生媒体代理（`nas-media://`），
Cookie 由 SDK 自己拼（不依赖浏览器）。

**已知做不到的**与网页版一致（见 [一页状态](../verification/STATUS.md)）；
另外客户端**上传还没有界面入口**（链路实现了但没按钮，见 `upload-no-entry`）。

## 重新打包

```bash
bash deploy/mac/build.sh                  # 默认连 http://192.168.3.56:5055
bash deploy/mac/build.sh http://别的地址:5055
```

脚本顺序（**不能改**，改过会出 bug）：

1. 前端构建（vite 会清空 `dist/`）；
2. **构建之后**才写 `dist/runtime-config.json` 的 `nasOrigin` ——
   反过来写会被 vite 覆盖，客户端就会让用户手填地址（这个 bug 真的发生过）；
3. `tauri build --config '{"build":{"beforeBuildCommand":""}}'`（禁止二次构建，保住配置）；
4. ad-hoc 签名 + `codesign --verify`；
5. **核对配置仍在**，丢了就报错退出。

重新打包后**可能再问一次本地网络权限**——ad-hoc 签名每次身份都变。
