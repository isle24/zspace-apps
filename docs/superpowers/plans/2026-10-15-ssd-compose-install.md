# SSD Compose 安装实施

**Goal:** 自动识别 IP 和 SSD，生成持久 compose.yaml，再启动 UI 与商店。

**Constraints:** Linux AMD64，Docker >=20.10；不覆盖已有目录/容器/卷；不迁移当前 NAS 服务。

- [ ] 添加 IP 随不同 NAS 地址变化、SSD 自动选择和持久 Compose 回归，先观察失败。
- [ ] 实现 lsblk/findmnt/df 的真实 SSD 识别、专用安装目录与 --install-dir；排除 bcache 混合盘和系统盘。
- [ ] 在独占新目录内保存 compose.yaml，创建私有 UI/control 目录并配置绑定命名卷；使用镜像内 Compose 从该文件启动。
- [ ] 运行脚本回归、独立审查、现有 NAS 只读选盘与旧引擎隔离启动验证。
- [ ] 更新 HTTPS 脚本和校验值，两个 GitHub 仓库说明同步，保留原服务和数据。
