# Docker Compose 直接复制部署

只需要商店的 NAS 玩家，直接使用[独立商店 Compose](./standalone-shop-docker.md)，镜像 `isle204/zspace-shop:latest`，首次在网页创建自己的管理员账号，无需第三方 UI。支持 AMD64 极空间、Docker 20.10 及以上。

以下 UI 和中央后台默认使用 `latest`，当前对应 `2026.10.14-r2`，平台 `linux/amd64`。每段完整保存为各自目录的 `compose.yaml`，无需 `.env` 或宿主密码文件，也无需源码编译。

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

四个持久卷保存 UI 数据、云私有元数据、PG 数据和 DB 密码。更新时只更换镜像版本并 `docker compose up -d`，保留数据卷。生产账户和目录状态不装入 Docker 镜像；新实例与已有服务的数据迁移见[备份与迁移](store-backup-migration.md)。

应用公开目录提供 176 条记录：13 款有安装入口（6 个已有 NAS 配方及 7 个签名云交付），163 条公开资料待适配。新增 6 款通过本轮镜像与部署清单核验；未把核验失败的镜像或飞牛原生 FPK 声明为可安装。
