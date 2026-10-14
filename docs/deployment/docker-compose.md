# Docker Compose 部署与客户端构建

只需要商店的 NAS 玩家使用[独立商店 Docker](./standalone-shop-docker.md)，无需第三方桌面或中央管理后台，首次在网页创建自己的账号。

以下两个入口用于从源码构建三方 UI 和中央目录后台。NAS 三方 UI 包含桌面、商店页面和同源代理；云商店后端包含中央目录 API、管理员页面和 PostgreSQL 17。两套 Compose 使用不同项目名和数据卷，可以分别升级。

| 入口 | 配置 | 页面与接口 | 持久数据 |
| --- | --- | --- | --- |
| NAS 三方 UI | `deploy/compose/ui/compose.yaml` | `/` 桌面、`/shop.html` 与 `/space-store/` 独立商店、`/healthz` | `space-ui_ui-data` |
| 云商店后端 | `deploy/compose/catalog/compose.yaml` | `/admin/` 管理后台、`/api/cloud/` 云目录、`/api/health` | `space-catalog_catalog-data`、`space-catalog_postgres-data` |

需要 Docker Engine、Docker Compose v2 或更新版本、可访问 npm/Go 模块和基础镜像仓库的网络。Dockerfile 使用 Node 26、根 `package.json` 的固定 pnpm 版本、`pnpm-lock.yaml` 和 Go 1.26；不依赖本机 `dist`、`node_modules` 或预编译二进制。可用 `docker build --platform linux/amd64 -f docker/ui/Dockerfile .` 指定 NAS 的 AMD64 架构。

## NAS 三方 UI

在仓库根目录执行：

```bash
cp deploy/compose/ui/config.example.env deploy/compose/ui/.env
```

编辑 `.env`：`NAS_ORIGIN` 必须是固定、无用户名密码、无路径的 NAS 官方 HTTP(S) 地址，例如 `http://192.168.3.56:5055`；不能填成 UI 自己的端口。`UI_PUBLIC_ORIGIN` 填浏览器实际打开的 UI 来源，例如 `http://192.168.3.56:18436` 或反代的 HTTPS 来源。局域网直接访问时，将 `UI_BIND_IP` 改成 NAS 的实际 LAN IP。默认 `127.0.0.1` 适用于同主机 HTTPS 反代。

```bash
docker compose --env-file deploy/compose/ui/.env -f deploy/compose/ui/compose.yaml config --quiet
docker compose --env-file deploy/compose/ui/.env -f deploy/compose/ui/compose.yaml up -d --build --wait
docker compose --env-file deploy/compose/ui/.env -f deploy/compose/ui/compose.yaml ps
curl -fsS http://127.0.0.1:18436/healthz
```

页面和 `/auth`、`/v2/` 等官方接口全部通过同源 `space-proxy`，运行期 `nasOrigin` 留空。访问桌面根路径或 `/shop.html`。代理只转发源码列出的 NAS 路径，目标固定为 `NAS_ORIGIN`。基础网关的 NAS 身份来源使用 `UI_PUBLIC_ORIGIN`，与浏览器会话中的同源地址一致；认证请求再由 UI 代理转到官方上游。

`SPACE_STORE_ENDPOINT` 留空时，UI 启动 `--engine=disabled --nas-admin-only` 的基础网关：可验证 NAS 管理员会话，但没有 Docker 安装引擎。要安装、维护应用，使用 `deploy/docker-installer/build-package.py` 生成的已校验发布安装器，按 `deploy/docker-installer/install-docker.sh` 的现有受管方案部署 NAS 本地控制器，再将 `SPACE_STORE_ENDPOINT` 设为它在容器内可达的 HTTP(S) 地址。源码安装器中的 `BUILD_*` 是构建占位，不能直接作为发布安装器运行。这个值必须指向 NAS 控制器，不能指向云目录后台。控制器要求固定 NAS 身份、专用存储目录和宿主挂载证明；不要通过给 UI 加 `privileged` 或简单挂 Docker socket 绕过这些要求。

本 Compose 不挂载 Docker socket。现有 NAS UI 已经部署并绑定控制器时，优先使用既有客户端更新脚本保留控制器和数据：

```bash
pnpm --filter @space/client build
pnpm --filter @space/store build
python3 deploy/nas-appstore/push-client.py
```

该脚本使用已配置且可用的 `sshbind` 别名，先备份旧静态页面和代理，再更新。新的 Compose 是独立部署示例，不能直接复用旧项目的数据卷或替换现有容器。

