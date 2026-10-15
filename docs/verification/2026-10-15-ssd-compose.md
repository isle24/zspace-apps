# 自动 IP 与 SSD Compose 落盘验收

## 行为

SSH 安装脚本自动识别本机 NAS 的局域网 IP，并从真实数据挂载中选择可用空间最多的已核验 SSD。在新目录中写入 `compose.yaml`，创建私有 UI/商店控制目录，再由 Docker Compose 读取该持久文件启动服务。默认应用运行数据位于安装目录的 `runtime/`。

IP 不内置任何 NAS 地址。多网卡时可选 `--ip`；多个 SSD 默认自动比较可用空间，也可通过 `--install-dir` 指定已验证 SSD 上的新目录。Compose 的 UI 和商店镜像均使用 `latest`。

## 目录和磁盘检查

- `findmnt` 确认实际数据挂载，`lsblk` 追溯所有底层磁盘，排除系统盘、只读盘、机械盘及包含 HDD 的 bcache 链。
- Btrfs 从内核 sysfs 确认全部成员、缺失设备状态和各成员底层磁盘。系统 Btrfs 成员无法核验时停止，不退到单个源设备推断。
- 创建前核对 SSD 父目录 device/inode，按目录 FD 逐级禁止跟随符号链接，使用独占 mkdir；不接管或修改已有目录。
- 新安装目录和公开 Compose 归 SSH 用户所有；`compose.yaml` 为 0644，UI 数据目录为 UID/GID 10001、0700，控制目录为 root、0700。仅对新创建的条目设置权限与所有者。
- 临时执行器仅挂载固定 Docker socket 和选中的 SSD 父目录，使用非递归挂载；只读容器根目录、无网络、移除 capabilities，仅增加新目录初始化所需的 CHOWN。
- 持久数据通过 local bind driver 的命名卷绑定到 SSD 目录，保留现有商店启动器所需的卷身份。宿主无需安装 Compose 或 Python。

## 验证

- 38 项安装器回归覆盖：两个不同 NAS 网段自动 IP、真实文件生成、最大可用空间 SSD、bcache 混合盘、系统/只读/未知盘、Btrfs 多成员与缺失、目录及符号链接冲突、重复与变化挂载、sudo 原账号所有权、特殊项目名的 Compose 验证、内容 SHA 校验、旧客户端挂载语法和原有端口/资源保护。
- 测试夹具执行真实 shell 与 Python 准备逻辑，实际读写隔离文件并验证权限；本机夹具仅记录 fchown 目标。真实 fchown 在 NAS 的新验证目录上验证。
- 当前 NAS 只读预检查自动识别当前局域网 IP 和可用空间最多的 `/data_n008` SSD；随后按预期拒绝已占用端口，原服务保持。
- 在真实 SSD 的专用验证目录中生成 Compose，文件所有者和 0644/0700 权限正确；镜像内 Compose 从保存文件执行 `config --quiet` 通过。本次没有使用新文件替换或启动现有 NAS 服务。
- Docker 20.10.24、24.0.9、26.1.4 的隔离引擎分别运行生产准备代码和执行器，从保存文件启动后健康；20.10/24 验证 UI＋商店，26 验证仅商店。旧引擎测试使用专用虚拟数据卷，SSD 自动识别另由真实 NAS 及多盘回归验证，不能将虚拟卷解释为真实 NAS SSD。
- shell 语法、差异格式检查与独立审查通过。旧引擎挂载语法、应用执行能力及上一版完整安装验收见[旧引擎记录](2026-10-15-docker-compat.md)。

## 发布

更新同一个 HTTPS `/install.sh` 与 `/install.sh.sha256` 地址，并核对下载内容与验收源码一致。同步两个 GitHub 仓库的脚本和说明。本轮仅变更安装脚本与文档；UI、商店镜像仍使用已经发布的 latest。

安装流程和后续 Compose 管理命令见 [SSH 部署说明](../deployment/ssh-install.md)。
