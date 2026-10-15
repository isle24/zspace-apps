# SSD 上的 Compose 安装

用户明确指定 SSH 脚本流程：自动获取各自 NAS 的 IP，在固态盘创建专用目录，写入 Docker Compose 文件，然后通过 Docker 启动，并保持旧引擎兼容。

现有脚本已自动识别 IP，但 Compose 仅从标准输入传给临时执行器，未保存到固态盘。改为从真实挂载与底层块设备识别纯 SSD 数据盘，排除系统盘、只读卷、机械盘和仅表层 ROTA=0 的 bcache 混合盘；多盘按可用空间最多选择。默认在所选盘创建与项目同名的专用目录，允许 --install-dir 指定另一块已验证 SSD 下的目录。

目录内保存 compose.yaml、UI 数据目录与商店控制目录，并将 SHOP_DATA_ROOT 默认指向目录内的新 runtime 子目录。控制卷及 UI 卷使用 local bind driver，将数据保留在 SSD；保持商店启动器要求的命名卷身份。临时镜像执行器仅用于兼容宿主缺少 Compose 或插件过旧的情形，实际启动读取持久 compose.yaml。

在现有项目、端口及目录冲突时保持数据，不覆盖文件、不格式化、不修改 NAS Docker 引擎。初始化仅在独占新目录后创建文件，并保留父目录 inode/device 校验、无符号链接及私有数据权限。无可验证 SSD 时停止并说明，不默默选机械盘。

验收覆盖非固定 IP、真实 SSD 与 bcache 识别、Compose 文件持久化、目录冲突和旧引擎启动；更新原 HTTPS 脚本及两个仓库文档。原 NAS 运行中的 UI 和商店无需重装。
