# 在极空间 NAS 上用 Docker Compose 跑「空间桌面」新 UI

已在本机 极空间（`192.168.3.56`）部署并验证：

```
目录：/tmp/zfsv3/nvme16/18181998187/data/docker/appstore
访问：http://192.168.3.56:18436/          新 UI（仿飞牛桌面）
      http://192.168.3.56:18436/shop.html 独立商店页
容器：space-desktop（compose 项目 space-desktop，restart: unless-stopped）
```

## 为什么必须同源（这是本轮最关键的发现）

第一版做成"浏览器直连 5055 + CORS（`Access-Control-Allow-Origin: *`）"，登录能成功，
但**进入文件夹就报「无法直接连接 NAS，请检查地址、网络与浏览器跨域条件」**。实测定位到：

1. 极空间 5055 上有一批路由（`/v2/`、`/zmusic/`、`/zvideo/`、`/transcode/`、`/downloader/`、
   `/storagepool/`、`/network-settings/` …）由 nginx 的 `auth.lua` 保护；
2. `auth.lua` 把**请求里的全部 cookie** 转发到 `/auth/token` 校验，校验不过直接
   `ngx.exit(403)`，而且这个 403 **不带任何 CORS 头**——浏览器因此报跨域失败；
3. 官方网页版能用，是因为它**本身就跑在 5055 上**，是同源，cookie 才会被带上；
4. 官方前端代码里也确实有 `document.cookie = "<name>=<value>; path=/"` 这一句。

实测（curl 直连 5055）：不带 cookie → `403`；带 `Cookie: token=<会话令牌>` → `200`。
所以 cookie 名是 **`token`**。

因此部署形态改成**前端 + NAS 接口 + 商店接口全部同源**：

```
浏览器 ──► space-proxy :18436 ──┬──► /web 静态前端（新 UI、shop.html）
（一个源）                       ├──► 极空间 5055（仅限固定前缀，见 proxy/main.go 的 nasPrefixes）
                                 └──► space-gateway :18435（/api/store/*，容器内）
```

配套的客户端改动：
- 登录成功后按官方做法写 `document.cookie = "token=<令牌>; path=/"`（**仅浏览器且接口与页面同源时**，跨源与原生端不写），退出时清除；
- 取数请求的 `credentials` 由固定 `"omit"` 改成 `credentialsFor(base)`：同源才允许携带 cookie，
  **跨源仍是 `"omit"`**，保持"凭证不出本页面来源"的既有约束。

`web/runtime-config.json` 的 `nasOrigin` 因此留空——同源规则会自动使用当前 origin，
登录页仍然只有 **账号 / 密码 / 保持登录 / 登录**。

## 部署步骤

```sh
# 1. 在本仓库生成部署产物（前端构建 + linux/amd64 网关 + 运行期配置）
bash deploy/nas-appstore/build.sh http://192.168.3.56:5055

# 2. 传到 NAS 的目标目录（该目录在极空间上是 root 所有，普通 SSH 用户写不进去，
#    需要用一个 privileged 容器代写，见 build.sh 末尾提示）

# 3. 在 NAS 上启动
cd /tmp/zfsv3/nvme16/18181998187/data/docker/appstore
docker compose up -d --build
docker compose logs -f
```

## 部署时踩到并已解决的三个坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 目标目录创建不了（SSH 用户与容器 root 都 Permission denied） | `/tmp/zfsv3/...` 是极空间的 FUSE 存储，目录 root:root 755；普通容器里的 root 与 SSH 用户都不是宿主 root | 用 `docker run --privileged --user 0:0` 的临时容器创建目录并写文件 |
| compose 报 `network appstore_default exists but was not created by compose` | NAS 上已存在同名网络（别的应用建的） | compose 文件里加 `name: space-desktop`，用独立项目名 |
| 容器反复重启：`existing DataDir must be a private directory (0700)` | 绑定挂载在 FUSE 上 chmod 后，`stat` 显示 700 但 Go 的 `Lstat` 仍看到组/其他权限位 | 数据目录改用 **Docker 命名卷**（`space-desktop-data`），不用绑定挂载 |
| 进入文件夹报「无法直接连接 NAS…跨域条件」 | 5055 的 `/v2/` 等路由由 nginx `auth.lua` 按 cookie 鉴权，403 且不带 CORS 头 | 改成同源部署（`space-proxy` 反代）+ 客户端按官方做法写 `token` cookie |

