# 单独部署空间应用商店

只部署商店即可创建自己的本地管理员账号、浏览目录和在 NAS 上安装应用。不需要第三方桌面、NAS 登录会话、SSH 初始化或 PostgreSQL。`zspace-shop` 是 NAS 商店；`zspace-store` 是已有的中央目录管理后台。

适用于已验证的 AMD64 极空间、Docker 27.3 及以上。把下面的 `NAS_IP` 改为自己的 NAS 局域网地址，粘贴到极空间 Docker Compose 并启动：

```yaml
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
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - shop-control:/control
    tmpfs: ["/tmp:rw,noexec,nosuid,size=32m"]
volumes:
  shop-control:
```

打开 `http://你的NAS地址:18443/`，首次在网页创建管理员（密码至少 12 字节），之后用该账号登录。安装时默认应用目录自动核验并可直接选择；也可展开“添加安装目录”，点击候选路径或手动输入。勾选“创建新的专用目录并添加”可在已映射的应用数据位置内创建新子目录，无需先通过 SSH 创建文件夹。已有目录不会被清空或更改权限。每个部署只有一位本地管理员，已初始化的实例不再开放首次注册。云端账号用于安装云端发布的应用、备份与同步，可在商店内单独注册登录。

引导服务通过 Docker socket 自动创建和管理自己的商店运行容器；运行容器使用非 root 账号、只读系统和既有安装校验。安装应用需要此 Docker 管理权限。Compose 中不需要映射端口，因为受管运行容器会直接发布 `SHOP_PORT`。

默认在 Docker 缓存所在的物理 `/data_*` 数据盘创建独立专用目录，应用和账号保存在其中。极空间的 `/data_*/data/udata/real` 包含不同的 Btrfs 子卷，默认不把该用户数据映射当作安装根目录。`shop-control` 保存部署身份证明，应与应用数据一同保留。新目录的路径可在引导容器日志及商店存储设置中确认。

可在首次部署前设置 `SHOP_DATA_ROOT: /data_n008/space-shop` 选择另一个不存在的专用目录。已部署后保持 NAS 地址、端口、控制卷和目录设置一致；现有目录与不同容器不会被自动接管。端口占用时在首次部署前修改 `SHOP_PORT`。停止 Compose 会停止它管理的商店服务，已安装应用继续保持自己的运行状态，数据和容器保留。

更新时保留原项目名称、Compose 配置和 `shop-control`，拉取 `latest` 后重新创建引导服务。新版本会核验旧部署，保留同一账号数据库、数据目录和 StoreID，先停止旧商店再切换新服务；升级失败自动恢复旧服务，旧容器与记录保留。当前支持数据库结构兼容的升级，不提供跨不兼容数据库迁移的自动降级。

```bash
docker compose pull
docker compose up -d --wait
```

源码构建：`python3 docker/shop/build.py --tag isle204/zspace-shop:2026.10.14-r2`。脚本构建商店前端与 Go 服务，校验固定版本 Docker CLI/Compose 下载内容，再构建 AMD64 镜像；同一次构建生成版本和 `latest` 两个标签；加 `--push` 同时推送。也可使用 `bash scripts/publish-docker.sh shop 2026.10.14-r2`。
