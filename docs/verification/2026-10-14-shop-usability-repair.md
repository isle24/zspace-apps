# 商店可用性与 latest 升级验收

## 已完成修复

- 安装目录首次读取实时核验，以条件更新固定身份；后续身份变化禁用，不能刷新接管。
- 默认可用目录自动选中，候选位置填入完整路径；可手工添加，或在已映射的数据位置创建新专用目录。已有目录不会清空或更改权限。
- 创建前核验父目录、精确 inode 与当前会话，拒绝链接、越界与已有目标。
- 公开目录主源超时后，以独立期限读取 GitHub 备用资料，不携带用户凭据。
- HTTPS 根路径提供公开目录，支持搜索、分类、图标及适配状态；保留 `/admin/`、2FA 与私有接口权限。
- 三种镜像同时发布版本与 `latest`，Compose 示例默认 `latest`；统一发布入口为 `scripts/publish-docker.sh`。
- 升级精确核验旧部署，记录持久化阶段，先停旧再切换；失败恢复旧服务，保留旧容器和凭据。当前支持数据库结构兼容的升级。

## 回归验证

- Go 全量测试通过；首次身份固定、父目录身份、会话撤销均有失败回归和修复后通过记录。
- 商店前端 311 项、后台及公开首页 23 项测试通过，类型检查及生产构建通过。
- 引导 41 项、双标签构建 3 项、部署 8 项、UI 入口 5 项测试通过；独立代码复核通过。
- 工作站和 NAS 曾成功读取 HTTPS 首页、管理员 HTML、匿名目录和前端资源，HTTP/1.1 与 HTTP/2 均有 200 记录；随后真实 Chrome 又复现前置入口的协议错误。源站持续正常，此项继续排查，不因偶然 200 判定网络故障已解决。未绕过证书校验，未新增源站 443。
- 当前数据库和匿名目录均为 176 公开、0 未发布；163 待适配，7 条云签名交付和 6 条本地配方。此次未重复发布或改应用版本。

## 极空间实机升级与安装

隔离项目 `zspace-shop-upgrade-qa-20261014`、端口 18451，从原 r1 升级到新镜像：

- StoreID `431b8b99c95a8a91b4c51dcbeff7b5f98d276e8dc253ea27` 保持，原密码登录通过。密码及会话仅存在测试进程内存，未写入文件、参数或日志。
- 默认根由待核验变为 `installAllowed=true`；通过真实 API 创建并登记 `qa-added`。
- Uptime Kuma 2.5.6 安装任务 `79b38f021f414f1088e1a815449790b61f0ed1abe7e01514` 成功，应用 HTTP 200。
- 停止任务 `85f3e6f5c77641c9e3f29627e7ed38e88386ceceb1c0f0aa` 已使应用退出。只移除确切停止的 QA 应用容器及空网络；数据、控制卷、旧/新商店容器保留，QA 服务已停止。

正式 18443 已切换 `latest`，受管容器 `812bb0619e3c63081828f98fdf279cd9f88a26d459ca06c7a9d128c7d881487e`，image config 为 `sha256:13ede9d516c1f458f998a1e1baf34c625ead3683d26df18e6e1d600cdb6c29fb`。原 StoreID 和 `configured=false` 保持，用户可自行创建账号。前端 `assets/store-AXGKm_hT.js` 的 SHA256 与本地构建相同。

## 中央服务器

- 升级前备份 `/var/backups/zspace-store/20261014T101522Z`，systemd 备份结果 success。
- 部署归档 `/opt/zspace-store/releases/shop-usability-r2-20261014T101626Z-f2bb37`，旧网关和静态文件保存在 `before/`。
- 根路径返回公开页面 HTML，匿名目录 176 条，管理员入口与 `/about` 均 HTTP 200，服务 active。

## 已有 NAS UI 与受管控制器

- 18441 已通过审计离线更新，release `controller-roots-20261014T102517Z-537226`，状态 ready。新容器 `59b6a534086492d8c5c6641febde7b2b61b9dd99bc42403198e416cc8df18fa4`，StoreID、数据映射和结构保持，schemaAdditions 为空。
- 原容器停止且保留，完整备份位于新 release 的 `backup/`。新控制器实际数据根及 Docker 缓存均通过非系统 Btrfs SSD 核验。
- 18436 的源码目录和运行目录各 117 个静态文件 SHA 相符，包含新目录选择和公开备用源。UI 容器未重启，proxy、entrypoint、runtime-config、NAS 身份来源及原 18441 连接配置保持。
- 源目录更新 helper 使用精确目录 RW 与单包 RO、只读根、cap-drop ALL、network none，没有使用 privileged。

## DockerHub 匿名核验

以下版本和 `latest` 均为 Linux AMD64，匿名读取的 OCI digest 相同：

| 镜像 | `2026.10.14-r2` 与 `latest` 的共同 digest |
| --- | --- |
| zspace-shop | sha256:826e5624cbde280e6d8a410d6091fc61665270ce898b10eded8c671b862947ee |
| zspace-ui | sha256:1f4e54ae6dc620aa9d110be1c2361b26de817439505f0ab2ca810d6d113af407 |
| zspace-store | sha256:03c6604fdc64e77f88f52a246fc30d9510ff13fb7a4223cbcda9e8012206161c |

## 真实浏览器验收

用户解锁 Mac 后，通过 Computer Use 操作真实 Chrome，在独立 QA 项目 18452 完成：

- 网页首次创建管理员，未保存到浏览器密码管理器；测试密码只在工具内存中生成、使用和清空。
- 首页实际显示 176 款应用，待适配应用禁用安装。
- 首次安装自动选中已核验默认目录；展开入口手动创建 `apps/browser-added`，新目录自动选中。
- 页面生成计划并执行 Uptime Kuma 2.5.6，任务 `4438d680401c3cc6aaa07acb2b1d72cdc20ec026b37fecaa` 完成。我的应用显示 running / healthy；点击链接实际打开 19446 `/setup`。
- 退出商店，停止并重启 Compose 后，原密码通过网页登录，安装记录保持。商店停止期间，已安装应用仍返回 HTTP 302。
- 页面停止应用任务 `e2ba1ff7ddf01f74a8ce717da3b3439cbef4ffc44f7dc9f9` 完成；退出商店并清空工具内存中的密码。

中央 HTTPS 入口的间歇性协议错误为独立排查项；不将 NAS 页面和接口安装成功当作该错误已解决。

## HTTPS 入口复测结果

已在 nj-game 对照同机站点核验 Nginx，语法检查通过，反向代理仍为 HTTP80 到127.0.0.1:18442，TLS由现有前置入口终止。临时诊断只记录合成probe，不记录用户参数、会话或请求体。54次probe的源站与上游全部200，响应回显与源日志相符。诊断已撤除，配置与原备份逐字节相同，Nginx语法检查和重载通过。

撤除后根页、后台、匿名目录的 HTTP/1.1 HEAD、HTTP/2 GET、普通urllib均200且TLS验证正常；真实Chrome随后打开HTTPS首页显示176条，搜索Uptime得到1条，后台登录页及动态码输入可访问。此前确实复现的52/92及Chrome协议错误，触发条件仍未确定，不能声称源站重载修复了某个已证实的旧worker故障。若再次出现，需要前置入口在失败时的日志和配置协同定位。

GitHub源码功能提交66ca8eb，公开README提交53ca2a0；两个README通过contents API与本地blob SHA核对相同。
