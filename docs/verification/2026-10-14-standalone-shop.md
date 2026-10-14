# 独立商店交付验收

## 已验证的独立运行流程

- 极空间 AMD64、Docker 27.3，最终镜像独立测试端口 18450；没有部署或登录第三方 UI 来执行商店测试。
- `bootstrap.authMode=independent`、`nasAuth.enabled=false`、`setupRequiresLoopback=false`。
- Playwright 实际完成首次网页创建管理员、退出、密码登录。
- 安装执行器可用；物理 SSD 应用目录与 Docker 缓存核验通过。
- Uptime Kuma 2.5.6 实际安装任务 `4c6a26514fd8473b2a399b726c53ab3101f02759f3614f10` 状态 `succeeded/complete`，19444 端口 HTTP 302 跳转初始化页面。
- Compose 重启后，StoreID `924b68f50b15f559942df08b8b420f93196328c8ac0e363c` 与运行容器 `eacd5b7d9aba881973c1704d9d521d4b5f4178764965fd6f42ef5eb685257528` 保持一致，原密码登录通过。
- 测试密码与会话只存在测试进程/浏览器内存中，没有写入部署文件、日志、文档或仓库。

## 正式发布与部署

- DockerHub `2026.10.14-r1` 与 `latest` 均匿名验证为 Linux AMD64，digest `sha256:6f163bc659d779414aa7d9b5e5899cd0d9d6a4b9e15f377401716b23b94a2c5c`。NAS 实际运行的 image config 为 `sha256:768cc6dcff614d9bb09b508a859b5296bce0e83453f186419209609bd84a7b1e`。
- 正式 Compose 项目 `zspace-shop` 已在 `http://192.168.3.56:18443/` 健康运行，重启计数 0。`configured=false`，保留给用户本人首次创建管理员；`authMode=independent`、`nasAuth.enabled=false`。
- 验收应用通过商店停止任务 `50da401e539e12565bffada876f1635f2273a9a206d3652f` 停止，随后只移除核验过的停止 QA 应用容器与空网络。测试目录、控制卷、账号数据库和镜像均保留；QA 引导/运行服务已停止。
- 既有 UI 18436 healthz 与控制器 18441 bootstrap 均 HTTP 200。

## 回归与边界

- 商店前端 308 项测试、类型检查及构建通过。
- Go 全量测试通过；账号初始化的默认 loopback 模式保留，显式 LAN 模式拒绝公网来源、代理身份头、外站请求与公共域名的 DNS 重绑定。
- Btrfs 双内核挂载视图回归通过；设备号差异通过物理设备、挂载身份与 FSROOT 相对路径验证，其他子卷、设备、冲突视图仍拒绝。
- Docker 引导 25 项测试及独立代码复核通过：持久化初始化 intent、helper/runtime checkpoint、安全恢复、确切生命周期停止；仅当初始化父目录包含已验证的 Docker cache 时使用 daemon 要求的 rslave，其余 helper 明确使用 rprivate，核验严格匹配计划。
- 执行器 Python 41 项测试通过；允许尚未连接或已停止的完整空网络端点，但仍核对确切网络 ID 配置与网络归属。

## 范围

本次确认独立本地账号和商店安装流程。该结果不等于对目录内全部应用做了启动验收，待适配应用状态保持原样。只声明 AMD64 极空间与明确的数据盘/经典 Docker image store；没有 ARM、其他 NAS 品牌或 containerd image store 的验收结论。当前第三方 UI、原 18441 控制器、中央管理员账号、2FA、签名身份和公开目录均保留。
