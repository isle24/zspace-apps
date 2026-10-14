# DockerHub 镜像一键部署

只需要 NAS 应用商店时，使用[独立商店 Docker 配置](./standalone-shop-docker.md)：`isle204/zspace-shop:latest` 包含商店页面和安装执行器，首次在网页创建自己的本地管理员，不依赖第三方 UI。已验证 AMD64 极空间、Docker 27.3 及以上。

以下 UI 和中央后台部署包只需要 Bash、Docker Engine 和 Docker Compose v2+，不需要本机 Node、Go、Python 或源码构建。两个项目使用独立名称与持久卷，可以分别更新。

| 项目 | 镜像 | 入口 |
| --- | --- | --- |
| NAS 三方 UI | `isle204/zspace-ui:latest` | 桌面 `/`、商店 `/shop.html`、`/space-store/` |
| 云商店后台 | `isle204/zspace-store:latest` | 管理后台 `/admin/`、云目录 `/api/cloud/` |

镜像目标架构为 Linux AMD64。Compose 默认使用 `latest`，用户更新时无需修改版本号；每次发布同时保留明确版本 tag，便于记录和回溯。DockerHub 页面：[UI](https://hub.docker.com/r/isle204/zspace-ui)、[商店后台](https://hub.docker.com/r/isle204/zspace-store)。

解压部署包后进入含 `deploy.sh`、`ui/`、`catalog/` 的目录。若从仓库运行，先 `cd deploy/dockerhub`。两套 Compose 都只引用镜像，没有 `build`。

## NAS UI

复制配置并填写实际地址：

```bash
cp ui/config.example.env ui/.env
```

例如同一台 NAS 上的局域网部署：

```dotenv
UI_BIND_IP=192.168.3.56
UI_PORT=18436
NAS_ORIGIN=http://192.168.3.56:5055
UI_PUBLIC_ORIGIN=http://192.168.3.56:18436
SPACE_STORE_ENDPOINT=http://192.168.3.56:18441
```

`NAS_ORIGIN` 固定为官方 NAS API 上游；`UI_PUBLIC_ORIGIN` 是浏览器真正打开的来源，不能混用两个端口。部署：

```bash
bash deploy.sh ui
```

页面与官方 API 通过同源代理访问。命令会拉取镜像、启动服务并等待健康检查；默认不挂宿主 Docker socket。访问 `UI_PUBLIC_ORIGIN` 对应地址。

需要在 UI 管理宿主 Docker 时，明确使用可选配置：

```bash
bash deploy.sh ui --with-docker
```

脚本读取 `/var/run/docker.sock` 的宿主 GID，给容器内普通账号 UID `10001` 添加该组。管理代理通过 Engine REST 工作，不需要镜像内 Docker CLI。socket 的 `:ro` 只限制挂载文件写入，仍允许 Engine API 写操作；此选项应只用于已授权的 NAS。服务保护标签阻止页面停止或重启 UI、商店及其数据库自身。

**NAS 应用安装仍需要受管本地控制器。** `SPACE_STORE_ENDPOINT` 应指向 NAS 本地安装服务，例如既有 `18441`，不能指向云目录后台。该控制器的固定 NAS 身份来源必须与 `UI_PUBLIC_ORIGIN` 一致；如果换了 UI 的浏览器来源，需要走受管控制器配置/迁移流程。留空时只启动 `engine=disabled` 基础网关，不能安装应用。单独挂 UI 的 Docker socket不会把基础网关变成安装引擎。

已有 NAS 使用 `18436` 时，不要同时在相同 IP/端口启动第二套 UI。保留既有客户端更新路径，或先安排受控迁移；不能通过更换项目名、清空卷或改 UI 来源绕过原控制器的身份绑定。

## 云商店后台

```bash
cp catalog/config.example.env catalog/.env
```

配置 `SPACE_PUBLIC_ORIGIN` 为实际公开 HTTPS 来源，例如 `https://zstore.example.com`；默认仅发布 `127.0.0.1:18442`，由同机 HTTPS 反代接入。首次本机验证可使用 `http://127.0.0.1:18442`。

```bash
bash deploy.sh catalog
```

首次运行会生成随机 PostgreSQL 密码文件 `catalog/.env.postgres-password`，权限为 `0600`，通过 Compose secret 提供给后台与数据库。密码不写入 `.env`，也不打印。随后启动仅监听容器内部回环地址的 bootstrap 服务，交互输入管理员用户名、密码与确认密码；密码输入不回显，JSON 经标准输入送入容器，响应中的会话不会打印。初始化成功后停止 bootstrap，再启动正常后台与 PostgreSQL 17。

正常后台使用 API-only 中央目录模式，不是 NAS 安装控制器；`/` 显示服务说明，管理入口为 `/admin/`。生产默认 `SPACE_ADMIN_2FA_REQUIRED=1`，第一次管理员登录需绑定双重验证。首次新库默认启用 **5 GiB** 镜像缓存，通过 `SPACE_IMAGE_CACHE_DEFAULT_BYTES=5368709120` 设置；已有数据库保存的缓存设置不会被启动变量覆盖。

数据库没有宿主发布端口，只在独立内部网络提供连接。后台另外接出站网络，以访问镜像仓库、AI 服务和素材目录。应用元数据、缓存和数据库使用独立持久卷。

## 已有数据、迁移与更新

再次运行同一项目时，脚本保留原配置、secret、数据库和数据卷；已有后台容器或已配置的管理员不会重新初始化。迁移时恢复原 PostgreSQL secret 与数据后，明确跳过管理员初始化：

```bash
bash deploy.sh catalog --skip-admin-bootstrap
```

已有商店容器或项目数据卷而 secret 文件缺失时，脚本会停止并要求恢复原文件，不会生成一个新密码去连接旧数据库。恢复的卷即使没有 Compose 标签，只要使用项目的 `catalog-data` 或 `postgres-data` 名称，同样会受到保护。请把原 secret 一起纳入私有备份，不要重新生成或上传公开仓库。

升级前保留当前镜像 ID、版本配置、原 secret，并对 PostgreSQL 做一致性备份，同时备份服务的私有元数据卷。将 `.env` 中镜像改成新版本，再执行相同命令即可拉取并更新；脚本不执行 `down -v`、`rm` 或清理数据操作。恢复步骤见[商店备份与迁移](./store-backup-migration.md)，已有受管 NAS 控制器升级见[控制器更新](./controller-update.md)。

上述备份文档中的每日 systemd timer 仅安装在既有 zstore 服务器；本 Compose 部署包没有自动创建定时备份，新部署需自行配置。控制器更新工具需要仓库中的 Python 源码及其版本校验流程，不能仅凭这两个镜像更新已有 NAS 控制器。

在 `deploy/dockerhub` 目录执行以下最小一致性备份。示例使用默认项目 `zspace-store` 和默认 secret 路径；自定义项目名时同时替换命令中的项目名和卷名，自定义 secret 路径时替换复制来源。先停止 catalog，保持 PostgreSQL 运行，避免数据库转储与私有元数据之间出现新的后台写入：

```bash
set -e
umask 077
backup_dir="$PWD/private-backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"
catalog_compose() {
  docker compose --env-file catalog/.env --project-name zspace-store -f catalog/compose.yaml "$@"
}
catalog_compose stop catalog
catalog_compose exec -T postgres pg_dump -U zstore -d zstore -Fc > "$backup_dir/postgres.dump"
catalog_compose run --rm --no-deps -T --entrypoint tar --user 10001:10001 \
  --volume zspace-store_catalog-data:/data:ro catalog -C /data -czf - . > "$backup_dir/catalog-data.tgz"
cp catalog/.env "$backup_dir/catalog.env"
cp catalog/.env.postgres-password "$backup_dir/postgres-password"
chmod 600 "$backup_dir"/*
catalog_compose images --format json > "$backup_dir/images.json"
catalog_compose up -d --no-build --pull never --wait catalog
```

命令失败时 catalog 保持停止，检查并完成备份后再启动；不要把不完整转储用于恢复。备份目录包含数据库密码、后台私有资料和可能的镜像缓存，应放在私有存储并另存到独立介质。恢复时使用相同版本镜像、原 secret 和对应项目的两个持久卷，并按备份文档验证健康与后台数据，避免清理现有卷。

旧 NAS UI 的 `/data` 卷可能是 root 拥有的 `0700` 目录，新镜像使用 UID/GID `10001:10001`。默认新卷会继承镜像的正确归属。迁移旧卷前先备份，再仅校正 UI 自身 `/data` 中服务文件的归属，或继续使用既有发布更新路径；不要递归修改 NAS 业务目录，也不要清空旧卷。

可用独立项目名部署测试实例，保持端口与公开来源一致：

```bash
bash deploy.sh catalog --config /专用目录/商店.env --project-name zspace-store-test
```

镜像已通过 `docker load` 导入、或本地验证时，可加 `--no-pull`，整个启动过程不访问镜像仓库。此时 PostgreSQL 17 镜像也必须已在本机。

查看状态与日志：

```bash
docker compose --env-file ui/.env -f ui/compose.yaml ps
docker compose --env-file catalog/.env -f catalog/compose.yaml ps
docker compose --env-file catalog/.env -f catalog/compose.yaml logs --tail 100 catalog
```

使用自定义 secret 路径时，将 `POSTGRES_PASSWORD_FILE` 设置为直接文件路径，不使用变量表达式；一键脚本会按配置文件所在目录解析相对路径。手工运行 Compose（含备份命令）时，请先把 `POSTGRES_PASSWORD_FILE` 导出为同一文件的绝对路径，避免 Compose 按自身 YAML 所在目录解析到其他位置。整个部署过程不读取或重写 `sshbind` 配置，也不复制服务器 SSH 凭据。

## 发布镜像

以下入口每次用同一构建同时推送版本与 `latest` 标签：

```bash
bash scripts/publish-docker.sh shop 2026.10.14-r2
bash scripts/publish-docker.sh ui 2026.10.14-r2
bash scripts/publish-docker.sh store 2026.10.14-r2
```

独立 NAS 商店更新使用其部署文档中的受管切换流程。中央后台、UI 与应用数据卷均须保留，更新不要删除数据卷。
