# Space Desktop · 空间桌面

面向极空间现有 5055 服务的第三方客户端，以及可独立使用的第三方应用商店。PC 使用 Tauri 2 + React/TypeScript；手机当前使用响应式 H5。NAS 客户端直接调用官方 API，Go 只负责独立商店，不承担 NAS 登录、业务读取或媒体转发。

界面采用**飞牛 fnOS 视觉语言**（用户选定）：桌面外壳、左侧应用栏、应用窗口、登录页、右上角资源挂件与全部应用窗口都按 fnOS 的真实界面复刻，数值来自对 fnOS Web 端的实测，素材来自用户本机 fnOS。详见[飞牛 UI 实施计划](docs/superpowers/plans/2026-10-11-fnos-full-ui.md)。

项目处于本地构建与逐项验收阶段，不宣称厂商官方发布身份。原生 iOS/Android/HarmonyOS、GitHub 仓库、Actions 和公开发布均后置。

## 两个独立入口

| 入口 | 用途 | 是否依赖商店后端 |
| --- | --- | --- |
| `index.html` / Tauri 客户端 | NAS 正常登录、文件、相册、影视、音乐、下载、设备信息及桌面窗口 | NAS 功能不依赖 Go；商店是可选入口 |
| `store.html` / 独立商店网站 | 浏览目录、管理员登录、登记存储、安装、任务、应用启动与首次配置 | 使用独立 Go + SQLite 商店；无需 NAS 账号或桌面客户端 |

独立 Go 服务的 `/` 默认打开商店，业务接口为 `/api/store/*`；`/api/nas/*` 返回 404。历史 `server/internal/nas` 仅保留作协议测试参考，不注册到运行服务。客户端可指定独立商店服务地址，NAS 登录设备不会自动成为商店安装目标。

## 本地开发与构建

安装 Node/pnpm 后可直接开发客户端：

```sh
pnpm install --frozen-lockfile
pnpm dev
```

访问 `http://127.0.0.1:5173`。正常 NAS 登录和“测试连接”都调用官方接口；测试连接只请求公钥，不提交账号密码。浏览器直接访问受保护 NAS 接口可能受到 CORS/Cookie 限制，不以公钥可达或登录成功代表文件、媒体可用。

仅本机 H5 开发可启用固定目标的透明传输代理；将示例地址替换为用户选定的 NAS：

```sh
NAS_DEV_TARGET='http://你的NAS地址:5055' pnpm dev
```

`NAS_DEV_TARGET`（或 `VITE_NAS_DEV_TARGET`）只在 loopback 开发服务器使用。SDK 仅在选定 NAS 与配置目标完全匹配时使用 `/__nas/`；代理保留官方路径、参数和响应，只将本客户端正常登录产生的新会话用于无状态 Cookie 桥接，不读取官方 Mac 客户端缓存，不持久化 Set-Cookie。这不是自建 NAS REST API，也不是已完成的正式 H5 部署方案；正式同源部署与手机访问仍需独立验收。不要将 Vite 开发代理暴露到 LAN。

独立商店本地预览需要 Go：

```sh
pnpm build
bash scripts/dev-h5.sh
```

历史命名的 `dev-h5.sh` 现在启动的是独立商店及静态产物，默认地址 `http://127.0.0.1:18435`，不会为 NAS 提供 `/api/nas` 接口。Vite 的 `/api` 代理只用于本地商店开发。

Mac 打包需要 Rust 和完整 Xcode 工具链：

```sh
bash scripts/build-mac.sh
```

产物在 `apps/client/src-tauri/target/release/bundle/macos/Space Desktop.app`；
用法、数据位置与重打包步骤见 [macOS 客户端](docs/deployment/macos-client.md)。脚本会先重建商店 sidecar，再构建客户端。本机 arm64 包已构建，正常登录和部分受保护读取已确认；新包的文件根、影视详情与真实媒体仍须逐项验收。本地构建不要求付费 Apple 开发者会员，签名、公证与分发另行安排。

## 原生与 H5 的 NAS 传输