## 独立商店首次配置需要在本机做

商店的首次管理员配置被后端限制为**只能从 loopback 发起**（防反向代理越权），
所以从局域网打开 `/shop.html` 会收到 `setup_loopback_only`。在 NAS 本机执行：

```sh
docker exec space-desktop wget -qO- \
  --header 'content-type: application/json' \
  --post-data '{"username":"你的管理员名","password":"至少12位的密码"}' \
  http://127.0.0.1:18435/api/store/setup
```

之后从浏览器正常登录商店即可。安装执行引擎默认 `disabled`（商店会如实显示「执行引擎未配置」），
需要真正安装应用时再按商店页面提示登记本机 Docker 或 sshbind 别名。

## 已验证 / 未验证

已验证（均为实测）：

- `GET /` 200 且 `<title>空间桌面</title>`；`/shop.html`、`/favicon.svg`、`/runtime-config.json`、`/api/store/status`、`/api/store/catalog` 全部 200；
- 容器 `healthy`，端口 `0.0.0.0:18436->18435`；
- 部署页登录表单实测只有 账号 / 密码 / 保持登录（**没有地址框**）；
- 在部署页提交（错误凭据）后返回极空间自己的错误码 `N001200`——证明浏览器确实连通了 5055，
  不是被跨域拦截；
- 部署页内打开「应用商店」窗口，能加载**容器内后端**返回的真实目录（Uptime Kuma / Navidrome /
  Jellyfin / Immich / Syncthing，含真实 logo 与「执行引擎未配置」的真实状态），
  说明同源 `/api/store/*` 路由在部署形态下正常。

截图：`docs/design-assets/fnos-replica/11-deployed-nas-login.png`（登录页，无地址框）、
`12-deployed-nas-desktop.png`（桌面 + 应用商店窗口，数据来自容器内后端）。

未验证：**真实账号登录后的数据态**（需要极空间账号，本次只用占位凭据验证到"请求到达并被拒绝"这一步）。

## 部署脚本（别再手搓）

```bash
bash deploy/nas-appstore/build.sh    # 前端构建 + 交叉编译网关 + 组装 dist-deploy
bash deploy/nas-appstore/push.sh     # 上传 → privileged 解包 → compose 重启 → 健康检查
```

两个脚本都是 `set -euo pipefail`，任一步失败就停。

**为什么专门写这个**：之前我用一段 ad-hoc 的 bash 做同样的事，其中
`mv store.html shop.html` 没加 `-f` 判断，而且整条链用 `&&` 串联。结果有一次
**前端构建报错**（CSS 里有个悬空选择器），`dist/` 里根本没生成 HTML，
`mv` 失败后整条链静默中止 —— 现场没有任何"部署失败"的迹象，
只有事后的 `dist/` 目录看起来"少了东西"。改用脚本后，缺 `web/index.html`
会直接报错退出。

顺带记住两条：
- 用 `vite build | tail -1` 看结果会**吃掉错误信息**，构建要看退出码；
- 构建产物里**必须有 `web/index.html`**，没有就是失败，不是"部署了旧版本"。

## 运行现状（2026-10-12 实测）

在用户的极空间 Z425 上，这个服务是这样的：

```
容器      space-desktop（重启策略 unless-stopped → NAS 重启后自动拉起）
内存      19.2 MiB / 23.05 GiB
CPU       0.00%（空闲）
镜像      29 MB
目录占用  21 MB（/tmp/zfsv3/nvme16/18181998187/data/docker/appstore）
挂载      /var/run/docker.sock（只读，供 Docker 只读视图）
          space-desktop-data（命名卷 → /data，商店数据）
端口      18436
```

**为什么记这些**：这是跑在别人机器上的服务。占多少内存、多少磁盘、重启后会不会自己起来 ——
这些是"能不能长期放着不管"的判断依据，而不是部署完就不用管的细节。

`docker.sock` 挂载只读，但**只读挂载照样能调 Docker 的管理 API** ——
界面里对此如实说明（这是已知且刻意接受的边界，见 `docs/verification/2026-10-12-system-docker.md`）。
