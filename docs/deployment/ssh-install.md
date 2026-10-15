# SSH 安装应用商店和桌面 UI

适用于 Linux AMD64（`x86_64`）NAS，要求已启用 Docker，服务端版本至少为 20.10。本机只需要 POSIX `sh`、Docker CLI、`ip`，以及 `ss` 或 `netstat` 等基础系统工具。无需在 NAS 安装 Node.js、Go、Python 或 Compose；脚本从固定版本的商店镜像使用 Docker CLI 27.3.1 和 Compose 2.32.4。

默认安装桌面 UI 和独立商店，固定使用 `isle204/zspace-ui:2026.10.15-r5`、`isle204/zspace-shop:2026.10.15-r3`。普通应用仍通过网页中的受管安装流程安装。SSH 脚本不创建账号、设置明文密码或代替用户同意条款。

## 下载并安装

通过 NAS 的 SSH 登录后，将下面的 IP 换成 NAS 的局域网地址执行。先完成 HTTPS 下载，再运行保存的文件，下载失败时不会执行半截脚本：

```sh
installer="$(mktemp /tmp/zspace-install.XXXXXX)" && curl -fsSL https://zstore.2iwm.com/install.sh -o "$installer" && sh "$installer" --ip 192.168.3.56
```

如果当前账号没有 Docker 权限，在最后一步使用 `sudo sh "$installer" --ip 192.168.3.56`。脚本会报告权限问题，不会安装系统软件或修改用户组。脚本保留在临时文件中，便于先查看内容或排错；下载完整不等于安装成功，以最后的健康检查结果为准。

安装成功后访问：

- 桌面 UI：`http://192.168.3.56:18436`
- 独立商店：`http://192.168.3.56:18443`

在网页创建首个账号并查看条款。UI 的 NAS 地址使用 `http://NAS_IP:5055`。

## 预检查和选项

下载后可先执行只读检查：

```sh
sh "$installer" --check --ip 192.168.3.56
sh "$installer" --help
```

`--check` 验证本机 LAN 地址、Linux AMD64、Docker 服务端版本、访问权限、项目资源冲突和端口占用，不拉取镜像、不创建 Docker 资源。实际数据磁盘、缓存位置、目录身份和挂载安全检查由商店启动器在安装阶段执行；预检查通过并不表示这些后续检查已通过。

| 选项 | 含义 |
| --- | --- |
| `--ip NAS_LAN_IP` | 指定本机接口上实际存在的 RFC1918 私有 IPv4 地址；推荐显式填写。 |
| `--shop-only` | 只安装独立商店，不拉取或启动 UI，不占用 18436 端口。 |
| `--project-name NAME` | 使用新的专用项目名，默认 `zspace-suite`；以小写字母或数字开头，最长 40 字符，后续可含 `_` 和 `-`。 |
| `--data-root /data_disk/new-directory` | 仅把指定路径作为 `SHOP_DATA_ROOT` 传给商店启动器。路径必须为尚未被其他安装使用的专用目录，位于 NAS 数据磁盘上。 |
| `--check` | 只读预检查。 |
| `--help` | 显示帮助。 |

省略 `--ip` 时，脚本先检查 SSH 连接的服务端地址，再检查路由源地址，最后检查是否只有一个可用的本机私有 IPv4；无法确定时停止并要求指定。不会把远端 SSH 客户端地址当作 NAS 地址。

数据路径仅接受 ASCII 字母、数字、`/`、`_`、`.`、`-`，不接受尾随 `/`、`..`、系统目录、逗号、空白或 shell 表达式。自选路径例子：

```sh
sh "$installer" --ip 192.168.3.56 --data-root /data_n008/space-shop
sh "$installer" --shop-only --ip 192.168.3.56 --project-name my-shop
```

省略数据路径时，启动器根据已核实的 Docker 数据盘选择新的专用目录。脚本本身不在用户指定目录中创建文件。商店数据与 Docker 镜像缓存必须分开，已有目录不会被自动接管。

## 已有安装与失败处理

这是首次安装入口。再次执行时，只要发现该项目的容器、控制卷、UI 数据卷或网络，便停止并保留全部资源，不执行升级、覆盖或删除。它也检查名称相同但标签不同的资源，防止接管其他服务。即使选择 `--shop-only`，已有同名 UI 资源仍会让该项目检查失败。

新的 `--project-name` 可避开项目名称冲突，但不会绕过端口冲突。默认安装需要 18436 和 18443 均空闲；仅商店需要 18443 空闲。脚本同时检查 Docker 的已有端口预留和系统 TCP 监听。工作中的安装应继续使用原来的网页；如需迁移或升级，请按照独立商店部署文档核对数据、控制卷和版本，不要通过删除控制卷强行重跑。

脚本先拉取固定版本镜像，再启动临时的 Compose 执行容器。执行容器以项目专用名称获得互斥，在该名称生效后再次核对资源和 Docker 端口，防止延迟的并发安装接管已完成的部署。它使用只读根目录、移除全部 capabilities、禁用提权、独立无网络环境及临时 `/tmp`，只挂载本地 Docker socket；Compose 配置通过标准输入传入，不挂载宿主根目录或用户数据目录。执行结束只删除它自身的临时执行容器。

脚本固定连接本机 `/var/run/docker.sock` Unix socket，忽略继承的 `DOCKER_HOST`、Docker context、API 版本、TLS 和 Docker 配置目录覆盖。它不支持通过远程 Docker 地址或其他 socket 安装。

Compose 最多等待 180 秒通过服务健康检查；脚本随后再次确认每个服务均为 `running` 且 `healthy`，才输出 `Installation ready` 和访问地址。镜像拉取耗时不计入该健康检查时限。镜像拉取、启动或健康检查失败时，已产生的镜像、服务容器、卷和数据均保留，终端会返回非零状态。

默认项目的排错命令：

```sh
docker --host unix:///var/run/docker.sock ps -a --filter label=com.docker.compose.project=zspace-suite
docker --host unix:///var/run/docker.sock logs zspace-suite-shop
docker --host unix:///var/run/docker.sock inspect zspace-suite-shop
```

如果首次执行被中断，先核对这些保留资源及商店数据状态。不要删除控制卷、数据目录或业务容器来消除脚本提示。常规重启原有容器会继续使用原有启动器的所有权核对和持久化状态，不需要重新执行首次安装脚本。

## 开发验证

```sh
sh -n deploy/docker-installer/install.sh
python3 deploy/docker-installer/test_install.py
```

测试使用临时 Unix socket 和记录所有操作的假 Docker CLI，实际执行安装脚本及临时容器中的固定 shell 检查逻辑；不连接宿主 Docker 或拉取镜像。覆盖旧版本边界、无效输入、本地地址判定、远程环境覆盖、外部资源冲突、并发延迟冲突、仅商店模式、健康状态及失败保留行为。它验证脚本控制流程，真实 Docker 不同版本的端到端验证需另外执行。

本轮实际验收：Docker 20.10.24、24.0.9、26.1.4 的隔离 Linux AMD64 引擎均完成 UI＋商店安装、目录验证和 Syncthing 安装/HTTP 200/停止；最终脚本也验证了独立商店模式。详见[兼容验收](../verification/2026-10-15-docker-compat.md)。
