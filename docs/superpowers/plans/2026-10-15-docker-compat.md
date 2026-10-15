# Docker 兼容与安装实施计划

**Goal:** 支持 Docker 20.10/24/26，并提供 zstore 域名下可直接通过 SSH 执行的一键安装。

**Architecture:** 宿主只运行已有 Docker CLI；受管商店继续使用固定 CLI 和 Compose 自动协商。安装脚本复用 UI+独立商店镜像，旧引擎用隔离 Docker daemon 实测。

**Global Constraints:** Linux AMD64；不降级现有 NAS 引擎；不改变数据、权限和挂载安全检查；不删除用户资源；镜像保留版本标签和 latest。

- [x] 为商店版本门槛和旧安装器增加旧版本接受、过旧及无效版本拒绝的回归，观察失败后改最低版本为 20.10。
- [x] 实现独立 SSH 安装脚本及参数、冲突、权限、健康检查回归，使用固定镜像内 Compose，避免宿主插件版本差异。
- [x] 在真实隔离 Docker 20.10、24、26 引擎上验证 CLI/API 协商、非递归挂载、UI/商店启动及应用安装；必要时修复已确认的字段差异。
- [x] 运行相关 Python/Go 回归和生产镜像构建；审查安装脚本；同步两仓库 README 和 Compose 兼容说明。
- [x] 推送版本及 latest，发布 HTTPS 安装脚本并校验内容和类型，升级现有 NAS 商店并验证保留配置与账号。