- 正常登录使用设备实时公钥和客户端自己的稳定设备身份。NAS Token 只保留在客户端 SDK 私有会话内存；浏览器不持久化 Token。
- Tauri 使用官方 HTTP 插件直连 NAS，保持 TLS 校验、禁止自动重定向，仅使用本客户端正常登录获得的 Cookie。NAS 功能不需要启动 Go 服务。
- 原生媒体使用进程内 `nas-media` 渲染协议：DOM 使用不透明引用，NAS 地址和凭据不进入 DOM URL；不监听 HTTP 端口，不暴露 NAS REST 接口。真实图片、音视频、Range 与格式兼容性仍单独验收。
- PC 只有主动选择“保持登录”才将凭据保存在系统钥匙串；自动登录单独选择。退出清除会话和已保存凭据。H5 仅在内存保持登录。
- 官方远程中转、HLS、字幕、完整媒体播放和系统写操作不因源码存在或包构建通过而视为已验证。

## 独立商店与存储

商店使用单独管理员账号和密码，没有默认密码。公开浏览目录不要求 NAS 登录；安装、存储登记、实例管理和任务查询需要商店授权。首次管理员配置只允许从服务本机完成，客户端切换商店地址会注销旧商店会话。

商店可在目标设备使用本地 Docker，也可在管理机使用已配置且 `usable: true` 的 sshbind 别名。安装目标以该商店的执行引擎与登记目录为准。独立部署、引导安装与访问配置见 [商店部署说明](docs/deployment/standalone-store.md)。服务参数区分 `--listen`（商店监听）、`--publish-host`（应用端口绑定）、`--access-host`（客户端访问应用的主机）和 `--public-origin`（显式浏览器来源）。

原生客户端未配置外部商店地址时，可按需启动本机独立商店 sidecar。其非敏感配置为 `~/Library/Application Support/com.isle.space-desktop/gateway.json`：

```json
{"engine":"sshbind","sshAlias":"你的已有别名","storageRoot":"/你的数据盘/专用商店目录"}
```

历史文件名不代表它是 NAS 网关。未配置安装引擎时仍可连接 NAS；变更本机商店配置后重新打开客户端，不要在安装任务进行中重启。

- 安装数据必须位于已登记、可写且通过安全检查的数据盘专用目录；目录登记不自动创建输入路径。系统盘、eMMC 和不能确认的 Docker 镜像位置阻止安装。
- SSD/HDD、虚拟存储池、未知介质分别显示真实检测结果。极空间 `/tmp/zfsv3` 可能是持久化数据池，不能按普通临时目录处理，也不能按名称认定 SSD。
- 应用数据根 `rootId` 与媒体根 `mediaRootId` 分开。Navidrome 的 `mediaPath` 必须位于所选媒体根内部；媒体只读挂载。可读不可写的现有音乐库允许登记为 `mediaReadOnly`，不能用来安装应用数据。
- Docker 镜像位置、应用数据位置及媒体卷身份分别核验。服务端生成固定计划，确认后再执行；源文件与应用数据目录不能互相包含。
- 失败安装可生成新的不可变重试计划，再次核对并确认；保留原实例、数据目录、端口、计划及任务历史，不隐式升级镜像。已存在的容器仅在完整复核归属后恢复；活动任务不能重复提交。
- 关闭窗口只改变 UI，停止实例保留数据。不提供删除、格式化、清空、prune 或 `down -v`，不修改 NAS 5055 和原网页。

引导阶段创建了用户批准的全新 `space-desktop` 专用目录，并仅对该新目录设置 `0700`。独立商店已在 NAS 的 18435 端口运行，管理员已由用户本人配置。Uptime Kuma 真实验证任务在 Docker Hub 拉取阶段失败，数据与记录保留；更新后的重试服务已部署，真实重试、健康与首次配置尚未通过，不能由商店首屏可访问推定。

## 飞牛 fnOS 界面复刻

客户端连接的仍是极空间 5055 官方接口，界面按飞牛 fnOS 复刻。视觉契约与任务划分见
[飞牛全套 UI 实施计划](docs/superpowers/plans/2026-10-11-fnos-full-ui.md)，
完整令牌/几何/控件实测见[飞牛设计系统](docs/design-assets/2026-10-11-fnos-design-system.md)，
当前效果截图见[复刻效果](docs/design-assets/fnos-replica/README.md)。

