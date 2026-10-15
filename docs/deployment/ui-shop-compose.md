# 极空间 UI 与独立商店一起部署

适用于全新部署的 AMD64 极空间，Docker 27.3 或更新版本，NAS 官方服务使用默认 5055 端口。把下面所有 `192.168.3.56` 替换为自己的 NAS 局域网 IP，直接粘贴到 Docker Compose 即可；不需要 `.env`、SSH 初始化或 PostgreSQL。

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

标准组合配置提供 NAS 桌面与商店安装，不把 Docker socket 暴露给 UI。UI 的全宿主 Docker 管理需按单独 UI 部署说明配置 socket 权限；商店安装与管理由独立商店执行器完成，不受此限制。