已有受管 NAS 本地控制器需要更新网关版本时，使用[控制器更新说明](./controller-update.md)中的独立审核与切换流程，保留原 SQLite、StoreID 和应用数据目录。

## 云商店后端

先创建只在本机保留的配置和 PostgreSQL 密码文件。下面生成密码但不会将其打印到终端；`.env` 和 `.env.postgres-password` 已被仓库忽略。

```bash
cp deploy/compose/catalog/config.example.env deploy/compose/catalog/.env
(umask 077; openssl rand -hex 32 > deploy/compose/catalog/.env.postgres-password)
```

编辑 `.env` 中的 `SPACE_PUBLIC_ORIGIN` 为实际公开 HTTPS 来源，例如 `https://zstore.example.com`。本机试验可填 `http://127.0.0.1:18442`。生产保持 `SPACE_ADMIN_2FA_REQUIRED=1`；只有本地开发可以设置为 `0`。密码通过 Compose secret 只提供给后台与 PostgreSQL，不写入 Compose 环境配置。[Docker Compose secrets 文档](https://docs.docker.com/compose/how-tos/use-secrets/)

```bash
docker compose --env-file deploy/compose/catalog/.env -f deploy/compose/catalog/compose.yaml config --quiet
docker compose --env-file deploy/compose/catalog/.env -f deploy/compose/catalog/compose.yaml build catalog
```

新安装需要先创建管理员。常规云后台禁止 `/api/store/setup`，只会从其专用本地元数据中导入已经存在的管理员。可选 `bootstrap` 服务只监听容器内回环地址，不发布任何端口；必须在常规 `catalog` 尚未运行时使用。下面在 Bash 终端执行，密码仅通过标准输入管道进入容器，不出现在参数、文件或终端输出中：

```bash
docker compose --env-file deploy/compose/catalog/.env -f deploy/compose/catalog/compose.yaml --profile bootstrap up -d --wait bootstrap
docker compose --env-file deploy/compose/catalog/.env -f deploy/compose/catalog/compose.yaml exec -T bootstrap wget -qO- http://127.0.0.1:18542/api/health
set -o pipefail
python3 - <<'PY' | docker compose --env-file deploy/compose/catalog/.env -f deploy/compose/catalog/compose.yaml exec -T bootstrap wget --post-file=/dev/stdin --header='Content-Type: application/json' -qO /dev/null http://127.0.0.1:18542/api/store/setup
import getpass, json, re, sys
sys.stdin = open('/dev/tty', encoding='utf-8')
print('管理员用户名: ', end='', file=sys.stderr, flush=True)
username = input().strip()
password = getpass.getpass('管理员密码: ')
confirmation = getpass.getpass('再次输入密码: ')
if password != confirmation:
    raise SystemExit('两次密码不一致，未发送请求')
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', username) or not 12 <= len(password.encode()) <= 72:
    raise SystemExit('用户名须为1至64个字母、数字、下划线或短横线，密码须为12至72字节')
print(json.dumps({'username': username, 'password': password}))
PY
docker compose --env-file deploy/compose/catalog/.env -f deploy/compose/catalog/compose.yaml stop bootstrap
docker compose --env-file deploy/compose/catalog/.env -f deploy/compose/catalog/compose.yaml up -d --wait catalog postgres
docker compose --env-file deploy/compose/catalog/.env -f deploy/compose/catalog/compose.yaml ps
curl -fsS http://127.0.0.1:18442/api/health
curl -fsS http://127.0.0.1:18442/admin/ > /dev/null
```

通过 SSH 管理服务器时，在服务器的交互终端执行初始化步骤。已有部署迁移时按[备份与迁移说明](./store-backup-migration.md)恢复管理员元数据和 PostgreSQL，跳过初始化，不重新生成或覆盖现有密码文件。

后台运行 `--catalog-only --api-only --engine=disabled`，`/` 返回服务说明，`/admin/` 提供管理员页面。第一次管理员登录按页面完成 2FA 绑定并提交正确验证码。PostgreSQL 没有发布宿主端口，仅后台能从内部网络连接；后台另接出站网络以访问镜像目录、AI 服务和 GitHub。入口启动时读取权限为 `0600` 的文件 secret，再降为 UID/GID `10001` 运行 Go 服务；数据卷创建时归此账号所有。旧卷权限不匹配时服务会拒绝启动，不会递归修改已有目录。

生产将 HTTPS 反代转到 `127.0.0.1:18442`，保留 Host 和外部协议头；可沿用 `deploy/zstore/zstore.conf`，把域名改成实际值。Compose 本身不申请证书。上游请求大小需允许业务的 JSON 请求与图标上传。

## 更新与备份

升级前记录当前镜像 ID、保留原部署配置，对 PostgreSQL 做一致性备份，并在停止后台写入后备份 `catalog-data`；该卷含本地兼容元数据及缓存。NAS UI 的数据卷和控制器元数据也应保留。命名卷不可用清空卷的方式升级。

```bash
# 在仓库根目录，保留旧配置和数据卷，重新构建并更新对应服务。
docker compose --env-file deploy/compose/ui/.env -f deploy/compose/ui/compose.yaml up -d --build ui
docker compose --env-file deploy/compose/catalog/.env -f deploy/compose/catalog/compose.yaml up -d --build catalog
```

数据库备份可通过专用 PostgreSQL 容器执行，不需要暴露数据库网络端口。备份目录和文件必须私有；请把实际日期作为文件名，避免覆盖旧备份：

```bash
mkdir -p backups
chmod 700 backups
(umask 077; docker compose --env-file deploy/compose/catalog/.env -f deploy/compose/catalog/compose.yaml \
  exec -T postgres pg_dump -U zstore -d zstore -Fc > backups/zstore-20261012.dump)
```

新库恢复、最终切换和验证步骤见[商店备份与迁移](./store-backup-migration.md)。本 Compose 与已有 nj-game 上的 `zstore.service` 是不同部署入口，不要未经迁移直接让两者共用目录或同时写同一个兼容元数据库。

## GitHub Actions 客户端产物

`.github/workflows/client-build.yml` 在 `main`、`codex/**` 的相关源码推送、面向 `main` 的 PR，以及 `workflow_dispatch` 手动触发时运行。锁定 pnpm `11.25.0` 并使用 `pnpm install --frozen-lockfile`；Go 版本从 `server/go.mod` 读取。

| 目标 | Rust target | 产物 |
| --- | --- | --- |
| macOS Apple Silicon | `aarch64-apple-darwin` | 保留可执行权限的 `.app` 压缩包 |
| macOS Intel | `x86_64-apple-darwin` | 保留可执行权限的 `.app` 压缩包 |
| Linux AMD64 | `x86_64-unknown-linux-gnu` | DEB、AppImage |
| Windows AMD64 | `x86_64-pc-windows-msvc` | NSIS、MSI |

`scripts/ci-build-sidecar.mjs` 根据 Rust target 生成对应的 Go 网关，关闭 CGO，并按 `space-gateway-<target-triple>[.exe]` 命名，以匹配 Tauri 的 `externalBin` 约定。[Tauri sidecar 文档](https://v2.tauri.app/develop/sidecar/)

全部桌面产物明确标为 `unsigned`，工作流使用 `--no-sign`，没有代码签名、公证或自动更新签名凭据。macOS/Windows 首次启动可能需要系统确认；从 artifact 下载的 AppImage 先执行 `chmod +x 文件名.AppImage`。Actions 另上传 `nas-client-linux-amd64`，包含已合并的桌面/独立商店静态页面与 NAS 代理。工作流只构建和上传客户端；服务器更新继续使用本机 `sshbind` 的受管部署流程，没有将服务器密钥复制到 GitHub。构建任务通过不代表已完成 NAS 登录、应用安装或线上验收，部署后仍需验证服务健康、页面版本和实际登录流程。


## 现有服务器交付（2026-10-13）

当前极空间UI地址为 http://192.168.3.56:18436/，独立商店为 /shop.html，受管NAS执行器为18441端口；云商店管理员后台为 https://zstore.2iwm.com/admin/。本轮均已更新并核验健康，原数据和备份保留。NAS执行器受管升级与回滚步骤见[控制器更新说明](controller-update.md)。

管理员首次登录扫码并输入有效动态码完成绑定，随后在发布设置填写AI服务接口、模型和密钥。镜像缓存池已设置5 GiB，后台预热；可在后台调整容量、查看已完成缓存。预热和镜像下载依赖服务器到公开仓库的网络，缓存未命中时客户端使用原始digest地址。

四个平台桌面包和NAS H5包由[客户端Actions](https://github.com/isle24/zspace-apps/actions/workflows/client-build.yml)生成，当前包未签名。源代码在私有仓库isle24/zspace-apps，公共应用素材与目录兜底在isle24/nas-app-store-catalog。


GitHub素材自动同步：本轮已把当前公开应用资料、签名目录、部署清单与图标导出到公共目录仓库。后续后台新增/修改应用的自动同步需要在“GitHub素材同步”设置仅授权目录仓库Contents写入的凭据；留空不会自动生成发布凭据，也不会复用管理员密码或本机GitHub登录令牌。