皮肤分层（按导入顺序，后加载者覆盖前者）：

| 文件 | 作用 |
| --- | --- |
| `apps/client/src/styles/fnos-theme.css` | 设计令牌（颜色/圆角/阴影/字号/尺寸），浅色默认，`:root[data-theme="dark"]` 为深色 |
| `styles/fnos-controls.css` | 共用控件：按钮、输入、标签页、工具栏、状态页、分页、对话框 |
| `styles/fnos-shell.css` | 桌面、左侧应用栏、应用窗口外壳、登录页 |
| `styles/fnos-widget.css` | 右上角资源挂件（收起胶囊 + 展开四卡） |
| `styles/fnos-media.css`、`fnos-files.css`、`fnos-store.css` | 各应用窗口皮肤 |
| `styles/fnos-dark.css` | 深色结构性覆盖（最后加载） |

真实素材（从用户本机 fnOS 导出，非重绘）：壁纸 `static/bg/wallpaper-1.webp`；
应用图标 `static/app/icons/<app>/icon.png`；应用栏 `desktop`/`launchpad` 图标；
空状态插画 `NoData/NoDevice/NoPermission/NoSearchResult` 的明暗两套。放在
`apps/client/public/app-icons/`、`public/state/`、`public/wallpaper-fnos.webp`。
远程访问与使用帮助的图标 fnOS 未提供，按同一规格（224 画布 / 28px 圆角 / 蓝色渐变）补齐。

应用窗口：默认 1100×640、圆角 16、透明标题栏 44px、右上角三个 46×44 按钮（− □ ×）、
内容区是内嵌的白色圆角窗格。左侧应用栏为通高玻璃面板，三段式：顶部「桌面 / 全部应用」、
分隔线、彩色应用图标、底部四个单色图形。右上角资源挂件 266×36，展开为运行状态 /
网络 / 存储读写 / 存储空间四张卡。

**诚实边界**：接口未返回的指标一律显示「—」，速率与图表需要真实字段和至少两个采样点，
不编造数值；未连接时所有窗口如实显示飞牛空状态插画。

## 验证与设计

```sh
pnpm test
pnpm typecheck
pnpm build
cd server
go test -race ./... -count=1
go vet ./...
```

前端回归、Rust 测试、Go race、Mac 构建、真实登录、受保护读取、媒体和应用部署分别记录。Mac/H5 当前传输已正常登录并读取部分真实列表；新包和新页面仍需独立验收，完整媒体能力尚未通过。

- [飞牛 UI 复刻验收](docs/verification/2026-10-11-fnos-ui-replica.md)：UI 全套完成，37 文件 / 1044 用例通过；真实数据态待账号
- [极空间接口连通性实测](docs/research/2026-10-11-zspace-endpoint-audit.md)：25 条路径实测，修正 `/system` → `/system/home`
- [最新 PC/H5 验收记录](docs/verification/2026-10-11-pc-store-h5.md)，旧快照保留，不作为永久能力声明。

[客户端设计](docs/superpowers/specs/2026-10-10-zspace-client-design.md)、[商店设计](docs/superpowers/specs/2026-10-10-zspace-app-store-design.md)、[本地构建安排](docs/superpowers/plans/2026-10-10-zspace-client-build-and-release.md)、[飞牛全套 UI 计划](docs/superpowers/plans/2026-10-11-fnos-full-ui.md)、[飞牛设计系统](docs/design-assets/2026-10-11-fnos-design-system.md)、[复刻效果截图](docs/design-assets/fnos-replica/README.md)、[早期视觉稿](docs/design-assets/zspace-client-gallery.md)。全部原始设计图和提示词保留；示例内容不冒充真实 NAS 数据。

## 验收与证据

想先看结论：[一页状态](docs/verification/STATUS.md)（能做什么 / 不能做什么 / 等谁）。
真机验收记录、能力总表与巡检脚本见 [docs/verification/README.md](docs/verification/README.md)。

一条命令重跑全部验收：

```bash
bash scripts/verify.sh --all    # 类型检查 + 单测 + 构建 + 两种主题回归 + 对比度 + 布局 + WebKit 渲染
```
