# macOS 客户端打包（Tauri）

## 怎么做

```bash
bash deploy/mac/build.sh                 # 默认连 http://192.168.3.56:5055
bash deploy/mac/build.sh http://别的地址   # 也可以指定
```

脚本做四件事：写 `dist/runtime-config.json`（原生端默认设备地址，登录页仍可改）→
`tauri build`（自动先跑前端构建）→ 对 `.app` 做 **ad-hoc 签名** → 打印产物与体积。

## 产物

`apps/client/src-tauri/target/release/bundle/macos/Space Desktop.app`（**34.94 MiB**）

| 组成 | 说明 |
| --- | --- |
| `Contents/MacOS/space-desktop` | 20.8 MB，Mach-O **arm64**，主程序 |
| `Contents/MacOS/space-gateway` | 15.7 MB，独立商店网关（sidecar，随包分发） |
| `Contents/Info.plist` | `com.isle.space-desktop` / Space Desktop 0.1.0 / 最低 macOS 10.13 |
| `Contents/Resources/icon.icns` | 应用图标 |

## 签名状态

- 构建产物是 linker-signed adhoc；脚本再对 bundle 做一次 `codesign --force --deep --sign -`。
- 验证：`codesign -dv` → `Identifier=com.isle.space-desktop`、`Signature=adhoc`；
  `codesign --verify --deep --strict` **通过**。
- 自用不需要开发者证书；首次打开若被 Gatekeeper 拦，右键「打开」一次即可。

## 冒烟测试（2026-10-12 00:45）

在本机执行 `open "Space Desktop.app"`：

- `space-desktop` 进程存活（PID 71411），窗口注册名 "Space Desktop"（窗口号 23654，1412×?）；
- sidecar `space-gateway` 同时起来并 **监听 127.0.0.1:18435** ✓（独立商店网关）；
- 观察 30 秒无崩溃退出。

未截到窗口图：macOS 的窗口截图需要「屏幕录制」权限，当前进程没有，`screencapture -l` 报
"could not create image from window"。界面请以本机实际窗口为准。

## 已知限制

- 只做了 arm64（本机架构）。要 Intel 或通用二进制需要在 `tauri.conf.json` 里加 target 并重编。
- 未做公证（notarization）：自用无必要；如果要分发给别人，需要 Apple 开发者账号。
- 商店部分由 Codex 负责，这里只保证 sidecar 随包分发并能起来。

## 2026-10-12 03:12 重新打包

客户端的**首次打包是 00:45**，之后的 8 轮改动（剪切板能力探测、下载批量操作、文件排序、
深色主题修复、死 CSS 清理…）都不在里面。已重新打包：

| 检查 | 结果 |
| --- | --- |
| 前端构建 | `tsc -b && vite build` 退出码 0，`dist/index.html` 时间戳 **03:11:57** |
| 打包 | `.app` 内主程序时间戳 **03:12:20** —— **晚于** dist，说明嵌的是当前构建 |
| 体积 | 34.95 MiB（含 `space-desktop` 20.7 MB + `space-gateway` 15.6 MB） |
| 签名 | `codesign --verify --deep --strict` 通过（ad-hoc） |
| 启动 | 进程存活（RSS ≈ 102 MB） |
| 内置 sidecar | `http://127.0.0.1:18435/health` → **200**，`/` → 200 |

### 两个教训

1. **`strings` 查不出内容 —— 这次差点用错方法下结论。**
   我一开始用 `strings space-desktop | grep 最近才有的字符串` 判断包是不是旧的，
   结果是 0 命中，看起来像"包很旧"。其实 **Tauri 会把前端资源压缩后嵌进二进制**，
   `strings` 本来就查不到。真正可靠的证据是**时间戳顺序**（dist 先、bundle 后）
   加上"构建退出码为 0"。
   > 顺带说明：那次重新打包本身仍然是对的（00:45 的包确实早于这 8 轮改动），
   > 只是我用来证明它的方法不成立。
2. **这台机器上已经没有 `pnpm` 了**（`which pnpm` 为空、常见位置也没有）。
   `tauri.conf.json` 的 `beforeBuildCommand` 与 `deploy/nas-appstore/build.sh` 里都写着
   `pnpm build`，于是打包直接失败（exit 127）。已改成调用本地二进制：
   `./node_modules/.bin/tsc -b && ./node_modules/.bin/vite build` —— 不依赖包管理器，
   `node_modules` 装好就能构建。

### 仍然没能验证的

**界面长什么样、能不能用，我依然看不到** —— 截应用窗口需要"屏幕录制"权限，
这个会话没有。也就是说：包是新的、能起来、sidecar 能响应，但**没有人真正看过它的界面**。
这一项仍然挂在能力矩阵的 ⏳ 里，等你打开看一眼。
