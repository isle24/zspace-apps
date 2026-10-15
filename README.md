# Space Desktop · 空间桌面

面向极空间现有 5055 服务的第三方客户端，以及可独立使用的第三方应用商店。PC 使用 Tauri 2 + React/TypeScript；手机当前使用响应式 H5。NAS 客户端使用官方 API；H5 通过 Go 同源代理转发请求，独立商店由 Go 服务维护目录与部署任务。

界面采用**飞牛 fnOS 视觉语言**（用户选定）：桌面外壳、左侧应用栏、应用窗口、登录页、右上角资源挂件与全部应用窗口都按 fnOS 的真实界面复刻，数值来自对 fnOS Web 端的实测，素材来自用户本机 fnOS。详见[飞牛 UI 实施计划](docs/superpowers/plans/2026-10-11-fnos-full-ui.md)。

项目提供 NAS H5 与独立商店部署，GitHub Actions 构建 macOS、Windows 与 Linux 桌面客户端；安装包当前未签名。原生 iOS/Android/HarmonyOS 尚未交付。源码与构建见 [isle24/zspace-apps](https://github.com/isle24/zspace-apps)，公开目录与部署文件见 [isle24/nas-app-store-catalog](https://github.com/isle24/nas-app-store-catalog)。

## SSH 一键安装

支持 Linux AMD64、Docker 20.10 及以上（包含 24、26），默认安装 UI＋独立商店。登录 NAS 的 SSH 后执行，自动识别本机 IP 和固态数据盘，将 Compose 与数据保存在该盘的新目录后启动：

```sh
installer="$(mktemp /tmp/zspace-install.XXXXXX)" && curl -fsSL https://zstore.2iwm.com/install.sh -o "$installer" && sh "$installer"
```

首次账号在网页创建；只装商店加 `--shop-only`，指定地址加 `--ip NAS_IP`。已有项目会停止安装并保留数据。[完整说明与预检查](docs/deployment/ssh-install.md)。

<!-- combined-ui-shop-start -->
## UI 和商店合并部署

适用于全新部署的 AMD64 极空间，Docker 20.10 或更新版本，NAS 官方服务使用默认 5055 端口。把下面所有 `192.168.3.56` 替换为自己的 NAS 局域网 IP，直接粘贴到 Docker Compose 即可；不需要 `.env`、SSH 初始化或 PostgreSQL。

```yaml
# Replace every 192.168.3.56 with your NAS LAN IP. Fresh AMD64 ZSpace deployment.
name: zspace-suite
services:
  ui:
    image: isle204/zspace-ui:latest
    pull_policy: always
    platform: linux/amd64
    network_mode: bridge
    user: "10001:10001"
    init: true
    restart: unless-stopped
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    labels:
      io.space-store.service: space-store
      io.space.role: ui
    ports: ["192.168.3.56:18436:18436"]
    environment:
      NAS_ORIGIN: http://192.168.3.56:5055
      UI_PUBLIC_ORIGIN: http://192.168.3.56:18436
      SPACE_STORE_ENDPOINT: http://192.168.3.56:18443
    volumes: [ui-data:/data]
    tmpfs: ["/tmp:rw,noexec,nosuid,size=32m"]
    depends_on:
      shop:
        condition: service_healthy

  shop:
    image: isle204/zspace-shop:latest
    pull_policy: always
    platform: linux/amd64
    network_mode: bridge
    restart: unless-stopped
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    stop_grace_period: 45s
    labels:
      io.space-store.service: space-store
      io.space.role: standalone-shop-bootstrap
    environment:
      NAS_IP: 192.168.3.56
      SHOP_PORT: "18443"
      SHOP_UI_ORIGIN: http://192.168.3.56:18436
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - shop-control:/control
    tmpfs: ["/tmp:rw,noexec,nosuid,size=32m"]

volumes:
  ui-data:
  shop-control:
```

先打开 `http://你的NAS地址:18443/` 创建独立商店管理员，再打开 `http://你的NAS地址:18436/`，使用自己的极空间账号登录 UI；UI 内的空间商店使用前面创建的商店账号。两个账号各自独立。

`SHOP_UI_ORIGIN` 明确允许 UI 调用商店；首次创建账号仍在 18443 的直接页面完成。商店会自动生成自己的运行容器，无需另行安装执行器。镜像默认 `latest`；更新时保留原项目、目录和数据卷。

已有独立商店接入 UI 时，保留原项目名、`shop-control` 卷、NAS 地址、端口和数据目录，升级至 `2026.10.15-r2` 或更新镜像，并新增 `SHOP_UI_ORIGIN`。不要将上面的新项目名套用到旧商店。升级会核对并保留原账号与目录；已有 UI 来源的替换或删除不在自动迁移范围。
<!-- combined-ui-shop-end -->

<!-- standalone-shop-start -->
## 独立商店 Docker（无需第三方桌面）

只需要应用商店的极空间玩家，部署 `isle204/zspace-shop:latest` 即可。首次在网页创建本地管理员账号，之后使用自己的商店账号登录；无需第三方 UI、NAS 会话、SSH 初始化或 PostgreSQL。支持 AMD64、Docker 20.10 及以上。

把 `NAS_IP` 改为自己的 NAS 地址，粘贴到极空间 Docker Compose：

```yaml
# Paste into ZSpace Docker Compose. Change NAS_IP to your NAS LAN address.
name: zspace-shop
services:
  shop:
    image: isle204/zspace-shop:latest
    platform: linux/amd64
    network_mode: bridge
    restart: unless-stopped
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    stop_grace_period: 45s
    labels:
      io.space-store.service: space-store
      io.space.role: standalone-shop-bootstrap
    environment:
      NAS_IP: 192.168.3.56
      SHOP_PORT: "18443"
      # Optional: an unused dedicated folder on a physical NAS data disk.
      # SHOP_DATA_ROOT: /data_n008/space-shop
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - shop-control:/control
    tmpfs: ["/tmp:rw,noexec,nosuid,size=32m"]
volumes:
  shop-control:
```

启动后打开 `http://你的NAS地址:18443/`。引导服务自动创建并管理独立商店运行容器；数据保存在 NAS 物理数据盘上的独立目录，`shop-control` 保存部署记录。保留控制卷、目录和原配置，停止后重启会复用同一商店。安装时默认应用目录自动核验，也可手动添加或创建专用目录。云端账号用于安装云端发布的应用、备份与同步，可在商店内单独注册登录。更新保留原项目与数据卷，拉取 `latest` 并重新创建即可；版本标签同时保留。

详见[独立商店部署说明](docs/deployment/standalone-shop-docker.md)。

<!-- standalone-shop-end -->

## 本轮部署与管理员能力

- [iPhone 玻璃风格媒体验收](docs/verification/2026-10-15-ios-glass-media.md)：影视与音乐的玻璃导航、播放条、明暗主题和实际 UI 问题修复。
- [2026-10-15 审查修复与验收](docs/verification/2026-10-15-review-repairs.md)：登录与退出、图标、目录与安装计划、旧商店升级及真实 NAS 验收。
- [DockerHub 镜像一键部署](docs/deployment/dockerhub.md)：`isle204/zspace-ui:2026.10.15-r5`、`isle204/zspace-shop:2026.10.15-r3` 与 `isle204/zspace-store:2026.10.15-r2`，各自同时提供 `latest`（Linux AMD64），无需源码编译。
- [2026-10-13 UI、镜像与目录验收](docs/verification/2026-10-13-ui-docker-catalog-delivery.md)：统一商店、全局影视背景、深色主题、启动器与缓存修复；NAS 已更新。
- [fnOS 全目录导入](docs/deployment/fnos-catalog-import.md)：176 条应用已全部公开展示；13 条有安装入口，163 条标记待适配。公开展示不代表已经适配极空间安装。
- [两个 Docker Compose 部署入口](docs/deployment/docker-compose.md)：NAS 三方 UI、云商店与 PostgreSQL 后台；另说明 NAS 本地应用安装执行器的受管部署。
- [逐项反馈与交付核对清单](docs/verification/2026-10-12-delivery-checklist.md)。
- [客户端 Actions](https://github.com/isle24/zspace-apps/actions/workflows/client-build.yml)。
- 云后台支持 AI 服务配置、镜像资料辅助、单服务 Compose 草稿导入、图标预览、后端图标分发、容量与热度控制的镜像缓存池及 TOTP 双重验证。
- 生产管理员首次登录需扫码并提交正确动态码才完成绑定；本地可取消强制绑定要求。AI 密钥由管理员在后台配置，数据库加密保存。

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

商店使用单独管理员账号和密码，没有默认密码。公开浏览目录不要求 NAS 登录；安装、存储登记、实例管理和任务查询需要商店授权。独立商店 Docker 支持从 NAS 局域网地址首次创建管理员；本机 sidecar 的默认初始化仍只允许 loopback。客户端切换商店地址会注销旧商店会话。

商店可在目标设备使用本地 Docker，也可在管理机使用已配置且 `usable: true` 的 sshbind 别名。安装目标以该商店的执行引擎与登记目录为准。独立部署、引导安装与访问配置见 [商店部署说明](docs/deployment/standalone-store.md)。服务参数区分 `--listen`（商店监听）、`--publish-host`（应用端口绑定）、`--access-host`（客户端访问应用的主机）和 `--public-origin`（显式浏览器来源）。

原生客户端未配置外部商店地址时，可按需启动本机独立商店 sidecar。其非敏感配置为 `~/Library/Application Support/com.isle.space-desktop/gateway.json`：

```json
{"engine":"sshbind","sshAlias":"你的已有别名","storageRoot":"/你的数据盘/专用商店目录"}
```

历史文件名不代表它是 NAS 网关。未配置安装引擎时仍可连接 NAS；变更本机商店配置后重新打开客户端，不要在安装任务进行中重启。

- 安装数据必须位于已登记、可写且通过安全检查的数据盘专用目录；可登记已有目录，或勾选“创建目录”在已核验的数据根下创建专用子目录。系统盘、eMMC 和不能确认的 Docker 镜像位置阻止安装。
- SSD/HDD、虚拟存储池、未知介质分别显示真实检测结果。极空间 `/tmp/zfsv3` 可能是持久化数据池，不能按普通临时目录处理，也不能按名称认定 SSD。
- 应用数据根 `rootId` 与媒体根 `mediaRootId` 分开。Navidrome 的 `mediaPath` 必须位于所选媒体根内部；媒体只读挂载。可读不可写的现有音乐库允许登记为 `mediaReadOnly`，不能用来安装应用数据。
- Docker 镜像位置、应用数据位置及媒体卷身份分别核验。服务端生成固定计划，确认后再执行；源文件与应用数据目录不能互相包含。
- 失败安装可生成新的不可变重试计划，再次核对并确认；保留原实例、数据目录、端口、计划及任务历史，不隐式升级镜像。已存在的容器仅在完整复核归属后恢复；活动任务不能重复提交。
- 关闭窗口只改变 UI，停止实例保留数据。不提供删除、格式化、清空、prune 或 `down -v`，不修改 NAS 5055 和原网页。

独立商店默认访问端口为 `18443`，安装器内部监听 `18435`。2026-10-14 已在极空间独立验收环境完成账号创建、目录创建、Uptime Kuma 安装、首次配置页访问、重启后登录及停止操作，见[验收记录](docs/verification/2026-10-14-shop-usability-repair.md)。此记录不代表目录中每款应用均已完成运行验收。

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


<!-- copy-compose-start -->
## Docker Compose 直接复制部署

以下镜像使用 `latest`，平台为 `linux/amd64`。新用户优先使用本文顶部的 UI 与独立商店组合配置；下面的 UI 配置适用于已有受管控制器的部署，云后台配置用于自行运营应用目录。

## NAS 三方 UI

把 `192.168.3.56` 改为实际 NAS 地址，并确认官方 API 为 `5055`、已有受管安装控制器为 `18441`。控制器的 NAS 身份来源须与 UI_PUBLIC_ORIGIN 相同。当前 NAS 已部署 UI，不要在同一端口同时启动第二个实例；迁移保留原控制器和数据。

```yaml
# Save as compose.yaml; replace all example NAS addresses together.
name: zspace-ui
services:
  ui:
    image: isle204/zspace-ui:latest
    platform: linux/amd64
    user: 10001:10001
    restart: unless-stopped
    init: true
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    labels:
      io.space-store.service: space-store
      io.space.role: ui
    ports: ["192.168.3.56:18436:18436"]
    environment:
      NAS_ORIGIN: http://192.168.3.56:5055
      UI_PUBLIC_ORIGIN: http://192.168.3.56:18436
      SPACE_STORE_ENDPOINT: http://192.168.3.56:18441
    volumes: [ui-data:/data]
    # Optional authorized host Docker management: uncomment both additions,
    # replace 989 with `stat -c '%g' /var/run/docker.sock`, then recreate ui.
    # group_add: ["989"]
    # Add "/var/run/docker.sock:/var/run/docker.sock:ro" to volumes above.
    tmpfs: ["/tmp:rw,noexec,nosuid,size=32m"]
    healthcheck:
      test: [CMD-SHELL, "wget -qO- http://127.0.0.1:18436/healthz >/dev/null"]
      interval: 30s
      timeout: 3s
      start_period: 15s
      retries: 3
volumes:
  ui-data:
```

```bash
docker compose up -d
```

打开 `http://NAS_IP:18436/`。需要管理宿主 Docker 时，按 YAML 注释添加 socket 和其 GID；默认通过现有 NAS 服务访问设备，安装功能由已配置的本地控制器执行。

## 云商店后台

将 `SPACE_PUBLIC_ORIGIN` 改为实际 HTTPS 来源。这里仅绑定本机 `127.0.0.1:18442`，现有 HTTPS 反向代理转发到该端口；本机测试可以把来源改为 `http://127.0.0.1:18442`。当前 `zstore.2iwm.com` 已有后台，已有实例迁移需恢复原数据库、私有元数据和密码卷。

```yaml
# Save as compose.yaml. No .env, host secret file or deployment script required.
name: zspace-store
services:
  secret-init:
    image: isle204/zspace-store:latest
    platform: linux/amd64
    restart: "no"
    read_only: true
    cap_drop: [ALL]
    cap_add: [SETUID, SETGID]
    security_opt: [no-new-privileges:true]
    labels: {io.space-store.service: space-store, io.space.role: secret-init}
    entrypoint: [/bin/sh, -ec]
    command:
      - |
        set +x
        umask 077
        task_secret=/secret-store/postgres-password
        if [ -e "$$task_secret" ] || [ -L "$$task_secret" ]; then
          [ -f "$$task_secret" ] && [ ! -L "$$task_secret" ] && [ -s "$$task_secret" ] &&
            [ "$$(stat -c '%a' "$$task_secret")" = 600 ] || {
              echo 'Existing database secret is invalid; restore the original secret.' >&2; exit 1;
            }
          exit 0
        fi
        # Both images create these data directories with private ownership.
        # Switch to their owners to inspect without DAC override permissions.
        task_pg_owner="$$(stat -c '%u:%g' /existing-postgres)"
        task_catalog_owner="$$(stat -c '%u:%g' /data)"
        task_pg_entries="$$(su-exec "$$task_pg_owner" ls -A /existing-postgres)"
        task_catalog_entries="$$(su-exec "$$task_catalog_owner" ls -A /data)"
        if [ -n "$$task_pg_entries" ] || [ -n "$$task_catalog_entries" ]; then
          echo 'Persistent database or catalog data exists but its secret is missing. Restore the original secret volume.' >&2
          exit 1
        fi
        chmod 700 /secret-store
        set -C
        od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$$task_secret"
        [ "$$(wc -c < "$$task_secret")" -eq 64 ]
        chmod 600 "$$task_secret"
    volumes:
      - database-secret:/secret-store
      - postgres-data:/existing-postgres:ro
      - catalog-data:/data:ro
  postgres:
    image: postgres:17
    platform: linux/amd64
    restart: unless-stopped
    labels: {io.space-store.service: space-store, io.space.role: database}
    depends_on:
      secret-init: {condition: service_completed_successfully}
    environment:
      POSTGRES_USER: zstore
      POSTGRES_DB: zstore
      POSTGRES_PASSWORD_FILE: /secret-store/postgres-password
      POSTGRES_INITDB_ARGS: --auth-host=scram-sha-256
    volumes:
      - postgres-data:/var/lib/postgresql/data
      - database-secret:/secret-store:ro
    networks: [database]
    healthcheck:
      test: [CMD-SHELL, "pg_isready -U zstore -d zstore"]
      interval: 10s
      timeout: 3s
      start_period: 15s
      retries: 10
  catalog:
    image: isle204/zspace-store:latest
    platform: linux/amd64
    restart: unless-stopped
    init: true
    read_only: true
    cap_drop: [ALL]
    cap_add: [SETUID, SETGID]
    security_opt: [no-new-privileges:true]
    labels: {io.space-store.service: space-store, io.space.role: catalog}
    depends_on:
      postgres: {condition: service_healthy}
    ports: ["127.0.0.1:18442:18442"]
    environment:
      SPACE_PUBLIC_ORIGIN: https://zstore.example.com
      SPACE_ADMIN_2FA_REQUIRED: "1"
      SPACE_IMAGE_CACHE_DEFAULT_BYTES: "5368709120"
      SPACE_DB_HOST: postgres
      SPACE_DB_USER: zstore
      SPACE_DB_NAME: zstore
      SPACE_DB_PASSWORD_FILE: /secret-store/postgres-password
    volumes:
      - catalog-data:/data
      - database-secret:/secret-store:ro
    tmpfs: ["/tmp:rw,noexec,nosuid,size=32m"]
    networks: [default, database]
    healthcheck:
      test: [CMD-SHELL, "wget -qO- http://127.0.0.1:18442/api/health >/dev/null"]
      interval: 30s
      timeout: 3s
      start_period: 20s
      retries: 3
  setup:
    profiles: [setup]
    image: isle204/zspace-store:latest
    platform: linux/amd64
    user: 10001:10001
    init: true
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    labels: {io.space-store.service: space-store, io.space.role: setup}
    stdin_open: true
    tty: true
    entrypoint: [/usr/local/bin/setup-admin]
    volumes: [catalog-data:/data]
    tmpfs: ["/tmp:rw,noexec,nosuid,size=32m"]
networks:
  database:
    internal: true
volumes:
  database-secret:
  postgres-data:
  catalog-data:
```

```bash
docker compose up -d
```

数据库密码在首次运行时随机生成，保存在独立私有卷；重复运行沿用原密码。已有数据而密码丢失时初始化会停止，要求恢复原密码卷。

首次初始化管理员，在这个 Compose 目录执行一条命令：

```bash
docker compose stop catalog && docker compose run --rm -it setup && docker compose up -d
```

按提示输入用户名、密码和确认密码，密码不回显。然后打开 `https://你的域名/admin/`，扫码并输入正确动态验证码完成 2FA 绑定。此命令的元数据引导服务仅监听容器内回环地址。

持久卷分别保存 UI 数据、云私有元数据、PG 数据和 DB 密码。更新时执行 `docker compose pull` 后再执行 `docker compose up -d`，保留数据卷；仅执行 `up -d` 不保证拉取新的 `latest`。生产账户和目录状态不装入 Docker 镜像；新实例与已有服务的数据迁移见[备份与迁移](docs/deployment/store-backup-migration.md)。

应用公开目录提供 176 条记录：13 款有安装入口（6 个已有 NAS 配方及 7 个签名云交付），163 条公开资料待适配。新增 6 款通过本轮镜像与部署清单核验；未把核验失败的镜像或飞牛原生 FPK 声明为可安装。

<!-- copy-compose-end -->
