# UI 与商店合并 Compose 验收

新增 `deploy/dockerhub/compose-ui-shop.yaml` 面向其他 AMD64 极空间用户全新部署。使用 `latest` 和 `pull_policy: always`，UI 为 18436，独立商店为 18443；替换所有 NAS IP 后无需外部环境文件、SSH 或数据库。

## 连接方式

UI 通过宿主 LAN 地址访问商店动态发布的端口。两个 Compose 服务使用既有 bridge，不创建额外项目网络，不依赖原 18441 控制器。UI 等待商店健康后启动。

商店新镜像增加可选 `SHOP_UI_ORIGIN`，只把明确配置的裸 HTTP(S) 来源传给现有网关 `--public-origin`。默认不增加额外来源，不修改 Go 同源边界，不移除代理头保护。首次创建管理员仍须直接打开商店端口，随后 UI 可使用独立商店账号登录。

配置用于新部署。旧实例未配置 UI origin 时，不能直接在原控制卷新增此变量；不可变配置校验会拒绝，不能把该安全拒绝称为已支持迁移。

## 验证

- 3 项新 origin 回归先失败后修复，41 项引导和 3 项构建原回归通过；独立代码复核通过。
- Compose 本机和 NAS 校验通过。
- 极空间新建隔离项目 `zspace-suite-qa-20261015`，测试 UI 18453、商店 18454，两个服务均 healthy。
- 从 DockerHub 实际拉取两种 `latest`，再次启动均 healthy，StoreID 与账号保持。
- 直接商店创建账号通过；经 UI 代理创建账号仍以 `setup_loopback_only` 拒绝。
- 经 UI 来源的密码登录、执行器状态和目录核验通过；其他来源以 `ORIGIN_REJECTED` 拒绝。
- 经 UI 生成 Uptime Kuma 安装计划通过，计划 `33a82f09899a8a4e2c1d34a18febe477cf5151021fcb25fd`。本轮未执行该计划，不将其称为新一轮应用运行验收。
- 测试密码及会话仅在进程内存中生成和使用，未写入参数、文件或日志。
- 原 NAS UI 18436、控制器 18441、独立商店 18443 和中央服务未修改。

## 镜像

`isle204/zspace-shop:2026.10.15-r1` 与 `latest` 均匿名核验为 Linux AMD64，OCI digest 均为 `sha256:5e14b8875e8a85aee11f78bb74e443a649a12b9db494d14f57488d1d676c31ce`。UI 继续使用此前已发布的 `isle204/zspace-ui:latest`，镜像内容未变。
