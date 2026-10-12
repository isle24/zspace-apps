# 本地 PC / H5 构建与后续交付

日期：2026-10-10。PC 使用 Tauri 2 + React/TypeScript；手机先做响应式 H5，iOS/Android/HarmonyOS 原生包后置。NAS 客户端直接调用官方 API，Go 只提供可独立部署的第三方应用商店。早期 Go NAS 网关方案退役，不继续实现 `/api/nas` 合同。

## 当前产物与职责

| 产物 | 用途 | 当前限制 |
| --- | --- | --- |
| `dist/index.html` | NAS 桌面/H5 客户端 | 浏览器受保护请求受 CORS/Cookie 约束，生产同源方案待验收 |
| `dist/store.html` | 无需 NAS 账号的独立商店网站 | 安装需要独立管理员与已配置安全存储/执行目标 |
| `Space Desktop.app` | 本机 arm64 Tauri 客户端 | 已构建并完成原生公钥探测；真实登录、读取和媒体另验 |
| Go `space-gateway` | 独立商店 API、SQLite 和静态网站 | 历史文件名；不注册 `/api/nas`，`/` 默认打开商店 |

Mac 包内保留可选商店 sidecar，但只在需要本机商店时按需启动。NAS 的登录和业务读取走 Tauri 官方 HTTP 插件，不等待 Go。原生媒体采用当前进程的 `nas-media` 协议，不开启 HTTP 服务器，DOM 使用不包含 NAS 凭据的不透明引用。

## 本地环境与复现

本轮环境记录为 macOS arm64、Go、Node/pnpm、Rust 和完整 Xcode 工具链。依赖由 pnpm-lock.yaml、Cargo.lock 与 go.sum 锁定。构建脚本单独设置 `DEVELOPER_DIR`，不修改系统全局开发目录；Xcode 窗口可关闭，工具链仍需保留。本机 `.app` 不要求付费 Apple 开发者会员，正式签名、公证与分发另行安排。

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
cd server
go test -race ./... -count=1
go vet ./...
cd ..
bash scripts/build-mac.sh
```

产物路径：`apps/client/src-tauri/target/release/bundle/macos/Space Desktop.app`。脚本先编译独立商店 sidecar，再打包 Tauri。应用不会占用、替换或重启 NAS 5055。Rust 单测、clippy、包构建与实际启动分别记录，不能只用前端 build 代替原生验收。

## H5 客户端与独立商店

NAS 客户端可直接运行 `pnpm dev`，不要求 Go 服务。默认 Vite 仅监听 loopback；浏览器通过官方接口正常登录。“测试连接”只请求公钥，成功不代表已登录或受保护文件已可读。

需要复现固定 NAS 的开发跨域行为时，可明确指定：

```sh
NAS_DEV_TARGET='http://你的NAS地址:5055' pnpm dev
```

环境变量中的地址必须替换为用户选择的 NAS。只有目标原点匹配才使用 `/__nas/`，官方路径、参数和响应保持一致；桥接仅依据本客户端正常登录的新 token/设备身份，无状态使用 Cookie，不借用官方 Mac 客户端缓存，也不持久化 Set-Cookie。该传输只供 localhost 开发，不对 LAN 暴露。正式 H5 的同源/TLS 部署与手机验证仍单独进行，不把本机代理当作生产交付。

独立商店可运行 `pnpm build` 后执行 `bash scripts/dev-h5.sh`，默认 `http://127.0.0.1:18435/` 加载商店。历史脚本名不意味着它为 NAS 提供业务代理。H5 商店使用独立账号，无需 NAS 账号；客户端设置商店服务地址也不改变 NAS 登录地址。

商店长期部署见 [独立部署说明](../../deployment/standalone-store.md)。服务监听、应用端口绑定、生成的应用访问地址与允许的浏览器来源分别由 `--listen`、`--publish-host`、`--access-host`、`--public-origin` 指定；不要混淆 LAN 暴露、反向代理来源与容器内部地址。首次管理员只能通过服务本机初始化，之后按明确配置开放访问。

## 凭据与媒体传输

NAS Token 由客户端 SDK 私有内存持有；Go 商店不接收或保存 NAS Token。Tauri 官方 HTTP 插件使用自己的正常登录 Cookie，开启 TLS 校验、禁止自动重定向。原生 `nas-media` 只给 DOM 不透明引用；媒体真实源与鉴权在本进程内处理，不建立 NAS REST 后端。

PC 凭据仅在用户主动选择保持登录时保存到系统钥匙串，自动登录另行选择；H5 不持久化密码、NAS/商店 Token。商店地址与客户端设备身份属于非敏感配置。第三方应用在独立页面/系统浏览器打开，不继承原生权限桥。

图片、原图、视频/音频直放、Range、字幕与格式兼容性逐项验证，不通过整段大视频 Blob 下载冒充流播放。未验证 HLS 或官方远程链路应明确限制，不能把封面或公钥成功当作播放成功。

## 存储与部署保护

安装前明确选择已登记的专用数据根，计划及执行时核验真实卷身份、介质与剩余空间。系统盘、eMMC、未知 Docker 镜像位置禁止拉取和安装；不自动迁移原 Docker 数据。极空间 `/tmp/zfsv3` 可能是持久化虚拟数据池，不能当成临时数据清理，也不能按路径名称认定为 SSD。

应用数据根与媒体根独立。可写安全根可用于 `data`；可读不可写音乐根只有 `mediaReadOnly`，以 `mediaReadAllowed` 判断媒体能力，不错误要求可写安装权限。媒体路径必须位于登记媒体根内，且与新实例可写目录不能互相包含；媒体始终只读。

引导阶段创建了批准的全新 `space-desktop` 专用目录并仅对它设置 `0700`；后续商店发布、日志与元数据只追加在已批准范围内。应用安装须另有执行与健康证据，脚本准备、目录登记或镜像检查都不能替代。禁止删除用户数据、格式化、prune、`down -v` 或修改已有目录权限；停止应用与关闭窗口均保留数据。

## 验收记录与发布边界

持续结果记录到 [当前验收记录](../../verification/2026-10-11-pc-store-h5.md)，本计划不固定滚动变化的测试计数或包大小。分别记录：前端回归/typecheck/build、Go race/vet、Rust 测试/clippy、Mac 构建与启动、H5/桌面交互、真实正常登录、受保护读取、图片与音视频、独立商店部署、初始化、官方入口和外网访问。

文档同步时，本机 arm64 `.app` 已构建；Mac/H5 正常登录及部分真实受保护读取已确认，当前新包仍须复验文件根、影视详情和媒体。独立商店 18435 管理员已配置，新的重试服务已追加部署；首次 Uptime Kuma 任务在镜像拉取阶段失败。示范应用安装和完整媒体能力仍不能记为全部完成。

用户验收确认后，再创建 GitHub 仓库、Actions、Release 与多平台产物。当前不创建 workflow、不推送、不公开发布。未来 CI 不连接用户 NAS、不上传其 SSH 密钥或账号；Windows/Linux 与原生手机工具链、签名和实机验证另行安排。[历史手机平台调研](../../research/2026-10-10-flutter-harmony-desktop.md) 继续保留，不改变当前 Tauri/H5 决策。
