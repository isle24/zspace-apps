# SSH 自动生成 Compose 并安装

脚本会自动识别每台 NAS 的局域网 IP，不内置固定 NAS 地址。默认安装 UI 和独立商店，兼容 Linux AMD64、Docker 20.10 及以上。

## 直接执行

```sh
installer="$(mktemp /tmp/zspace-install.XXXXXX)" && curl -fsSL https://zstore.2iwm.com/install.sh -o "$installer" && sh "$installer"
```

无需修改 IP。当前 SSH 账号需有 Docker 权限；权限不足时，使用 `sudo sh "$installer"` 执行下载好的脚本。首次账号在网页创建，脚本不生成或保存密码。

## 实际执行流程

1. 从 SSH 服务端地址、本机路由及网卡自动识别局域网 IP。
2. 核对真实数据挂载及底层块设备，选择可用空间最多的固态数据盘。
3. 在该盘创建与项目同名的专用目录，并保存 `compose.yaml`。
4. 创建 UI 数据和商店控制目录，Compose 的命名卷绑定到这些 SSD 目录；应用运行数据默认放在安装目录的 `runtime/` 下。
5. 从已保存的 Compose 文件启动 Docker，等待 UI 和商店健康后输出访问地址。

默认目录结构如下，`<SSD>` 是自动识别的盘，并非固定路径：

```text
<SSD>/zspace-suite/
  compose.yaml
  ui-data/
  shop-control/
  runtime/
```

访问地址使用识别到的 NAS IP：UI 为 `http://NAS_IP:18436`，商店为 `http://NAS_IP:18443`。仅商店模式不创建 `ui-data/`，也不启动 UI。

Compose 保存 `isle204/zspace-ui:latest` 和 `isle204/zspace-shop:latest`。宿主已有 Compose v2 时，可在安装目录执行 `docker compose pull && docker compose up -d` 更新；也可将文件导入 NAS 的 Docker Compose 管理页面。首次安装脚本使用商店镜像内的 Compose，宿主无需另外安装 Compose、Python、Node.js 或 Go。

## 可选参数

| 参数 | 用途 |
| --- | --- |
| `--check` | 只读显示识别到的 IP、SSD 和 Compose 路径，检查版本与冲突，不创建文件或拉镜像。 |
| `--shop-only` | 仅安装独立商店。 |
| `--install-dir /data_固态盘/my-shop` | 在指定的已验证 SSD 挂载根目录下新建专用目录。 |
| `--project-name my-shop` | 修改项目名，默认 `zspace-suite`。 |
| `--ip NAS_IP` | 多网卡时手动指定本机局域网地址；通常不需要填写。 |
| `--data-root PATH` | 高级选项：覆盖应用运行数据路径，仍由启动器验证目录身份；默认不需要填写。 |

例如只装商店：

```sh
sh "$installer" --shop-only
```

不使用已有目录，不覆盖文件，不接管已有容器、卷或网络。端口已被使用时停止安装；已有 NAS 服务无需重新安装。失败时保留已创建的文件和数据，便于检查 `compose.yaml` 和容器日志。

固态盘识别会检查全部底层设备，Btrfs 还核对内核记录的所有成员。系统盘、机械盘、机械盘上的 SSD 缓存和无法核验的成员不会被当成可安装 SSD。找不到可验证 SSD 时停止，不自动退到机械盘。

宿主需有 `ip`、`findmnt`、`lsblk`、`df`、`stat`、`sha256sum` 及 `ss`/`netstat` 等 NAS 基础工具。真实 SSD 识别、目录持久化和旧引擎验证范围见[验收记录](../verification/2026-10-15-ssd-compose.md)。
